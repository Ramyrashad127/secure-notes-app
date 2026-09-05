import { type Instrumentation } from "next";

import { normalizeHttpRoute, recordHttpError } from "@/lib/metrics";

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Metrics are initialized lazily by the app entry (src/lib/metrics).
    // Hook here keeps startup observers available for the whole server.
  }
}

function routeOf(path: string): string {
  return normalizeHttpRoute(path.split("?")[0] ?? "/");
}

export const onRequestError: Instrumentation.onRequestError = (
  err,
  request,
  context,
) => {
  void err;
  void context;
  recordHttpError(request.method.toUpperCase(), routeOf(request.path), 500);
};