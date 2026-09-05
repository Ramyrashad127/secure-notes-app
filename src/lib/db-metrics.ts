import {
  decDbQueriesInFlight,
  incDbQueriesInFlight,
  recordDbQuery,
  type DbStatement,
} from "@/lib/metrics";

/** Classify the leading statement keyword of a SQL string into a low-cardinality label. */
export function classifyStatement(query: string): DbStatement {
  const head = query.replace(/^\s*\(?\s*/, "").toLowerCase();
  if (/^(select|with)\b/.test(head)) return "select";
  if (/^insert\b/.test(head)) return "insert";
  if (/^update\b/.test(head)) return "update";
  if (/^(delete|truncate)\b/.test(head)) return "delete";
  return "other";
}

interface TimingState {
  statement: DbStatement;
  startedAt: number;
  finished: boolean;
}

function finishTiming(state: TimingState, status: "success" | "error"): void {
  if (state.finished) return;
  state.finished = true;
  recordDbQuery(state.statement, status, (performance.now() - state.startedAt) / 1000);
  decDbQueriesInFlight(state.statement);
}

/**
 * Wrap a postgres.js query thenable so that promise settlement, `.values()`,
 * `.execute()`, `.describe()`, and tagged-template calls all feed a single
 * timing record. The proxy preserves the chainable API drizzle relies on
 * (e.g. `client.unsafe(query, params).values()`).
 */
function timedThenable(
  query: string,
  inner: unknown,
  inheritedState?: TimingState,
): unknown {
  const state: TimingState =
    inheritedState ?? {
      statement: classifyStatement(query),
      startedAt: performance.now(),
      finished: false,
    };

  if (!inheritedState) {
    incDbQueriesInFlight(state.statement);
  }

  const chainable = [
    "values",
    "execute",
    "describe",
    "stream",
    "count",
    "safe",
  ];

  return new Proxy(inner as object, {
    get(target, prop) {
      if (prop === "then") {
        return (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) =>
          (
            target as {
              then: (
                onFulfilled?: (value: unknown) => unknown,
                onRejected?: (reason: unknown) => unknown,
              ) => Promise<unknown>;
            }
          ).then(
            (value: unknown) => {
              finishTiming(state, "success");
              return onFulfilled ? onFulfilled(value) : value;
            },
            (reason: unknown) => {
              finishTiming(state, "error");
              if (onRejected) return onRejected(reason);
              throw reason;
            },
          );
      }
      if (chainable.includes(String(prop))) {
        const chain = (target as Record<string, unknown>)[String(prop)];
        if (typeof chain !== "function") return chain;
        return (...args: unknown[]) =>
          timedThenable(query, chain.apply(target, args), state);
      }
      const value = Reflect.get(target as object, prop);
      return typeof value === "function"
        ? (value as (...args: never[]) => unknown).bind(target as object)
        : value;
    },
  });
}

function queryTextFromTaggedCall(args: unknown[]): string {
  const strings = args[0] as { join?: (separator: string) => string } | undefined;
  return typeof strings?.join === "function" ? strings.join("") : "sql call";
}

/**
 * Wrap a postgres.js client so every query executed through it (drizzle runs
 * all statements via `client.unsafe`) is timed, labeled, and counted. Property
 * access, `options` mutations, and method binding are preserved via the proxy
 * pass-through.
 */
export function instrumentPostgres<T>(client: T): T {
  const target = client as T & {
    unsafe?: (query: string, params?: unknown[]) => unknown;
    [key: string]: unknown;
  };

  return new Proxy(target, {
    get(obj, prop) {
      if (prop === "unsafe") {
        return (query: string, params?: unknown[]) =>
          timedThenable(query, (obj.unsafe as (q: string, p?: unknown[]) => unknown)(query, params));
      }
      const value = Reflect.get(obj, prop, obj);
      return typeof value === "function" ? value.bind(obj) : value;
    },
    apply(obj, _thisArg, args) {
      return timedThenable(queryTextFromTaggedCall(args), Reflect.apply(obj as never, obj as never, args));
    },
  }) as T;
}