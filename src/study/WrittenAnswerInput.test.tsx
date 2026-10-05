import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { current } from "../learning/learningFixtures.test-support";
import { WrittenAnswerInput, type WrittenAnswerInputProps } from "./WrittenAnswerInput";
import type { ConjugationAssignment } from "../api/generated";
import { conjugationQuestion, conjugationWrittenQuestion } from "../conjugation/conjugationQuestion";
import { ConjugationQuestionHeading } from "../conjugation/ConjugationQuestionHeading";
import type { WrittenAnswerQuestion } from "./WrittenAnswerInput";

afterEach(cleanup);
function props(patch: Partial<WrittenAnswerInputProps> = {}): WrittenAnswerInputProps {
  const assignment = current().assignment!;
  assignment.answer_spec = { ...assignment.answer_spec, kind: "forms", labels: ["Singular", "Plural"], part_count: 2 };
  return { assignment, value: "", language: "ru", readOnly: false, canSubmit: true, canForget: true, submitOnEnter: true,
    onChange: vi.fn(), onSubmit: vi.fn(), onForget: vi.fn(), ...patch };
}
function Controlled({ source }: { source: WrittenAnswerInputProps }) {
  const [value, setValue] = useState(source.value);
  return <WrittenAnswerInput {...source} value={value} onChange={next => { source.onChange(next); setValue(next); }} />;
}
const field = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("one written answer field", () => {
  it("shows conjunction context and the independent personal hint before sending any answer", () => {
    const p = props(); p.assignment.prompt = { ...p.assignment.prompt, hint: "личная подсказка",
      conjunction_hint: { meaning_category: "konditional", verb_position: "Verb am Ende" } };
    const { container, rerender } = render(<WrittenAnswerInput {...p} />);
    expect(screen.getByText("konditional").lang).toBe("de"); expect(screen.getByText("Verb am Ende").lang).toBe("de");
    expect(screen.getByText("личная подсказка")).toBeTruthy();
    expect(p.onSubmit).not.toHaveBeenCalled(); expect(p.onChange).not.toHaveBeenCalled();
    rerender(<WrittenAnswerInput {...p} assignment={{ ...p.assignment, id: "another",
      prompt: { ...p.assignment.prompt, conjunction_hint: null } }} />);
    expect(container.querySelector(".written-conjunction")).toBeNull();
  });
  it.each([
    ["ru", "Категория не заполнена", "Положение глагола не заполнено"],
    ["uk", "Категорію не заповнено", "Положення дієслова не заповнено"],
    ["en", "Category not filled in", "Verb position not filled in"],
  ] as const)("%s distinguishes unfilled conjunction grammar from absent context", (language, category, position) => {
    const p = props({ language }); p.assignment.prompt.conjunction_hint = { meaning_category: null, verb_position: null };
    render(<WrittenAnswerInput {...p} />);
    expect(screen.getByText(category).lang).toBe(language); expect(screen.getByText(position).lang).toBe(language);
  });
  it.each([
    ["ru", "Заполнено частей (примерно): 1 из 2"],
    ["uk", "Заповнено частин (приблизно): 1 із 2"],
    ["en", "Parts entered (approx.): 1 of 2"],
  ] as const)("%s describes approximate occupancy without judging or sending the draft", (language, message) => {
    const p = props({ language, value: "der Quatsch" }); render(<WrittenAnswerInput {...p} />);
    const hint = screen.getByText(message);
    expect(field().getAttribute("aria-describedby")?.split(" ")).toContain(hint.id);
    expect(hint.getAttribute("aria-live")).toBe("polite");
    expect(p.onChange).not.toHaveBeenCalled(); expect(p.onSubmit).not.toHaveBeenCalled();
    expect(field().value).toBe("der Quatsch");
  });
  it("updates the estimate while typing, but incomplete or separator-only input can still be submitted unchanged", () => {
    const p = props(); render(<Controlled source={p} />); const element = field(); element.focus();
    expect(screen.getByText("Заполнено частей (примерно): 0 из 2")).toBeTruthy();
    fireEvent.change(element, { target: { value: "das Haus" } });
    expect(screen.getByText("Заполнено частей (примерно): 1 из 2")).toBeTruthy();
    fireEvent.keyDown(element, { key: "Enter" }); expect(p.onSubmit).toHaveBeenCalledOnce();
    fireEvent.change(element, { target: { value: "das Haus ↔ falscherPlural" } });
    expect(screen.getByText("Заполнено частей (примерно): 2 из 2")).toBeTruthy();
    fireEvent.change(element, { target: { value: " , / ◆ " } });
    expect(screen.getByText("Заполнено частей (примерно): 0 из 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить" })); expect(p.onSubmit).toHaveBeenCalledTimes(2);
    expect(field()).toBe(element); expect(document.activeElement).toBe(element); expect(field().value).toBe(" , / ◆ ");
  });
  it("uses the current question's shape after a read-only phase without replacing the input", () => {
    const p = props({ value: "das Haus / falsch", readOnly: true });
    const { rerender } = render(<WrittenAnswerInput {...p} />); const element = field();
    expect(screen.getByText("Заполнено частей (примерно): 2 из 2")).toBeTruthy();
    const assignment = { ...p.assignment, id: "next", answer_spec: { ...p.assignment.answer_spec,
      kind: "phrase" as const, labels: ["Satz"], part_count: 1 } };
    rerender(<WrittenAnswerInput {...p} assignment={assignment} readOnly={false} value="" />);
    expect(screen.getByText("Заполнено частей (примерно): 0 из 1")).toBeTruthy();
    expect(screen.getByText("Satz").lang).toBe("de"); expect(field()).toBe(element);
    expect(p.onSubmit).not.toHaveBeenCalled(); expect(p.onChange).not.toHaveBeenCalled();
  });
  it.each(["ru", "uk", "en"] as const)("%s labels remain local, while required forms use the saved German labels", language => {
    const p = props({ language }); render(<WrittenAnswerInput {...p} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(field().labels?.[0].textContent).toBe({ ru: "Твой ответ", uk: "Твоя відповідь", en: "Your answer" }[language]);
    expect(screen.getByText("Singular / Plural").lang).toBe("de");
    expect(screen.getByRole("heading").textContent).toBe("дом");
    expect(field().getAttribute("spellcheck")).toBe("false");
  });
  it("does not send whitespace, even when the owner is ready", () => {
    const p = props({ value: " \n " }); const { container } = render(<WrittenAnswerInput {...p} />);
    fireEvent.keyDown(field(), { key: "Enter" }); fireEvent.submit(container.querySelector("form")!);
    expect(p.onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Забыл…" })); expect(p.onForget).toHaveBeenCalledOnce();
  });
  it("Enter and the submit button delegate the unchanged controlled input", () => {
    const p = props({ value: "das Haus, Häuser" }); render(<WrittenAnswerInput {...p} />);
    fireEvent.keyDown(field(), { key: "Enter" }); fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    expect(p.onSubmit).toHaveBeenCalledTimes(2); expect(p.onChange).not.toHaveBeenCalled();
    expect(field().value).toBe("das Haus, Häuser");
  });
  it("the code parameter disables Enter without disabling the submit button", () => {
    const p = props({ value: "Haus", submitOnEnter: false }); render(<WrittenAnswerInput {...p} />);
    fireEvent.keyDown(field(), { key: "Enter" }); expect(p.onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Проверить" })); expect(p.onSubmit).toHaveBeenCalledOnce();
  });
  it("IME composition cannot submit, forget or insert a symbol before it finishes", () => {
    const p = props({ value: "Haus" }); const { container } = render(<WrittenAnswerInput {...p} />);
    fireEvent.compositionStart(field()); fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.submit(container.querySelector("form")!); fireEvent.click(screen.getByRole("button", { name: "Забыл…" }));
    fireEvent.click(screen.getByRole("button", { name: "ä" }));
    expect(p.onSubmit).not.toHaveBeenCalled(); expect(p.onForget).not.toHaveBeenCalled(); expect(p.onChange).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field()); fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(field(), { key: "Enter", keyCode: 229 }); expect(p.onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: "Enter" }); expect(p.onSubmit).toHaveBeenCalledOnce();
  });
  it("holding Enter cannot answer a later assignment", () => {
    const p = props({ value: "Haus" }); const { rerender } = render(<WrittenAnswerInput {...p} />);
    fireEvent.keyDown(field(), { key: "Enter" });
    rerender(<WrittenAnswerInput {...p} assignment={{ ...p.assignment, id: "next" }} value="Baum" />);
    fireEvent.keyDown(field(), { key: "Enter", repeat: true }); expect(p.onSubmit).toHaveBeenCalledOnce();
  });
  it.each(["ä", "ö", "ü", "ß"])("%s replaces the selection and restores its caret without submitting", symbol => {
    const p = props({ value: "😀Hauser" }); render(<Controlled source={p} />);
    field().focus(); field().setSelectionRange(3, 4);
    const button = screen.getByRole("button", { name: symbol });
    const pointer = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
    fireEvent(button, pointer); expect(pointer.defaultPrevented).toBe(true);
    fireEvent.click(button);
    expect(field().value).toBe(`😀H${symbol}user`); expect(field().selectionStart).toBe(4); expect(field().selectionEnd).toBe(4);
    expect(document.activeElement).toBe(field()); expect(p.onSubmit).not.toHaveBeenCalled();
  });
  it("keyboard activation of a symbol returns focus to the saved text selection", () => {
    const p = props({ value: "Huser" }); render(<Controlled source={p} />);
    field().setSelectionRange(1, 1); const symbol = screen.getByRole("button", { name: "ä" }); symbol.focus(); fireEvent.click(symbol);
    expect(field().value).toBe("Häuser"); expect(field().selectionStart).toBe(2); expect(document.activeElement).toBe(field());
  });
  it("an unconfirmed presentation permits input while both answer actions remain blocked", () => {
    const p = props({ value: "Haus", canSubmit: false, canForget: false, status: "Подтверждаем показ задания" });
    render(<Controlled source={p} />); fireEvent.change(field(), { target: { value: "Häuser" } });
    fireEvent.keyDown(field(), { key: "Enter" }); fireEvent.click(screen.getByRole("button", { name: "Забыл…" }));
    expect(p.onChange).toHaveBeenCalledWith("Häuser"); expect(p.onSubmit).not.toHaveBeenCalled(); expect(p.onForget).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(p.status);
    expect(field().getAttribute("aria-describedby")).toContain(screen.getByRole("status").id);
  });
  it("sending leaves the same focused field read-only and cannot mutate its captured text", () => {
    const p = props({ value: "captured" }); const { rerender, container } = render(<WrittenAnswerInput {...p} />);
    const input = field(); input.focus();
    rerender(<WrittenAnswerInput {...p} readOnly status="Сохраняем ответ" />);
    expect(field()).toBe(input); expect(document.activeElement).toBe(input); expect(input.readOnly).toBe(true);
    fireEvent.change(input, { target: { value: "replacement" } }); fireEvent.submit(container.querySelector("form")!);
    fireEvent.click(screen.getByRole("button", { name: "ä" })); fireEvent.click(screen.getByRole("button", { name: "Забыл…" }));
    expect(p.onChange).not.toHaveBeenCalled(); expect(p.onSubmit).not.toHaveBeenCalled(); expect(p.onForget).not.toHaveBeenCalled();
  });
});

