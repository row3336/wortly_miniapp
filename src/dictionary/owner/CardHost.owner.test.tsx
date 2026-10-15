import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient } from "../../api/generated";
import { createOpenedAccess } from "../../app/openedAccess";
import { ManualPendingStore } from "../../learning/manualPending";
import type { AsyncStorage } from "../../platform/storage";
import { CardHost, type CardHostProps } from "../card/CardHost";
import { CARD, cardView } from "../card/cardTestData.test-support";
import { testGate } from "../../commands/testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Core-shaped server of one card with the owner's common data (C-FIELDS-3): revision, translations in order, noun grammar. */
function server(role: "owner" | "user" = "owner") {
  const s = { state: 10n, next: 500, revision: 1n, translations: ["дом", "жилище", "здание"],
    others: { uk: ["будинок", "житло"], en: [] as string[] },
    grammar: { gender: "neuter", gender_status: "applicable", singular: "Haus", singular_status: "applicable", plural: "Häuser",
      plural_status: "applicable", article_status: "applicable" } as Record<string, string | null>,
    contexts: new Map<string, "open" | "closed">(), posts: [] as Record<string, any>[] };
  const view = (localDate: string | null = "2026-10-07") => {
    const value = cardView();
    value.study.local_date = localDate;
    if (localDate === null) value.study.directions.forEach(direction => { direction.interval_preview = null; });
    value.content.card.revision = String(s.revision);
    value.study.card_revision = String(s.revision);
    value.content.translations.common = [...s.translations];
    value.content.grammar = { ...s.grammar } as never;
    return value;
  };
  const context = (contextId: string) => {
    const status = s.contexts.get(contextId), reference = { id: contextId, kind: "dictionary", card_id: CARD };
    return status === "open" ? { status, context: reference, view: view(null), interval: null,
      capabilities: { interval_increase: null, undo_offer: null, undo_target: null } } : status === "closed" ? { status, context: reference } : { status: "unavailable" };
  };
  const current = () => ({ status: "available", scope: "common", card_id: CARD, card_type: "noun", card_revision: String(s.revision),
    language: "ru", translations: [...s.translations], grammar: { ...s.grammar } });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "http://local");
    if (url.pathname === `/api/v1/dictionary/cards/${CARD}/view`) return json({ state_version: String(s.state), current: view() });
    if (url.pathname === `/api/v1/dictionary/cards/${CARD}/common`) {
      return json({ state_version: String(s.state), current: role !== "owner" ? { status: "unavailable" } : { status: "available",
        card_id: CARD, card_revision: String(s.revision), language: "ru", translations: { ru: [...s.translations], ...structuredClone(s.others) } } });
    }
    if (url.pathname.startsWith("/api/v1/dictionary/contexts/")) {
      return json({ state_version: String(s.state), current: context(url.pathname.split("/").at(-1)!) });
    }
    if (url.pathname === "/api/v1/learning/current") return json({ pair: "ru-de", state_version: String(s.state), manual_selection_version: "1",
      group: null, manual_selection: [], learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 2,
        manual_eligible: 0, automatic_eligible: 2 } });
    if (url.pathname !== "/api/v1/commands" || init!.method !== "POST") throw new Error(`unexpected ${init!.method} ${input}`);
    const body = JSON.parse(String(init!.body));
    s.posts.push(body);
    const fact = (extra: Record<string, unknown>) => ({ id: body.command_id, kind: body.kind, status: "applied", applied_at: "2026-10-13T09:00:00Z",
      result_id: null, ...extra });
    if (body.kind === "context.open" || body.kind === "context.close") {
      let contextId: string = body.context_id;
      if (body.kind === "context.open") { contextId = id(s.next++); s.contexts.set(contextId, "open"); } else s.contexts.set(contextId, "closed");
      s.state++;
      return json({ command: fact({ target_id: CARD, action_id: null, context_id: contextId, object_version: null }),
        current: context(contextId), state_version: String(s.state) });
    }
    if (body.kind !== "field.save" || body.payload.scope !== "common") throw new Error(`unexpected command ${body.kind}`);
    const rejected = (code: string, status: number) => json({ command: { id: body.command_id, status: "rejected" }, current: current(),
      state_version: String(s.state), error: { code } }, status);
    if (body.expected_field_version !== String(s.revision)) return rejected("VERSION_CONFLICT", 409);
    const payload = body.payload;
    if (payload.field_name === "translation") {
      const texts = (payload.value as string[]).map(text => text.trim());
      if (texts.length === 0 || texts.some(text => text === "")) return json({ error: { code: "VALIDATION_FAILED" } }, 422);
      s.translations = texts;
    } else if (payload.field_name === "separability") s.grammar.separability = payload.value;
    else {
      const column = payload.field_name === "article" ? "article_status" : `${payload.field_name}_status`;
      s.grammar[column] = payload.value.status;
      if (payload.field_name !== "article") s.grammar[payload.field_name] = payload.value.value?.trim() ?? null;
    }
    s.revision++; s.state++;
    return json({ command: fact({ target_id: CARD, action_id: null, context_id: body.context_id, object_version: String(s.revision) }),
      current: current(), state_version: String(s.state) });
  });
  const reads = (part: string) => fetcher.mock.calls.filter(([url, init]) => init!.method === "GET" && String(url).includes(part)).length;
  return Object.assign(s, { fetcher, reads });
}

