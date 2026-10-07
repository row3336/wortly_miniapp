import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictionaryCardView } from "../../api/generated";
import { validDictionaryView } from "../viewApi";
import { CardScreen, type CardScreenProps } from "./CardScreen";
import type { ManualControl } from "./CardStudyBlock";
import { CARD, cardView, direction, excluded, general, location, preposition, response, reviewing } from "./cardTestData.test-support";

afterEach(cleanup);

const idle = (): ManualControl => ({ status: "idle", enabled: true, onChange: vi.fn(), onRetry: vi.fn() });
function show(view: DictionaryCardView | null, patch: Partial<CardScreenProps> = {}) {
  if (view) expect(validDictionaryView(response(view), CARD)).toBe(true);
  const props: CardScreenProps = { language: "ru", phase: view ? "ready" : "loading", problem: null, view, origin: { kind: "dictionary" },
    manual: idle(), onBack: vi.fn(), onRetry: vi.fn(), ...patch };
  render(<CardScreen {...props} />);
  return props;
}
const study = () => screen.getByRole("region", { name: "Изучение" });
const examples = () => screen.getByRole("region", { name: "Примеры" });
const texts = (root: HTMLElement) => Array.from(root.querySelectorAll(".german-example")).map(node => node.textContent);

describe("М12 content (RA 6.1.9, TA §7, Т28)", () => {
  it("noun: article with singular, plural, translation, examples, association; type and CEFR visible", () => {
    const view = cardView();
    view.content.examples = { common: [general], personal: null };
    show(view);
    const order = ["reference-word", "reference-translation", "card-examples", "reference-association"]
      .map(name => document.querySelector(`.${name}`)!);
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("das Haus");
    expect(document.querySelector(".reference-plural")!.textContent).toBe("Häuser");
    expect(screen.getByText("Существительное")).toBeTruthy();
    expect(screen.getByText("A1")).toBeTruthy();
    // The empty association is applicable: «Не заполнено».
    expect(within(screen.getByRole("region", { name: "Ассоциация" })).getByText("Не заполнено")).toBeTruthy();
  });

  it("an applicable empty field shows «Не заполнено», a not applicable one is hidden (Т28)", () => {
    const view = cardView();
    view.content.grammar = { gender: "neuter", gender_status: "applicable", singular: "Haus", singular_status: "applicable",
      plural: null, plural_status: "not_applicable", article_status: "applicable" };
    view.content.translations = { common: [], personal: null };
    view.study.facts.common_translation_present = false;
    show(view);
    expect(document.querySelector(".reference-plural")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Перевод" })).getByText("Не заполнено")).toBeTruthy();
    expect(within(examples()).getByText("Не заполнено")).toBeTruthy();
  });

  it("verb: the two tense tables stay side by side (Q24 pending), hat/ist with Partizip II together", () => {
    const view = cardView();
    view.content.card = { ...view.content.card, lemma: "gehen", type: "verb" };
    view.study.card_type = "verb";
    view.content.grammar = { infinitive: "gehen", infinitive_status: "applicable", preterite: "ging", preterite_status: "applicable",
      participle_ii: "gegangen", participle_ii_status: "applicable", auxiliary: "sein", auxiliary_status: "applicable", separability: "unknown" };
    const forms = (values: string[]) => ["ich", "du", "er_sie_es", "wir", "ihr", "sie_sie"]
      .map((pronoun_group, i) => ({ pronoun_group: pronoun_group as "ich", value: values[i], status: "applicable" as const }));
    view.content.reference_conjugations = [{ tense: "present", forms: forms(["gehe", "gehst", "geht", "gehen", "geht", "gehen"]) },
      { tense: "preterite", forms: forms(["ging", "gingst", "ging", "gingen", "gingt", "gingen"]) }];
    show(view);
    expect(document.querySelector(".reference-compound")!.textContent).toBe("ist gegangen");
    expect(Array.from(document.querySelectorAll(".reference-conjugations caption")).map(node => node.textContent)).toEqual(["Präsens", "Präteritum"]);
  });

  it("personal translation replaces the common one with its mark (RA 6.1.11)", () => {
    const view = cardView(); view.content.translations = { common: ["дом"], personal: { value: "домик", version: "2" } };
    show(view);
    const block = screen.getByRole("region", { name: "Перевод" });
    expect(within(block).getByText("Личный перевод")).toBeTruthy();
    expect(within(block).queryByText("дом")).toBeNull();
    expect(within(block).getByText("домик")).toBeTruthy();
  });
});

describe("М12 examples (К07-104, К05-127, Т16, Т85)", () => {
  it("an own example replaces every common one and is marked as personal", () => {
    const view = cardView(); view.content.examples = { common: [general, { ...general, id: "00000000-0000-4000-8000-000000000809" }],
      personal: { value: "Mein Haus.", version: "2" } };
    show(view);
    expect(texts(examples())).toEqual(["Mein Haus."]);
    expect(within(examples()).getByText("Личный пример")).toBeTruthy();
  });
  it("without an own example: all common examples in source order", () => {
    const view = cardView(); view.content.examples = { common: [general, direction], personal: null };
    show(view);
    expect(texts(examples())).toEqual([general.text, direction.text]);
  });
  it("two-case preposition: 0 or 1 own role shows only the two common wechsel examples, Akkusativ first; a full pair shows both own with their cases", () => {
    show(preposition({ akkusativ: "Ich gehe in den Park.", dativ: null }));
    expect(texts(examples())).toEqual([direction.text, location.text]);
    expect(examples().textContent).not.toContain(general.text);
    cleanup();
    show(preposition({ akkusativ: "Ich gehe in den Park.", dativ: "Ich bin im Park." }));
    expect(texts(examples())).toEqual(["Ich gehe in den Park.", "Ich bin im Park."]);
    expect(Array.from(examples().querySelectorAll("dt")).map(node => node.textContent)).toEqual(["Akkusativ", "Dativ"]);
    // The preposition's category and cases are shown under the word (К07-017).
    expect(screen.getByText("Wechselpräposition")).toBeTruthy();
    expect(screen.getByText("Akkusativ / Dativ")).toBeTruthy();
  });
  it("a single own example of a two-case preposition stays stored but the common pair is shown", () => {
    const view = preposition(); view.content.examples.personal = { value: "Mein Satz.", version: "2" };
    show(view);
    expect(texts(examples())).toEqual([direction.text, location.text]);
  });
});

describe("М12 study block (RA 6.1.10)", () => {
  it("not yet selected: «В очереди на изучение» and «Добавить в обучение»", () => {
    const props = show(cardView());
    expect(within(study()).getByText("В очереди на изучение")).toBeTruthy();
    fireEvent.click(within(study()).getByRole("button", { name: "Добавить в обучение" }));
    expect(props.manual.onChange).toHaveBeenCalledWith(true);
  });
  it("manual selection: «В следующей группе слов» and «Убрать из следующей группы»", () => {
    const view = cardView(); view.study.facts.manual.selected = true;
    const props = show(view);
    expect(within(study()).getByText("В следующей группе слов")).toBeTruthy();
    fireEvent.click(within(study()).getByRole("button", { name: "Убрать из следующей группы" }));
    expect(props.manual.onChange).toHaveBeenCalledWith(false);
  });
  it("current Learning: only «Изучается», no interval, date or action", () => {
    const view = reviewing();
    view.study.facts.learning.current = { group_id: "00000000-0000-4000-8000-000000000b01", group_status: "active", member_status: "active", member_version: "1" };
    view.study.directions.forEach(item => { item.schedule = null; item.interval_preview = null; });
    view.card_actions = { exclude: false, return: false, relearn: false };
    show(view);
    expect(study().textContent).toBe("Изучается");
  });
  it("ordinary reviews: both directions with «Интервал» and «Следующий повтор», no pencils or buttons", () => {
    show(reviewing());
    expect(within(study()).getAllByRole("term").map(term => term.textContent)).toEqual(["Рус → Нем", "Нем → Рус"]);
    expect(within(study()).getByText("Интервал: 8 дн.")).toBeTruthy();
    expect(within(study()).getAllByText(/^Следующий повтор: /)).toHaveLength(2);
    expect(within(study()).queryByRole("button")).toBeNull();
    expect(within(study()).queryByText("Предел достигнут")).toBeNull();
  });
  it("top step of the L1→De increase: «Предел достигнут» (К07-063)", () => {
    const view = reviewing(); view.study.directions[0].interval_preview = [];
    show(view);
    expect(within(study()).getAllByText("Предел достигнут")).toHaveLength(1);
  });
  it("written reviews off: status instead of the old L1→De terms, the oral direction keeps its terms (К07-058); no action buttons yet (Р1)", () => {
    show(excluded());
    expect(within(study()).getByText("Основные письменные повторы выключены")).toBeTruthy();
    expect(within(study()).getAllByText(/^Интервал: /).map(node => node.textContent)).toEqual(["Интервал: 8 дн."]);
    expect(screen.queryByRole("button", { name: /Вернуть|Не повторять|Изучить заново/ })).toBeNull();
  });
  it("from the oral quiz only De→L1 is shown", () => {
    show(reviewing(), { origin: { kind: "quiz", direction: "de-l1" } });
    expect(within(study()).getAllByRole("term").map(term => term.textContent)).toEqual(["Нем → Рус"]);
  });
  it("uses the working fallback when the UI language has no abbreviation for the pair (en / en-de)", () => {
    const view = reviewing(cardView(CARD, "en-de")); view.content.translations.common = ["house"];
    show(view, { language: "en" });
    expect(within(screen.getByRole("region", { name: "Study" })).getAllByRole("term").map(term => term.textContent))
      .toEqual(["Translation → German", "German → translation"]);
  });
  it("manual states: sending disables, unknown offers the same command again, failed explains", () => {
    const manual = idle();
    show(cardView(), { manual: { ...manual, status: "sending" } });
    expect((within(study()).getByRole("button", { name: "Сохраняем…" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    show(cardView(), { manual: { ...manual, status: "unknown" } });
    fireEvent.click(within(study()).getByRole("button", { name: "Повторить" }));
    expect(manual.onRetry).toHaveBeenCalledTimes(1);
    expect(within(study()).getByRole("alert").textContent).toBe("Изменение не подтверждено");
    cleanup();
    show(cardView(), { manual: { ...manual, status: "failed" } });
    expect(within(study()).getByRole("alert").textContent).toBe("Не удалось изменить обучение");
    cleanup();
    show(cardView(), { manual: { ...manual, enabled: false } });
    expect((within(study()).getByRole("button", { name: "Добавить в обучение" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("М12 screen states (RA 6.1.14)", () => {
  it("loading without a card, then a reread keeps the previous card busy and the manual action off", () => {
    show(null);
    expect(screen.getByRole("status").textContent).toBe("Загружаем карточку…");
    cleanup();
    show(cardView(), { phase: "loading" });
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true");
    expect((within(study()).getByRole("button", { name: "Добавить в обучение" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("failure: message with retry for a load problem, without retry for a denied access", () => {
    const props = show(null, { phase: "failed", problem: "load" });
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    cleanup();
    show(null, { phase: "failed", problem: "expired" });
    expect(screen.getByRole("alert").textContent).toBe("Не удалось загрузить карточку");
    expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
  });
  it("unavailable is its own state; Back always works", () => {
    const props = show(null, { phase: "unavailable" });
    expect(screen.getByText("Карточка недоступна")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });
  it("connection points render under the study block only with a shown card", () => {
    show(reviewing(), { actions: <p>m-actions</p>, interval: <p>m-intv</p> });
    expect(within(study()).getByText("m-intv")).toBeTruthy();
    const actions = screen.getByText("m-actions");
    expect(study().compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
