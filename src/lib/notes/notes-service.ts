import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  noteVersions,
  notes,
  type Note,
  type NoteVersion,
} from "@/db/schema";
import { logAuditEvent, type AuditLogger } from "@/lib/audit/audit-service";
import { getSession } from "@/lib/auth/session";
import { recordNoteOperation } from "@/lib/metrics";
import type { CreateNoteInput } from "@/lib/validations/notes";

export class UnauthorizedError extends Error {
  constructor() {
    super("You must be signed in to do that");
    this.name = "UnauthorizedError";
  }
}

export class NoteNotFoundError extends Error {
  constructor() {
    super("Note not found");
    this.name = "NoteNotFoundError";
  }
}

export class ConflictError extends Error {
  constructor() {
    super("This note was updated elsewhere. Refresh and try again.");
    this.name = "ConflictError";
  }
}

export class VersionNotFoundError extends Error {
  constructor() {
    super("Version not found");
    this.name = "VersionNotFoundError";
  }
}

export const SNAPSHOT_INTERVAL_MS = 30 * 60 * 1000;

export interface NoteStore {
  listByUserId(userId: string): Promise<Note[]>;
  findByIdAndUserId(id: string, userId: string): Promise<Note | null>;
  insert(data: { userId: string; title: string; content: string }): Promise<Note>;
  update(id: string, userId: string, data: { title: string; content: string }): Promise<Note>;
  softDelete(id: string, userId: string): Promise<void>;
}

export interface VersionStore {
  insert(data: { noteId: string; userId: string; version: number; title: string; content: string }): Promise<NoteVersion>;
  latestVersion(noteId: string): Promise<NoteVersion | null>;
  listByNoteId(noteId: string): Promise<NoteVersion[]>;
  findByIdAndNoteId(id: string, noteId: string): Promise<NoteVersion | null>;
}

export interface SessionStore {
  resolve(token: string): Promise<{ userId: string } | null>;
}

export interface NotesDeps {
  noteStore?: NoteStore;
  versionStore?: VersionStore;
  sessionStore?: SessionStore;
  auditLogger?: AuditLogger;
  /**
   * Run a write callback inside a DB transaction. Defaults to `db.transaction`.
   * When omitted (e.g. unit-test fakes), writes fall back to the store closures.
   */
  transaction?: <T>(fn: (tx: TransactionClient) => Promise<T>) => Promise<T>;
}

/**
 * The deps shape the service needs at runtime: the core stores are required,
 * while `transaction` remains optional (tests omit it and run stores directly).
 */
export type NotesServiceDeps = Omit<Required<NotesDeps>, "transaction"> &
  Pick<NotesDeps, "transaction">;

/** Holds the transaction-scoped data-access closures used inside db.transaction. */
export interface TransactionClient {
  updateNote(
    id: string,
    userId: string,
    data: { title: string; content: string },
  ): Promise<Note>;
  insertVersion(data: {
    noteId: string;
    userId: string;
    version: number;
    title: string;
    content: string;
  }): Promise<NoteVersion>;
  createNoteWithVersion(data: {
    userId: string;
    title: string;
    content: string;
  }): Promise<Note>;
}

