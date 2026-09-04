import { describe, expect, it } from "vitest";
import type { Note, NoteVersion } from "@/db/schema";
import {
  ConflictError,
  createNote,
  deleteNote,
  getNote,
  getNoteVersions,
  listNotes,
  NoteNotFoundError,
  restoreVersion,
  UnauthorizedError,
  updateNote,
  VersionNotFoundError,
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

function makeVersion(overrides: Partial<NoteVersion> = {}): NoteVersion {
  return {
    id: "ver-1",
    noteId: "note-1",
    userId: "user-a",
    version: 1,
    title: "Test note",
    content: "Some content",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

interface AuditCall {
  userId: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
}

interface FakeState {
  notes: Note[];
  versions: NoteVersion[];
  sessions: Map<string, string>;
  audits: AuditCall[];
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
      async latestVersion(noteId) {
        const versions = state.versions
          .filter((v) => v.noteId === noteId)
          .sort((a, b) => b.version - a.version);
        return versions[0] ?? null;
      },
      async listByNoteId(noteId) {
        return state.versions
          .filter((v) => v.noteId === noteId)
          .sort((a, b) => b.version - a.version);
      },
      async findByIdAndNoteId(id, noteId) {
        const version = state.versions.find(
          (v) => v.id === id && v.noteId === noteId,
        );
        return version ?? null;
      },
    },
    sessionStore: {
      async resolve(token) {
        const userId = state.sessions.get(token);
        return userId ? { userId } : null;
      },
    },
    auditLogger(userId, eventType, payload) {
      state.audits.push({ userId, eventType, payload });
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
        eventType: "NOTE_CREATED",
        payload: { noteId: note.id, title: "Grocery" },
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
    const note = makeNote({
      id: "n1",
      userId: "user-a",
      updatedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    state.notes.push(note);
    state.versions.push(
      makeVersion({
        id: "v1",
        noteId: "n1",
        userId: "user-a",
        version: 1,
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
      }),
    );

    const { note: updated } = await updateNote(
      "n1",
      { title: "Renamed", content: "New body" },
      "token-a",
      deps,
    );

    expect(updated.title).toBe("Renamed");
    expect(updated.content).toBe("New body");
    expect(state.versions).toHaveLength(1);
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
        eventType: "NOTE_DELETED",
        payload: { noteId: "n1", title: "Shred me" },
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

describe("notes service: optimistic concurrency control", () => {
  it("rejects a save whose clientUpdatedAt is older than the stored updatedAt", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(
      makeNote({
        id: "n1",
        userId: "user-a",
        title: "Original",
        updatedAt: new Date("2026-01-02T12:00:00.000Z"),
      }),
    );

    await expect(
      updateNote(
        "n1",
        {
          title: "Stale overwrite",
          content: "",
          clientUpdatedAt: new Date("2026-01-02T11:59:59.000Z"),
        },
        "token-a",
        deps,
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(state.notes[0].title).toBe("Original");
  });

  it("allows a save whose clientUpdatedAt matches the stored updatedAt", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(
      makeNote({
        id: "n1",
        userId: "user-a",
        title: "Original",
        updatedAt: new Date("2026-01-02T12:00:00.000Z"),
      }),
    );

    const { note: updated } = await updateNote(
      "n1",
      {
        title: "Fresh",
        content: "",
        clientUpdatedAt: new Date("2026-01-02T12:00:00.000Z"),
      },
      "token-a",
      deps,
    );

    expect(updated.title).toBe("Fresh");
  });

  it("skips the conflict check when clientUpdatedAt is omitted", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(
      makeNote({ id: "n1", userId: "user-a", title: "Original" }),
    );

    const { note: updated } = await updateNote(
      "n1",
      { title: "Changed", content: "" },
      "token-a",
      deps,
    );

    expect(updated.title).toBe("Changed");
  });
});

describe("notes service: version snapshots", () => {
  it("does not snapshot on a background autosave within 30 minutes of the last snapshot", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(
      makeNote({
        id: "n1",
        userId: "user-a",
        title: "Live",
        content: "Live body",
        updatedAt: new Date(Date.now() - 5 * 1000),
      }),
    );
    state.versions.push(
      makeVersion({
        id: "v1",
        noteId: "n1",
        userId: "user-a",
        version: 1,
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
      }),
    );

    const { note: updated } = await updateNote(
      "n1",
      { title: "Autosaved", content: "body" },
      "token-a",
      deps,
    );

    expect(updated.title).toBe("Autosaved");
    expect(state.versions).toHaveLength(1);
    // No snapshot was created, so NOTE_UPDATED must NOT be logged
    expect(state.audits.map((a) => a.eventType)).not.toContain("NOTE_UPDATED");
  });

  it("snapshots once 30 minutes have passed since the last snapshot even if the note was just autosaved", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(
      makeNote({
        id: "n1",
        userId: "user-a",
        title: "Live",
        content: "Live body",
        updatedAt: new Date(Date.now() - 5 * 1000),
      }),
    );
    state.versions.push(
      makeVersion({
        id: "v1",
        noteId: "n1",
        userId: "user-a",
        version: 1,
        createdAt: new Date(Date.now() - 31 * 60 * 1000),
      }),
    );

    const { note: updated } = await updateNote(
      "n1",
      { title: "Autosaved", content: "body" },
      "token-a",
      deps,
    );

    expect(updated.title).toBe("Autosaved");
    expect(state.versions).toHaveLength(2);
    // A background autosave snapshots the PREVIOUS database content, not the incoming payload
    expect(state.versions[1]).toMatchObject({
      noteId: "n1",
      userId: "user-a",
      version: 2,
      title: "Live",
      content: "Live body",
    });
  });

  it("snapshots when exactly 30 minutes have passed since the last snapshot", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(
      makeNote({
        id: "n1",
        userId: "user-a",
        title: "Live",
        content: "Live body",
        updatedAt: new Date(Date.now() - 5 * 1000),
      }),
    );
    state.versions.push(
      makeVersion({
        id: "v1",
        noteId: "n1",
        userId: "user-a",
        version: 1,
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      }),
    );

    await updateNote(
      "n1",
      { title: "Boundary", content: "b" },
      "token-a",
      deps,
    );

    expect(state.versions).toHaveLength(2);
  });

  it("manual saves bypass the 30-minute timer and snapshot immediately", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(
      makeNote({
        id: "n1",
        userId: "user-a",
        title: "Live",
        content: "Live body",
        updatedAt: new Date(Date.now() - 5 * 1000),
      }),
    );
    state.versions.push(
      makeVersion({
        id: "v1",
        noteId: "n1",
        userId: "user-a",
        version: 1,
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
      }),
    );

    const { note: updated } = await updateNote(
      "n1",
      { title: "Manual", content: "manual body", isManualSave: true },
      "token-a",
      deps,
    );

    expect(updated.title).toBe("Manual");
    expect(state.versions).toHaveLength(2);
    expect(state.versions[1]).toMatchObject({
      noteId: "n1",
      userId: "user-a",
      version: 2,
      title: "Manual",
      content: "manual body",
    });
    expect(state.audits).toContainEqual(
      expect.objectContaining({
        userId: "user-a",
        eventType: "NOTE_UPDATED",
        payload: { noteId: "n1", title: "Manual" },
      }),
    );
  });

  it("a follow-up autosave does not snapshot again within 30 minutes of the snapshot", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(
      makeNote({
        id: "n1",
        userId: "user-a",
        title: "Live",
        content: "Live body",
        updatedAt: new Date(Date.now() - 5 * 1000),
      }),
    );
    state.versions.push(
      makeVersion({
        id: "v1",
        noteId: "n1",
        userId: "user-a",
        version: 1,
        createdAt: new Date(Date.now() - 31 * 60 * 1000),
      }),
    );

    await updateNote("n1", { title: "First", content: "c1" }, "token-a", deps);
    expect(state.versions).toHaveLength(2);

    await updateNote("n1", { title: "Second", content: "c2" }, "token-a", deps);

    expect(state.versions).toHaveLength(2);
  });

  it("background autosave past the threshold snapshots the previous DB content, not the incoming overwrite", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(
      makeNote({
        id: "n1",
        userId: "user-a",
        title: "Long document",
        content: "Previous hour of carefully typed content",
        updatedAt: new Date(Date.now() - 5 * 1000),
      }),
    );
    state.versions.push(
      makeVersion({
        id: "v1",
        noteId: "n1",
        userId: "user-a",
        version: 1,
        title: "Long document",
        content: "Previous hour of carefully typed content",
        createdAt: new Date(Date.now() - 31 * 60 * 1000),
      }),
    );

    // User selects all and deletes -> 5s autosave sends blank content
    const { note: updated } = await updateNote(
      "n1",
      { title: "Long document", content: "" },
      "token-a",
      deps,
    );

    // Live note must reflect the new (blank) content
    expect(updated.content).toBe("");

    // Snapshot must capture the PREVIOUS database content, not the blank overwrite
    expect(state.versions).toHaveLength(2);
    expect(state.versions[1]).toMatchObject({
      noteId: "n1",
      userId: "user-a",
      version: 2,
      title: "Long document",
      content: "Previous hour of carefully typed content",
    });
  });

  it("manual save snapshots the incoming (new) content", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(
      makeNote({
        id: "n1",
        userId: "user-a",
        title: "Live",
        content: "Live body",
        updatedAt: new Date(Date.now() - 5 * 1000),
      }),
    );
    state.versions.push(
      makeVersion({
        id: "v1",
        noteId: "n1",
        userId: "user-a",
        version: 1,
        title: "Live",
        content: "Live body",
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
      }),
    );

    const { note: updated } = await updateNote(
      "n1",
      { title: "Live", content: "brand new content", isManualSave: true },
      "token-a",
      deps,
    );

    expect(updated.content).toBe("brand new content");
    expect(state.versions).toHaveLength(2);
    expect(state.versions[1]).toMatchObject({
      noteId: "n1",
      userId: "user-a",
      version: 2,
      title: "Live",
      content: "brand new content",
    });
  });
});

