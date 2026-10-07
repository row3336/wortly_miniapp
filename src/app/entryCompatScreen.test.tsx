import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EntryScreen } from "./EntryScreen";
import { maintenanceWait, t } from "../i18n/messages";

// M-COMPAT-HDR: working ru/uk/en texts of the update and planned-pause screens (labelled until G05).
describe("update and planned-pause screens", () => {
  it.each(["ru", "uk", "en"] as const)("an outdated client reads the update message, and offers no fake button (%s)", language => {
    const html = renderToStaticMarkup(<EntryScreen language={language} state={{ kind: "incompatible" }}
      onRetry={vi.fn()} onReapply={vi.fn()} />);
    expect(html).toContain(t(language).incompatible); expect(html).toContain(t(language).incompatibleDetail);
    expect(html).not.toContain(t(language).unavailable);
    expect(html).not.toContain("<button");
  });

  it.each(["ru", "uk", "en"] as const)("a paused reapply is told from «unavailable» and keeps the refusal screen's reapply button (%s)", language => {
    const state = { kind: "rejected" as const, reason: "Review complete", pause: { waitSeconds: 30 } };
    const html = renderToStaticMarkup(<EntryScreen language={language} state={state} onReapply={() => {}} />);
    expect(html).toContain(t(language).maintenance); expect(html).toContain(t(language).maintenanceDetail);
    expect(html).toContain(maintenanceWait(language, 30)!); expect(html).toContain("Review complete");
    expect(html).not.toContain(t(language).unavailable);
    expect(html).toContain(t(language).reapply);
    expect(renderToStaticMarkup(<EntryScreen language={language} state={state} />)).not.toContain("<button");
  });

  it("a refusal without a pause is unchanged and shows no wait", () => {
    const html = renderToStaticMarkup(<EntryScreen language="ru" state={{ kind: "rejected", reason: "Причина" }} onReapply={() => {}} />);
    expect(html).toContain(t("ru").rejected); expect(html).not.toContain(t("ru").maintenance); expect(html).not.toContain("maintenance-wait");
  });

  it("shows no number without an estimate and a plain note once it has passed", () => {
    expect(renderToStaticMarkup(<EntryScreen language="ru" state={{ kind: "rejected", pause: {} }} />)).not.toContain("maintenance-wait");
    expect(renderToStaticMarkup(<EntryScreen language="ru" state={{ kind: "rejected", pause: { waitSeconds: 0 } }} />))
      .toContain(t("ru").maintenanceOver);
  });

  it("has the same new keys in every language and a number in each wait line", () => {
    const keys = (language: "ru" | "uk" | "en") => Object.keys(t(language)).sort();
    expect(keys("uk")).toEqual(keys("ru")); expect(keys("en")).toEqual(keys("ru"));
    for (const language of ["ru", "uk", "en"] as const) {
      expect(maintenanceWait(language, 7)).toContain("7");
      expect(maintenanceWait(language, 61)).toContain("2");
      expect(maintenanceWait(language, null)).toBeNull();
    }
  });
});
