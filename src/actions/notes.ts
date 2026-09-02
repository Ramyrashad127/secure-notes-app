"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import type { Note } from "@/db/schema";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  NoteNotFoundError,
  UnauthorizedError,
  updateNote,
} from "@/lib/notes/notes-service";
import {
  createNoteSchema,
  deleteNoteSchema,
  noteIdSchema,
  updateNoteSchema,
  type CreateNoteInput,
  type UpdateNoteInput,
} from "@/lib/validations/notes";

export type NoteActionResult =
  | { success: true }
  | { success: false; error: string };

export type CreateNoteActionResult =
  | { success: true; note: Note }
  | { success: false; error: string };

export type GetNoteActionResult =
  | { success: true; note: Note }
  | { success: false; error: string };

export type ListNotesActionResult =
  | { success: true; notes: Note[] }
  | { success: false; error: string };

async function getSessionToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
}

function noteActionError(error: unknown): { success: false; error: string } {
  if (error instanceof UnauthorizedError) {
    return { success: false, error: error.message };
  }
  if (error instanceof NoteNotFoundError) {
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
    await updateNote(
      parsed.id,
      { title: parsed.title, content: parsed.content },
      token,
    );
    return { success: true };
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