// Flash watch for 2.33 (from QA C/M-STALE-NOFLASH-QA): record every moment a refusal-like text is visible to the user,
// and fake a replaced or once-refused document over an App test's synthetic server.
import { isInaccessible } from "@testing-library/react";
import { vi } from "vitest";
import { staleCommand, staleRefusal } from "./openRules.test-support";

export const refusalTexts = ["Не удалось", "не подтверждено", "недоступно", "Проверь состояние", "Проверить статус", "Проверьте"];

/** Collects every visible text node containing one of `texts`, after every DOM mutation (each React commit). */
export function watchFlash(root: HTMLElement, texts: string[] = refusalTexts) {
  const seen: string[] = [];
  const check = () => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.textContent ?? "";
      const parent = node.parentElement;
      if (!parent) continue;
      if (texts.some(text => value.includes(text)) && !isInaccessible(parent)) seen.push(value.trim());
    }
  };
  const observer = new MutationObserver(check);
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  check();
  return { seen, stop: () => observer.disconnect(), check };
}

/** Every text a DOM mutation publishes (a commit): added nodes, and both values of an overwritten text node. */
export function watchCommits(texts: string[]) {
  const seen: string[] = [];
  const note = (value: string | null) => { if (value && texts.some(text => value.includes(text))) seen.push(value.trim()); };
  const observer = new MutationObserver(records => records.forEach(record => {
    if (record.type === "characterData") { note(record.oldValue); note(record.target.textContent); }
    record.addedNodes.forEach(node => note(node.textContent));
  }));
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
  return { seen, stop: () => observer.disconnect() };
}

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const reply = (value: unknown, status: number) => new Response(JSON.stringify(value), { status });

/**
 * From now on this window's document is replaced: every document-bound request is DOCUMENT_STALE, a foreground waits for
 * `hold` and is then refused too. Auth and register still pass (they never name a document).
 */
export function replaceDocument(fetcher: ReturnType<typeof vi.fn<Fetch>>, hold: Promise<void>, options: { foreground?: "stale" | "live" } = {}) {
  const base = fetcher.getMockImplementation()!;
  let foregrounds = 0;
  fetcher.mockImplementation(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram") || path.endsWith("/client/register")) return base(url, init);
    if (path.endsWith("/client/open")) {
      if (body?.event !== "foreground") return base(url, init);
      foregrounds += 1;
      await hold;
      return options.foreground === "live" ? base(url, init) : reply(staleRefusal, 409);
    }
    if (init?.method === "POST" && body?.command_id) return reply(staleCommand(body.command_id, body.session_id ?? null, 9999, body.kind), 409);
    return reply(staleRefusal, 409);
  });
  return { foregrounds: () => foregrounds, restore: () => fetcher.mockImplementation(base) };
}

/** Only the next request matching `match` is refused as DOCUMENT_STALE; foregrounds wait for `hold` and then pass. */
export function refuseOnce(fetcher: ReturnType<typeof vi.fn<Fetch>>, match: (path: string, init?: RequestInit) => boolean, hold: Promise<void>) {
  const base = fetcher.getMockImplementation()!;
  let refused = 0, foregrounds = 0;
  fetcher.mockImplementation(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/client/open") && body?.event === "foreground") { foregrounds += 1; await hold; return base(url, init); }
    if (refused === 0 && match(path, init)) {
      refused += 1;
      if (init?.method === "POST" && body?.command_id) return reply(staleCommand(body.command_id, body.session_id ?? null, 9999, body.kind), 409);
      return reply(staleRefusal, 409);
    }
    return base(url, init);
  });
  return { refused: () => refused, foregrounds: () => foregrounds };
}

export function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
