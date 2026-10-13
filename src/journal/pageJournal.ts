import { createJsonTransport, errorCode, type HttpOptions } from "../api/http";
import { ClientJournal, journalRecord, type ClientJournalOptions } from "./clientJournal";
import { CLIENT_BUILD_VERSION, errorClass } from "./events";
import { IdbJournalStore } from "./journalStore";

/** The intake route of the client journal (core 30fe429). */
export const CLIENT_EVENTS_PATH = "/client/events";
/** c.error per page: a script error in a loop must not fill the buffer. */
export const SCRIPT_ERRORS_PER_PAGE = 20;

/** The journal of this page: batches go through the shared transport (trace header, contract version, bounds). */
export function createPageJournal(transport: HttpOptions, clientVersion: string,
  extra: Pick<ClientJournalOptions, "openStore" | "clock" | "limits"> = {}, warn: (message: string) => void = message => console.warn(message)): ClientJournal {
  // The journal's own exchange never speaks for the window: a refusal of a batch must not start the window check that
  // DOCUMENT_STALE asks for (the intake checks no document), so the window's hook is not passed on.
  const { onDocumentStale: _window, ...own } = transport;
  const request = createJsonTransport(own);
  // The core accepts only a build version (X.Y.Z, optionally +<7-12 hex>); any other keeps every batch on the device.
  // Said once in the developer console, never on a screen; the value itself is not repeated.
  if (!CLIENT_BUILD_VERSION.test(clientVersion)) {
    warn("Wortly client journal: VITE_WORTLY_CLIENT_VERSION is not X.Y.Z[+hex7-12]; client events stay on the device and are not sent.");
  } else if (clientVersion === "0.0.0") {
    warn("Wortly client journal: no build version (VITE_WORTLY_CLIENT_VERSION unset); client events are sent as version 0.0.0.");
  }
  return new ClientJournal({
    clientVersion,
    openStore: () => IdbJournalStore.open(),
    ...extra,
    async send(batch, credentials) {
      const reply = await request(CLIENT_EVENTS_PATH, { method: "POST", token: credentials.token, proof: credentials.proof, body: batch });
      const code = errorCode(reply.value);
      return { status: reply.status, ...(code === undefined ? {} : { code }),
        ...(reply.retryAfter === undefined ? {} : { retryAfter: reply.retryAfter }) };
    },
  });
}

/**
 * Unhandled script errors become c.error with the class name only (never the message or the stack: they may carry
 * request data); the background sends what is buffered. Returns the cleanup.
 */
export function watchPage(target: Window, journal: () => ClientJournal | null): () => void {
  let errors = 0;
  const scriptError = (error: unknown) => {
    if (errors >= SCRIPT_ERRORS_PER_PAGE) return;
    errors++;
    journalRecord({ ev: "c.error", err: errorClass(error) });
  };
  const onError = (event: ErrorEvent) => scriptError(event.error);
  const onRejection = (event: PromiseRejectionEvent) => scriptError(event.reason);
  const onHidden = () => { if (target.document.visibilityState === "hidden") journal()?.flushSoon(); };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  target.document.addEventListener("visibilitychange", onHidden);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
    target.document.removeEventListener("visibilitychange", onHidden);
  };
}
