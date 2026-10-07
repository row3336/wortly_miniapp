import { vi } from "vitest";
import type { DictionaryCardActions } from "../../api/generated";
import type { CardActionCommand, CardActionIntent } from "./cardActionApi";

export const aid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const CARD = aid(901), ACTION = aid(777), PROFILE = aid(50);
export const origin = { client_instance_id: aid(1), document_id: aid(2) };
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

export const excludeIntent = (change: Partial<CardActionIntent> = {}): CardActionIntent =>
  ({ kind: "card.exclude", command_id: aid(10), card_id: CARD, expected_card_state_version: null, ...change }) as CardActionIntent;
export const relearnIntent = (change: Partial<CardActionIntent> = {}): CardActionIntent =>
  ({ kind: "card.relearn", command_id: aid(11), card_id: CARD, confirmed: true, ...change }) as CardActionIntent;
export const command = (intent: CardActionIntent): CardActionCommand => ({ ...intent, ...origin });

export const rights = (excluded: boolean): DictionaryCardActions =>
  excluded ? { exclude: false, return: true, relearn: false } : { exclude: true, return: false, relearn: true };
export const current = (excluded: boolean, version: string | null) =>
  ({ status: "available", card_id: CARD, pair: "ru-de", excluded, version, actions: rights(excluded) });

/** core coordinator._fact of a card action: target = card, a history action, no context or result. */
export function actionFact(intent: CardActionIntent, change: Record<string, unknown> = {}) {
  const objectVersion = intent.kind === "card.relearn" ? "4"
    : intent.expected_card_state_version === null ? "1" : String(Number(intent.expected_card_state_version) + 1);
  return { id: intent.command_id, kind: intent.kind, status: "applied", applied_at: "2026-10-07T10:00:00Z", target_id: intent.card_id,
    action_id: ACTION, result_id: null, context_id: null, object_version: objectVersion, ...change };
}

export const profileCurrent = () => ({
  profile_id: PROFILE, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
  access: { status: "admitted", reason: null, version: "1" }, state_version: "5",
});

/** What the next POST meets: the server applies or not, and the reply arrives or is lost. */
export type Fate = "ok" | "lose-before" | "lose-after" | "conflict" | "forbidden" | "setup" | "500" | "garbage";

/**
 * An in-memory server of card.exclude/return/relearn and of their status: idempotent by command_id, versioned like core
 * card_exclusion (CAS of the flag, the reply's current is the card's state now).
 */
export function cardActionServer(fates: Fate[] = []) {
  const state = { excluded: false, version: null as string | null, stateVersion: 10, statusFailures: 0 };
  const facts = new Map<string, { intent: CardActionIntent; fact: ReturnType<typeof actionFact> }>();
  const posts: Record<string, unknown>[] = [];
  const gets: string[] = [];
  const queue = [...fates];
  const now = () => current(state.excluded, state.version);
  const intentOf = (body: Record<string, unknown>): CardActionIntent => {
    const payload = body.payload as Record<string, unknown>;
    return body.kind === "card.relearn"
      ? { kind: "card.relearn", command_id: body.command_id as string, card_id: payload.card_id as string, confirmed: true }
      : { kind: body.kind as "card.exclude", command_id: body.command_id as string, card_id: payload.card_id as string,
        expected_card_state_version: body.expected_card_state_version as string | null };
  };
  const rejected = (body: Record<string, unknown>, code: string, status: number) => json({
    command: { id: body.command_id, status: "rejected" }, current: now(), state_version: String(state.stateVersion),
    error: { code } }, status);
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (init?.method === "POST" && path.endsWith("/commands")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      const fate = queue.shift() ?? "ok";
      if (fate === "lose-before") throw new TypeError("network");
      if (fate === "500") return json({ error: { code: "WRITE_UNAVAILABLE" } }, 503);
      if (fate === "garbage") return json({ unexpected: true });
      if (fate === "forbidden") return rejected(body, "FORBIDDEN", 403);
      if (fate === "setup") return rejected(body, "SETUP_REQUIRED", 409);
      const known = facts.get(body.command_id as string);
      if (known) return json({ command: { ...known.fact, status: "already_applied" }, current: now(), state_version: String(state.stateVersion) });
      const intent = intentOf(body);
      if (fate === "conflict") return rejected(body, "VERSION_CONFLICT", 409);
      if (intent.kind !== "card.relearn") {
        const wanted = intent.kind === "card.exclude";
        if (state.excluded === wanted || state.version !== intent.expected_card_state_version) return rejected(body, "VERSION_CONFLICT", 409);
        state.excluded = wanted;
        state.version = state.version === null ? "1" : String(Number(state.version) + 1);
      }
      state.stateVersion++;
      const fact = actionFact(intent);
      facts.set(intent.command_id, { intent, fact });
      if (fate === "lose-after") throw new TypeError("network");
      return json({ command: fact, current: now(), state_version: String(state.stateVersion) });
    }
    const match = /\/commands\/([0-9a-f-]+)\?(.*)$/.exec(path);
    if (match) {
      gets.push(path);
      if (state.statusFailures > 0) { state.statusFailures--; throw new TypeError("network"); }
      const known = facts.get(match[1]);
      if (!known) return json({ command: { id: match[1], status: "not_found" }, current: profileCurrent(), state_version: String(state.stateVersion) });
      const hash = new URLSearchParams(match[2]).get("expected_intent_hash");
      return json({ command: { ...known.fact, status: "already_applied" }, current: now(), state_version: String(state.stateVersion),
        verified_intent_hash: hash });
    }
    throw new Error(`unexpected request ${path}`);
  });
  return { state, facts, posts, gets, fetcher, fates: queue };
}
export type CardActionServer = ReturnType<typeof cardActionServer>;
