import { describe, expect, it } from "vitest";
import {
  createNoteSchema,
  deleteNoteSchema,
  noteContentSchema,
  noteIdSchema,
  noteTitleSchema,
  restoreVersionSchema,
  updateNoteSchema,
} from "./notes";

describe("noteTitleSchema", () => {
  it("accepts a non-empty title", () => {
    expect(noteTitleSchema.safeParse("Shopping list").success).toBe(true);
  });

  it("rejects an empty title", () => {
    const result = noteTitleSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects a title over 200 characters", () => {
    const result = noteTitleSchema.safeParse("a".repeat(201));
    expect(result.success).toBe(false);
  });

  it("accepts a title of exactly 200 characters", () => {
    expect(noteTitleSchema.safeParse("a".repeat(200)).success).toBe(true);
  });
});

describe("noteContentSchema", () => {
  it("accepts empty content", () => {
    expect(noteContentSchema.safeParse("").success).toBe(true);
  });

  it("accepts plain text content", () => {
    expect(noteContentSchema.safeParse("Meet Alice at noon.").success).toBe(true);
  });

  it("rejects content over 50,000 characters", () => {
    const result = noteContentSchema.safeParse("a".repeat(50_001));
    expect(result.success).toBe(false);
  });
});

describe("noteIdSchema", () => {
  it("accepts a valid uuid", () => {
    expect(
      noteIdSchema.safeParse("6f1ef1e8-3b0c-4a2d-9c7e-8b8f8f8f8f8f").success,
    ).toBe(true);
  });

  it("rejects a non-uuid string", () => {
    const result = noteIdSchema.safeParse("not-a-uuid");
    expect(result.success).toBe(false);
  });
});

describe("createNoteSchema", () => {
  it("accepts valid input", () => {
    expect(
      createNoteSchema.safeParse({ title: "Title", content: "Body" }).success,
    ).toBe(true);
  });

  it("accepts empty content", () => {
    expect(
      createNoteSchema.safeParse({ title: "Title", content: "" }).success,
    ).toBe(true);
  });

  it("rejects a missing title", () => {
    const result = createNoteSchema.safeParse({ content: "Body" });
    expect(result.success).toBe(false);
  });
});

describe("updateNoteSchema", () => {
  it("accepts valid input", () => {
    expect(
      updateNoteSchema.safeParse({
        id: "6f1ef1e8-3b0c-4a2d-9c7e-8b8f8f8f8f8f",
        title: "Title",
        content: "Body",
      }).success,
    ).toBe(true);
  });

  it("rejects an invalid id", () => {
    const result = updateNoteSchema.safeParse({
      id: "nope",
      title: "Title",
      content: "Body",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an ISO string clientUpdatedAt and parses it to a Date", () => {
    const result = updateNoteSchema.safeParse({
      id: "6f1ef1e8-3b0c-4a2d-9c7e-8b8f8f8f8f8f",
      title: "Title",
      content: "Body",
      clientUpdatedAt: "2026-01-02T12:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clientUpdatedAt).toBeInstanceOf(Date);
      expect(result.data.clientUpdatedAt?.toISOString()).toBe(
        "2026-01-02T12:00:00.000Z",
      );
    }
  });

  it("accepts a Date clientUpdatedAt", () => {
    const result = updateNoteSchema.safeParse({
      id: "6f1ef1e8-3b0c-4a2d-9c7e-8b8f8f8f8f8f",
      title: "Title",
      content: "Body",
      clientUpdatedAt: new Date("2026-01-02T12:00:00.000Z"),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clientUpdatedAt).toBeInstanceOf(Date);
    }
  });

  it("rejects an invalid clientUpdatedAt string", () => {
    const result = updateNoteSchema.safeParse({
      id: "6f1ef1e8-3b0c-4a2d-9c7e-8b8f8f8f8f8f",
      title: "Title",
      content: "Body",
      clientUpdatedAt: "not-a-date",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an isManualSave boolean", () => {
    const result = updateNoteSchema.safeParse({
      id: "6f1ef1e8-3b0c-4a2d-9c7e-8b8f8f8f8f8f",
      title: "Title",
      content: "Body",
      isManualSave: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isManualSave).toBe(true);
    }
  });

  it("rejects a non-boolean isManualSave", () => {
    const result = updateNoteSchema.safeParse({
      id: "6f1ef1e8-3b0c-4a2d-9c7e-8b8f8f8f8f8f",
      title: "Title",
      content: "Body",
      isManualSave: "yes",
    });
    expect(result.success).toBe(false);
  });
});

describe("deleteNoteSchema", () => {
  it("accepts a valid id", () => {
    expect(
      deleteNoteSchema.safeParse({
        id: "6f1ef1e8-3b0c-4a2d-9c7e-8b8f8f8f8f8f",
      }).success,
    ).toBe(true);
  });

  it("rejects an invalid id", () => {
    expect(deleteNoteSchema.safeParse({ id: "x" }).success).toBe(false);
  });
});

describe("restoreVersionSchema", () => {
  it("accepts valid noteId and versionId", () => {
    expect(
      restoreVersionSchema.safeParse({
        noteId: "6f1ef1e8-3b0c-4a2d-9c7e-8b8f8f8f8f8f",
        versionId: "6f1ef1e8-3b0c-4a2d-9c7e-8b8f8f8f8f8f",
      }).success,
    ).toBe(true);
  });

  it("rejects an invalid versionId", () => {
    const result = restoreVersionSchema.safeParse({
      noteId: "6f1ef1e8-3b0c-4a2d-9c7e-8b8f8f8f8f8f",
      versionId: "nope",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing noteId", () => {
    expect(
      restoreVersionSchema.safeParse({
        versionId: "6f1ef1e8-3b0c-4a2d-9c7e-8b8f8f8f8f8f",
      }).success,
    ).toBe(false);
  });
});