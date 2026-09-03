export function formatVersionTimestamp(date: Date): string {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const days = Math.round((startOfToday - startOfDay) / 86_400_000);

  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;

  const day = date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${day} at ${time}`;
}