describe("notes service: getNoteVersions", () => {
  it("rejects an invalid token", async () => {
    const { deps } = createFakeDeps();

    await expect(getNoteVersions("n1", "bad-token", deps)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("returns all versions for an owned note, newest first", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(makeNote({ id: "n1", userId: "user-a", title: "Doc" }));
    state.versions.push(
      makeVersion({ id: "v1", noteId: "n1", userId: "user-a", version: 1, title: "Old", content: "old body" }),
      makeVersion({ id: "v2", noteId: "n1", userId: "user-a", version: 2, title: "New", content: "new body" }),
      makeVersion({ id: "v3", noteId: "n1", userId: "user-a", version: 3, title: "Newest", content: "newest body" }),
    );

    const versions = await getNoteVersions("n1", "token-a", deps);

    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it("does not leak another user's note versions", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-b", "user-b");
    state.notes.push(makeNote({ id: "n1", userId: "user-a", title: "Private" }));
    state.versions.push(makeVersion({ id: "v1", noteId: "n1", userId: "user-a", version: 1 }));

    await expect(getNoteVersions("n1", "token-b", deps)).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );
  });
});

describe("notes service: restoreVersion", () => {
  it("rejects an invalid token", async () => {
    const { deps } = createFakeDeps();

    await expect(
      restoreVersion("n1", "v1", "bad-token", deps),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("restores a note's title/content from the version, bumps updatedAt, and appends a snapshot", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    const before = new Date("2026-01-01T00:00:00.000Z");
    const note = makeNote({ id: "n1", userId: "user-a", title: "Current", content: "current body", updatedAt: before });
    state.notes.push(note);
    state.versions.push(
      makeVersion({ id: "v1", noteId: "n1", userId: "user-a", version: 1, title: "Old title", content: "old body" }),
      makeVersion({ id: "v2", noteId: "n1", userId: "user-a", version: 2, title: "This note", content: "this body" }),
    );

    const restored = await restoreVersion("n1", "v2", "token-a", deps);

    expect(restored.title).toBe("This note");
    expect(restored.content).toBe("this body");
    expect(restored.updatedAt.getTime()).toBeGreaterThan(before.getTime());

    expect(state.versions).toHaveLength(3);
    expect(state.versions[2]).toMatchObject({
      noteId: "n1",
      userId: "user-a",
      version: 3,
      title: "This note",
      content: "this body",
    });
  });

  it("does not restore another user's note", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-b", "user-b");
    state.notes.push(makeNote({ id: "n1", userId: "user-a", title: "Private" }));
    state.versions.push(makeVersion({ id: "v1", noteId: "n1", userId: "user-a", version: 1 }));

    await expect(restoreVersion("n1", "v1", "token-b", deps)).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );

    expect(state.notes[0].title).toBe("Private");
    expect(state.versions).toHaveLength(1);
  });

  it("throws when the version does not belong to the note", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(makeNote({ id: "n1", userId: "user-a", title: "Doc" }));
    state.versions.push(makeVersion({ id: "v1", noteId: "n1", userId: "user-a", version: 1 }));
    state.versions.push(makeVersion({ id: "v-other", noteId: "other-note", userId: "user-a", version: 1 }));

    await expect(restoreVersion("n1", "v-other", "token-a", deps)).rejects.toBeInstanceOf(
      VersionNotFoundError,
    );
  });

  it("throws when the version is missing", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(makeNote({ id: "n1", userId: "user-a", title: "Doc" }));
    state.versions.push(makeVersion({ id: "v1", noteId: "n1", userId: "user-a", version: 1 }));

    await expect(restoreVersion("n1", "missing", "token-a", deps)).rejects.toBeInstanceOf(
      VersionNotFoundError,
    );
  });
});

