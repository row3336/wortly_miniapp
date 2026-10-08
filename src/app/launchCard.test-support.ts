import type { Mock } from "vitest";
import type { DictionaryCardView } from "../api/generated";
import { cardView } from "../dictionary/card/cardTestData.test-support";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

/** The launch address of a bot message button, as Telegram opens it (answer Q20). */
export const launch = (search: string) => window.history.replaceState(null, "", `/${search}`);

/**
 * Serves the card screen over an App test server: the card read (/view) and its context commands, the rest goes to the
 * server as before. `learning` also answers the card's manual-selection read, for a server that has no Learning of its own.
 * `exclude` accepts «Не повторять» once and runs the server's side effects on the study session (as core does).
 */
export function serveLaunchCard(fetcher: Mock<Fetch>, cardId: string,
  options: { hidden?: boolean; learning?: boolean; view?: (cardId: string) => DictionaryCardView; exclude?: () => void } = {}) {
  const base = fetcher.getMockImplementation()!;
  const shown = options.view ?? cardView;
  let state = 1000, next = 600;
  fetcher.mockImplementation(async (url, init) => {
    const target = new URL(String(url), "http://localhost");
    if (target.pathname.endsWith("/view")) {
      return response({ state_version: String(state), current: options.hidden ? { status: "unavailable" } : shown(cardId) });
    }
    if (options.learning && target.pathname.endsWith("/learning/current")) return response({ pair: "ru-de", state_version: String(state),
      manual_selection_version: "1", group: null, manual_selection: [], learning: { status: "new_group", ready: 0, preview: 0,
        next_due_at: null, new_group_size: 2, manual_eligible: 0, automatic_eligible: 2 } });
    const body = init?.method === "POST" && target.pathname.endsWith("/commands") ? JSON.parse(String(init.body)) : null;
    if (body?.kind === "context.open" || body?.kind === "context.close") {
      const contextId: string = body.kind === "context.open" ? `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}` : body.context_id;
      state++;
      // The context carries the card without a local date, so it offers no interval preview either.
      const view = shown(cardId); view.study.local_date = null;
      view.study.directions.forEach(direction => { direction.interval_preview = null; });
      const reference = { id: contextId, kind: "dictionary", card_id: cardId };
      return response({ command: { id: body.command_id, kind: body.kind, status: "applied", applied_at: "2026-10-07T09:00:00Z",
        target_id: cardId, action_id: null, result_id: null, context_id: contextId, object_version: null },
        current: body.kind === "context.open" ? { status: "open", context: reference, view, interval: null,
          capabilities: { interval_increase: null, undo_offer: null, undo_target: null } } : { status: "closed", context: reference },
        state_version: String(state) });
    }
    if (body?.kind === "card.exclude" && options.exclude) {
      options.exclude();
      state++;
      return response({ command: { id: body.command_id, kind: body.kind, status: "applied", applied_at: "2026-10-07T09:00:00Z",
        target_id: cardId, action_id: "00000000-0000-4000-8000-000000000777", result_id: null, context_id: null, object_version: "1" },
        current: { status: "available", card_id: cardId, pair: "ru-de", excluded: true, version: "1",
          actions: { exclude: false, return: true, relearn: false } }, state_version: String(state) });
    }
    return base(url, init);
  });
  const reads = () => fetcher.mock.calls.filter(([url]) => new URL(String(url), "http://localhost").pathname.endsWith("/view"))
    .map(([url]) => new URL(String(url), "http://localhost"));
  return {
    /** Paths of the card reads, in order. */
    views: () => reads().map(url => url.pathname),
    /** Query strings of the card reads, in order: the origin they claim. */
    origins: () => reads().map(url => url.search),
  };
}

/** Commands that are not the card context of the launch card: any of them would be a study side effect of the card. */
export const besidesContext = (kinds: string[]) => kinds.filter(kind => kind !== "context.open" && kind !== "context.close");
