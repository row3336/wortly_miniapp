import { vi } from "vitest";
import { deferred, fixture, id, profile, response } from "../learning/learningFixtures.test-support";
import { createFeedbackApi } from "./feedbackApi";
import { FeedbackController, type FeedbackSnapshot } from "./feedbackController";
import { FeedbackPendingStore } from "./feedbackPending";

/** What the next POST /commands meets: the server applies or not, and the reply arrives or is lost. */
export type Fate = "ok" | "lose-before" | "lose-after" | "422" | "409" | "403" | "401" | "500" | "garbage" | "400" | "404" | "413" | "408" | "429";
export const slot = "wortly.pending.feedback";
export const TEXT = "Das Wort ist falsch geschrieben";

/** An in-memory server of feedback.send: idempotent by command_id, text never echoed back. */
export function feedbackWorld(fates: Fate[] = []) {
  const f = fixture(); f.owner.dispose();
  const facts = new Map<string, { text: string; card_id: string | null; inbox: string }>();
  const posts: Array<{ command_id: string; kind: string; client_instance_id: string; document_id: string;
    payload: { text: string; card_id?: string } }> = [];
  const gets: string[] = [];
  const queue = [...fates];
  const state = { statusFailures: 0, inbox: 900, gate: null as ReturnType<typeof deferred<void>> | null };
  const fact = (commandId: string, status: string) => ({ id: commandId, kind: "feedback.send", status, applied_at: "2026-10-06T12:00:00Z",
    target_id: facts.get(commandId)!.inbox, action_id: null, result_id: null, context_id: null, object_version: null });
  const current = (commandId: string) => ({ inbox_id: facts.get(commandId)!.inbox, card_id: facts.get(commandId)!.card_id });
  f.fetcher.mockImplementation(async (url, init) => {
    const path = String(url);
    if (init?.method === "POST" && path.endsWith("/commands")) {
      const body = JSON.parse(String(init.body)); posts.push(body);
      const fate = queue.shift() ?? "ok";
      if (fate === "lose-before") throw new TypeError("network");
      if (fate === "422") return response({ error: { code: "VALIDATION_FAILED" } }, 422);
      if (fate === "403") return response({ error: { code: "FORBIDDEN" } }, 403);
      if (fate === "401") return response({ error: { code: "AUTH_INVALID" } }, 401);
      if (fate === "500") return response({ error: { code: "INTERNAL" } }, 500);
      if (["400", "404", "413", "408", "429"].includes(fate)) return response({ error: { code: "REFUSED" } }, Number(fate));
      if (fate === "garbage") return response({ unexpected: true });
      const known = facts.get(body.command_id);
      if (fate === "409" || known && known.text !== body.payload.text) {
        return response({ command: { id: body.command_id, status: "rejected" }, current: { status: "unavailable" },
          state_version: "5", error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409);
      }
      if (!known) facts.set(body.command_id, { text: body.payload.text, card_id: body.payload.card_id ?? null, inbox: id(state.inbox++) });
      if (state.gate) await state.gate.promise;
      if (fate === "lose-after") throw new TypeError("network");
      return response({ command: fact(body.command_id, known ? "already_applied" : "applied"), current: current(body.command_id), state_version: "5" });
    }
    const commandId = path.split("/commands/")[1];
    if (commandId) {
      gets.push(commandId);
      if (state.statusFailures > 0) { state.statusFailures--; throw new TypeError("network"); }
      if (!facts.has(commandId)) return response({ command: { id: commandId, status: "not_found" }, current: profile("5"), state_version: "5" });
      return response({ command: fact(commandId, "already_applied"), current: current(commandId), state_version: "5" });
    }
    throw new Error(`unexpected request ${path}`);
  });
  /** The next POST is applied but waits for the returned gate before it answers. */
  const hold = () => { state.gate = deferred<void>(); return state.gate; };
  return { f, facts, posts, gets, state, hold, fates: queue };
}
export type FeedbackWorld = ReturnType<typeof feedbackWorld>;

export function makeController(world: FeedbackWorld, store = new FeedbackPendingStore(world.f.storage), cardId?: string) {
  const updates = vi.fn<(snapshot: FeedbackSnapshot) => void>();
  let next = 100;
  const controller = new FeedbackController({
    api: createFeedbackApi({ fetcher: world.f.fetcher, timeoutMs: 1000, maxResponseBytes: 100000 }),
    pendingStore: store, cardId, access: () => world.f.access(), newId: () => id(next++), onUpdate: updates });
  return { controller, store, updates };
}
export const pendingRecord = (commandId: string, text = TEXT) => JSON.stringify({ schemaVersion: 1, profileId: id(50),
  intent: { command_id: commandId, kind: "feedback.send", payload: { text } } });