type ConjugationInputProps = Omit<WrittenAnswerInputProps, "assignment"> & WrittenAnswerQuestion;
const uuid = (n: number) => `6c0e2a4b-8d1f-4b3a-9c5e-${String(n).padStart(12, "0")}`;
function verb(n: number, text: string, tense: "present" | "preterite" = "present"): ConjugationAssignment {
  return { id: uuid(n), card_id: uuid(n + 1), status: "presented", kind: "conjugation", cycle_id: uuid(n + 2),
    slot_id: { cycle_id: uuid(n + 2), pronoun_group: "du" }, base_verb_id: uuid(n + 1), display_verb_id: uuid(n + 3),
    tense, pronoun_group: "du", prompt: { verb: text, translation: "переводить", language: "ru", pronoun: "du", tense },
    answer_spec: { kind: "forms", labels: ["du"], part_count: 1, case_sensitive: false } };
}
function conjugation(patch: Partial<Omit<ConjugationInputProps, "assignment" | "heading">> = {}, source = verb(10, "übersetzen")): ConjugationInputProps {
  const question = conjugationQuestion(source);
  return { assignment: conjugationWrittenQuestion(question),
    heading: <ConjugationQuestionHeading question={question} />, value: "", language: "ru",
    readOnly: false, canSubmit: true, canForget: true, submitOnEnter: true, onChange: vi.fn(), onSubmit: vi.fn(), onForget: vi.fn(), ...patch };
}

