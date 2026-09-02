"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2, Plus } from "lucide-react"
import { toast } from "sonner"

import { createNoteAction } from "@/actions/notes"
import { Button } from "@/components/ui/button"

export function NewNoteButton() {
  const router = useRouter()
  const [isPending, startTransition] = React.useTransition()

  function handleCreate() {
    startTransition(async () => {
      const result = await createNoteAction({
        title: "Untitled note",
        content: "",
      })

      if (result.success) {
        router.push(`/notes/${result.note.id}`)
        router.refresh()
        return
      }

      toast.error(result.error)
    })
  }

  return (
    <Button onClick={handleCreate} disabled={isPending} className="w-full">
      {isPending ? (
        <Loader2 className="animate-spin" aria-hidden />
      ) : (
        <Plus aria-hidden />
      )}
      {isPending ? "Creating…" : "New note"}
    </Button>
  )
}