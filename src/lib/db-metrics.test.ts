import { beforeEach, describe, expect, it } from "vitest";

import { classifyStatement, instrumentPostgres } from "./db-metrics";
import { registry } from "./metrics";

function postgresLikeThenable(rows: unknown[]): Promise<unknown> & {
  values(): Promise<unknown[]>;
  describe(): Promise<unknown>;
  execute(): unknown;
} {
  const base = Promise.resolve().then(() => rows);
  return Object.assign(base, {
    values() {
      return Promise.resolve(rows);
    },
    describe() {
      return Promise.resolve({});
    },
    execute() {
      return postgresLikeThenable(rows);
    },
  });
}

function createFakeClient() {
  const calls: { query: string; params?: unknown[] }[] = [];
  const client = {
    calls,
    options: { max: 10 },
    unsafe(query: string, params?: unknown[]) {
      calls.push({ query, params });
      return postgresLikeThenable([{ active: 1 }]);
    },
  };
  return client;
}

describe("classifyStatement", () => {
  it.each([
    ["SELECT * FROM users", "select"],
    ["  with cte as (select 1) select * from cte", "select"],
    ["INSERT INTO notes (id) VALUES ($1)", "insert"],
    ["UPDATE notes SET title = $1", "update"],
    ["DELETE FROM notes WHERE id = $1", "delete"],
    ["TRUNCATE sessions", "delete"],
    ["BEGIN", "other"],
  ])("classifies %j as %s", (query, expected) => {
    expect(classifyStatement(query)).toBe(expected);
  });
});

describe("instrumentPostgres", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  it("times and labels a successful query awaited through client.unsafe", async () => {
    const client = createFakeClient();
    const wrapped = instrumentPostgres(client);

    const result = await wrapped.unsafe("SELECT count(*) FROM notes", []);

    expect(client.calls).toHaveLength(1);
    expect(result).toEqual([{ active: 1 }]);

    const duration = await registry.getSingleMetricAsString(
      "db_query_duration_seconds",
    );
    expect(duration).toContain('db_query_duration_seconds_count{statement="select",status="success"} 1');

    const total = await registry.getSingleMetricAsString("db_queries_total");
    expect(total).toContain('db_queries_total{statement="select",status="success"} 1');
  });

  it("preserves the chainable postgres API used by drizzle (.values)", async () => {
    const client = createFakeClient();
    const wrapped = instrumentPostgres(client);

    const rows = await wrapped
      .unsafe("INSERT INTO notes (title) VALUES ($1)", ["x"])
      .values();

    expect(rows).toEqual([{ active: 1 }]);

    const total = await registry.getSingleMetricAsString("db_queries_total");
    expect(total).toContain('db_queries_total{statement="insert",status="success"} 1');
  });

  it("records an error status when the query throws, and rethrows", async () => {
    const client = createFakeClient();
    client.unsafe = () =>
      Promise.reject(new Error("connection lost")) as unknown as ReturnType<
        typeof client.unsafe
      >;
    const wrapped = instrumentPostgres(client);

    await expect(wrapped.unsafe("SELECT 1", [])).rejects.toThrow(
      "connection lost",
    );

    const total = await registry.getSingleMetricAsString("db_queries_total");
    expect(total).toContain('db_queries_total{statement="select",status="error"} 1');
  });

  it("returns in-flight gauge to zero after a query completes", async () => {
    const client = createFakeClient();
    const wrapped = instrumentPostgres(client);

    await wrapped.unsafe("UPDATE notes SET content = $1", ["x"]);

    const gauge = await registry.getSingleMetricAsString("db_queries_in_flight");
    expect(gauge).toContain('db_queries_in_flight{statement="update"} 0');
  });

  it("passes through property access and options mutations", () => {
    const client = createFakeClient();
    const wrapped = instrumentPostgres(client) as typeof client;

    (wrapped.options as { max: number }).max = 5;
    expect(client.options.max).toBe(5);
    expect(wrapped.calls).toBe(client.calls);
  });
});