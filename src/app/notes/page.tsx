import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Your Notes | Secure Notes",
};

export default function NotesPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Your Notes</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          This is where your secure notes will live. Note management is coming
          in a later ticket.
        </p>
      </div>
      <Link
        href="/"
        className="text-sm text-primary underline-offset-4 hover:underline"
      >
        Back home
      </Link>
    </div>
  );
}