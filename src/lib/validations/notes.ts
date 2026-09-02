import { z } from "zod";

export const noteTitleSchema = z
  .string()
  .min(1, "Title is required")
  .max(200, "Title must be at most 200 characters");

export const noteContentSchema = z
  .string()
  .max(50_000, "Content must be at most 50,000 characters");

export const noteIdSchema = z
  .string()
  .uuid("Invalid note id");

export const createNoteSchema = z.object({
  title: noteTitleSchema,
  content: noteContentSchema,
});

export const updateNoteSchema = z.object({
  id: noteIdSchema,
  title: noteTitleSchema,
  content: noteContentSchema,
});

export const deleteNoteSchema = z.object({
  id: noteIdSchema,
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
export type DeleteNoteInput = z.infer<typeof deleteNoteSchema>;