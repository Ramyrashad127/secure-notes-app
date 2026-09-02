import { describe, expect, it } from "vitest";
import type { AuditEventInput } from "@/lib/audit";
import type { Note, NoteVersion } from "@/db/schema";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  NoteNotFoundError,
  UnauthorizedError,
  updateNote,
  type NotesDeps,
} from "./notes-service";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    userId: "user-a",
    title: "Test note",
    content: "Some content",
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

interface FakeState {
  notes: Note[];
  versions: NoteVersion[];
  sessions: Map<string, string>;
  audits: AuditEventInput[];
}

function createFakeDeps(): { deps: Required<NotesDeps>; state: FakeState } {
  const state: FakeState = {
    notes: [],
    versions: [],
    sessions: new Map(),
    audits: [],
  };

  const deps: Required<NotesDeps> = {
    noteStore: {
      async listByUserId(userId) {
        return state.notes
          .filter((n) => n.userId === userId && !n.deletedAt)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      },
      async findByIdAndUserId(id, userId) {
        const note = state.notes.find((n) => n.id === id && n.userId === userId && !n.deletedAt);
        return note ?? null;
      },
      async insert(data) {
        const now = new Date();
        const note: Note = { id: `note-${state.notes.length + 1}`, ...data, deletedAt: null, createdAt: now, updatedAt: now };
        state.notes.push(note);
        return note;
      },
      async update(id, userId, data) {
        const note = state.notes.find((n) => n.id === id && n.userId === userId && !n.deletedAt);
        if (!note) throw new NoteNotFoundError();
        note.title = data.title;
        note.content = data.content;
        note.updatedAt = new Date();
        return note;
      },
      async softDelete(id, userId) {
        const note = state.notes.find((n) => n.id === id && n.userId === userId && !n.deletedAt);
        if (!note) throw new NoteNotFoundError();
        note.deletedAt = new Date();
      },
    },
    versionStore: {
      async insert(data) {
        const version: NoteVersion = { id: `ver-${state.versions.length + 1}`, createdAt: new Date(), ...data };
        state.versions.push(version);
        return version;
      },
    },
    sessionStore: {
      async resolve(token) {
        const userId = state.sessions.get(token);
        return userId ? { userId } : null;
      },
    },
    auditSink(input) {
      state.audits.push(input);
    },
  };

  return { deps, state };
}

describe("notes service: session verification", () => {
  it("rejects every operation with an invalid token", async () => {
    const { deps } = createFakeDeps();

    await expect(listNotes("bad-token", deps)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(getNote("note-1", "bad-token", deps)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      createNote({ title: "T", content: "C" }, "bad-token", deps),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      updateNote("note-1", { title: "T", content: "C" }, "bad-token", deps),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(deleteNote("note-1", "bad-token", deps)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});

describe("notes service: createNote", () => {
  it("binds the session userId and writes a v1 snapshot", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token", "user-a");

    const note = await createNote({ title: "Grocery", content: "Milk" }, "token", deps);

    expect(note.userId).toBe("user-a");
    expect(note.title).toBe("Grocery");
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]).toMatchObject({
      noteId: note.id,
      userId: "user-a",
      version: 1,
      title: "Grocery",
      content: "Milk",
    });
  });

  it("emits a NOTE_CREATED audit event", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token", "user-a");

    const note = await createNote({ title: "Grocery", content: "Milk" }, "token", deps);

    expect(state.audits).toContainEqual(
      expect.objectContaining({
        userId: "user-a",
        action: "NOTE_CREATED",
        entityType: "note",
        entityId: note.id,
        metadata: { title: "Grocery" },
      }),
    );
  });
});

describe("notes service: authorization boundaries", () => {
  it("lists only the current user's notes", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-b", "user-b");
    state.notes.push(
      makeNote({ id: "n1", userId: "user-a", title: "A's note" }),
      makeNote({ id: "n2", userId: "user-b", title: "B's note" }),
    );

    const result = await listNotes("token-b", deps);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("n2");
  });

  it("returns null for another user's note on getNote", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-b", "user-b");
    state.notes.push(makeNote({ id: "n1", userId: "user-a" }));

    await expect(getNote("n1", "token-b", deps)).resolves.toBeNull();
  });

  it("throws not-found when updating another user's note", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-b", "user-b");
    state.notes.push(makeNote({ id: "n1", userId: "user-a", title: "Original" }));

    await expect(
      updateNote("n1", { title: "Hacked", content: "" }, "token-b", deps),
    ).rejects.toBeInstanceOf(NoteNotFoundError);

    expect(state.notes[0].title).toBe("Original");
  });

  it("throws not-found when deleting another user's note and emits no audit", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-b", "user-b");
    state.notes.push(makeNote({ id: "n1", userId: "user-a" }));

    await expect(deleteNote("n1", "token-b", deps)).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );

    expect(state.notes[0].deletedAt).toBeNull();
    expect(state.audits).toHaveLength(0);
  });
});

describe("notes service: update & soft-delete", () => {
  it("updates the owner's note", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    const note = makeNote({ id: "n1", userId: "user-a" });
    state.notes.push(note);

    const updated = await updateNote(
      "n1",
      { title: "Renamed", content: "New body" },
      "token-a",
      deps,
    );

    expect(updated.title).toBe("Renamed");
    expect(updated.content).toBe("New body");
    expect(state.versions).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it("soft-deletes the owner's note and emits NOTE_DELETED", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(makeNote({ id: "n1", userId: "user-a", title: "Shred me" }));

    await deleteNote("n1", "token-a", deps);

    expect(state.notes[0].deletedAt).not.toBeNull();
    expect(state.audits).toContainEqual(
      expect.objectContaining({
        userId: "user-a",
        action: "NOTE_DELETED",
        entityType: "note",
        entityId: "n1",
        metadata: { title: "Shred me" },
      }),
    );
  });

  it("hides soft-deleted notes from list and get", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(
      makeNote({ id: "alive", userId: "user-a", deletedAt: null }),
      makeNote({ id: "gone", userId: "user-a", deletedAt: new Date() }),
    );

    const list = await listNotes("token-a", deps);
    expect(list.map((n) => n.id)).toEqual(["alive"]);

    await expect(getNote("gone", "token-a", deps)).resolves.toBeNull();
  });

  it("rejects update/delete of an already deleted note", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(makeNote({ id: "gone", userId: "user-a", deletedAt: new Date() }));

    await expect(
      updateNote("gone", { title: "X", content: "" }, "token-a", deps),
    ).rejects.toBeInstanceOf(NoteNotFoundError);
    await expect(deleteNote("gone", "token-a", deps)).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );
  });
});

describe("notes service: list ordering", () => {
  it("returns notes most recently updated first", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(
      makeNote({ id: "old", userId: "user-a", updatedAt: new Date("2026-01-01") }),
      makeNote({ id: "new", userId: "user-a", updatedAt: new Date("2026-02-01") }),
    );

    const list = await listNotes("token-a", deps);

    expect(list.map((n) => n.id)).toEqual(["new", "old"]);
  });
});