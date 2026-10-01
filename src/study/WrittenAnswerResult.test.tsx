import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