describe("a conjugation question in the same written answer field", () => {
  it("shows the typed heading as the question and the pronoun as the only answer part", () => {
    const p = conjugation(); const { container, rerender } = render(<WrittenAnswerInput {...p} />);
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("Präsens: übersetzen — переводить"); expect(heading.hasAttribute("lang")).toBe(false);
    expect(screen.getByRole("region", { name: heading.textContent! })).toBeTruthy();
    expect(screen.getByText("du").lang).toBe("de");
    expect(container.querySelector(".written-hint, .written-conjunction")).toBeNull();
    expect(screen.getByText("Заполнено частей (примерно): 0 из 1")).toBeTruthy();
    fireEvent.change(field(), { target: { value: "übersetzt" } }); expect(p.onChange).toHaveBeenCalledWith("übersetzt");
    rerender(<WrittenAnswerInput {...p} value="übersetzt" />);
    expect(screen.getByText("Заполнено частей (примерно): 1 из 1")).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(/6c0e2a4b-/);
    expect(p.onSubmit).not.toHaveBeenCalled();
  });
  it.each([
    ["ru", "Твой ответ", "Проверить", "Забыл…"],
    ["uk", "Твоя відповідь", "Перевірити", "Не пам’ятаю…"],
    ["en", "Your answer", "Check", "I forgot…"],
  ] as const)("%s keeps the interface labels local around the German question", (language, answer, check, forgot) => {
    const p = conjugation({ language, value: "übersetzt" }); render(<WrittenAnswerInput {...p} />);
    expect(screen.getByRole("textbox", { name: answer })).toBe(field()); expect(field().lang).toBe("de");
    fireEvent.click(screen.getByRole("button", { name: check })); fireEvent.click(screen.getByRole("button", { name: forgot }));
    expect(p.onSubmit).toHaveBeenCalledOnce(); expect(p.onForget).toHaveBeenCalledOnce(); expect(field().value).toBe("übersetzt");
  });
  it("does not send whitespace, while Enter and the button delegate the unchanged form", () => {
    const blank = conjugation({ value: " \n " }); const { container, unmount } = render(<WrittenAnswerInput {...blank} />);
    fireEvent.keyDown(field(), { key: "Enter" }); fireEvent.submit(container.querySelector("form")!);
    expect(blank.onSubmit).not.toHaveBeenCalled(); unmount();
    const p = conjugation({ value: "übersetzt" }); render(<WrittenAnswerInput {...p} />);
    fireEvent.keyDown(field(), { key: "Enter" }); fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    expect(p.onSubmit).toHaveBeenCalledTimes(2); expect(p.onChange).not.toHaveBeenCalled(); expect(field().value).toBe("übersetzt");
  });
  it("IME composition cannot submit, forget or insert a symbol before it finishes", () => {
    const p = conjugation({ value: "übersetzt" }); const { container } = render(<WrittenAnswerInput {...p} />);
    fireEvent.compositionStart(field()); fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.submit(container.querySelector("form")!); fireEvent.click(screen.getByRole("button", { name: "Забыл…" }));
    fireEvent.click(screen.getByRole("button", { name: "ü" }));
    expect(p.onSubmit).not.toHaveBeenCalled(); expect(p.onForget).not.toHaveBeenCalled(); expect(p.onChange).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field()); fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(field(), { key: "Enter", keyCode: 229 }); expect(p.onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: "Enter" }); expect(p.onSubmit).toHaveBeenCalledOnce();
  });
  it("holding Enter cannot answer the next conjugation question, which replaces the heading in the same field", () => {
    const p = conjugation({ value: "übersetzt" }); const { rerender } = render(<WrittenAnswerInput {...p} />);
    const input = field(); fireEvent.keyDown(input, { key: "Enter" });
    rerender(<WrittenAnswerInput {...conjugation({ value: "gingst", onSubmit: p.onSubmit }, verb(20, "gehen", "preterite"))} />);
    expect(screen.getByRole("heading").textContent).toBe("Präteritum: gehen — переводить"); expect(field()).toBe(input);
    fireEvent.keyDown(field(), { key: "Enter", repeat: true }); expect(p.onSubmit).toHaveBeenCalledOnce();
  });
  it("sending keeps the same conjugation field read-only and its captured text unchanged", () => {
    const p = conjugation({ value: "übersetzt" }); const { rerender, container } = render(<WrittenAnswerInput {...p} />);
    const input = field(); input.focus();
    rerender(<WrittenAnswerInput {...p} readOnly status="Сохраняем ответ" />);
    expect(field()).toBe(input); expect(document.activeElement).toBe(input); expect(input.readOnly).toBe(true);
    fireEvent.change(input, { target: { value: "replacement" } }); fireEvent.submit(container.querySelector("form")!);
    fireEvent.click(screen.getByRole("button", { name: "ä" })); fireEvent.click(screen.getByRole("button", { name: "Забыл…" }));
    expect(p.onChange).not.toHaveBeenCalled(); expect(p.onSubmit).not.toHaveBeenCalled(); expect(p.onForget).not.toHaveBeenCalled();
  });
});
