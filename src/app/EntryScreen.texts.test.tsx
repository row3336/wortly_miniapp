// C390 В2: WORKING TEXT of the two expired states (re-entry offered — active or waiting for the gate — and a new launch
// needed) in ru/uk/en; the old «close the app» line never stands alone next to an active button.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Language } from "../i18n/language";
import { t } from "../i18n/messages";
import { EntryScreen } from "./EntryScreen";

afterEach(cleanup);
const languages: Language[] = ["ru", "uk", "en"];

describe("the expired screen by its state (C163/AC-104)", () => {
  for (const language of languages) {
    const copy = t(language);
    it(`${language}: re-entry offered — its own text and an active button`, () => {
      render(<EntryScreen state={{ kind: "expired", reentry: true, checkable: true }} language={language} onReenter={() => {}} />);
      expect(screen.getByText(copy.expiredReentryDetail)).toBeTruthy();
      expect(screen.queryByText(copy.expiredDetail)).toBeNull();
      expect((screen.getByRole("button", { name: copy.retry }) as HTMLButtonElement).disabled).toBe(false);
    });
    it(`${language}: re-entry waiting for the gate — the wait text, an inactive button, no command line of §4.8`, () => {
      render(<EntryScreen state={{ kind: "expired", reentry: true, wait: { cause: "offline" } }} language={language} onReenter={() => {}} />);
      expect(screen.getByText(copy.expiredReentryWaitDetail)).toBeTruthy();
      // C392: no promise that one answer of the server is enough (the gate may still hold after ready).
      expect(copy.expiredReentryWaitDetail).not.toMatch(/ответит|відповість|answers again/);
      expect((screen.getByRole("button", { name: copy.retry }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByRole("status")).toBeNull();
    });
    it(`${language}: a planned pause adds only its estimate`, () => {
      render(<EntryScreen state={{ kind: "expired", reentry: true, wait: { cause: "maintenance", waitSeconds: 120 } }}
        language={language} onReenter={() => {}} />);
      expect(screen.getByText(copy.expiredReentryWaitDetail)).toBeTruthy();
      expect(screen.queryByText(copy.commandMaintenance, { exact: false })).toBeNull();
      expect(document.querySelector(".maintenance-wait")?.textContent).toBeTruthy();
    });
    it(`${language}: a new launch needed — the old instruction, no button`, () => {
      render(<EntryScreen state={{ kind: "expired" }} language={language} onReenter={() => {}} />);
      expect(screen.getByText(copy.expiredDetail)).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
    });
  }
});
