"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2, Save } from "lucide-react"
import { toast } from "sonner"

import { updateNoteAction } from "@/actions/notes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { Note } from "@/db/schema"

export function NoteEditor({ note }: { note: Note }) {
  const router = useRouter()
  const [title, setTitle] = React.useState(note.title)
  const [content, setContent] = React.useState(note.content)
  const [isPending, startTransition] = React.useTransition()

  const isDirty = title !== note.title || content !== note.content

  function handleSave() {
    startTransition(async () => {
      const result = await updateNoteAction({
        id: note.id,
        title,
        content,
      })

      if (!result.success) {
        toast.error(result.error)
        return
      }

      toast.success("Note saved")
      router.refresh()
    })
  }

  return (
    <div className="flex h-full w-full flex-col gap-4 p-4 md:p-6">
      <div className="flex items-center gap-2">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Note title"
          aria-label="Note title"
          className="flex-1 text-base font-semibold md:text-lg"
          disabled={isPending}
        />
      </div>
      <Textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder="Write something…"
        aria-label="Note content"
        className="min-h-0 flex-1 resize-none"
        disabled={isPending}
      />
      <div className="flex items-center justify-end gap-2">
        <Button onClick={handleSave} disabled={isPending || !isDirty}>
          {isPending ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Save aria-hidden />
          )}
          {isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  )
}