function fixture(role: "owner" | "user" = "owner") {
  const srv = server(role), values = new Map<string, string>();
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  const opened: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
    profile: { profile_id: id(3), role, ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "10",
      access: { status: "admitted", version: "1", reason: null } }, session: null, compatibility: { compatible: true, contract_version: "1" } };
  let next = 100;
  const onBack = vi.fn();
  const props: CardHostProps = { access: createOpenedAccess({ opened, token: "synthetic-owner-token", proof: "synthetic-owner-proof",
    generation: 1, isLive: () => true, onDenied: () => {} }), transport: { fetcher: srv.fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000, gate: testGate() },
    language: "ru", pendingStore: new ManualPendingStore(storage), cardId: CARD, origin: { kind: "dictionary" }, newId: () => id(next++), onBack };
  return { srv, props, onBack };
}

const translation = () => screen.getByRole("region", { name: "Перевод" });
const enabled = async (name: string) => {
  const button = await screen.findByRole("button", { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
};
const fields = () => screen.getAllByRole("textbox", { name: /^Перевод \d$/ }) as HTMLInputElement[];
const texts = () => fields().map(field => field.value);
const commonPosts = (srv: ReturnType<typeof server>) => srv.posts.filter(post => post.kind === "field.save");

async function openTranslations(f: ReturnType<typeof fixture>) {
  render(<CardHost {...f.props} />);
  await screen.findByRole("heading", { level: 2 });
  fireEvent.click(await enabled("Изменить перевод для всех"));
  return screen.getByRole("region", { name: "Перевод для всех — русский" });
}

describe("М12 owner common editor in the card host (R12-04…06, R14-01)", () => {
  it("W1 a user sees no common action, only the personal pencil (K07-030; no echo in the Mini App)", async () => {
    const f = fixture("user");
    render(<CardHost {...f.props} />);
    await screen.findByRole("heading", { level: 2 });
    await enabled("Изменить личный перевод");
    expect(screen.queryByRole("button", { name: "Изменить перевод для всех" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Изменить грамматику для всех" })).toBeNull();
  });

  it("W2 the owner reorders with «Выше»/«Ниже», adds with «+» and saves the whole list in order with the card revision", async () => {
    const f = fixture();
    const editor = await openTranslations(f);
    expect(texts()).toEqual(["дом", "жилище", "здание"]);
    // One editor at a time: the personal pencil waits while the common editor is open.
    expect((screen.getByRole("button", { name: "Изменить личный перевод" }) as HTMLButtonElement).disabled).toBe(true);
    const up = within(editor).getByRole("button", { name: "Переместить «здание» выше" });
    up.focus();
    fireEvent.click(up);
    expect(texts()).toEqual(["дом", "здание", "жилище"]);
    fireEvent.click(within(editor).getByRole("button", { name: "Переместить «здание» выше" }));
    expect(texts()).toEqual(["здание", "дом", "жилище"]);
    // At the top «Выше» is off: the focus moves to «Ниже» of the same field; the new place is announced.
    expect(document.activeElement).toBe(within(editor).getByRole("button", { name: "Переместить «здание» ниже" }));
    expect(within(editor).getByText("«здание» — 1 из 3.")).toBeTruthy();
    fireEvent.click(within(editor).getByRole("button", { name: "Добавить перевод" }));
    expect((within(editor).getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(editor).getByText("Пустое поле: заполните его или уберите.")).toBeTruthy();
    fireEvent.change(fields()[3], { target: { value: " строение " } });
    const views = f.srv.reads("/view");
    fireEvent.click(within(editor).getByRole("button", { name: "Сохранить" }));
    await within(translation()).findByText("Перевод для всех сохранён.");
    expect(commonPosts(f.srv)).toHaveLength(1);
    expect(commonPosts(f.srv)[0]).toMatchObject({ expected_field_version: "1", context_id: [...f.srv.contexts.keys()][0],
      payload: { card_id: CARD, field_name: "translation", scope: "common", language: "ru", value: ["здание", "дом", "жилище", " строение "] } });
    await waitFor(() => expect(f.srv.reads("/view")).toBe(views + 1));
    // The card shows the new common order (the server's, read again).
    await waitFor(() => expect(within(translation()).getAllByText(/^(здание|дом|жилище|строение)$/).map(node => node.textContent))
      .toEqual(["здание", "дом", "жилище", "строение"]));
  });

  it("W3 R12-06: the cross of the last translation explains the refusal and nothing is sent", async () => {
    const f = fixture();
    f.srv.translations = ["дом"];
    const editor = await openTranslations(f);
    const cross = within(editor).getByRole("button", { name: "Убрать «дом»" });
    expect(cross.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(cross);
    expect(within(editor).getByRole("alert").textContent).toBe(
      "Последний перевод удалить нельзя: у карточки должен остаться хотя бы один перевод на этом языке.");
    expect(texts()).toEqual(["дом"]);
    expect(commonPosts(f.srv)).toHaveLength(0);
  });

  it("W4 a long press picks a field up: vertical swipes are off while it travels, the others part, the drop puts it first", async () => {
    const swipes = { isVerticalSwipesEnabled: true, disableVerticalSwipes: vi.fn(), enableVerticalSwipes: vi.fn() };
    vi.stubGlobal("Telegram", { WebApp: swipes });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 44, width: 300, top: 0, left: 0, bottom: 44,
      right: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const f = fixture();
    const editor = await openTranslations(f);
    const rows = () => within(editor).getAllByRole("listitem");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // A move before the long press ends is a scroll: nothing is picked up.
    fireEvent.pointerDown(fields()[1], { pointerId: 7, clientX: 10, clientY: 100, pointerType: "touch" });
    fireEvent.pointerMove(fields()[1], { pointerId: 7, clientX: 10, clientY: 120, pointerType: "touch" });
    act(() => { vi.advanceTimersByTime(500); });
    expect(swipes.disableVerticalSwipes).not.toHaveBeenCalled();
    fireEvent.pointerUp(fields()[1], { pointerId: 7, clientX: 10, clientY: 120, pointerType: "touch" });

    fireEvent.pointerDown(fields()[2], { pointerId: 8, clientX: 10, clientY: 200, pointerType: "touch" });
    act(() => { vi.advanceTimersByTime(399); });
    expect(swipes.disableVerticalSwipes).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(swipes.disableVerticalSwipes).toHaveBeenCalledTimes(1);
    expect(rows()[2].getAttribute("data-picked")).toBe("true");
    fireEvent.pointerMove(fields()[2], { pointerId: 8, clientX: 10, clientY: 200 - 104, pointerType: "touch" });
    expect(rows()[2].style.transform).toBe("translateY(-104px)");
    expect(rows().slice(0, 2).map(row => row.style.transform)).toEqual(["translateY(52px)", "translateY(52px)"]);
    fireEvent.pointerUp(fields()[2], { pointerId: 8, clientX: 10, clientY: 96, pointerType: "touch" });
    expect(swipes.enableVerticalSwipes).toHaveBeenCalledTimes(1);
    expect(texts()).toEqual(["здание", "дом", "жилище"]);
    vi.useRealTimers();
    fireEvent.click(within(editor).getByRole("button", { name: "Сохранить" }));
    await within(translation()).findByText("Перевод для всех сохранён.");
    expect(commonPosts(f.srv)[0].payload.value).toEqual(["здание", "дом", "жилище"]);
  });

  it("W5 a pointer cancel puts the field back and gives the swipes back; swipes off before stay off", async () => {
    const swipes = { isVerticalSwipesEnabled: false, disableVerticalSwipes: vi.fn(), enableVerticalSwipes: vi.fn() };
    vi.stubGlobal("Telegram", { WebApp: swipes });
    const f = fixture();
    await openTranslations(f);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.pointerDown(fields()[0], { pointerId: 3, clientX: 10, clientY: 100, pointerType: "touch" });
    act(() => { vi.advanceTimersByTime(400); });
    fireEvent.pointerMove(fields()[0], { pointerId: 3, clientX: 10, clientY: 300, pointerType: "touch" });
    fireEvent.pointerCancel(fields()[0], { pointerId: 3, pointerType: "touch" });
    expect(texts()).toEqual(["дом", "жилище", "здание"]);
    expect(swipes.disableVerticalSwipes).not.toHaveBeenCalled();
    expect(swipes.enableVerticalSwipes).not.toHaveBeenCalled();
  });

  it("W6 a change elsewhere is a conflict: the saved list is shown, «Сохранить моё» goes against the new revision", async () => {
    const f = fixture();
    const editor = await openTranslations(f);
    fireEvent.click(within(editor).getByRole("button", { name: "Переместить «жилище» выше" }));
    // Another device of the owner saved meanwhile.
    f.srv.translations = ["квартира"]; f.srv.revision = 2n;
    fireEvent.click(within(editor).getByRole("button", { name: "Сохранить" }));
    const alert = await within(editor).findByText("Общий перевод уже изменён в другом месте.");
    expect(alert).toBeTruthy();
    expect(within(editor).getByText("Сейчас сохранено: «квартира».")).toBeTruthy();
    expect(texts()).toEqual(["жилище", "дом", "здание"]);
    fireEvent.click(within(editor).getByRole("button", { name: "Сохранить моё" }));
    await within(translation()).findByText("Перевод для всех сохранён.");
    expect(commonPosts(f.srv).map(post => post.expected_field_version)).toEqual(["1", "2"]);
    expect(f.srv.translations).toEqual(["жилище", "дом", "здание"]);
  });

  it("W7 grammar for everyone: each allowed field of the type is saved by its own command; examples are not offered", async () => {
    const f = fixture();
    render(<CardHost {...f.props} />);
    await screen.findByRole("heading", { level: 2 });
    fireEvent.click(await enabled("Изменить грамматику для всех"));
    const editor = screen.getByRole("region", { name: "Грамматика для всех" });
    expect(within(editor).getAllByRole("group").map(group => group.querySelector("legend")!.textContent))
      .toEqual(["Род", "Единственное число", "Множественное число", "Артикль"]);
    const plural = within(editor).getByRole("group", { name: "Множественное число" });
    fireEvent.change(within(plural).getByRole("textbox"), { target: { value: "Häuschen" } });
    fireEvent.click(within(plural).getByRole("button", { name: "Сохранить: Множественное число" }));
    await within(plural).findByText("Сохранено.");
    const gender = within(editor).getByRole("group", { name: "Род" });
    fireEvent.change(within(gender).getAllByRole("combobox")[1], { target: { value: "masculine" } });
    fireEvent.click(within(gender).getByRole("button", { name: "Сохранить: Род" }));
    await within(gender).findByText("Сохранено.");
    expect(commonPosts(f.srv).map(post => [post.payload.field_name, post.payload.language, post.payload.value, post.expected_field_version]))
      .toEqual([["plural", null, { status: "applicable", value: "Häuschen" }, "1"],
        ["gender", null, { status: "applicable", value: "masculine" }, "2"]]);
    expect(within(editor).queryByText(/Пример/)).toBeNull();
  });

  it("W8 unsaved common changes: the screen Back asks first; leaving without saving sends nothing", async () => {
    const f = fixture();
    const editor = await openTranslations(f);
    fireEvent.change(fields()[0], { target: { value: "домик" } });
    expect(editor).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(f.onBack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Выйти без сохранения" }));
    expect(f.onBack).toHaveBeenCalledWith("sent");
    expect(commonPosts(f.srv)).toHaveLength(0);
  });

  it("W9 R12-04: the dictionary's language is open, the others are folded under badges and open on a tap for viewing", async () => {
    const f = fixture();
    const editor = await openTranslations(f);
    const others = await within(editor).findByRole("region", { name: "Другие языки" });
    const uk = await within(others).findByRole("button", { name: "украинский · 2" });
    const en = within(others).getByRole("button", { name: "английский · 0" });
    expect(within(others).queryByRole("button", { name: /русский/ })).toBeNull();
    expect(uk.getAttribute("aria-expanded")).toBe("false");
    expect(within(others).queryByText("будинок")).toBeNull();
    fireEvent.click(uk);
    expect(uk.getAttribute("aria-expanded")).toBe("true");
    expect(within(others).getAllByRole("listitem").map(item => item.textContent)).toEqual(
      expect.arrayContaining(["будинок", "житло"]));
    fireEvent.click(en);
    expect(within(others).getByText("Перевода нет")).toBeTruthy();
    // Viewing only: no field of another language, no save of it.
    expect(within(others).queryByRole("textbox")).toBeNull();
    expect(texts()).toEqual(["дом", "жилище", "здание"]);
    expect(f.srv.reads("/common")).toBe(1);
    expect(commonPosts(f.srv)).toHaveLength(0);
  });
});
