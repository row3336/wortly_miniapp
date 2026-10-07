import { describe, expect, it } from "vitest";
import type { DictionarySearchResponse } from "../api/generated";
import { ApiError } from "../api/http";
import { DictionarySearchController, type DictionarySearchIo } from "./dictionarySearchController";
import type { SearchRequest } from "./searchApi";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const card = (n: number) => ({ card_id: id(n), revision: "1", lemma: `Wort${n}`, type: "noun" as const, cefr: null,
  translation: { common: [`слово${n}`], personal: null } });

/** Scripted pages per query: one ordinary item per page and a similar list on the first page. */
function harness() {
  const similar = new Map<string, number[]>([["Haus", [11]], ["Ha", [13]]]);
  const held = new Map<string, () => void>();
  const holds = new Set<string>();
  let failNext = false, pair: "ru-de" | "uk-de" = "ru-de";
  const io: DictionarySearchIo = {
    live: () => true,
    async read(request: SearchRequest) {
      if (holds.has(request.query)) {
        holds.delete(request.query);
        await new Promise<void>(done => held.set(request.query, done));
      }
      if (failNext) { failNext = false; throw new ApiError("network"); }
      const offset = request.cursor_token === null ? 0 : 1;
      const page: DictionarySearchResponse = { state_version: "1", query: request.query, pair, mode: request.mode,
        items: [{ ...card(1 + offset), match_kind: "prefix" }], next_cursor: offset === 0 ? "c1" : null,
        similar: request.cursor_token === null ? (similar.get(request.query) ?? []).map(card) : null };
      return page;
    },
  };
  const controller = new DictionarySearchController();
  controller.attach(() => {});
  let access = {};
  const scope = {};
  const commit = () => controller.commit({ access, pair, scope, floor: "1", limits: { suggest: 1, page: 1 }, io });
  const view = () => controller.view({ access, pair, open: true });
  /** A new opened access, e.g. the application foreground or another dictionary pair. */
  const newAccess = (next: "ru-de" | "uk-de" = pair) => { access = {}; pair = next; };
  return { similar, controller, commit, view, holds, held, newAccess,
    lemmas: () => view().similar.map(item => item.lemma), fail: () => { failNext = true; } };
}

describe("similar cards in the search document (K07-091)", () => {
  it("come from the first page apart from the results, stay through «Ещё» and leave with a new query", async () => {
    const h = harness();
    h.controller.setQuery("Haus"); h.commit(); await flush();
    expect(h.view().items.map(item => item.lemma)).toEqual(["Wort1"]);
    expect(h.lemmas()).toEqual(["Wort11"]);
    h.similar.set("Haus", [12]);
    h.controller.submit(); h.commit(); await flush();
    expect(h.lemmas()).toEqual(["Wort12"]);
    h.controller.loadMore(); h.commit(); await flush();
    expect(h.view().items.map(item => item.lemma)).toEqual(["Wort1", "Wort2"]);
    expect(h.lemmas()).toEqual(["Wort12"]);
    h.controller.setQuery("Hause");
    expect(h.lemmas()).toEqual([]);
    h.commit(); await flush();
    expect(h.lemmas()).toEqual([]);
  });

  it("a late first page of another query brings neither its results nor its similar cards", async () => {
    const h = harness();
    h.holds.add("Ha");
    h.controller.setQuery("Ha"); h.commit(); await flush();
    h.controller.setQuery("Haus"); h.commit(); await flush();
    expect(h.lemmas()).toEqual(["Wort11"]);
    h.held.get("Ha")!(); await flush();
    expect(h.view()).toMatchObject({ phase: "ready", query: "Haus" });
    expect(h.lemmas()).toEqual(["Wort11"]);
  });

  it("a failed read shows no similar cards; entry from another section clears them", async () => {
    const h = harness();
    h.controller.setQuery("Haus"); h.commit(); await flush();
    h.fail(); h.controller.submit(); h.commit(); await flush();
    expect(h.view()).toMatchObject({ phase: "failed", similar: [], items: [] });
    h.controller.retry(); h.commit(); await flush();
    expect(h.lemmas()).toEqual(["Wort11"]);
    h.controller.enterFromSection();
    expect(h.view()).toMatchObject({ query: "", similar: [], items: [] });
  });

  it("В5 (root decision): a card already among the results, also after «Ещё», is not shown again as similar", async () => {
    const h = harness();
    h.similar.set("Haus", [1, 11, 2]);
    h.controller.setQuery("Haus"); h.commit(); await flush();
    expect(h.lemmas()).toEqual(["Wort11", "Wort2"]);
    h.controller.submit(); h.commit(); await flush();
    h.controller.loadMore(); h.commit(); await flush();
    expect(h.view().items.map(item => item.lemma)).toEqual(["Wort1", "Wort2"]);
    expect(h.lemmas()).toEqual(["Wort11"]);
  });

  it("Р2-3: a new access of another pair clears the similar cards, also while its reread is still loading", async () => {
    const h = harness();
    h.controller.setQuery("Haus"); h.commit(); await flush();
    expect(h.lemmas()).toEqual(["Wort11"]);
    h.holds.add("Haus");
    h.newAccess("uk-de"); h.commit(); await flush();
    expect(h.view()).toMatchObject({ phase: "loading", pair: null, items: [], similar: [] });
    h.similar.set("Haus", [14]);
    h.held.get("Haus")!(); await flush();
    expect(h.view()).toMatchObject({ phase: "ready", pair: "uk-de" });
    expect(h.lemmas()).toEqual(["Wort14"]);
  });

  it("Р2-4: a reread of several full pages keeps the similar cards of the first page", async () => {
    const h = harness();
    h.controller.setQuery("Haus"); h.controller.submit(); h.commit(); await flush();
    h.controller.loadMore(); h.commit(); await flush();
    expect(h.view()).toMatchObject({ mode: "full", pagesLoaded: 2 });
    h.similar.set("Haus", [15]);
    h.newAccess(); h.commit(); await flush();
    expect(h.view()).toMatchObject({ phase: "ready", pagesLoaded: 2 });
    expect(h.view().items.map(item => item.lemma)).toEqual(["Wort1", "Wort2"]);
    expect(h.lemmas()).toEqual(["Wort15"]);
  });

  it("another pair hides the similar cards in the same render", async () => {
    const h = harness();
    h.controller.setQuery("Haus"); h.commit(); await flush();
    expect(h.controller.view({ access: {}, pair: "uk-de", open: true }).similar).toEqual([]);
  });
});
