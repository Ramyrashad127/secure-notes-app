import { describe, expect, it } from "vitest";

import { isClientAbortError } from "./instrumentation";

describe("isClientAbortError", () => {
  it.each([
    ["Error: aborted", true],
    ["uncaughtException:  Error: aborted", true],
    ["Error: The destination stream closed early.", true],
    ["stream closed early", true],
    ["connection reset by peer", true],
    ["connection closed by client", true],
    ["Client closed the connection", true],
    ["Connection reset (ECONNRESET)", true],
    ["operation cancelled", true],
  ])("classifies %j as client abort", (message, expected) => {
    expect(isClientAbortError(new Error(message))).toBe(expected);
  });

  it.each([
    ["Connection failed: could not connect to database", false],
    ["Unique violation: duplicate key", false],
    ["Invalid email or password", false],
    ["Something went wrong. Please try again.", false],
    ["Failed to create note", false],
  ])("does NOT classify %j as client abort", (message, expected) => {
    expect(isClientAbortError(new Error(message))).toBe(expected);
  });

  it("handles non-Error payloads", () => {
    expect(isClientAbortError("aborted")).toBe(true);
    expect(isClientAbortError(null)).toBe(false);
    expect(isClientAbortError(undefined)).toBe(false);
    expect(isClientAbortError(42)).toBe(false);
  });
});