"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { LogOut, Settings as SettingsIcon, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { logoutAction } from "@/actions/auth"
import { deleteNoteAction } from "@/actions/notes"
import { NewNoteButton } from "@/components/notes/new-note-button"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { Note } from "@/db/schema"

export function NoteList({ notes }: { notes: Note[] }) {
  const pathname = usePathname()
  const router = useRouter()
  const [isLoggingOut, startLogoutTransition] = React.useTransition()

  function handleLogout() {
    startLogoutTransition(async () => {
      const result = await logoutAction()

      if (!result.success) {
        toast.error(result.error)
        return
      }

      router.push("/login")
      router.refresh()
    })
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <NewNoteButton />
      <ScrollArea className="min-h-0 flex-1">
        {notes.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            No notes yet. Create your first one.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {notes.map((note) => (
              <NoteListItem
                key={note.id}
                note={note}
                active={pathname === `/notes/${note.id}`}
              />
            ))}
          </ul>
        )}
      </ScrollArea>
      <div className="flex flex-col gap-1">
        <Link
          href="/settings"
          className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <SettingsIcon aria-hidden className="size-4" />
          Settings
        </Link>
        <Button
          variant="ghost"
          className="justify-start gap-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={handleLogout}
          disabled={isLoggingOut}
        >
          <LogOut aria-hidden className="size-4" />
          {isLoggingOut ? "Logging out…" : "Log out"}
        </Button>
      </div>
    </div>
  )
}

function NoteListItem({ note, active }: { note: Note; active: boolean }) {
  return (
    <li className="group flex items-center gap-1">
      <Link
        href={`/notes/${note.id}`}
        className={cn(
          "flex-1 truncate rounded-md px-2 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          active
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
      >
        {note.title || "Untitled note"}
      </Link>
      <DeleteNoteDialog noteId={note.id} title={note.title} />
    </li>
  )
}

function DeleteNoteDialog({
  noteId,
  title,
}: {
  noteId: string
  title: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = React.useTransition()
  const [open, setOpen] = React.useState(false)

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteNoteAction({ id: noteId })

      if (!result.success) {
        toast.error(result.error)
        return
      }

      toast.success("Note deleted")
      setOpen(false)
      router.push("/notes")
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
          />
        }
      >
        <Trash2 aria-hidden className="size-3.5" />
        <span className="sr-only">Delete {title}</span>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete note?</DialogTitle>
          <DialogDescription>
            &ldquo;{title || "Untitled note"}&rdquo; will be permanently deleted
            and cannot be recovered.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isPending}
          >
            {isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}