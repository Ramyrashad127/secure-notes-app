// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAutosave, type UseAutosaveParams } from "./use-autosave";

interface SavePayload {
  id: string;
  title: string;
  content: string;
  clientUpdatedAt: Date | undefined;
  isManualSave: boolean;
}

interface EditorValue {
  title: string;
  content: string;
}

let cleanupFns: (() => void)[] = [];

function makeParams(overrides: Partial<UseAutosaveParams<EditorValue>> = {}) {
  return {
    noteId: "note-1",
    value: { title: "Hello", content: "World" },
    initialUpdatedAt: new Date("2026-01-01T12:00:00.000Z"),
    delayMs: 100,
    saveFn: vi.fn(),
    ...overrides,
  } satisfies UseAutosaveParams<EditorValue>;
}

function trackUnmount(unmount: () => void) {
  cleanupFns.push(unmount);
}

afterEach(() => {
  for (const fn of cleanupFns) {
    if (typeof fn === "function") fn();
  }
  cleanupFns = [];
  vi.useRealTimers();
});

beforeEach(() => {
  localStorage.clear();
  cleanupFns = [];
});

describe("useAutosave", () => {

describe("useAutosave sync state machine", () => {
  it("starts idle and transitions idle -> saving -> saved on a successful save", async () => {
    const params = makeParams({
      saveFn: vi.fn().mockResolvedValue({
        success: true as const,
        updatedAt: new Date("2026-01-01T12:00:05.000Z"),
      }),
    });
    const { result, unmount: renderResultUnmount } = renderHook(() => useAutosave(params));
    trackUnmount(renderResultUnmount);

    expect(result.current.status).toBe("idle");

    act(() => result.current.save());
    expect(result.current.status).toBe("saving");

    await waitFor(() => expect(result.current.status).toBe("saved"));
  });

  it("debounces: only one save fires after multiple rapid calls within the delay", async () => {
    const saveFn = vi.fn().mockResolvedValue({
      success: true as const,
      updatedAt: new Date("2026-01-01T12:00:05.000Z"),
    });
    const params = makeParams({ saveFn });
    const { result, unmount: renderResultUnmount } = renderHook(() => useAutosave(params));
    trackUnmount(renderResultUnmount);

    act(() => result.current.save());
    act(() => result.current.save());
    act(() => result.current.save());

    await waitFor(() => expect(result.current.status).toBe("saved"));

    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(saveFn).toHaveBeenCalledWith(
      expect.objectContaining({ isManualSave: false }),
    );
  });

  it("auto-saves (debounced) when the value changes", async () => {
    const saveFn = vi.fn().mockResolvedValue({
      success: true as const,
      updatedAt: new Date("2026-01-01T12:00:05.000Z"),
    });
    const params = makeParams({ saveFn });
    const { result, rerender, unmount } = renderHook(
      (p) => useAutosave(p),
      { initialProps: params },
    );
    trackUnmount(unmount);

    rerender({ ...params, value: { title: "Edited", content: "New body" } });

    await waitFor(() => expect(result.current.status).toBe("saved"));
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it("reports lastSaveWasManual true after a manual save and false after an autosave", async () => {
    const saveFn = vi.fn().mockResolvedValue({
      success: true as const,
      updatedAt: new Date("2026-01-01T12:00:05.000Z"),
    });
    const params = makeParams({ saveFn });
    const { result, unmount: renderResultUnmount } = renderHook(() => useAutosave(params));
    trackUnmount(renderResultUnmount);

    act(() => result.current.save({ manual: true }));
    await waitFor(() => expect(result.current.status).toBe("saved"));
    expect(result.current.lastSaveWasManual).toBe(true);

    act(() => result.current.save());
    await waitFor(() =>
      expect(result.current.lastSaveWasManual).toBe(false),
    );
  });

  it("multiple rapid value changes within the delay produce a single save", async () => {
    const saveFn = vi.fn().mockResolvedValue({
      success: true as const,
      updatedAt: new Date("2026-01-01T12:00:05.000Z"),
    });
    const params = makeParams({ saveFn });
    const { rerender, unmount } = renderHook(
      (p) => useAutosave(p),
      { initialProps: params },
    );
    trackUnmount(unmount);

    rerender({ ...params, value: { title: "A", content: "1" } });
    rerender({ ...params, value: { title: "AB", content: "12" } });
    rerender({ ...params, value: { title: "ABC", content: "123" } });

    await waitFor(() => expect(saveFn).toHaveBeenCalledTimes(1));
    expect(saveFn).toHaveBeenCalledWith(
      expect.objectContaining({ title: "ABC", content: "123" }),
    );
  });

  it("does not auto-save when the value is unchanged on re-render", async () => {
    const saveFn = vi.fn().mockResolvedValue({
      success: true as const,
      updatedAt: new Date("2026-01-01T12:00:05.000Z"),
    });
    const params = makeParams({ saveFn });
    const { rerender, unmount } = renderHook(
      (p) => useAutosave(p),
      { initialProps: params },
    );
    trackUnmount(unmount);

    rerender({ ...params, value: { title: "Hello", content: "World" } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(saveFn).not.toHaveBeenCalled();
  });

  it("passes the note id and latest value to the save function", async () => {
    const saveFn = vi.fn().mockResolvedValue({
      success: true as const,
      updatedAt: new Date("2026-01-01T12:00:05.000Z"),
    });
    const params = makeParams({
      saveFn,
      value: { title: "Edited", content: "New body" },
    });
    const { result, unmount: renderResultUnmount } = renderHook(() => useAutosave(params));
    trackUnmount(renderResultUnmount);

    act(() => result.current.save());

    await waitFor(() => expect(result.current.status).toBe("saved"));

    expect(saveFn).toHaveBeenCalledWith({
      id: "note-1",
      title: "Edited",
      content: "New body",
      clientUpdatedAt: expect.any(Date),
      isManualSave: false,
    });
  });
});

describe("useAutosave optimistic concurrency", () => {
  it("passes clientUpdatedAt from the last successful save", async () => {
    const calls: SavePayload[] = [];
    const saveFn = vi.fn().mockImplementation(async (payload: SavePayload) => {
      calls.push(payload);
      return {
        success: true as const,
        updatedAt: new Date(Date.parse(payload.clientUpdatedAt?.toISOString() ?? "2026-01-01T12:00:00.000Z") + 5000),
      };
    });
    const params = makeParams({ saveFn });
    const { result, unmount: renderResultUnmount } = renderHook(() => useAutosave(params));
    trackUnmount(renderResultUnmount);

    act(() => result.current.save());
    await waitFor(() => expect(result.current.status).toBe("saved"));

    act(() => result.current.save());
    await waitFor(() => expect(result.current.status).toBe("saved"));

    expect(calls).toHaveLength(2);
    expect(calls[0].clientUpdatedAt?.getTime()).toBe(
      new Date("2026-01-01T12:00:00.000Z").getTime(),
    );
    expect(calls[1].clientUpdatedAt?.getTime()).toBe(
      new Date("2026-01-01T12:00:05.000Z").getTime(),
    );
  });

  it("passes clientUpdatedAt from the initialUpdatedAt when no save has succeeded yet", async () => {
    const saveFn = vi.fn().mockResolvedValue({
      success: true as const,
      updatedAt: new Date("2026-01-01T12:00:05.000Z"),
    });
    const params = makeParams({
      saveFn,
      initialUpdatedAt: new Date("2026-01-01T11:00:00.000Z"),
    });
    const { result, unmount: renderResultUnmount } = renderHook(() => useAutosave(params));
    trackUnmount(renderResultUnmount);

    act(() => result.current.save());

    await waitFor(() => expect(result.current.status).toBe("saved"));

    expect(saveFn).toHaveBeenCalledWith(
      expect.objectContaining({
        clientUpdatedAt: new Date("2026-01-01T11:00:00.000Z"),
      }),
    );
  });
});

describe("useAutosave error handling", () => {
  it("transitions to error when the save fails", async () => {
    const params = makeParams({
      saveFn: vi.fn().mockRejectedValue(new Error("network down")),
    });
    const { result, unmount: renderResultUnmount } = renderHook(() => useAutosave(params));
    trackUnmount(renderResultUnmount);

    act(() => result.current.save());

    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("flags a CONFLICT result and does not stash it for retry", async () => {
    const saveFn = vi
      .fn()
      .mockResolvedValue({ success: false, error: "CONFLICT", message: "nope" });
    const params = makeParams({ saveFn });
    const { result, unmount: renderResultUnmount } = renderHook(() => useAutosave(params));
    trackUnmount(renderResultUnmount);

    act(() => result.current.save());

    await waitFor(() => expect(result.current.isConflict).toBe(true));
    expect(localStorage.getItem("autosave:note-1")).toBeNull();
  });

  it("stashes the payload in localStorage when the save rejects and retries on the next save", async () => {
    const saveFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({
        success: true as const,
        updatedAt: new Date("2026-01-01T12:00:05.000Z"),
      });
    const params = makeParams({ saveFn });
    const { result, unmount: renderResultUnmount } = renderHook(() => useAutosave(params));
    trackUnmount(renderResultUnmount);

    act(() => result.current.save());
    await waitFor(() => expect(result.current.status).toBe("error"));
    const stashed = JSON.parse(localStorage.getItem("autosave:note-1") ?? "null");
    expect(stashed).toMatchObject({
      id: "note-1",
      title: "Hello",
      content: "World",
    });

    act(() => result.current.save());
    await waitFor(() => expect(result.current.status).toBe("saved"));
    expect(localStorage.getItem("autosave:note-1")).toBeNull();
  });
});

describe("useAutosave offline flush", () => {
  it("flushes a stashed payload from localStorage on mount", async () => {
    localStorage.setItem(
      "autosave:note-1",
      JSON.stringify({
        id: "note-1",
        title: "Stashed",
        content: "Stashed body",
        clientUpdatedAt: "2026-01-01T12:00:00.000Z",
      }),
    );
    const saveFn = vi.fn().mockResolvedValue({
      success: true as const,
      updatedAt: new Date("2026-01-01T12:00:10.000Z"),
    });
    const params = makeParams({ saveFn });
    const { result, unmount: renderResultUnmount } = renderHook(() => useAutosave(params));
    trackUnmount(renderResultUnmount);

    await waitFor(() => expect(result.current.status).toBe("saved"));

    expect(saveFn).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Stashed", content: "Stashed body" }),
    );
    expect(localStorage.getItem("autosave:note-1")).toBeNull();
  });

  it("flushes the stash when the browser comes back online", async () => {
    localStorage.setItem(
      "autosave:note-1",
      JSON.stringify({
        id: "note-1",
        title: "Stashed",
        content: "Stashed body",
        clientUpdatedAt: "2026-01-01T12:00:00.000Z",
      }),
    );
    const saveFn = vi.fn().mockResolvedValue({
      success: true as const,
      updatedAt: new Date("2026-01-01T12:00:10.000Z"),
    });
    const params = makeParams({ saveFn });
    renderHook(() => useAutosave(params));

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(saveFn).toHaveBeenCalled());
    expect(localStorage.getItem("autosave:note-1")).toBeNull();
  });
});

  describe("useAutosave cleanup", () => {
    it("cancels the debounced timer on unmount", async () => {
      const saveFn = vi.fn().mockResolvedValue({
        success: true as const,
        updatedAt: new Date("2026-01-01T12:00:05.000Z"),
      });
      const params = makeParams({ saveFn });
      const { result, unmount } = renderHook(() => useAutosave(params));

      act(() => result.current.save());
      unmount();

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(saveFn).not.toHaveBeenCalled();
    });
  });
});
