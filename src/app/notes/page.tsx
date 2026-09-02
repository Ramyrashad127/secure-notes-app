export default function NotesIndexPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">
        Welcome to your notes
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Select a note from the sidebar, or create a new one to get started.
      </p>
    </div>
  );
}