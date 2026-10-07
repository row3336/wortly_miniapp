import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { feedbackWorld, slot, TEXT, type Fate } from "../feedback/feedbackFixtures.test-support";
import type { Language } from "../i18n/language";
import { response } from "../learning/learningFixtures.test-support";
import { SettingsHost } from "./SettingsHost";
import { settingsFeedbackCopy } from "./settingsFeedbackCopy";
import { SettingsPendingStore } from "./settingsPending";
import { settingsResponse } from "./settingsRead.test-support";
import { useSettingsDocument } from "./useSettingsDocument";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
type Props = Parameters<typeof useSettingsDocument>[0] & { language: Language; active: boolean; shown: boolean; onToday(): void };
/** The document owner stays mounted when the editor is not shown, as ApplicationDocument keeps it. */
function Host(props: Props) {
  const document = useSettingsDocument(props);
  return props.shown ? <SettingsHost {...props} document={document} /> : null;
}
function setup(fates: Fate[] = [], language: Language = "ru", world = feedbackWorld(fates)) {
  const base = world.f.fetcher.getMockImplementation()!;
  const data = settingsResponse(); data.state_version = "1";
  for (const field of Object.values(data.settings)) field.version = "1";
  world.f.fetcher.mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.endsWith("/settings")) return response(data);
    if (path.includes("/commands")) return base(url, init);
    return response({ state_version: "1", topics: [] });
  });
  const props: Props = { access: world.f.access(), transport: { fetcher: world.f.fetcher, timeoutMs: 30000, maxResponseBytes: 50000 },
    pendingStore: new SettingsPendingStore(world.f.storage), language, active: true, shown: true, onCurrent: vi.fn(), onToday: vi.fn() };
  const ui = render(<Host {...props} />);
  return { world, props, ...ui };
}
const form = (language: Language = "ru") => within(screen.getByRole("region", { name: settingsFeedbackCopy[language].title }));
const field = (language: Language = "ru") => form(language).getByRole("textbox", { name: settingsFeedbackCopy[language].label }) as HTMLTextAreaElement;
const sendButton = (language: Language = "ru") => form(language).getByRole("button", { name: settingsFeedbackCopy[language].send });
async function ready(language: Language = "ru") { await waitFor(() => expect(field(language).readOnly).toBe(false)); }

