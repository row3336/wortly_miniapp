// The closed Learning screen while a study record outlives the confirmed closure (D-CP4 3.1.4, Н6; root decision on
// QA CP4a-1 Ф5 and C049): 9.2.4 only in a confirmed planned pause (503 MAINTENANCE); an ordinary 503, a lost
// connection keep 9.2.2; a check in flight keeps 9.2.1. Real view, lanes and transport over the synthetic server.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { tick } from "../commands/recoveryTime.test-support";
import { id, missing, response } from "./learningFixtures.test-support";
import { LearningScreen } from "./LearningScreen";
import { learningViewFixture } from "./learningView.test-support";
import type { LearningViewController } from "./learningViewController";

const owners: LearningViewController[] = [];
afterEach(() => { cleanup(); owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

type Check = "maintenance" | "write_unavailable" | "drop" | "hang";
const texts = {
  checking: "Проверяем, сохранилось ли действие…",
  offline: "Нет связи с сервером. Ждём, когда связь восстановится…",
  maintenance: "Идёт плановое обновление. Подожди, мы продолжим сами.",
  // 9.2.4 with the estimate of the pause (TA:179, CT:151): the core announced 120 s.
  maintenanceWithWait: "Идёт плановое обновление. Подожди, мы продолжим сами. Примерное ожидание — около 2 мин.",
};

async function closedWhileChecking(check: Check) {
  vi.useFakeTimers();
  const f = learningViewFixture("normal", id(3)); owners.push(f.view);
  let checks: Check | null = null;
  f.fetcher.mockImplementation(async (url, init) => {
    const method = init?.method ?? "GET", path = new URL(String(url), "http://localhost").pathname;
    const kind = method === "POST" ? JSON.parse(String(init!.body)).kind as string : null;
    if (kind === "answer.submit") throw new TypeError("network");
    // CP4b: the automatic closure C follows the spent budget; from it on the checks of X meet `check`.
    if (kind === "session.stop") checks = check;
    if (checks && method === "GET" && path.startsWith("/api/v1/commands/")) {
      if (checks === "drop") throw new TypeError("network");
      if (checks === "hang") return new Promise<Response>(() => {});
      return response({ error: { code: checks === "maintenance" ? "MAINTENANCE" : "WRITE_UNAVAILABLE",
        ...(checks === "maintenance" ? { wait_seconds: 120 } : {}) } }, 503);
    }
    // The synthetic server answers a status only for a command it holds: any other ID is not found (core command_status).
    if (method === "GET" && path.startsWith("/api/v1/commands/")) {
      return response(missing({ command_id: path.split("/").at(-1)!, session_id: id(3) } as never, f.view.snapshot().commands.stateVersion));
    }
    return f.handler(url, init);
  });
  await f.view.refresh(); f.view.setDraft("Haus"); void f.view.submit(); await tick();
  // Six lost sends: the budget is spent; since M1b (CP4b, CON §6.1 п.8) the document closes the session itself with the
  // closure C naming X — before, the person's Stop closed it here.
  for (let spent = 0; spent < 70_000; spent += 1000) await tick(1000);
  await tick(); await tick(1000);
  const close = f.posts().filter(post => post.kind === "session.stop");
  // X is the spent answer itself (QA M1b P3).
  expect(close.map(post => post.payload)).toEqual([{ reason: "save_failed",
    unsaved_command_id: f.posts().find(post => post.kind === "answer.submit")!.command_id }]);
  expect(f.view.snapshot()).toMatchObject({ phase: "closed", commands: { closedAction: { state: "checking" } } });
  render(<LearningScreen state={f.view.snapshot()} actions={f.view} language="ru" submitOnEnter renderPreview={() => null} />);
  expect(document.querySelector(".learning-closed-check .wortly-loader")).toBeTruthy();
  expect(document.querySelector(".recovery-overlay")).toBeNull();
  expect(screen.queryAllByRole("button").map(button => button.textContent)).toEqual([]);
  return f;
}

it("a confirmed planned pause shows 9.2.4 with its estimate, never 9.2.1 or 9.2.2", async () => {
  await closedWhileChecking("maintenance");
  expect(screen.getByText(texts.maintenanceWithWait)).toBeTruthy();
  expect(screen.queryByText(texts.checking)).toBeNull();
  expect(screen.queryByText(texts.offline)).toBeNull();
});
it.each([["write_unavailable"], ["drop"]] as const)("%s is no planned pause: 9.2.2", async check => {
  await closedWhileChecking(check);
  expect(screen.getByText(texts.offline)).toBeTruthy();
  expect(screen.queryByText(content => content.startsWith(texts.maintenance))).toBeNull();
});
it("a check still in flight: 9.2.1", async () => {
  await closedWhileChecking("hang");
  expect(screen.getByText(texts.checking)).toBeTruthy();
});