describe("notes service: redundant save prevention", () => {
  it("autosave: short-circuits when the incoming content matches the live note", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    const note = makeNote({
      id: "n1",
      userId: "user-a",
      title: "Original",
      content: "Same body",
    });
    state.notes.push(note);
    state.versions.push(makeVersion({ id: "v1", noteId: "n1", userId: "user-a", version: 1 }));

    const { note: updated } = await updateNote(
      "n1",
      { title: "Original", content: "Same body" },
      "token-a",
      deps,
    );

    expect(updated.title).toBe("Original");
    expect(state.versions).toHaveLength(1);
  });

  it("autosave: does not update the stored updatedAt when the content is unchanged", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    const originalUpdatedAt = new Date("2026-01-01T12:00:00.000Z");
    const note = makeNote({
      id: "n1",
      userId: "user-a",
      title: "Original",
      content: "Same body",
      updatedAt: originalUpdatedAt,
    });
    state.notes.push(note);

    await updateNote(
      "n1",
      { title: "Original", content: "Same body" },
      "token-a",
      deps,
    );

    expect(state.notes[0].updatedAt.getTime()).toBe(originalUpdatedAt.getTime());
  });

  it("manual save: creates a snapshot even when incoming matches the live note but differs from the latest snapshot", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    // live note was autosaved; latest snapshot is an older state
    state.notes.push(
      makeNote({
        id: "n1",
        userId: "user-a",
        title: "Original",
        content: "Autosaved body",
      }),
    );
    state.versions.push(
      makeVersion({
        id: "v1",
        noteId: "n1",
        userId: "user-a",
        version: 1,
        title: "Original",
        content: "Older body",
      }),
    );

    await updateNote(
      "n1",
      { title: "Original", content: "Autosaved body", isManualSave: true },
      "token-a",
      deps,
    );

    expect(state.versions).toHaveLength(2);
    expect(state.versions[1]).toMatchObject({
      version: 2,
      title: "Original",
      content: "Autosaved body",
    });
  });

  it("manual save: short-circuits and creates no snapshot when incoming matches the latest snapshot", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-a", "user-a");
    state.notes.push(
      makeNote({
        id: "n1",
        userId: "user-a",
        title: "Original",
        content: "Same body",
      }),
    );
    state.versions.push(
      makeVersion({
        id: "v1",
        noteId: "n1",
        userId: "user-a",
        version: 1,
        title: "Original",
        content: "Same body",
      }),
    );

    await updateNote(
      "n1",
      { title: "Original", content: "Same body", isManualSave: true },
      "token-a",
      deps,
    );

    expect(state.versions).toHaveLength(1);
    expect(state.versions[0].version).toBe(1);
  });

  it("rejects a redundant save for a different user's note", async () => {
    const { deps, state } = createFakeDeps();
    state.sessions.set("token-b", "user-b");
    state.notes.push(
      makeNote({ id: "n1", userId: "user-a", title: "Original", content: "Same body" }),
    );

    await expect(
      updateNote(
        "n1",
        { title: "Original", content: "Same body" },
        "token-b",
        deps,
      ),
    ).rejects.toBeInstanceOf(NoteNotFoundError);
  });
});