describe("the message to the developer in settings", () => {
  it("does not send an empty or blank message", async () => {
    const { world } = setup(); await ready();
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field(), { target: { value: "  \n " } });
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sendButton()); await act(async () => {});
    expect(world.posts).toHaveLength(0);
  });
  it("shows success only after the server answers and clears the field then", async () => {
    const { world } = setup(); await ready();
    const gate = world.hold();
    fireEvent.change(field(), { target: { value: TEXT } });
    fireEvent.click(sendButton());
    await screen.findByText(settingsFeedbackCopy.ru.sending);
    expect(screen.queryByText(settingsFeedbackCopy.ru.confirmed)).toBeNull();
    expect(field().value).toBe(TEXT); expect(field().readOnly).toBe(true); expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => gate.resolve());
    await screen.findByText(settingsFeedbackCopy.ru.confirmed);
    expect(field().value).toBe(""); expect(world.posts).toHaveLength(1); expect(world.posts[0].payload).toEqual({ text: TEXT });
    expect(world.f.values.has(slot)).toBe(false);
  });
  it("keeps the text on a lost reply and confirms it on retry without a second message", async () => {
    const { world } = setup(["lose-after"]); await ready();
    fireEvent.change(field(), { target: { value: TEXT } }); fireEvent.click(sendButton());
    await screen.findByText(settingsFeedbackCopy.ru.problems.network);
    expect(field().value).toBe(TEXT); expect(screen.queryByText(settingsFeedbackCopy.ru.confirmed)).toBeNull();
    fireEvent.click(form().getByRole("button", { name: settingsFeedbackCopy.ru.retry }));
    await screen.findByText(settingsFeedbackCopy.ru.confirmed);
    expect(world.posts).toHaveLength(1); expect(world.facts.size).toBe(1); expect(field().value).toBe("");
  });
  it("a refused message keeps the text and can be sent again", async () => {
    const { world } = setup(["422"]); await ready();
    fireEvent.change(field(), { target: { value: TEXT } }); fireEvent.click(sendButton());
    await screen.findByText(settingsFeedbackCopy.ru.refused);
    expect(field().value).toBe(TEXT);
    fireEvent.click(sendButton());
    await screen.findByText(settingsFeedbackCopy.ru.confirmed);
    expect(world.posts.map(post => post.command_id)[0]).not.toBe(world.posts[1].command_id);
  });
  it.each([["403", "forbidden"], ["401", "expired"]] as const)("HTTP %s shows only the access problem, not the send-again refusal", async (fate, problem) => {
    setup([fate]); await ready();
    fireEvent.change(field(), { target: { value: TEXT } }); fireEvent.click(sendButton());
    await screen.findByText(settingsFeedbackCopy.ru.problems[problem]);
    expect(screen.queryByText(settingsFeedbackCopy.ru.refused)).toBeNull(); expect(field().value).toBe(TEXT);
  });
  it("a failed cleanup after the server confirmed shows the storage error without the success text; retry then confirms", async () => {
    const { world } = setup(); await ready();
    vi.spyOn(world.f.storage, "remove").mockRejectedValueOnce(new Error("local failure"));
    fireEvent.change(field(), { target: { value: TEXT } }); fireEvent.click(sendButton());
    await screen.findByText(settingsFeedbackCopy.ru.problems.storage);
    expect(screen.queryByText(settingsFeedbackCopy.ru.confirmed)).toBeNull();
    fireEvent.click(form().getByRole("button", { name: settingsFeedbackCopy.ru.retry }));
    await screen.findByText(settingsFeedbackCopy.ru.confirmed);
    expect(world.posts).toHaveLength(1); expect(world.f.values.has(slot)).toBe(false);
  });
  it("the unconfirmed message lives in the application storage and survives a restart: same command_id, nothing is sent by itself", async () => {
    const first = setup(["lose-before"]); await ready();
    fireEvent.change(field(), { target: { value: TEXT } }); fireEvent.click(sendButton());
    await screen.findByRole("button", { name: settingsFeedbackCopy.ru.retry });
    const commandId = first.world.posts[0].command_id;
    expect(first.world.f.values.has(slot)).toBe(true);
    first.unmount();
    const second = setup([], "ru", first.world);
    await waitFor(() => expect(field().value).toBe(TEXT));
    await screen.findByRole("button", { name: settingsFeedbackCopy.ru.retry });
    expect(second.world.posts).toHaveLength(1);
    fireEvent.click(form().getByRole("button", { name: settingsFeedbackCopy.ru.retry }));
    await screen.findByText(settingsFeedbackCopy.ru.confirmed);
    expect(second.world.posts.map(post => post.command_id)).toEqual([commandId, commandId]); expect(second.world.f.values.has(slot)).toBe(false);
  });
  it("keeps the typed text while the settings editor is hidden and shown again", async () => {
    const { props, rerender } = setup(); await ready();
    fireEvent.change(field(), { target: { value: TEXT } });
    rerender(<Host {...props} active={false} shown={false} />);
    expect(screen.queryByRole("region", { name: settingsFeedbackCopy.ru.title })).toBeNull();
    rerender(<Host {...props} active shown />);
    expect(field().value).toBe(TEXT); expect(field().readOnly).toBe(false);
  });
  it("keeps the typed text across a foreground that replaces the access handle", async () => {
    const { world, props, rerender } = setup(); await ready();
    fireEvent.change(field(), { target: { value: TEXT } });
    world.f.replace(); rerender(<Host {...props} access={world.f.access()} />);
    await act(async () => {});
    expect(field().value).toBe(TEXT);
  });
  it.each(["ru", "uk", "en"] as const)("%s: has its own wording and shows no direct contact of the developer", async language => {
    setup([], language); await ready(language);
    const section = screen.getByRole("region", { name: settingsFeedbackCopy[language].title });
    expect(section.querySelector("a, [href]")).toBeNull();
    expect(section.textContent).not.toMatch(/@|t\.me|tg:\/\/|mailto:|https?:|\+\d{5,}/i);
    for (const text of [settingsFeedbackCopy[language].hint, settingsFeedbackCopy[language].send]) expect(within(section as HTMLElement).getByText(text)).toBeTruthy();
  });
  it("the three wordings differ and are complete", () => {
    for (const key of ["title", "label", "hint", "send", "retry", "refused", "confirmed"] as const) {
      expect(new Set(["ru", "uk", "en"].map(language => settingsFeedbackCopy[language as Language][key])).size).toBe(3);
    }
    for (const language of ["ru", "uk", "en"] as const) {
      for (const text of Object.values(settingsFeedbackCopy[language].problems)) expect(text.length).toBeGreaterThan(10);
    }
  });
});
