"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"

import { consumeRecoveryCode, verifyLoginChallenge } from "@/actions/auth-2fa"
import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"

export function TwoFactorChallengeForm() {
  const router = useRouter()
  const [mode, setMode] = React.useState<"totp" | "recovery">("totp")
  const [isPending, startTransition] = React.useTransition()

  const form = useForm<{ code: string }>({
    defaultValues: { code: "" },
  })

  function onSubmit(values: { code: string }) {
    startTransition(async () => {
      const result =
        mode === "totp"
          ? await verifyLoginChallenge(values.code)
          : await consumeRecoveryCode(values.code)

      if (result.success) {
        toast.success("Welcome back!")
        router.push("/notes")
        router.refresh()
        return
      }

      form.setError("root", { message: result.error })
      toast.error(result.error)
    })
  }

  return (
    <div className="space-y-5">
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        <button
          type="button"
          onClick={() => {
            setMode("totp")
            form.clearErrors()
          }}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            mode === "totp"
              ? "bg-background shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Authenticator code
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("recovery")
            form.clearErrors()
          }}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            mode === "recovery"
              ? "bg-background shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Recovery code
        </button>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
          {form.formState.errors.root?.message ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {form.formState.errors.root.message}
            </p>
          ) : null}

          <FormField
            control={form.control}
            name="code"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {mode === "totp"
                    ? "Enter the 6-digit code from your authenticator app"
                    : "Enter a recovery code"}
                </FormLabel>
                <FormControl>
                  <Input
                    inputMode={mode === "totp" ? "numeric" : "text"}
                    autoComplete={mode === "totp" ? "one-time-code" : "off"}
                    placeholder={
                      mode === "totp" ? "000000" : "XXXX-XXXX-XXXX-XXXX"
                    }
                    maxLength={mode === "totp" ? 6 : 19}
                    disabled={isPending}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : null}
            {isPending ? "Verifying…" : "Verify"}
          </Button>
        </form>
      </Form>
    </div>
  )
}