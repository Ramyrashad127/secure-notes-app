import { notFound } from "next/navigation";
import { cookies } from "next/headers";

import { NoteEditor } from "@/components/notes/note-editor";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getNote } from "@/lib/notes/notes-service";

export default async function NotePage({
  params,
}: {
  params: Promise<{ noteId: string }>;
}) {
  const { noteId } = await params;

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const note = token ? await getNote(noteId, token) : null;

  if (!note) notFound();

  return <NoteEditor note={note} />;
}