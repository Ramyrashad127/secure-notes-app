import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { notes } from "./notes";
import { users } from "./users";

export const noteVersions = pgTable(
  "note_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("note_versions_note_id_version_idx").on(
      table.noteId,
      table.version,
    ),
    index("note_versions_note_id_idx").on(table.noteId),
    index("note_versions_user_id_idx").on(table.userId),
  ],
);

export type NoteVersion = InferSelectModel<typeof noteVersions>;
export type NewNoteVersion = InferInsertModel<typeof noteVersions>;