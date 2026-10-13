import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WrittenResult } from "../api/generated";
import { WrittenAnswerResult, type WrittenAnswerResultProps } from "./WrittenAnswerResult";

afterEach(cleanup);
function props(): WrittenAnswerResultProps {
  const result: WrittenResult = { result_id: "result", assignment_id: "assignment", version: "1", status: "active", grade: 2, correct: false,
    accepted_at: "2026-09-30T12:00:00Z", answer_date: "2026-09-30", detail: { input: { kind: "text", text: "😀Hxus" },
      conjunction_hint: null, examples: null, variants: [{ parts: ["😀Haus"] }, { parts: ["Gebäude"] }],
      initial_check: { correct: false, variant_index: null, correct_answer: "😀Haus", other_answers: ["Gebäude"], matched_spans: [],
        input_errors: [{ start: 2, end: 3 }], answer_errors: [{ start: 2, end: 3 }],
        span_unit: "unicode_code_point", span_bounds: "start_inclusive_end_exclusive" } } };
  return { result, language: "ru", pending: null, grades: [], canCorrect: true, canNext: true, timer: null,
    onGrade: vi.fn(), onCorrect: vi.fn(), onNext: vi.fn() };
}

describe("server-provided answer presentation", () => {
  it.each(["ru", "uk", "en"] as const)("%s shows the saved full answer even when the original input was correct", language => {
    const p = props(), detail = p.result.detail!;
    p.result.correct = true; p.result.grade = 4;
    detail.input = { kind: "text", text: "HEIẞ!" };
    detail.variants = [{ parts: ["heiß"] }];
    Object.assign(detail.initial_check, { correct: true, variant_index: 0, correct_answer: "heiß",
      other_answers: [], input_errors: [], answer_errors: [] });
    const { container } = render(<WrittenAnswerResult {...p} language={language} canCorrect={false} />);
    expect(container.querySelector(".written-result-input .written-result-text")?.textContent).toBe("HEIẞ!");
    expect(container.querySelector(".written-correct-answer .written-result-text")?.textContent).toBe("heiß");
    expect(container.querySelector(".written-correct-answer .written-result-text")?.getAttribute("lang")).toBe("de");
    expect(container.querySelectorAll(".written-error")).toHaveLength(0);
    expect(p.onCorrect).not.toHaveBeenCalled(); expect(p.onNext).not.toHaveBeenCalled();
  });
  it.each([null, "changing", "unknown"] as const)("keeps the answered conjunction context during %s", pending => {
    const p = props(); p.result.detail!.conjunction_hint = { meaning_category: "konditional", verb_position: "Verb am Ende" };
    render(<WrittenAnswerResult {...p} pending={pending} />);
    expect(screen.getByText("konditional").lang).toBe("de"); expect(screen.getByText("Verb am Ende").lang).toBe("de");
    expect(p.onCorrect).not.toHaveBeenCalled(); expect(p.onNext).not.toHaveBeenCalled();
  });
  it("renders saved context as text and removes it when that result detail is unavailable", () => {
    const p = props(); p.result.detail!.conjunction_hint = {
      meaning_category: "<img src=x onerror=bad()>", verb_position: "<script>bad()</script>" };
    const { container, rerender } = render(<WrittenAnswerResult {...p} />);
    expect(container.querySelectorAll("img,script")).toHaveLength(0);
    expect(screen.getByText("<img src=x onerror=bad()>")).toBeTruthy();
    rerender(<WrittenAnswerResult {...p} result={{ ...p.result, detail: null }} />);
    expect(container.querySelector(".written-conjunction")).toBeNull();
  });
  it("highlights only the two erroneous code-point ranges without splitting an emoji", () => {
    const p = props(); const { container } = render(<WrittenAnswerResult {...p} />);
    expect(Array.from(container.querySelectorAll(".written-error"), e => e.textContent)).toEqual(["x", "a"]);
    expect(container.querySelector(".written-result-text")?.textContent).toBe("😀Hxus");
    expect(container.querySelectorAll(".written-result-text")[1].textContent).toBe("😀Haus");
    expect(screen.getByRole("status").textContent).toBe("Есть ошибка");
    expect(screen.getByRole("list").textContent).toBe("Gebäude");
  });
  it("preserves all original code points in a decomposed accented fragment", () => {
    const p = props(); p.result.detail!.input = { kind: "text", text: "Ha\u0308user" };
    p.result.detail!.initial_check.input_errors = [{ start: 1, end: 3 }];
    const { container } = render(<WrittenAnswerResult {...p} />);
    expect(container.querySelector(".written-error")?.textContent).toBe("a\u0308");
    expect(container.querySelector(".written-result-text")?.textContent).toBe("Ha\u0308user");
  });
  it("renders markup in submitted, correct and alternate answers only as text", () => {
    const p = props(), detail = p.result.detail!;
    detail.input = { kind: "text", text: "<img src=x onerror=alert(1)>" };
    Object.assign(detail.initial_check, { correct_answer: "<script>bad()</script>", other_answers: ["<a href=x>word</a>"],
      input_errors: [], answer_errors: [] });
    const { container } = render(<WrittenAnswerResult {...p} />);
    expect(container.querySelectorAll("img,script,a")).toHaveLength(0);
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain("<script>bad()</script>");
  });
  it.each(["ru", "uk", "en"] as const)("%s localizes the explanation while keeping the saved German answers", language => {
    const p = props(); render(<WrittenAnswerResult {...p} language={language} />);
    expect(screen.getByRole("status").textContent).toBe({ ru: "Есть ошибка", uk: "Є помилка", en: "There is a mistake" }[language]);
    expect(screen.getByRole("list").textContent).toBe("Gebäude");
  });
  it("a correction changes the saved-result label, not the original text analysis", () => {
    const p = props(); p.result.grade = 4; p.result.correct = true; p.result.version = "2";
    const { container } = render(<WrittenAnswerResult {...p} grades={[3, 4, 5]} canCorrect={false} />);
    expect(screen.getByRole("status").textContent).toBe("Ответ исправлен");
    expect(Array.from(container.querySelectorAll(".written-error"), e => e.textContent)).toEqual(["x", "a"]);
    expect(screen.queryByRole("button", { name: "Исправить ответ" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Легко" })); expect(p.onGrade).toHaveBeenCalledWith(5);
  });
  it.each(["changing", "unknown"] as const)("%s does not claim a confirmed grade and blocks mutations and navigation", pending => {
    const p = props(); p.result.grade = 4; p.result.correct = true;
    const { container } = render(<WrittenAnswerResult {...p} pending={pending} grades={[3, 4, 5]} timer={{ key: "old", durationMs: 3000 }} />);
    expect(screen.getByRole("status").textContent).toBe(pending === "changing" ? "Сохраняем изменение" : "Проверяем изменение");
    expect(container.querySelector("svg")).toBeNull(); expect(container.querySelector(".written-timer")).toBeNull();
    for (const button of screen.getAllByRole("button")) fireEvent.click(button);
    expect(p.onGrade).not.toHaveBeenCalled(); expect(p.onCorrect).not.toHaveBeenCalled(); expect(p.onNext).not.toHaveBeenCalled();
  });
  it("legacy absent diagnostics remain neutral, without inventing a match or hiding the full answer", () => {
    const p = props(); delete p.result.detail!.initial_check.input_errors; delete p.result.detail!.initial_check.answer_errors;
    const { container } = render(<WrittenAnswerResult {...p} />);
    expect(container.querySelector(".written-error")).toBeNull(); expect(container.textContent).toContain("😀Haus");
  });
  it("collected detail is reported without fabricating the submitted text", () => {
    const p = props(); p.result.detail = null; render(<WrittenAnswerResult {...p} />);
    expect(screen.getByText("Разбор ответа больше недоступен")).toBeTruthy();
    expect(screen.queryByText("😀Hxus")).toBeNull();
  });
  it("forgot displays the declared action and the complete correct answer", () => {
    const p = props(); p.result.detail!.input = { kind: "forgot" };
    Object.assign(p.result.detail!.initial_check, { input_errors: [], answer_errors: [] });
    render(<WrittenAnswerResult {...p} />); expect(screen.getByText("Забыл…")).toBeTruthy(); expect(screen.getByText("😀Haus")).toBeTruthy();
  });
  it("a timer paused by a read continues the bar from its level; a fresh timer starts full", () => {
    const p = props(); const { container, rerender } = render(<WrittenAnswerResult {...p} timer={{ key: "k:0", durationMs: 3000 }} />);
    const bar = () => (container.querySelector(".written-timer span") as HTMLElement).style;
    expect(bar().animationDuration).toBe("3000ms"); expect(bar().animationDelay).toBe("");
    rerender(<WrittenAnswerResult {...p} timer={{ key: "k:1", durationMs: 1000, elapsedMs: 2000 }} />);
    // The whole bar lasts the original 3 s and starts 2 s in: it drains the last second from where it was.
    expect(bar().animationDuration).toBe("3000ms"); expect(bar().animationDelay).toBe("-2000ms");
  });
  it("only offered actions can run; a timer animation never invokes any callback", () => {
    const p = props(); const { container, rerender } = render(<WrittenAnswerResult {...p} canCorrect={false} canNext={false}
      timer={{ key: "session:result:1:1", durationMs: 2000 }} />);
    const line = container.querySelector(".written-timer span")!; fireEvent.animationEnd(line);
    expect(p.onNext).not.toHaveBeenCalled(); expect(p.onGrade).not.toHaveBeenCalled(); expect(p.onCorrect).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Исправить ответ" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Далее" })); expect(p.onNext).not.toHaveBeenCalled();
    rerender(<WrittenAnswerResult {...p} timer={{ key: "session:result:2:2", durationMs: 3000 }} />);
    expect(container.querySelector(".written-timer span")).not.toBe(line);
    fireEvent.click(screen.getByRole("button", { name: "Исправить ответ" })); expect(p.onCorrect).toHaveBeenCalledOnce();
  });
});

