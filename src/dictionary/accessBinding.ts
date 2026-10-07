import { useEffect, useRef } from "react";
import { oneOf } from "../api/wireValidation";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";

export type DictionaryPair = "ru-de" | "uk-de" | "en-de";

/** The dictionary pair of an opened access; an unknown language is refused during render. */
export function pairOf(access: OpenedAccess): DictionaryPair {
  const pair = `${access.profile.dictionary_language}-de`;
  if (!oneOf(pair, ["ru-de", "uk-de", "en-de"])) throw new Error("unknown dictionary pair");
  return pair as DictionaryPair;
}

/** Floor scope of one opened document: the same key while the document and the pair stay the same. */
export function identityKey(access: OpenedAccess): string {
  return JSON.stringify([access.key, access.profile.profile_id, access.document.clientInstanceId,
    access.document.documentId, access.document.epoch, access.profile.dictionary_language]);
}

export function admitted(access: OpenedAccess): boolean {
  return access.isLive() && access.profile.access.status === "admitted";
}

/** One authenticated read whose outcome is dropped, before access.run sees it, once `current` turns false. */
export function runCurrent<T>(access: OpenedAccess, current: () => boolean, operation: (token: string) => Promise<T>): Promise<T> {
  const requireCurrent = () => { if (!current()) throw new ClosedAccessError(); };
  return access.run(async ({ token }) => {
    requireCurrent();
    try {
      const value = await operation(token);
      requireCurrent();
      return value;
    } catch (error) {
      // Obsolete denials must be discarded before access.run can revoke this handle.
      requireCurrent();
      throw error;
    }
  });
}

/**
 * Accesses seen while the page was hidden or restored from the page cache. Their reads stay stopped;
 * the foreground of the application hands over a new access object, which reads again.
 */
export function useSuspendedAccesses(latest: () => OpenedAccess, repaint: () => void): WeakSet<OpenedAccess> {
  const suspended = useRef(new WeakSet<OpenedAccess>());
  const read = useRef(latest);
  read.current = latest;
  useEffect(() => {
    const suspend = () => { suspended.current.add(read.current()); repaint(); };
    document.addEventListener("visibilitychange", suspend, true);
    window.addEventListener("pageshow", suspend, true);
    return () => {
      document.removeEventListener("visibilitychange", suspend, true);
      window.removeEventListener("pageshow", suspend, true);
    };
  }, [repaint]);
  return suspended.current;
}
