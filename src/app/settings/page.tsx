import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { TwoFactorSettings } from "@/components/settings/two-factor-settings";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getCurrentUser } from "@/lib/auth/auth-service";

export default async function SettingsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const user = token ? await getCurrentUser(token) : null;

  if (!user) redirect("/login");

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Manage your account security.
          </p>
        </div>
        <TwoFactorSettings enabled={user.twoFactorEnabled} />
      </div>
    </div>
  );
}