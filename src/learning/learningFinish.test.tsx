// M-LEARN-FIN: the phase summary after a correction (К05-151, Т78), a phrase introduction without forms (TA §6),
// the example after a Learning answer (К05-126, К05-127, Т16, Т85) and the «learning-complete» signal (TA:50, К09-004).
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardExample, CardExamples, PrepositionCardExamples } from "../api/generated";
import { renderLearningPreviewExamples } from "../study/LearningPreviewExamples";
import { LearningPreviewCard } from "./LearningPreviewCard";
import { previewContent } from "./learningPreview.test-support";
import { LearningScreen } from "./LearningScreen";
import { id, response } from "./learningFixtures.test-support";
import { learningUndoServer, type LearningUndoOptions } from "./learningUndo.test-support";
import { learningViewFixture } from "./learningView.test-support";
import { LearningViewController } from "./learningViewController";
import { useLearningDocument } from "./useLearningDocument";

const owners: LearningViewController[] = [];
afterEach(() => {
  cleanup(); owners.splice(0).forEach(owner => owner.dispose());
  vi.restoreAllMocks(); delete (window as Window & { Telegram?: unknown }).Telegram;
});

async function harness(options: LearningUndoOptions = {}, onLearningComplete: () => void = vi.fn()) {
  const s = learningUndoServer(options);
  const own = (complete = onLearningComplete) => {
    const view = new LearningViewController({ access: s.access, storage: s.storage, newId: s.newId,
      transport: { fetcher: s.fetcher, timeoutMs: 30000, maxResponseBytes: 100000 }, sessionId: id(3),
      transitionMode: () => "normal", onUpdate: vi.fn(), onLearningComplete: complete });
    owners.push(view);
    return view;
  };
  const view = own();
  await view.refresh();
  const answer = async (text: string) => { view.setDraft(text); await view.submit(); };
  const kinds = () => s.posts().map(post => post.kind);
  return { ...s, view, own, answer, kinds, complete: onLearningComplete };
}

describe("К05-151 / Т78: a correction that finishes the phase opens its summary instead of the shown next card", () => {
  it("from «Предыдущий ответ» over the shown B: the corrected result, then «Далее» opens the summary; B is gone", async () => {
    const h = await harness({ correctionEndsPhase: true });
    await h.answer("falsch"); await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7), status: "presented" } });
    h.view.setDraft("B draft"); h.view.previousResult(); await h.view.correct();
    expect(h.view.snapshot()).toMatchObject({ phase: "previous_result", question: null, canSubmit: false, canEditDraft: false,
      canNext: true, answer: { result: { grade: 4, version: "2" } }, current: { status: "summary", assignment: null } });
    await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "summary", question: null, canSubmit: false, canPrevious: false });
    // The withdrawn B accepts nothing more: no present and no late submit leave the client.
    h.view.setDraft("late"); await h.view.submit(); await h.view.submit({ forgot: true });
    expect(h.kinds()).toEqual(["assignment.present", "answer.submit", "assignment.present", "result.correct"]);
  });
  it("from the result screen while B is only issued: the summary follows without presenting B", async () => {
    const h = await harness({ correctionEndsPhase: true });
    await h.answer("falsch");
    expect(h.view.snapshot()).toMatchObject({ phase: "result_wrong", canCorrect: true });
    await h.view.correct();
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", current: { status: "summary" } });
    await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "summary", question: null });
    expect(h.kinds()).toEqual(["assignment.present", "answer.submit", "result.correct"]);
  });
  it("a correction inside an unfinished phase keeps the shown B and its draft", async () => {
    const h = await harness();
    await h.answer("falsch"); await h.view.next();
    h.view.setDraft("B draft"); h.view.previousResult(); await h.view.correct();
    expect(h.view.snapshot()).toMatchObject({ phase: "previous_result", current: { status: "active" } });
    await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7), status: "presented" }, draft: "B draft" });
    expect(h.kinds()).toEqual(["assignment.present", "answer.submit", "assignment.present", "result.correct"]);
  });
});

