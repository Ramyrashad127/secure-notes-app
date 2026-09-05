import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyStatus,
  normalizeHttpRoute,
  recordAuthEvent,
  recordCacheOperation,
  recordHttpError,
  recordHttpRequest,
  recordNoteOperation,
  registry,
  safeRecord,
} from "./metrics";

describe("metrics emission", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records auth events with explicit type/status/reason labels", async () => {
    recordAuthEvent({ type: "login", status: "success", reason: "" });
    recordAuthEvent({
      type: "login",
      status: "failure",
      reason: "invalid_credentials",
    });
    recordAuthEvent({ type: "2fa", status: "failure", reason: "invalid_code" });

    const out = await registry.getSingleMetricAsString("auth_events_total");
    expect(out).toContain(
      'auth_events_total{type="login",status="success",reason=""} 1',
    );
    expect(out).toContain(
      'auth_events_total{type="login",status="failure",reason="invalid_credentials"} 1',
    );
    expect(out).toContain(
      'auth_events_total{type="2fa",status="failure",reason="invalid_code"} 1',
    );
  });

  it("records note operations including autosave failure labels", async () => {
    recordNoteOperation("create");
    recordNoteOperation("update");
    recordNoteOperation("autosave");
    recordNoteOperation("autosave_skipped");
    recordNoteOperation("autosave_failure");

    const out = await registry.getSingleMetricAsString("note_operations_total");
    expect(out).toContain('note_operations_total{operation="create"} 1');
    expect(out).toContain('note_operations_total{operation="update"} 1');
    expect(out).toContain('note_operations_total{operation="autosave"} 1');
    expect(out).toContain('note_operations_total{operation="autosave_skipped"} 1');
    expect(out).toContain('note_operations_total{operation="autosave_failure"} 1');
  });

  it("records cache hits and misses", async () => {
    recordCacheOperation("hit");
    recordCacheOperation("miss");

    const out = await registry.getSingleMetricAsString("cache_operations_total");
    expect(out).toContain('cache_operations_total{result="hit"} 1');
    expect(out).toContain('cache_operations_total{result="miss"} 1');
  });

  it("records http traffic, latency, and error rates by status class", async () => {
    recordHttpRequest({ method: "GET", route: "/", status: 200, durationSeconds: 0.01 });
    recordHttpRequest({ method: "GET", route: "/notes/:id", status: 404, durationSeconds: 0.05 });
    recordHttpRequest({ method: "POST", route: "/notes", status: 500, durationSeconds: 0.2 });

    const traffic = await registry.getSingleMetricAsString("http_requests_total");
    expect(traffic).toContain('http_requests_total{method="GET",route="/",status_class="2xx"} 1');
    expect(traffic).toContain(
      'http_requests_total{method="GET",route="/notes/:id",status_class="4xx"} 1',
    );
    expect(traffic).toContain(
      'http_requests_total{method="POST",route="/notes",status_class="5xx"} 1',
    );

    const errors = await registry.getSingleMetricAsString("http_errors_total");
    expect(errors).toContain(
      'http_errors_total{method="GET",route="/notes/:id",status_class="4xx"} 1',
    );
    expect(errors).toContain(
      'http_errors_total{method="POST",route="/notes",status_class="5xx"} 1',
    );
    expect(errors).not.toContain('route="/"');

    const latency = await registry.getSingleMetricAsString(
      "http_request_duration_seconds",
    );
    expect(latency).toContain('http_request_duration_seconds_count{method="GET",route="/",status="200"} 1');
    expect(latency).toContain('http_request_duration_seconds_sum{method="POST",route="/notes",status="500"} 0.2');
  });

  it("records server errors from onRequestError hooks", async () => {
    recordHttpError("POST", "/api/notes", 500);

    const errors = await registry.getSingleMetricAsString("http_errors_total");
    expect(errors).toContain(
      'http_errors_total{method="POST",route="/api/notes",status_class="5xx"} 1',
    );
  });
});

describe("route normalization", () => {
  it("falls back to the root path", () => {
    expect(normalizeHttpRoute("")).toBe("/");
    expect(normalizeHttpRoute("/")).toBe("/");
  });

  it("replaces uuid and numeric segments with :id", () => {
    expect(
      normalizeHttpRoute("/notes/bbc1d638-0a99-4f0b-9b99-01e1ef2d2bf6/edit"),
    ).toBe("/notes/:id/edit");
    expect(normalizeHttpRoute("/notes/42")).toBe("/notes/:id");
    expect(normalizeHttpRoute("/login")).toBe("/login");
  });
});

describe("status classification", () => {
  it("maps numeric status codes to their class", () => {
    expect(classifyStatus(200)).toBe("2xx");
    expect(classifyStatus(404)).toBe("4xx");
    expect(classifyStatus(500)).toBe("5xx");
  });
});

describe("safeRecord", () => {
  it("logs a [METRICS_ERROR] without rethrowing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      safeRecord(() => {
        throw new Error("boom");
      }),
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith("[METRICS_ERROR]", expect.any(Error));
  });
});