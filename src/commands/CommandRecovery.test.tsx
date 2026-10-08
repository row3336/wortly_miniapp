// The shared controls of an unknown outcome and Enter on a result (M-REFAC-CMD).
import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRecovery, recoveryCover } from "./CommandRecovery";
import { commandCopy } from "./commandCopy";
import { useEnterNext } from "./useEnterNext";

afterEach(() => { cleanup(); });

describe("command recovery controls", () => {
  it.each(["ru", "uk", "en"] as const)("checks by the same ID, resends or retries Stop only when granted (%s)", language => {
    const onCheck = vi.fn(), onRetry = vi.fn();
    const ui = render(<CommandRecovery className="x-recovery" language={language} lanes={[{ phase: "unresolved" }, { phase: "idle" }]}
      canRetryPrimary canRetryStop={false} onCheck={onCheck} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: commandCopy[language].check }));
    fireEvent.click(screen.getByRole("button", { name: commandCopy[language].retry }));
    expect(onCheck).toHaveBeenCalledOnce(); expect(onRetry).toHaveBeenCalledWith("primary");
    expect(screen.queryByRole("button", { name: commandCopy[language].retryStop })).toBeNull();
    expect(ui.container.firstElementChild?.className).toBe("x-recovery");
  });
  it("a check waits while either lane is still exchanging", () => {
    const onCheck = vi.fn();
    render(<CommandRecovery className="x" language="ru" lanes={[{ phase: "idle" }, { phase: "sending" }]}
      canRetryPrimary={false} canRetryStop onCheck={onCheck} onRetry={vi.fn()} />);
    const check = screen.getByRole("button", { name: "Проверить состояние" });
    expect(check).toHaveProperty("disabled", true); fireEvent.click(check); expect(onCheck).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Повторить завершение" })).toBeTruthy();
  });
});

function Probe(props: { result: unknown; canNext: boolean; submitOnEnter?: boolean; next(): Promise<void> }) {
  const root = useRef<HTMLElement>(null), composing = useRef(false);
  useEnterNext(root, composing, props.submitOnEnter ?? true, props.result, props.canNext, props);
  return <main ref={root} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
    <p>result</p><button type="button">grade</button></main>;
}
describe("Enter on a result", () => {
  it("advances once from the page, never from a focused control, a held key or an IME composition", () => {
    const next = vi.fn(async () => {});
    render(<Probe result={{}} canNext next={next} />);
    fireEvent.keyDown(document.body, { key: "Enter" }); expect(next).toHaveBeenCalledOnce();
    fireEvent.keyDown(document.body, { key: "Enter", repeat: true });
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    fireEvent.keyDown(document.body, { key: "Enter", isComposing: true });
    fireEvent.keyDown(document.body, { key: "Enter", keyCode: 229 });
    fireEvent.compositionStart(screen.getByText("result")); fireEvent.keyDown(screen.getByText("result"), { key: "Enter" });
    expect(next).toHaveBeenCalledOnce();
  });
  it("listens only while a result may advance", () => {
    const next = vi.fn(async () => {});
    const ui = render(<Probe result={null} canNext next={next} />);
    fireEvent.keyDown(document.body, { key: "Enter" });
    ui.rerender(<Probe result={{}} canNext={false} next={next} />); fireEvent.keyDown(document.body, { key: "Enter" });
    ui.rerender(<Probe result={{}} canNext submitOnEnter={false} next={next} />); fireEvent.keyDown(document.body, { key: "Enter" });
    expect(next).not.toHaveBeenCalled();
  });
});

describe("the blurred cover of a waiting recovery (Q25.2, QA CP2c З2)", () => {
  const waiting = { kind: "waiting", status: "resending", pauseSeconds: null } as const;
  const lanes = (kind: string) => ({ primary: { pendingIntent: { kind } } });
  it("is lifted only for the mark that a question was shown", () => {
    expect(recoveryCover(waiting, lanes("assignment.present"))).toBeNull();
  });
  it.each(["answer.submit", "result.grade", "result.correct", "result.undo"])("keeps the cover for a lost %s", kind => {
    expect(recoveryCover(waiting, lanes(kind))).toBe(waiting);
  });
  it("keeps the unsaved screen even for the mark of a shown question and passes no screen through", () => {
    const unsaved = { kind: "unsaved" } as const;
    expect(recoveryCover(unsaved, lanes("assignment.present"))).toBe(unsaved);
    expect(recoveryCover(null, lanes("assignment.present"))).toBeNull();
  });
});
