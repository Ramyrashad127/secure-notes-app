import { type Instrumentation } from "next";

export function register() {
  // No-op: the metrics registry is initialized lazily by the app entry
  // (src/lib/metrics). Nothing here touches Node-only modules so the Edge
  // bundle of this file compiles cleanly.
}

export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  void err;
  void context;

  // `src/lib/metrics` registers prom-client collectors and reads process
  // internals, so it must only be loaded in the Node.js runtime. The dynamic
  // import keeps it out of the Edge bundle entirely (Edge just no-ops).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { normalizeHttpRoute, recordHttpError } = await import("@/lib/metrics");
    recordHttpError(
      request.method.toUpperCase(),
      normalizeHttpRoute(request.path.split("?")[0] ?? "/"),
      500,
    );
  } catch {
    // Instrumentation must never break request handling.
  }
};