const defaultDeps: Required<NotesDeps> = {
  noteStore: {
    async listByUserId(userId) {
      return db.select().from(notes).where(and(eq(notes.userId, userId), isNull(notes.deletedAt))).orderBy(desc(notes.updatedAt));
    },
    async findByIdAndUserId(id, userId) {
      const [note] = await db.select().from(notes).where(and(eq(notes.id, id), eq(notes.userId, userId), isNull(notes.deletedAt))).limit(1);
      return note ?? null;
    },
    async insert(data) {
      const [note] = await db.insert(notes).values(data).returning();
      if (!note) throw new Error("Failed to create note");
      return note;
    },
    async update(id, userId, data) {
      const [note] = await db.update(notes).set({ ...data, updatedAt: new Date() }).where(and(eq(notes.id, id), eq(notes.userId, userId), isNull(notes.deletedAt))).returning();
      if (!note) throw new NoteNotFoundError();
      return note;
    },
    async softDelete(id, userId) {
      const [deleted] = await db.update(notes).set({ deletedAt: new Date() }).where(and(eq(notes.id, id), eq(notes.userId, userId), isNull(notes.deletedAt))).returning();
      if (!deleted) throw new NoteNotFoundError();
      void deleted;
    },
  },
  versionStore: {
    async insert(data) {
      const [version] = await db.insert(noteVersions).values(data).returning();
      if (!version) throw new Error("Failed to create note version");
      return version;
    },
    async latestVersion(noteId) {
      const [row] = await db
        .select()
        .from(noteVersions)
        .where(eq(noteVersions.noteId, noteId))
        .orderBy(desc(noteVersions.version))
        .limit(1);
      return row ?? null;
    },
    async listByNoteId(noteId) {
      return db
        .select()
        .from(noteVersions)
        .where(eq(noteVersions.noteId, noteId))
        .orderBy(desc(noteVersions.version));
    },
    async findByIdAndNoteId(id, noteId) {
      const [row] = await db
        .select()
        .from(noteVersions)
        .where(and(eq(noteVersions.id, id), eq(noteVersions.noteId, noteId)))
        .limit(1);
      return row ?? null;
    },
  },
  sessionStore: {
    async resolve(token) {
      return getSession(token);
    },
  },
  auditLogger: (userId, eventType, payload) => {
    void logAuditEvent(userId, eventType, payload);
  },
  transaction: (fn) =>
    db.transaction((tx) => {
      const txClient: TransactionClient = {
        async updateNote(id, userId, data) {
          const [note] = await tx
            .update(notes)
            .set({ ...data, updatedAt: new Date() })
            .where(
              and(
                eq(notes.id, id),
                eq(notes.userId, userId),
                isNull(notes.deletedAt),
              ),
            )
            .returning();
          if (!note) throw new NoteNotFoundError();
          return note;
        },
        async insertVersion(data) {
          const [version] = await tx.insert(noteVersions).values(data).returning();
          if (!version) throw new Error("Failed to create note version");
          return version;
        },
        async createNoteWithVersion(data) {
          const [note] = await tx.insert(notes).values(data).returning();
          if (!note) throw new Error("Failed to create note");
          const [version] = await tx
            .insert(noteVersions)
            .values({
              noteId: note.id,
              userId: data.userId,
              version: 1,
              title: data.title,
              content: data.content,
            })
            .returning();
          if (!version) throw new Error("Failed to create note version");
          return note;
        },
      };
      return fn(txClient);
    }),
};

async function requireUserId(
  token: string,
  deps: NotesServiceDeps,
): Promise<string> {
  const session = await deps.sessionStore.resolve(token);
  if (!session) throw new UnauthorizedError();
  return session.userId;
}

function buildTransactionClient(deps: NotesServiceDeps): TransactionClient {
  const txClient: TransactionClient = {
    async updateNote(id, userId, data) {
      return deps.noteStore.update(id, userId, data);
    },
    async insertVersion(data) {
      return deps.versionStore.insert(data);
    },
    async createNoteWithVersion(data) {
      const note = await deps.noteStore.insert(data);
      await deps.versionStore.insert({
        noteId: note.id,
        userId: data.userId,
        version: 1,
        title: data.title,
        content: data.content,
      });
      return note;
    },
  };
  return txClient;
}

/** Run writes inside the injected transaction, or fall back to store closures. */
async function runInTransaction<T>(
  deps: NotesServiceDeps,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  if (deps.transaction) {
    return deps.transaction(fn);
  }
  return fn(buildTransactionClient(deps));
}

async function requireOwnedNote(
  noteId: string,
  userId: string,
  deps: NotesServiceDeps,
): Promise<Note> {
  const note = await deps.noteStore.findByIdAndUserId(noteId, userId);
  if (!note) throw new NoteNotFoundError();
  return note;
}

export async function listNotes(
  token: string,
  deps: NotesServiceDeps = defaultDeps,
): Promise<Note[]> {
  const userId = await requireUserId(token, deps);
  return deps.noteStore.listByUserId(userId);
}

export async function getNote(
  noteId: string,
  token: string,
  deps: NotesServiceDeps = defaultDeps,
): Promise<Note | null> {
  const userId = await requireUserId(token, deps);
  return deps.noteStore.findByIdAndUserId(noteId, userId);
}

export async function createNote(
  input: CreateNoteInput,
  token: string,
  deps: NotesServiceDeps = defaultDeps,
): Promise<Note> {
  const userId = await requireUserId(token, deps);

  const note = await runInTransaction(deps, (tx) =>
    tx.createNoteWithVersion({
      userId,
      title: input.title,
      content: input.content,
    }),
  );

  deps.auditLogger(userId, "NOTE_CREATED", { noteId: note.id, title: input.title });
  recordNoteOperation("create");
  return note;
}