describe("«learning-complete» (TA:50, К09-004): only the own accepted answer that completes the group", () => {
  it("signals once on the answer of the last stage; a grade, re-reads, the summary and summary_home add nothing", async () => {
    const h = await harness({ cards: [6], completesGroup: true });
    await h.answer("Haus");
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", current: { status: "summary", group: { status: "completed" } } });
    expect(h.complete).toHaveBeenCalledTimes(1);
    await h.view.grade(5); await h.view.refresh(); await h.view.next();
    expect(h.view.snapshot().phase).toBe("summary");
    await h.view.stop("summary_home");
    expect(h.view.snapshot().phase).toBe("closed");
    expect(h.kinds()).toEqual(["assignment.present", "answer.submit", "result.grade", "session.stop"]);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
  it("a finished round of a group that is not completed, or an ordinary answer, gives no signal", async () => {
    const round = await harness({ cards: [6] });
    await round.answer("Haus"); await round.view.next();
    expect(round.view.snapshot()).toMatchObject({ phase: "summary", current: { group: { status: "active" } } });
    const ordinary = await harness({ completesGroup: true });
    await ordinary.answer("Haus");
    expect(ordinary.view.snapshot()).toMatchObject({ phase: "result_correct", current: { status: "active" } });
    expect(round.complete).not.toHaveBeenCalled(); expect(ordinary.complete).not.toHaveBeenCalled();
  });
  it("a correction that completes the group signals once (К05-151; root decision, pending owner Р2)", async () => {
    const h = await harness({ correctionEndsPhase: true, completesGroup: true });
    await h.answer("falsch");
    expect(h.complete).not.toHaveBeenCalled();
    await h.view.correct();
    expect(h.view.snapshot()).toMatchObject({ current: { status: "summary", group: { status: "completed" } } });
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
  it("an undo gives no signal; a new answer that completes the group again is a new accepted event (Р4)", async () => {
    const h = await harness({ cards: [6], completesGroup: true });
    await h.answer("Haus"); await h.view.next(); await h.view.undo();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", current: { status: "active" } });
    expect(h.complete).toHaveBeenCalledTimes(1);
    await h.answer("Haus");
    expect(h.complete).toHaveBeenCalledTimes(2);
  });
  it("a lost reply confirmed by its check signals once; the duplicate reply of the same command_id does not repeat it", async () => {
    const h = await harness({ cards: [6], completesGroup: true });
    // The server applies the answer, its reply is lost on the way back.
    const server = h.fetcher.getMockImplementation()!;
    h.fetcher.mockImplementationOnce(async (...call) => { await server(...call); throw new TypeError("network"); });
    await h.answer("Haus");
    expect(h.view.snapshot().phase).toBe("unknown");
    expect(h.complete).not.toHaveBeenCalled();
    await h.view.refresh();
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", current: { status: "summary" } });
    expect(h.complete).toHaveBeenCalledTimes(1);
    await h.view.refresh();
    expect(h.kinds().filter(kind => kind === "answer.submit")).toHaveLength(1);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
  it("a restart that reads a completed summary does not signal", async () => {
    const h = await harness({ cards: [6], completesGroup: true });
    await h.answer("Haus");
    h.view.dispose();
    const later = vi.fn(), restarted = h.own(later); await restarted.refresh();
    expect(restarted.snapshot()).toMatchObject({ phase: "summary", current: { group: { status: "completed" } } });
    expect(later).not.toHaveBeenCalled();
  });
  it("a failing signal never changes the screen", async () => {
    const h = await harness({ cards: [6], completesGroup: true }, () => { throw new Error("haptic unavailable"); });
    await h.answer("Haus");
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } }, problem: null });
  });
});

describe("useLearningDocument sends «learning-complete» through the Telegram haptic API (К09-007)", () => {
  function hook(s: ReturnType<typeof learningUndoServer>) {
    // One options object: a new transport on every render would re-create the owner.
    const options: Parameters<typeof useLearningDocument>[0] = { access: s.access(), storage: s.storage, newId: s.newId,
      transport: { fetcher: s.fetcher, timeoutMs: 30000, maxResponseBytes: 100000 }, initialSessionId: id(3), transitionMode: "normal" };
    return renderHook(props => useLearningDocument(props), { initialProps: options });
  }
  it("one success notification for the completing answer", async () => {
    const notificationOccurred = vi.fn();
    (window as Window & { Telegram?: unknown }).Telegram = { WebApp: { HapticFeedback: { notificationOccurred } } };
    const s = learningUndoServer({ cards: [6], completesGroup: true }), { result } = hook(s);
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("Haus"));
    await act(() => result.current.actions.submit());
    expect(result.current.state).toMatchObject({ phase: "result_correct", current: { status: "summary" } });
    expect(notificationOccurred).toHaveBeenCalledTimes(1); expect(notificationOccurred).toHaveBeenCalledWith("success");
    await act(() => result.current.actions.next());
    expect(result.current.state?.phase).toBe("summary");
    expect(notificationOccurred).toHaveBeenCalledTimes(1);
  });
  it("without the haptic API the screen state is the same", async () => {
    const s = learningUndoServer({ cards: [6], completesGroup: true }), { result } = hook(s);
    await waitFor(() => expect(result.current.state?.phase).toBe("question"));
    act(() => result.current.actions.setDraft("Haus"));
    await act(() => result.current.actions.submit());
    expect(result.current.state).toMatchObject({ phase: "result_correct", problem: null });
  });
});

const example = (n: number, text: string, role: CardExample["role"] = "general"): CardExample =>
  ({ id: id(900 + n), text, role, highlighted_parts: [] });
const direction = example(1, "Ich gehe in die Schule.", "wechsel_direction");
const location = example(2, "Ich bin in der Schule.", "wechsel_location");
type Fixture = ReturnType<typeof learningViewFixture>;
function LiveScreen({ f }: { f: Fixture }) {
  const [state, setState] = useState(() => f.view.snapshot());
  useEffect(() => { f.onUpdate.mockImplementation(setState); return () => { f.onUpdate.mockReset(); }; }, [f]);
  return <LearningScreen state={state} language="ru" submitOnEnter actions={f.view} renderPreview={() => null} />;
}
/** The Learning screen after one answer whose saved detail carries these frozen examples. */
async function answeredWith(examples: CardExamples | PrepositionCardExamples | null) {
  const f = learningViewFixture(); owners.push(f.view);
  render(<LiveScreen f={f} />); await act(() => f.view.refresh());
  f.fetcher.mockImplementationOnce(async (...call) => {
    const body = await (await f.handler(...call)).json();
    body.result.detail = { input: { kind: "text", text: "Haus" }, conjunction_hint: null, examples, variants: [{ parts: ["Haus"] }],
      initial_check: { correct: true, variant_index: 0, correct_answer: "Haus", other_answers: [], matched_spans: [],
        input_errors: [], answer_errors: [], span_unit: "unicode_code_point", span_bounds: "start_inclusive_end_exclusive" } };
    return response(body);
  });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Haus" } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  await waitFor(() => expect(screen.getByText("Верно")).toBeTruthy());
  return f;
}
const sentences = () => Array.from(document.querySelectorAll("p.german-example"), node => node.textContent);
const labels = () => Array.from(document.querySelectorAll(".personal-example-pair dt"), node => node.textContent);
function prepositionPair(akkusativ: string | null, dativ: string | null, single: string | null = null): PrepositionCardExamples {
  const full = akkusativ !== null && dativ !== null;
  return { common: [direction, example(3, "Gemeinsamer Satz."), location], personal: single === null ? null : { value: single, version: "3" },
    preposition_pair: { editor: { akkusativ: { value: akkusativ, version: "2" }, dativ: { value: dativ, version: "2" } },
      effective: full ? { source: "personal", akkusativ: { value: akkusativ!, version: "2" }, dativ: { value: dativ!, version: "2" } }
        : { source: "common", akkusativ: direction, dativ: location } } };
}

describe("М08 in Learning: one example after the answer by К05-126 / К05-127 (Т16, Т85)", () => {
  it("the own example wins over the commons", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    await answeredWith({ common: [example(1, "Das Haus ist groß."), example(2, "Ein altes Haus.")], personal: { value: "Mein Haus.", version: "1" } });
    expect(sentences()).toEqual(["Mein Haus."]);
  });
  it("without an own example one random common one", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    await answeredWith({ common: [example(1, "Das Haus ist groß."), example(2, "Ein altes Haus.")], personal: null });
    expect(sentences()).toEqual(["Ein altes Haus."]);
  });
  it("a two-case preposition with the full own pair: both own sentences with their cases, Akkusativ first", async () => {
    await answeredWith(prepositionPair("Ich laufe in den Park.", "Ich sitze im Park."));
    expect(sentences()).toEqual(["Ich laufe in den Park.", "Ich sitze im Park."]);
    expect(labels()).toEqual(["Akkusativ", "Dativ"]);
  });
  it.each([[null, null, null], ["Ich laufe in den Park.", null, null], [null, null, "Mein Satz."]])(
    "a two-case preposition without the full own pair: both commons, never a mix (%s, %s, %s)", async (akk, dat, single) => {
      await answeredWith(prepositionPair(akk, dat, single));
      expect(sentences()).toEqual([direction.text, location.text]);
      expect(labels()).toEqual([]);
    });
  it("a result without frozen examples shows none", async () => {
    await answeredWith(null);
    expect(sentences()).toEqual([]);
  });
});

describe("М07 phrase introduction (TA §6: German text and translation, no further forms)", () => {
  it("shows the phrase and its translation without forms, case data or conjugation tables", () => {
    const content = previewContent(id(21));
    content.card = { ...content.card, type: "phrase", lemma: "Auf Wiedersehen!" };
    content.translations = { common: ["До свидания!"], personal: null };
    const { container } = render(<LearningPreviewCard content={content} language="ru" renderExamples={renderLearningPreviewExamples} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Auf Wiedersehen!");
    expect(screen.getByText("До свидания!")).toBeTruthy(); expect(screen.getByText("Фраза")).toBeTruthy();
    for (const selector of [".reference-form", ".reference-main-forms", ".reference-plural", ".reference-taxonomy", "table"]) {
      expect(container.querySelector(selector)).toBeNull();
    }
  });
});