describe("example after a written answer (К05-126)", () => {
  const common = (n: number, role: "general" | "wechsel_location" | "wechsel_direction" | null = "general") =>
    ({ id: `example-${n}`, text: `Beispiel ${n}`, role, highlighted_parts: [{ start: 0, end: 8 }] });
  const withExamples = (examples: NonNullable<WrittenResult["detail"]>["examples"]) => {
    const p = props(); p.result.detail!.examples = examples; return p;
  };
  const shown = (container: HTMLElement) => [...container.querySelectorAll(".german-example")].map(node => node.textContent);

  it("is shown only when the written quiz asks for it: Learning and conjugation render the same result without it", () => {
    const p = withExamples({ common: [common(1)], personal: null });
    const { container, rerender } = render(<WrittenAnswerResult {...p} />);
    expect(shown(container)).toEqual([]);
    rerender(<WrittenAnswerResult {...p} example={{ random: () => 0 }} />);
    expect(shown(container)).toEqual(["Beispiel 1"]);
    expect(container.querySelector(".german-example strong")?.textContent).toBe("Beispiel");
    expect(container.querySelector(".german-example")?.getAttribute("lang")).toBe("de");
  });
  it("prefers the personal example; without one, one random common example; never a heading or translation", () => {
    const personal = withExamples({ common: [common(1), common(2)], personal: { value: "Mein Satz", version: "1" } });
    const random = vi.fn(() => 0.9);
    const first = render(<WrittenAnswerResult {...personal} example={{ random }} />);
    expect(shown(first.container)).toEqual(["Mein Satz"]); expect(random).not.toHaveBeenCalled();
    expect(screen.queryByText(/Пример/)).toBeNull();
    first.unmount();
    const general = withExamples({ common: [common(1), common(2), common(3)], personal: null });
    const second = render(<WrittenAnswerResult {...general} example={{ random: () => 0.5 }} />);
    expect(shown(second.container)).toEqual(["Beispiel 2"]);
  });
  it("keeps one choice for the result across re-renders and revisions, and shows nothing without examples", () => {
    const p = withExamples({ common: [common(1), common(2)], personal: null });
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValue(0.9);
    const { container, rerender } = render(<WrittenAnswerResult {...p} example={{ random }} />);
    expect(shown(container)).toEqual(["Beispiel 1"]);
    rerender(<WrittenAnswerResult {...p} result={{ ...p.result, version: "2", grade: 4, correct: true }} example={{ random }} />);
    expect(shown(container)).toEqual(["Beispiel 1"]); expect(random).toHaveBeenCalledOnce();
    rerender(<WrittenAnswerResult {...p} result={{ ...p.result, detail: { ...p.result.detail!, examples: { common: [], personal: null } } }}
      example={{ random }} />);
    expect(shown(container)).toEqual([]);
    rerender(<WrittenAnswerResult {...p} result={{ ...p.result, detail: null }} example={{ random }} />);
    expect(shown(container)).toEqual([]);
  });
  it("shows both common examples of a wechsel preposition, Akkusativ (direction) first (К05-127): no single random example", () => {
    const p = withExamples({ common: [common(1, "wechsel_location"), common(2, "wechsel_direction")], personal: null });
    const { container } = render(<WrittenAnswerResult {...p} example={{ random: () => 0 }} />);
    expect(shown(container)).toEqual(["Beispiel 2", "Beispiel 1"]);
  });
});

