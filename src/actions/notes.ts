"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
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
} from "@/lib/notes/notes-service";
import {
  createNoteSchema,
  deleteNoteSchema,
  noteIdSchema,
  restoreVersionSchema,
  updateNoteSchema,
  type CreateNoteInput,
  type RestoreVersionInput,
  type UpdateNoteInput,
} from "@/lib/validations/notes";
import { CONFLICT_ERROR } from "@/lib/notes/conflict";

export type NoteActionResult =
  | { success: true; snapshotCreated?: boolean }
  | { success: false; error: string; message?: string };

/** Payload returned when a save conflicts with a newer server-side update. */
export type NoteConflictResult = {
  success: false;
  error: typeof CONFLICT_ERROR;
  message: string;
};

export type CreateNoteActionResult =
  | { success: true; note: Note }
  | { success: false; error: string };

export type GetNoteActionResult =
  | { success: true; note: Note }
  | { success: false; error: string };

export type ListNotesActionResult =
  | { success: true; notes: Note[] }
  | { success: false; error: string };

export type GetNoteVersionsActionResult =
  | { success: true; versions: NoteVersion[] }
  | { success: false; error: string };

export type RestoreVersionActionResult = NoteActionResult;

async function getSessionToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
}

function noteActionError(
  error: unknown,
): { success: false; error: string; message?: string } {
  if (error instanceof ConflictError) {
    return { success: false, error: CONFLICT_ERROR, message: error.message };
  }
  if (
    error instanceof UnauthorizedError ||
    error instanceof NoteNotFoundError ||
    error instanceof VersionNotFoundError
  ) {
    return { success: false, error: error.message };
  }
  return { success: false, error: "Something went wrong. Please try again." };
}

export async function createNoteAction(
  input: CreateNoteInput,
): Promise<CreateNoteActionResult> {
  let parsed;
  try {
    parsed = createNoteSchema.parse(input);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues[0]?.message ?? "Invalid input"
        : "Invalid input";
    return { success: false, error: message };
  }

  const token = await getSessionToken();
  if (!token) return { success: false, error: "You must be signed in to do that" };

  try {
    const note = await createNote(parsed, token);
    return { success: true, note };
  } catch (error) {
    return noteActionError(error);
  }
}

export async function updateNoteAction(
  input: UpdateNoteInput,
): Promise<NoteActionResult> {
  let parsed;
  try {
    parsed = updateNoteSchema.parse(input);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues[0]?.message ?? "Invalid input"
        : "Invalid input";
    return { success: false, error: message };
  }

  const token = await getSessionToken();
  if (!token) return { success: false, error: "You must be signed in to do that" };

  try {
    const { note, snapshotCreated } = await updateNote(
      parsed.id,
      {
        title: parsed.title,
        content: parsed.content,
        clientUpdatedAt: parsed.clientUpdatedAt,
        isManualSave: parsed.isManualSave,
      },
      token,
    );
    revalidatePath(`/notes/${note.id}`);
    revalidatePath("/notes", "layout");
    return { success: true, snapshotCreated };
  } catch (error) {
    return noteActionError(error);
  }
}

export async function deleteNoteAction(
  input: { id: string },
): Promise<NoteActionResult> {
  let parsed;
  try {
    parsed = deleteNoteSchema.parse(input);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues[0]?.message ?? "Invalid input"
        : "Invalid input";
    return { success: false, error: message };
  }

  const token = await getSessionToken();
  if (!token) return { success: false, error: "You must be signed in to do that" };

  try {
    await deleteNote(parsed.id, token);
    return { success: true };
  } catch (error) {
    return noteActionError(error);
  }
}

export async function listNotesAction(): Promise<ListNotesActionResult> {
  const token = await getSessionToken();
  if (!token) return { success: false, error: "You must be signed in to do that" };

  try {
    const notes = await listNotes(token);
    return { success: true, notes };
  } catch (error) {
    return noteActionError(error);
  }
}

export async function getNoteAction(
  noteId: string,
): Promise<GetNoteActionResult> {
  let parsed;
  try {
    parsed = noteIdSchema.parse(noteId);
  } catch {
    return { success: false, error: "Invalid note id" };
  }

  const token = await getSessionToken();
  if (!token) return { success: false, error: "You must be signed in to do that" };

  try {
    const note = await getNote(parsed, token);
    if (!note) return { success: false, error: "Note not found" };
    return { success: true, note };
  } catch (error) {
    return noteActionError(error);
  }
}

export async function getNoteVersionsAction(
  noteId: string,
): Promise<GetNoteVersionsActionResult> {
  let parsed;
  try {
    parsed = noteIdSchema.parse(noteId);
  } catch {
    return { success: false, error: "Invalid note id" };
  }

  const token = await getSessionToken();
  if (!token) return { success: false, error: "You must be signed in to do that" };

  try {
    const versions = await getNoteVersions(parsed, token);
    return { success: true, versions };
  } catch (error) {
    return noteActionError(error);
  }
}

export async function restoreNoteVersionAction(
  input: RestoreVersionInput,
): Promise<RestoreVersionActionResult> {
  let parsed;
  try {
    parsed = restoreVersionSchema.parse(input);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues[0]?.message ?? "Invalid input"
        : "Invalid input";
    return { success: false, error: message };
  }

  const token = await getSessionToken();
  if (!token) return { success: false, error: "You must be signed in to do that" };

  try {
    const updated = await restoreVersion(parsed.noteId, parsed.versionId, token);
    revalidatePath(`/notes/${updated.id}`);
    revalidatePath("/notes", "layout");
    return { success: true };
  } catch (error) {
    return noteActionError(error);
  }
}