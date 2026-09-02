import { cookies } from "next/headers";

import { NoteList } from "@/components/notes/note-list";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { listNotes } from "@/lib/notes/notes-service";

export default async function NotesLayout({
  children,
}: LayoutProps<"/notes">) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const notes = token ? await listNotes(token) : [];

  return (
    <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
      <aside className="max-h-56 w-full shrink-0 border-b bg-background md:max-h-none md:max-w-64 md:flex-1 md:border-r md:border-b-0">
        <NoteList notes={notes} />
      </aside>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}