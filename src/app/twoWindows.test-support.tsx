import { withJournalIntake } from "../journal/intake.test-support";
// Several real <App/> windows over one shared synthetic server (QA-R1-V3, C151). Each window is mounted with its own
// storage (its own installation) and its own fetch, stubbed as globals right before its render.
//
// Test boundary (C226): every window captures its own references while it mounts, and nothing in src reads either global
// later. App reads window.localStorage once in its mount effect (App.tsx:86) and binds window.fetch once a little later,
// in the continuation of its first saved-language read (App.tsx:112, after the async storage get). So `mount` waits for
// the window's first screen before the next window stubs the globals; two windows rendered back to back without that
// wait would share the second window's fetch. The Telegram global, navigator and document stay shared by all windows.
import { render, within } from "@testing-library/react";
import { StrictMode } from "react";
import { vi } from "vitest";
import { App } from "./App";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const exchange = { timeout: 5000 };

export function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return { getItem: key => map.has(key) ? map.get(key)! : null, setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); }, clear: () => map.clear(), key: index => [...map.keys()][index] ?? null,
    get length() { return map.size; } };
}

export type Entry = { device: string; method: string; path: string; kind: string | null; session: string | null; event: string | null };
/**
 * Windows over `server`, answered as the core answers several installations of one profile:
 * - client/open reports only the window's OWN unclosed session (core clients.py:287-292); while another window's
 *   session is open it answers SESSION_BUSY with that session as the remote stop target (clients.py:258-266);
 * - a start while any session of the profile is open is the final refusal SESSION_BUSY (409), and the open session
 *   goes on untouched (study/session_start_refusal.py:82-85).
 */
export function windows(server: Fetch) {
  const log: Entry[] = [];
  let open: { session: string; device: string } | null = null, version = 0n;
  const seen = async (reply: Response) => {
    try {
      const value = await reply.clone().json() as { state_version?: string; profile?: { state_version?: string } };
      for (const raw of [value.state_version, value.profile?.state_version]) if (raw && BigInt(raw) > version) version = BigInt(raw);
    } catch { /* not JSON */ }
  };
  const mount = async (name: string, expectText: string, strict = false) => {
    const device = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
      log.push({ device: name, method: init?.method ?? "GET", path, kind: body?.kind ?? null, session: body?.session_id ?? null, event: body?.event ?? null });
      if (init?.method === "POST" && body?.kind === "session.start" && open !== null) {
        return new Response(JSON.stringify({ current: { session_id: body.session_id, status: "not_found" },
          command: { id: body.command_id, status: "rejected" }, state_version: String(version), error: { code: "SESSION_BUSY" } }), { status: 409 });
      }
      const reply = await server(url, init);
      await seen(reply);
      if (init?.method === "POST" && reply.ok && body?.kind === "session.start") open = { session: body.session_id, device: name };
      if (init?.method === "POST" && reply.ok && body?.kind === "session.stop" && open?.session === body.session_id) open = null;
      if (path.endsWith("/client/open")) {
        const value = await reply.clone().json() as { session?: { id: string } | null; profile?: unknown; compatibility?: unknown };
        if (open !== null && open.device !== name) return new Response(JSON.stringify({ status: "SESSION_BUSY", profile: value.profile,
          compatibility: value.compatibility, session: { status: "busy", stop_remote_target: open.session, document_conflict: false,
            document_epoch: "1" } }), { status: reply.status });
        if (value.session && open?.session !== value.session.id) {
          value.session = null; return new Response(JSON.stringify(value), { status: reply.status });
        }
      }
      return reply;
    });
    vi.stubGlobal("fetch", withJournalIntake(device)); vi.stubGlobal("localStorage", memoryStorage());
    const rendered = render(strict ? <StrictMode><App /></StrictMode> : <App />);
    const ui = within(rendered.container);
    // The first screen needs this window's fetch: by then it holds its references, and the next window may stub its own.
    await ui.findByText(expectText, undefined, exchange);
    return { name, ui };
  };
  const by = (name: string) => log.filter(entry => entry.device === name);
  const posts = (name: string) => by(name).filter(entry => entry.method === "POST" && entry.path.endsWith("/commands"))
    .map(entry => [entry.kind, entry.session]);
  const opens = (name: string) => by(name).filter(entry => entry.path.endsWith("/client/open")).map(entry => entry.event);
  return { mount, posts, opens };
}
