import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  envBackup.METRICS_TOKEN = process.env.METRICS_TOKEN;
  envBackup.METRICS_BEARER_TOKEN = process.env.METRICS_BEARER_TOKEN;
  process.env.METRICS_TOKEN = "test-secret-token";
  delete process.env.METRICS_BEARER_TOKEN;
});

afterEach(() => {
  process.env.METRICS_TOKEN = envBackup.METRICS_TOKEN;
  process.env.METRICS_BEARER_TOKEN = envBackup.METRICS_BEARER_TOKEN;
  vi.restoreAllMocks();
});

async function importRouteModule() {
  return import("./route");
}

describe("/api/metrics authorization", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const { GET } = await importRouteModule();
    const res = await GET(new Request("http://localhost/api/metrics"));

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("returns 401 when the token does not match", async () => {
    const { GET } = await importRouteModule();
    const res = await GET(
      new Request("http://localhost/api/metrics", {
        headers: { authorization: "Bearer wrong-token" },
      }),
    );

    expect(res.status).toBe(401);
  });

  it("returns 401 for a non-Bearer scheme", async () => {
    const { GET } = await importRouteModule();
    const res = await GET(
      new Request("http://localhost/api/metrics", {
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      }),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("returns 401 when the server token is not configured", async () => {
    delete process.env.METRICS_TOKEN;
    const { GET } = await importRouteModule();
    const res = await GET(
      new Request("http://localhost/api/metrics", {
        headers: { authorization: "Bearer any-token" },
      }),
    );

    expect(res.status).toBe(401);
  });

  it("returns 200 with Prometheus text content when the token matches", async () => {
    const { GET } = await importRouteModule();
    const res = await GET(
      new Request("http://localhost/api/metrics", {
        headers: { authorization: "Bearer test-secret-token" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("# HELP");
    expect(body).toContain("process_cpu");
  });

  it("accepts a token from the fallback METRICS_BEARER_TOKEN env", async () => {
    delete process.env.METRICS_TOKEN;
    process.env.METRICS_BEARER_TOKEN = "fallback-token";
    const { GET } = await importRouteModule();

    const denied = await GET(
      new Request("http://localhost/api/metrics", {
        headers: { authorization: "Bearer nope" },
      }),
    );
    expect(denied.status).toBe(401);

    const allowed = await GET(
      new Request("http://localhost/api/metrics", {
        headers: { authorization: "Bearer fallback-token" },
      }),
    );
    expect(allowed.status).toBe(200);
  });
});