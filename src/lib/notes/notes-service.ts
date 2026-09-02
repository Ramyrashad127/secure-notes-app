import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  noteVersions,
  notes,
  type Note,
  type NoteVersion,
} from "@/db/schema";
import { audit as defaultAudit, type AuditEventInput } from "@/lib/audit";
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

export interface NoteStore {
  listByUserId(userId: string): Promise<Note[]>;
  findByIdAndUserId(id: string, userId: string): Promise<Note | null>;
  insert(data: { userId: string; title: string; content: string }): Promise<Note>;
  update(id: string, userId: string, data: { title: string; content: string }): Promise<Note>;
  softDelete(id: string, userId: string): Promise<void>;
}

export interface VersionStore {
  insert(data: { noteId: string; userId: string; version: number; title: string; content: string }): Promise<NoteVersion>;
}

export interface SessionStore {
  resolve(token: string): Promise<{ userId: string } | null>;
}

export interface NotesDeps {
  noteStore?: NoteStore;
  versionStore?: VersionStore;
  sessionStore?: SessionStore;
  auditSink?: (input: AuditEventInput) => void;
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
  },
  sessionStore: {
    async resolve(token) {
      return getSession(token);
    },
  },
  auditSink: defaultAudit,
};

async function requireUserId(
  token: string,
  deps: Required<NotesDeps>,
): Promise<string> {
  const session = await deps.sessionStore.resolve(token);
  if (!session) throw new UnauthorizedError();
  return session.userId;
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
  deps.auditSink({
    userId,
    action: "NOTE_CREATED",
    entityType: "note",
    entityId: note.id,
    metadata: { title: input.title },
  });
  return note;
}

export async function updateNote(
  noteId: string,
  input: { title: string; content: string },
  token: string,
  deps: Required<NotesDeps> = defaultDeps,
): Promise<Note> {
  const userId = await requireUserId(token, deps);
  return deps.noteStore.update(noteId, userId, {
    title: input.title,
    content: input.content,
  });
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
  deps.auditSink({
    userId,
    action: "NOTE_DELETED",
    entityType: "note",
    entityId: note.id,
    metadata: { title: note.title },
  });
}