export async function updateNote(
  noteId: string,
  input: {
    title: string;
    content: string;
    clientUpdatedAt?: Date;
    isManualSave?: boolean;
  },
  token: string,
  deps: NotesServiceDeps = defaultDeps,
): Promise<{ note: Note; snapshotCreated: boolean }> {
  const userId = await requireUserId(token, deps);

  const current = await deps.noteStore.findByIdAndUserId(noteId, userId);
  if (!current) throw new NoteNotFoundError();
  const previousUpdatedAt = current.updatedAt.getTime();
  const previousTitle = current.title;
  const previousContent = current.content;

  const latestVersion = await deps.versionStore.latestVersion(noteId);
  const lastSnapshotAt = latestVersion?.createdAt.getTime() ?? 0;
  const latestSnapshotTitle = latestVersion?.title ?? null;
  const latestSnapshotContent = latestVersion?.content ?? null;

  const matchesLive =
    input.title === current.title && input.content === current.content;
  const matchesLatestSnapshot =
    latestSnapshotTitle === input.title && latestSnapshotContent === input.content;

  if (input.isManualSave === true) {
    if (matchesLatestSnapshot) {
      recordNoteOperation("autosave_skipped");
      return { note: current, snapshotCreated: false };
    }
  } else if (matchesLive) {
    recordNoteOperation("autosave_skipped");
    return { note: current, snapshotCreated: false };
  }

  if (
    input.clientUpdatedAt &&
    previousUpdatedAt > input.clientUpdatedAt.getTime()
  ) {
    if (input.isManualSave !== true) {
      recordNoteOperation("autosave_failure");
    }
    throw new ConflictError();
  }

  const { note: updated, snapshotCreated } = await runInTransaction(
    deps,
    async (tx) => {
      const updatedNote = await tx.updateNote(noteId, userId, {
        title: input.title,
        content: input.content,
      });

      const shouldSnapshot =
        input.isManualSave === true ||
        Date.now() - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS;

      let didCreateSnapshot = false;
      if (shouldSnapshot) {
        const snapshotTitle = input.isManualSave
          ? updatedNote.title
          : previousTitle;
        const snapshotContent = input.isManualSave
          ? updatedNote.content
          : previousContent;
        await tx.insertVersion({
          noteId,
          userId,
          version: (latestVersion?.version ?? 0) + 1,
          title: snapshotTitle,
          content: snapshotContent,
        });
        didCreateSnapshot = true;
      }

      return { note: updatedNote, snapshotCreated: didCreateSnapshot };
    },
  );

  if (snapshotCreated) {
    deps.auditLogger(userId, "NOTE_UPDATED", {
      noteId,
      title: updated.title,
    });
  }

  if (input.isManualSave === true) {
    recordNoteOperation("update");
  } else {
    recordNoteOperation("autosave");
  }

  return { note: updated, snapshotCreated };
}

export async function deleteNote(
  noteId: string,
  token: string,
  deps: NotesServiceDeps = defaultDeps,
): Promise<void> {
  const userId = await requireUserId(token, deps);
  const note = await deps.noteStore.findByIdAndUserId(noteId, userId);
  if (!note) throw new NoteNotFoundError();
  await deps.noteStore.softDelete(noteId, userId);
  deps.auditLogger(userId, "NOTE_DELETED", { noteId: note.id, title: note.title });
  recordNoteOperation("delete");
}

export async function getNoteVersions(
  noteId: string,
  token: string,
  deps: NotesServiceDeps = defaultDeps,
): Promise<NoteVersion[]> {
  const userId = await requireUserId(token, deps);
  await requireOwnedNote(noteId, userId, deps);
  return deps.versionStore.listByNoteId(noteId);
}

export async function restoreVersion(
  noteId: string,
  versionId: string,
  token: string,
  deps: NotesServiceDeps = defaultDeps,
): Promise<Note> {
  const userId = await requireUserId(token, deps);
  await requireOwnedNote(noteId, userId, deps);

  const version = await deps.versionStore.findByIdAndNoteId(versionId, noteId);
  if (!version) throw new VersionNotFoundError();

  const restored = await deps.noteStore.update(noteId, userId, {
    title: version.title,
    content: version.content,
  });

  const latestVersion = await deps.versionStore.latestVersion(noteId);
  await deps.versionStore.insert({
    noteId,
    userId,
    version: (latestVersion?.version ?? 0) + 1,
    title: version.title,
    content: version.content,
  });

  return restored;
}