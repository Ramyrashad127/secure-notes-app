"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import QRCode from "qrcode"
import { Loader2, ShieldCheck, ShieldOff } from "lucide-react"
import { toast } from "sonner"

import {
  disable2FA,
  initiate2FASetup,
  verifyAndEnable2FA,
} from "@/actions/auth-2fa"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type TwoFactorStatus = "disabled" | "setup" | "verify" | "enabled";

export function TwoFactorSettings({ enabled }: { enabled: boolean }) {
  const router = useRouter()
  const [status, setStatus] = React.useState<TwoFactorStatus>(
    enabled ? "enabled" : "disabled",
  )
  const [uri, setUri] = React.useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null)
  const [secret, setSecret] = React.useState<string | null>(null)
  const [code, setCode] = React.useState("")
  const [disablePassword, setDisablePassword] = React.useState("")
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[] | null>(null)
  const [isPending, startTransition] = React.useTransition()

  React.useEffect(() => {
    if (!uri) return
    let cancelled = false
    QRCode.toDataURL(uri, { width: 200, margin: 1 })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl)
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [uri])

  function handleEnable() {
    startTransition(async () => {
      const result = await initiate2FASetup()
      if (!result.success) {
        toast.error(result.error)
        return
      }
      setUri(result.uri)
      setSecret(result.secret)
      setStatus("verify")
    })
  }

  function handleVerify() {
    startTransition(async () => {
      const result = await verifyAndEnable2FA(code)
      if (!result.success) {
        toast.error(result.error)
        return
      }
      setRecoveryCodes(result.recoveryCodes)
      setStatus("enabled")
      toast.success("Two-factor authentication enabled")
      router.refresh()
    })
  }

  function handleDisable() {
    startTransition(async () => {
      const result = await disable2FA(disablePassword)
      if (!result.success) {
        toast.error(result.error)
        return
      }
      setStatus("disabled")
      setUri(null)
      setSecret(null)
      setRecoveryCodes(null)
      setDisablePassword("")
      toast.success("Two-factor authentication disabled")
      router.refresh()
    })
  }

  if (status === "enabled" && recoveryCodes) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recovery codes</CardTitle>
          <CardDescription>
            These codes will only be shown once. Store them somewhere safe.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {recoveryCodes.map((codeItem) => (
              <li
                key={codeItem}
                className="rounded-md bg-muted px-3 py-2 font-mono text-sm"
              >
                {codeItem}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-amber-600">
            Save these codes now. They are not shown again.
          </p>
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => {
              setRecoveryCodes(null)
              router.refresh()
            }}
          >
            I&apos;ve saved my codes
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (status === "enabled") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-emerald-500" aria-hidden />
            Two-factor authentication
          </CardTitle>
          <CardDescription>
            Your account is protected with an authenticator app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DisableTwoFactorDialog
            onConfirm={handleDisable}
            isPending={isPending}
            password={disablePassword}
            onPasswordChange={setDisablePassword}
          />
        </CardContent>
      </Card>
    )
  }

  if (status === "verify") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Scan the QR code</CardTitle>
          <CardDescription>
            Scan this code with your authenticator app, then enter the 6-digit
            code it generates to confirm.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {qrDataUrl ? (
            <div className="flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrDataUrl}
                alt="QR code for your authenticator app"
                width={200}
                height={200}
                className="rounded-md border"
              />
            </div>
          ) : null}
          {secret ? (
            <p className="text-center text-sm text-muted-foreground">
              Can&apos;t scan? Enter this code manually:{" "}
              <code className="font-mono">{secret}</code>
            </p>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="2fa-code">6-digit verification code</Label>
            <Input
              id="2fa-code"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={isPending}
            />
          </div>
          <Button
            className="w-full"
            onClick={handleVerify}
            disabled={isPending || code.length !== 6}
          >
            {isPending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : null}
            {isPending ? "Verifying…" : "Verify and enable"}
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldOff className="size-5 text-muted-foreground" aria-hidden />
          Two-factor authentication
        </CardTitle>
        <CardDescription>
          Add an extra layer of security to your account with an authenticator
          app.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={handleEnable} disabled={isPending}>
          {isPending ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : null}
          {isPending ? "Starting…" : "Enable 2FA"}
        </Button>
      </CardContent>
    </Card>
  )
}

function DisableTwoFactorDialog({
  onConfirm,
  isPending,
  password,
  onPasswordChange,
}: {
  onConfirm: () => void
  isPending: boolean
  password: string
  onPasswordChange: (value: string) => void
}) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button variant="destructive" className="w-full">
            <ShieldOff aria-hidden />
            Disable 2FA
          </Button>
        }
      >
        Disable 2FA
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disable two-factor authentication?</DialogTitle>
          <DialogDescription>
            Your recovery codes will be invalidated and you will only need your
            password to sign in.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="2fa-disable-password">Current password</Label>
          <Input
            id="2fa-disable-password"
            type="password"
            autoComplete="current-password"
            placeholder="Enter your password to confirm"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            disabled={isPending}
          />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isPending || !password}
          >
            {isPending ? "Disabling…" : "Disable 2FA"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}