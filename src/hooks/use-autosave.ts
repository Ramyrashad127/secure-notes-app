import * as React from "react";

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

export interface AutosavePayload {
  id: string;
  title: string;
  content: string;
  clientUpdatedAt?: Date;
  isManualSave: boolean;
}

export type AutosaveResult =
  | { success: true; updatedAt: Date; snapshotCreated?: boolean }
  | { success: false; error: string; message?: string };

export interface UseAutosaveParams<TValue> {
  noteId: string;
  value: TValue;
  initialUpdatedAt?: Date;
  delayMs?: number;
  saveFn: (payload: AutosavePayload) => Promise<AutosaveResult>;
}

export interface UseAutosaveReturn<TValue> {
  status: AutosaveStatus;
  isConflict: boolean;
  save: (options?: { manual?: boolean }) => void;
  currentValue: TValue;
  lastSaveWasManual: boolean;
  /** Whether a 5s autosave is needed (editor differs from last autosave). */
  isLiveDirty: boolean;
  /** Whether the manual "Save" (create snapshot) button should be active. */
  isSnapshotPending: boolean;
  /** Adopt server-authoritative state (e.g. after a version restore) as the new last-saved baseline. */
  reconcile: (value: TValue) => void;
}

const STORAGE_PREFIX = "autosave:";
const DEFAULT_DELAY_MS = 5000;

interface StashedPayload {
  id: string;
  title: string;
  content: string;
  clientUpdatedAt?: string;
}

function stashKey(noteId: string): string {
  return `${STORAGE_PREFIX}${noteId}`;
}

function readStash(noteId: string): StashedPayload | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(stashKey(noteId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StashedPayload;
  } catch {
    window.localStorage.removeItem(stashKey(noteId));
    return null;
  }
}

function writeStash(noteId: string, payload: StashedPayload): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(stashKey(noteId), JSON.stringify(payload));
}

function clearStash(noteId: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(stashKey(noteId));
}

export function useAutosave<TValue>({
  noteId,
  value,
  initialUpdatedAt,
  delayMs = DEFAULT_DELAY_MS,
  saveFn,
}: UseAutosaveParams<TValue>): UseAutosaveReturn<TValue> {
  const [status, setStatus] = React.useState<AutosaveStatus>("idle");
  const [isConflict, setIsConflict] = React.useState(false);
  const [currentValue, setCurrentValue] = React.useState<TValue>(value);
  const [lastSaveWasManual, setLastSaveWasManual] = React.useState(false);
  const [lastSnapshottedValue, setLastSnapshottedValue] =
    React.useState<TValue>(value);

  const lastSavedAtRef = React.useRef<Date | null>(initialUpdatedAt ?? null);
  const saveFnRef = React.useRef(saveFn);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestValueRef = React.useRef<TValue>(value);
  const flushingRef = React.useRef(false);
  const prevValueRef = React.useRef<TValue>(value);
  const mountedRef = React.useRef(false);

  React.useEffect(() => {
    saveFnRef.current = saveFn;
    latestValueRef.current = value;
  });

  const getClientUpdatedAt = React.useCallback(
    () => lastSavedAtRef.current ?? initialUpdatedAt,
    [initialUpdatedAt],
  );

  const cancelTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const performSave = React.useCallback(
    async (payload: AutosavePayload, savedValue: TValue) => {
      try {
        const result = await saveFnRef.current(payload);

        if (!result.success) {
          if (result.error === "CONFLICT") {
            setIsConflict(true);
            setLastSaveWasManual(false);
            setStatus("idle");
            return;
          }
          writeStash(noteId, {
            id: payload.id,
            title: payload.title,
            content: payload.content,
            clientUpdatedAt: payload.clientUpdatedAt?.toISOString(),
          });
          setLastSaveWasManual(false);
          setStatus("error");
          return;
        }

        clearStash(noteId);
        lastSavedAtRef.current = result.updatedAt;
        setCurrentValue(savedValue);
        setLastSaveWasManual(payload.isManualSave);
        setStatus("saved");
        if (payload.isManualSave === true || result.snapshotCreated === true) {
          setLastSnapshottedValue(savedValue);
        }
      } catch {
        writeStash(noteId, {
          id: payload.id,
          title: payload.title,
          content: payload.content,
          clientUpdatedAt: payload.clientUpdatedAt?.toISOString(),
        });
        setLastSaveWasManual(false);
        setStatus("error");
      }
    },
    [noteId],
  );

  const buildPayload = React.useCallback(
    (isManualSave: boolean): AutosavePayload => {
      const current = latestValueRef.current as AutosavePayload;
      return {
        id: noteId,
        title: current.title,
        content: current.content,
        clientUpdatedAt: getClientUpdatedAt(),
        isManualSave,
      };
    },
    [getClientUpdatedAt, noteId],
  );

  const save = React.useCallback(
    (options?: { manual?: boolean }) => {
      const manual = options?.manual === true;
      cancelTimer();
      const savedValue = latestValueRef.current;
      const payload = buildPayload(manual);

      if (manual) {
        setStatus("saving");
        void performSave(payload, savedValue);
        return;
      }

      setStatus("saving");
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void performSave(payload, savedValue);
      }, delayMs);
    },
    [buildPayload, cancelTimer, delayMs, performSave],
  );

  const reconcile = React.useCallback((newValue: TValue) => {
    cancelTimer();
    latestValueRef.current = newValue;
    prevValueRef.current = newValue;
    lastSavedAtRef.current = new Date();
    setLastSnapshottedValue(newValue);
    setCurrentValue(newValue);
    setLastSaveWasManual(false);
    setStatus("idle");
  }, [cancelTimer]);

  React.useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      prevValueRef.current = value;
      return;
    }

    const prev = prevValueRef.current;
    prevValueRef.current = value;
    if (JSON.stringify(prev) === JSON.stringify(value)) return;

    save();
  }, [save, value]);

  React.useEffect(() => {
    function flushStash() {
      const stashed = readStash(noteId);
      if (!stashed || flushingRef.current) return;
      flushingRef.current = true;

      const payload: AutosavePayload = {
        id: stashed.id,
        title: stashed.title,
        content: stashed.content,
        clientUpdatedAt: stashed.clientUpdatedAt
          ? new Date(stashed.clientUpdatedAt)
          : getClientUpdatedAt(),
        isManualSave: false,
      };
      setStatus("saving");
      void performSave(payload, latestValueRef.current).finally(() => {
        flushingRef.current = false;
      });
    }

    flushStash();

    window.addEventListener("online", flushStash);
    return () => {
      cancelTimer();
      window.removeEventListener("online", flushStash);
    };
  }, [cancelTimer, getClientUpdatedAt, noteId, performSave]);

  const isLiveDirty =
    JSON.stringify(value) !== JSON.stringify(currentValue);
  const isSnapshotPending =
    JSON.stringify(value) !== JSON.stringify(lastSnapshottedValue);

  return {
    status,
    isConflict,
    save,
    currentValue,
    lastSaveWasManual,
    isLiveDirty,
    isSnapshotPending,
    reconcile,
  };
}