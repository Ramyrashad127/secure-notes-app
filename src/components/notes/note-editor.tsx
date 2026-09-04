"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  CheckCircle2,
  CircleAlert,
  Clock,
  Loader2,
  RotateCcw,
  Save,
} from "lucide-react"
import { toast } from "sonner"

import { restoreNoteVersionAction, updateNoteAction } from "@/actions/notes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { VersionHistory } from "@/components/notes/version-history"
import { useAutosave, type AutosavePayload } from "@/hooks/use-autosave"
import { formatVersionTimestamp } from "@/lib/date-format"
import { cn } from "@/lib/utils"
import type { Note, NoteVersion } from "@/db/schema"

const CONFLICT_MESSAGE =
  "This note was updated in another tab. Please refresh to see the latest changes."

export function NoteEditor({ note }: { note: Note }) {
  const router = useRouter()
  const [title, setTitle] = React.useState(note.title)
  const [content, setContent] = React.useState(note.content)
  const [preview, setPreview] = React.useState<NoteVersion | null>(null)
  const [isRestoring, startRestoreTransition] = React.useTransition()

  const {
    status,
    isConflict,
    save,
    lastSaveWasManual,
    isSnapshotPending,
    reconcile,
  } = useAutosave<{
    title: string
    content: string
  }>({
    noteId: note.id,
    value: { title, content },
    initialUpdatedAt: note.updatedAt,
    saveFn: async (payload: AutosavePayload) => {
      const result = await updateNoteAction(payload)
      if (!result.success) return result
      return {
        success: true,
        updatedAt: new Date(),
        snapshotCreated: result.snapshotCreated,
      }
    },
  })

  const isLocked = isConflict
  const isPreviewing = preview !== null

  const [prevNote, setPrevNote] = React.useState(note)
  if (
    prevNote !== note &&
    (prevNote.id !== note.id ||
      prevNote.title !== note.title ||
      prevNote.content !== note.content)
  ) {
    setPrevNote(note)
    setTitle(note.title)
    setContent(note.content)
    if (title !== note.title || content !== note.content) {
      reconcile({ title: note.title, content: note.content })
    }
  }

  React.useEffect(() => {
    if (isConflict) {
      toast.error(CONFLICT_MESSAGE, { id: `conflict-${note.id}` })
    }
  }, [isConflict, note.id])

  React.useEffect(() => {
    if (status === "saved" && lastSaveWasManual) {
      toast.success("Note saved", { id: `saved-${note.id}` })
    }
    if (status === "error") {
      toast.error(
        "Changes are saved on this device and will sync when you're back online.",
        { id: `autosave-error-${note.id}` },
      )
    }
  }, [status, lastSaveWasManual, note.id])

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        if (isSnapshotPending && !isLocked) {
          save({ manual: true })
        }
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [isSnapshotPending, isLocked, save])

  function handleManualSave() {
    save({ manual: true })
  }

  function cancelPreview() {
    setPreview(null)
  }

  function handleRestore() {
    if (!preview) return

    startRestoreTransition(async () => {
      const result = await restoreNoteVersionAction({
        noteId: note.id,
        versionId: preview.id,
      })

      if (!result.success) {
        toast.error(result.error)
        return
      }

      toast.success("Version restored")
      setPreview(null)
      router.refresh()
    })
  }

  if (isPreviewing) {
    return (
      <div className="flex h-full w-full flex-col gap-4 p-4 md:p-6">
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm"
        >
          <Clock className="size-4 text-muted-foreground" aria-hidden />
          <span>
            Viewing a past version from{" "}
            {formatVersionTimestamp(preview.createdAt)}
          </span>
        </div>

        <Input
          value={preview.title}
          readOnly
          disabled
          aria-label="Note title"
          className="flex-1 text-base font-semibold md:text-lg"
        />
        <Textarea
          value={preview.content}
          readOnly
          disabled
          aria-label="Note content"
          className="min-h-0 flex-1 resize-none"
        />

        <div className="flex items-center justify-end gap-2">
          <VersionHistory noteId={note.id} onSelect={setPreview} />
          <Button variant="outline" onClick={cancelPreview}>
            Cancel
          </Button>
          <Button onClick={handleRestore} disabled={isRestoring}>
            {isRestoring ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <RotateCcw aria-hidden />
            )}
            {isRestoring ? "Restoring…" : "Restore this version"}
          </Button>
        </div>
      </div>
    )
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
          disabled={isLocked}
        />
      </div>
      <Textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder="Write something…"
        aria-label="Note content"
        className="min-h-0 flex-1 resize-none"
        disabled={isLocked}
      />
      <div className="flex items-center justify-end gap-2">
        <AutosaveIndicator status={status} />
        <VersionHistory noteId={note.id} onSelect={setPreview} />
        <Button
          onClick={handleManualSave}
          disabled={isLocked || !isSnapshotPending}
        >
          <Save aria-hidden />
          Save
        </Button>
      </div>
    </div>
  )
}

function AutosaveIndicator({ status }: { status: string }) {
  if (status === "saving") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Saving…
      </span>
    )
  }

  if (status === "saved") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <CheckCircle2 className="size-3.5 text-emerald-500" aria-hidden />
        Saved
      </span>
    )
  }

  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-destructive">
        <CircleAlert className="size-3.5" aria-hidden />
        Offline changes saved locally
      </span>
    )
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm text-muted-foreground",
      )}
      aria-live="polite"
    >
      Idle
    </span>
  )
}