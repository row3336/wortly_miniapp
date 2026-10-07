import type { DictionaryCardView } from "../api/generated";
import { cardView, reviewing } from "./card/cardTestData.test-support";

/**
 * The card endpoints of core for one reviewed word, with its manual increase (C-INTV) and the one undo offer (C-INTV-OFFER):
 * view, dictionary context, Learning state, context.open/close, interval.increase, action.undo_offer.open/close, action.undo.
 * The profile state version is the caller's (a quiz fixture shares its own); every accepted command bumps it.
 */
export type IntervalWorldOptions = { cardId: string; version: { get(): number; bump(): number }; id(n: number): string };

const LOCAL_DATE = "2026-10-07";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
export const addDays = (days: number, from = LOCAL_DATE) => {
  const date = new Date(`${from}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
};

type Written = { version: number; days: number; ladder: number[] };

export function intervalWorld(options: IntervalWorldOptions) {
  const { cardId } = options;
  const w = {
    written: { version: 2, days: 3, ladder: [9, 14, 22, 35, 56, 90, 150, 260] } as Written,
    contexts: new Map<string, "open" | "closed">(), next: 600,
    right: null as null | { action: string; context: string; version: number; status: "available" | "used" | "expired";
      before: Written; offer: "pending" | "offered" | "closed" | "consumed"; offerVersion: number },
    posts: [] as Record<string, any>[],
    /** The state version of the last accepted increase. */
    increasedAt: null as number | null,
  };
  const steps = () => w.written.ladder.map((days, index) => ({ option_id: index + 1, interval_days: days, next_due_date: addDays(days) }));
  const view = (): DictionaryCardView => {
    const value = reviewing(cardView(cardId));
    Object.assign(value.study.directions[0], { progress_version: String(w.written.version),
      schedule: { interval_days: w.written.days, next_due_date: addDays(w.written.days) },
      interval_preview: steps().map(step => ({ step_id: step.option_id, interval_days: step.interval_days, next_due_date: step.next_due_date })) });
    return value;
  };
  const context = (contextId: string) => {
    const status = w.contexts.get(contextId), reference = { id: contextId, kind: "dictionary", card_id: cardId };
    if (status === "closed") return { status, context: reference };
    if (status !== "open") return { status: "unavailable" };
    const options = steps();
    const live = w.right && w.right.context === contextId && w.right.status === "available"
      && (w.right.offer === "pending" || w.right.offer === "offered") ? w.right : null;
    return { status, context: reference, view: view(),
      interval: { local_date: LOCAL_DATE, expected_pair: "ru-de", direction: "l1-de", applicable: true,
        current_schedule: { interval_days: w.written.days, next_due_date: addDays(w.written.days), persisted: true },
        expected_progress_version: String(w.written.version), options,
        default_option_id: options.length ? Math.min(5, options.length) : null },
      capabilities: { interval_increase: options.length ? { direction: "l1-de" } : null,
        undo_offer: live ? { action_id: live.action, context_id: contextId, status: live.offer, version: String(live.offerVersion) } : null,
        undo_target: live?.offer === "offered"
          ? { action_id: live.action, kind: "interval.increase", version: String(live.version), context_id: contextId } : null } };
  };
  const reply = (fact: Record<string, unknown>, contextId: string) =>
    json({ command: fact, current: context(contextId), state_version: String(options.version.get()) });
  const refuse = (body: Record<string, any>, code: string, contextId: string) =>
    json({ command: { id: body.command_id, status: "rejected" }, current: context(contextId), state_version: String(options.version.get()),
      error: { code } }, 409);

  /** The response of a card endpoint, or null for any other request. */
  function handle(input: RequestInfo | URL, init?: RequestInit): Response | null {
    const url = new URL(String(input), "http://local");
    if (url.pathname === `/api/v1/dictionary/cards/${cardId}/view`) return json({ state_version: String(options.version.get()), current: view() });
    if (url.pathname.startsWith("/api/v1/dictionary/contexts/")) {
      return json({ state_version: String(options.version.get()), current: context(url.pathname.split("/").at(-1)!) });
    }
    if (url.pathname === "/api/v1/learning/current") return json({ pair: "ru-de", state_version: String(options.version.get()),
      manual_selection_version: "1", group: null, manual_selection: [], learning: { status: "new_group", ready: 0, preview: 0,
        next_due_at: null, new_group_size: 2, manual_eligible: 0, automatic_eligible: 2 } });
    if (url.pathname !== "/api/v1/commands" || init?.method !== "POST") return null;
    const body = JSON.parse(String(init.body));
    const kind = String(body.kind);
    if (!kind.startsWith("context.") && kind !== "interval.increase" && !kind.startsWith("action.undo")) return null;
    w.posts.push(body);
    const fact = (extra: Record<string, unknown>) => ({ id: body.command_id, kind, status: "applied", applied_at: "2026-10-07T09:00:00Z",
      target_id: cardId, action_id: null, result_id: null, context_id: body.context_id ?? null, object_version: null, ...extra });
    if (kind === "context.open") {
      for (const key of w.contexts.keys()) w.contexts.set(key, "closed");
      if (w.right) w.right.status = "expired";
      const contextId = options.id(w.next++); w.contexts.set(contextId, "open"); options.version.bump();
      return reply(fact({ context_id: contextId }), contextId);
    }
    const contextId: string = body.context_id;
    if (w.contexts.get(contextId) !== "open") return refuse(body, "DOCUMENT_STALE", contextId);
    if (kind === "context.close") {
      w.contexts.set(contextId, "closed"); if (w.right) w.right.status = "expired"; options.version.bump();
      return reply(fact({}), contextId);
    }
    if (kind === "interval.increase") {
      const step = steps().find(option => option.option_id === body.payload.option_id);
      if (!step || body.expected_progress_version !== String(w.written.version) || step.interval_days !== body.payload.interval_days) {
        return refuse(body, "VERSION_CONFLICT", contextId);
      }
      const before = structuredClone(w.written);
      w.written = { version: w.written.version + 1, days: step.interval_days, ladder: w.written.ladder.filter(days => days > step.interval_days) };
      const action = options.id(w.next++);
      w.right = { action, context: contextId, version: 1, status: "available", before, offer: "pending", offerVersion: 1 };
      w.increasedAt = options.version.bump();
      return reply(fact({ action_id: action, object_version: "1" }), contextId);
    }
    const right = w.right;
    if (!right || right.action !== body.action_id || right.status !== "available" || right.context !== contextId) {
      return refuse(body, "CAPABILITY_EXPIRED", contextId);
    }
    if (kind === "action.undo_offer.open" || kind === "action.undo_offer.close") {
      if (right.offer !== "pending" && right.offer !== "offered") return refuse(body, "CAPABILITY_EXPIRED", contextId);
      right.offerVersion++; right.offer = kind === "action.undo_offer.open" ? "offered" : "closed";
      if (right.offer === "closed") right.status = "expired";
      options.version.bump();
      return reply(fact({ target_id: right.action, object_version: String(right.offerVersion) }), contextId);
    }
    if (right.offer !== "offered") return refuse(body, "CAPABILITY_EXPIRED", contextId);
    w.written = { ...right.before, version: w.written.version + 1 };
    right.status = "used"; right.version++; right.offer = "consumed";
    options.version.bump();
    return reply(fact({ action_id: right.action, object_version: String(right.version) }), contextId);
  }
  return Object.assign(w, { handle, view, kinds: () => w.posts.map(post => String(post.kind)) });
}
export type IntervalWorld = ReturnType<typeof intervalWorld>;
