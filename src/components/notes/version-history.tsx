"use client"

import * as React from "react"
import { History, Loader2 } from "lucide-react"

import { getNoteVersionsAction } from "@/actions/notes"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { formatVersionTimestamp } from "@/lib/date-format"
import type { NoteVersion } from "@/db/schema"

interface VersionHistoryProps {
  noteId: string
  onSelect: (version: NoteVersion) => void
}

export function VersionHistory({ noteId, onSelect }: VersionHistoryProps) {
  const [open, setOpen] = React.useState(false)
  const [versions, setVersions] = React.useState<NoteVersion[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen) {
      setVersions(null)
      setError(null)
    }
  }

  React.useEffect(() => {
    if (!open) return;

    let cancelled = false;

    getNoteVersionsAction(noteId).then((result) => {
      if (cancelled) return;
      if (result.success) {
        setVersions(result.versions);
      } else {
        setError(result.error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open, noteId]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={<Button variant="outline" />}
      >
        <History aria-hidden />
        History
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Version History</DialogTitle>
          <DialogDescription>
            Select a past version to preview it. You can restore it from the
            editor.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : versions === null ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin" aria-hidden />
            <span className="sr-only">Loading versions</span>
          </div>
        ) : versions.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No versions saved yet.
          </p>
        ) : (
          <ScrollArea className="max-h-80">
            <ul className="flex flex-col gap-1">
              {versions.map((version) => (
                <li key={version.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onSelect(version);
                    }}
                    className="flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <span className="text-sm font-medium">
                      Version {version.version}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatVersionTimestamp(version.createdAt)}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {version.title || "Untitled note"} —{" "}
                      {version.content.slice(0, 60) || "Empty"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  )
}