// R12-08 вар.2: the learner's own association as a hint after a mistake (the first check failed; «Не помню» included).
describe("the learner's association after a mistake", () => {
  const own = { value: "Haus = дом, где ХАУс", version: "6" };
  const hint = () => screen.queryByRole("region", { name: "Твоя ассоциация" });
  const invite = "Своей ассоциации пока нет. Добавь её — так слово легче вспомнить.";
  const wrong = (association?: unknown) => {
    const p = props(); if (association !== undefined) Object.assign(p.result.detail!, { association }); return p;
  };

  it("B1 a mistake shows the own association after the right answer and the example, before the timer; text in the pair's language", () => {
    const p = { ...wrong(own), association: { textLanguage: "ru" }, timer: { key: "k", durationMs: 3000 }, example: { random: () => 0 } } as WrittenAnswerResultProps;
    p.result.detail!.examples = { common: [], personal: { value: "Mein Haus ist groß.", version: "1" } };
    const { container } = render(<WrittenAnswerResult {...p} />);
    expect(within(hint()!).getByText(own.value).getAttribute("lang")).toBe("ru");
    expect(screen.queryByText(invite)).toBeNull();
    const order = [screen.getByText("Mein Haus ist groß."), hint()!, container.querySelector(".written-timer")!];
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("B2 a correct first answer shows no block, whatever the property says", () => {
    const p = wrong(); const detail = p.result.detail!, check = detail.initial_check;
    p.result.correct = true; p.result.grade = 4;
    detail.input = { kind: "text", text: "😀Haus" };
    Object.assign(check, { correct: true, variant_index: 0, matched_spans: [{ start: 0, end: 5 }], input_errors: [], answer_errors: [] });
    render(<WrittenAnswerResult {...p} association={{ onAdd: vi.fn() }} />);
    expect(screen.queryByText("Твоя ассоциация")).toBeNull(); expect(screen.queryByText(invite)).toBeNull();
    expect(screen.queryByRole("button", { name: "Добавить ассоциацию" })).toBeNull();
  });
  it("B3 «Не помню» is a mistake: the block is shown", () => {
    const p = wrong(own); p.result.detail!.input = { kind: "forgot" };
    Object.assign(p.result.detail!.initial_check, { input_errors: [], answer_errors: [] });
    render(<WrittenAnswerResult {...p} association={{}} />);
    expect(within(hint()!).getByText(own.value)).toBeTruthy();
  });
  it("B4 the block stays after «Исправить ответ»: the initial check decides, not the corrected grade", () => {
    const p = wrong(own); p.result.correct = true; p.result.grade = 4;
    render(<WrittenAnswerResult {...p} association={{}} />);
    expect(screen.getByRole("status").textContent).toBe("Ответ исправлен"); expect(within(hint()!).getByText(own.value)).toBeTruthy();
  });
  it("B5 none of their own: the invitation with the button when the screen can open the card, otherwise the line alone (R13-07)", () => {
    const onAdd = vi.fn(), p = wrong(null);
    const ui = render(<WrittenAnswerResult {...p} association={{ onAdd }} />);
    expect(within(hint()!).getByText(invite)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Добавить ассоциацию" })); expect(onAdd).toHaveBeenCalledOnce();
    ui.rerender(<WrittenAnswerResult {...p} association={{}} />);
    expect(within(hint()!).getByText(invite)).toBeTruthy(); expect(screen.queryByRole("button", { name: "Добавить ассоциацию" })).toBeNull();
    ui.rerender(<WrittenAnswerResult {...wrong({ value: " \n", version: "2" })} association={{}} />);
    expect(within(hint()!).getByText(invite)).toBeTruthy();
  });
  it("B6 no property (the conjugation test) or no key (an older core) or no detail: no block, no invitation", () => {
    const ui = render(<WrittenAnswerResult {...wrong(own)} />);
    expect(hint()).toBeNull(); expect(screen.queryByText("Ассоциация")).toBeNull();
    ui.rerender(<WrittenAnswerResult {...wrong()} association={{ onAdd: vi.fn() }} />);
    expect(hint()).toBeNull(); expect(screen.queryByText(invite)).toBeNull();
    ui.rerender(<WrittenAnswerResult {...wrong(own)} result={{ ...wrong(own).result, detail: null }} association={{}} />);
    expect(hint()).toBeNull();
  });
  it.each([["uk", "Твоя асоціація", "Своєї асоціації поки немає. Додай її — так слово легше згадати.", "Додати асоціацію"],
    ["en", "Your association", "You have no association of your own yet. Add one to make the word easier to recall.", "Add association"]] as const)(
    "B7 %s texts", (language, title, text, add) => {
      render(<WrittenAnswerResult {...wrong(null)} language={language} association={{ onAdd: vi.fn() }} />);
      expect(within(screen.getByRole("region", { name: title })).getByText(text)).toBeTruthy();
      expect(screen.getByRole("button", { name: add })).toBeTruthy();
    });
});
