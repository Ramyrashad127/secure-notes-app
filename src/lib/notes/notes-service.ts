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
};

async function requireUserId(
  token: string,
  deps: Required<NotesDeps>,
): Promise<string> {
  const session = await deps.sessionStore.resolve(token);
  if (!session) throw new UnauthorizedError();
  return session.userId;
}

async function requireOwnedNote(
  noteId: string,
  userId: string,
  deps: Required<NotesDeps>,
): Promise<Note> {
  const note = await deps.noteStore.findByIdAndUserId(noteId, userId);
  if (!note) throw new NoteNotFoundError();
  return note;
}

export async function listNotes(
  token: string,
  deps: Required<NotesDeps> = defaultDeps,
): Promise<Note[]> {
  const userId = await requireUserId(token, deps);
  return deps.noteStore.listByUserId(userId);
}

export async function getNote(
  noteId: string,
  token: string,
  deps: Required<NotesDeps> = defaultDeps,
): Promise<Note | null> {
  const userId = await requireUserId(token, deps);
  return deps.noteStore.findByIdAndUserId(noteId, userId);
}

export async function createNote(
  input: CreateNoteInput,
  token: string,
  deps: Required<NotesDeps> = defaultDeps,
): Promise<Note> {
  const userId = await requireUserId(token, deps);
  const note = await deps.noteStore.insert({
    userId,
    title: input.title,
    content: input.content,
  });
  await deps.versionStore.insert({
    noteId: note.id,
    userId,
    version: 1,
    title: input.title,
    content: input.content,
  });
  deps.auditLogger(userId, "NOTE_CREATED", { noteId: note.id, title: input.title });
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
  deps: Required<NotesDeps> = defaultDeps,
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
      return { note: current, snapshotCreated: false };
    }
  } else if (matchesLive) {
    return { note: current, snapshotCreated: false };
  }

  if (
    input.clientUpdatedAt &&
    previousUpdatedAt > input.clientUpdatedAt.getTime()
  ) {
    throw new ConflictError();
  }

  const updated = await deps.noteStore.update(noteId, userId, {
    title: input.title,
    content: input.content,
  });

  const shouldSnapshot =
    input.isManualSave === true ||
    Date.now() - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS;

  let snapshotCreated = false;
  if (shouldSnapshot) {
    const snapshotTitle = input.isManualSave ? updated.title : previousTitle;
    const snapshotContent = input.isManualSave
      ? updated.content
      : previousContent;
    await deps.versionStore.insert({
      noteId,
      userId,
      version: (latestVersion?.version ?? 0) + 1,
      title: snapshotTitle,
      content: snapshotContent,
    });
    snapshotCreated = true;
  }

  if (snapshotCreated) {
    deps.auditLogger(userId, "NOTE_UPDATED", {
      noteId,
      title: updated.title,
    });
  }

  return { note: updated, snapshotCreated };
}

export async function deleteNote(
  noteId: string,
  token: string,
  deps: Required<NotesDeps> = defaultDeps,
): Promise<void> {
  const userId = await requireUserId(token, deps);
  const note = await deps.noteStore.findByIdAndUserId(noteId, userId);
  if (!note) throw new NoteNotFoundError();
  await deps.noteStore.softDelete(noteId, userId);
  deps.auditLogger(userId, "NOTE_DELETED", { noteId: note.id, title: note.title });
}

export async function getNoteVersions(
  noteId: string,
  token: string,
  deps: Required<NotesDeps> = defaultDeps,
): Promise<NoteVersion[]> {
  const userId = await requireUserId(token, deps);
  await requireOwnedNote(noteId, userId, deps);
  return deps.versionStore.listByNoteId(noteId);
}

export async function restoreVersion(
  noteId: string,
  versionId: string,
  token: string,
  deps: Required<NotesDeps> = defaultDeps,
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