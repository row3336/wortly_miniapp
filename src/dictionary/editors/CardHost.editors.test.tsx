import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictionaryCardView, OpenedClient } from "../../api/generated";
import { useBackLayer } from "../../app/navigationBack";
import { createOpenedAccess } from "../../app/openedAccess";
import { ManualPendingStore } from "../../learning/manualPending";
import type { AsyncStorage } from "../../platform/storage";
import { CardHost, type CardHostProps } from "../card/CardHost";
import { CARD, cardView, preposition } from "../card/cardTestData.test-support";
import { testGate } from "../../commands/testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ACTION = id(777);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Core-shaped server of one card: its view with own fields, the card context and the field commands (C-FIELDS-1/2). */
function server(base: () => DictionaryCardView = cardView) {
  const s = { state: 10n, next: 500, contexts: new Map<string, "open" | "closed">(), right: null as string | null,
    own: new Map<string, { value: string | null; version: bigint }>(), posts: [] as Record<string, any>[] };
  const field = (key: string) => s.own.get(key) ?? { value: null, version: key === "akkusativ" || key === "dativ" ? 2n : 1n };
  const text = (key: string) => { const own = field(key); return own.value === null ? null : { value: own.value, version: String(own.version) }; };
  const view = (localDate: string | null = "2026-10-07") => {
    const value = base();
    value.study.local_date = localDate;
    if (localDate === null) value.study.directions.forEach(direction => { direction.interval_preview = null; });
    value.content.translations.personal = text("translation");
    value.content.association = text("association");
    value.content.field_versions = { translation: String(field("translation").version), example: "1", association: String(field("association").version) };
    if ("preposition_pair" in value.content.examples) {
      const pair = value.content.examples.preposition_pair;
      const role = (key: string) => ({ value: field(key).value, version: String(field(key).version) });
      pair.editor = { akkusativ: role("akkusativ"), dativ: role("dativ") };
      if (pair.editor.akkusativ.value !== null && pair.editor.dativ.value !== null) {
        pair.effective = { source: "personal", akkusativ: { value: pair.editor.akkusativ.value, version: pair.editor.akkusativ.version },
          dativ: { value: pair.editor.dativ.value, version: pair.editor.dativ.version } };
      }
    }
    return value;
  };
  const context = (contextId: string) => {
    const status = s.contexts.get(contextId), reference = { id: contextId, kind: "dictionary", card_id: CARD };
    return status === "open" ? { status, context: reference, view: view(null), interval: null,
      capabilities: { interval_increase: null, undo_offer: null, undo_target: null } } : status === "closed" ? { status, context: reference } : { status: "unavailable" };
  };
  const current = (key: string) => {
    const content = view().content;
    if (key === "akkusativ" || key === "dativ") {
      const pair = (content.examples as { preposition_pair: any }).preposition_pair;
      return { status: "available", card_id: CARD, language: "ru", card_revision: "1", field_name: "example", case_role: key,
        field_version: String(field(key).version), personal: text(key), preposition_pair: pair };
    }
    return { status: "available", card_id: CARD, language: "ru", card_revision: "1", field_name: key, field_version: String(field(key).version),
      personal: text(key), common_translations: key === "translation" ? content.translations.common : null,
      common_examples: key === "example" ? [] : null,
      undo_target: key === "translation" && s.right ? { action_id: s.right, kind: "field.save", version: "1", context_id: [...s.contexts.keys()].at(-1) } : null };
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "http://local");
    if (url.pathname === `/api/v1/dictionary/cards/${CARD}/view`) return json({ state_version: String(s.state), current: view() });
    if (url.pathname.startsWith("/api/v1/dictionary/contexts/")) {
      return json({ state_version: String(s.state), current: context(url.pathname.split("/").at(-1)!) });
    }
    if (url.pathname === "/api/v1/learning/current") return json({ pair: "ru-de", state_version: String(s.state), manual_selection_version: "1",
      group: null, manual_selection: [], learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 2,
        manual_eligible: 0, automatic_eligible: 2 } });
    if (url.pathname !== "/api/v1/commands" || init!.method !== "POST") throw new Error(`unexpected ${init!.method} ${input}`);
    const body = JSON.parse(String(init!.body));
    s.posts.push(body);
    const fact = (extra: Record<string, unknown>) => ({ id: body.command_id, kind: body.kind, status: "applied", applied_at: "2026-10-07T09:00:00Z",
      result_id: null, ...extra });
    if (body.kind === "context.open" || body.kind === "context.close") {
      let contextId: string = body.context_id;
      if (body.kind === "context.open") { contextId = id(s.next++); s.contexts.set(contextId, "open"); } else s.contexts.set(contextId, "closed");
      s.state++; s.right = null;
      return json({ command: fact({ target_id: CARD, action_id: null, context_id: contextId, object_version: null }),
        current: context(contextId), state_version: String(s.state) });
    }
    const key = body.kind === "field.undo" ? "translation" : body.payload.case_role ?? body.payload.field_name;
    const own = field(key);
    if (body.kind === "field.undo") s.own.set(key, { value: null, version: own.version + 1n });
    else s.own.set(key, { value: String(body.payload.value).trim() || null, version: own.version + 1n });
    s.right = body.kind === "field.save" && key === "translation" ? ACTION : null;
    s.state++;
    return json({ command: fact({ target_id: id(600), action_id: body.kind === "field.undo" ? body.action_id : s.right,
      context_id: body.context_id, object_version: String(own.version + 1n) }), current: current(key), state_version: String(s.state) });
  });
  const reads = (part: string) => fetcher.mock.calls.filter(([url, init]) => init!.method === "GET" && String(url).includes(part)).length;
  return Object.assign(s, { fetcher, reads });
}

function fixture(base?: () => DictionaryCardView) {
  const srv = server(base), values = new Map<string, string>();
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  const opened: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
    profile: { profile_id: id(3), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "10",
      access: { status: "admitted", version: "1", reason: null } }, session: null, compatibility: { compatible: true, contract_version: "1" } };
  let next = 100;
  const onBack = vi.fn();
  const props: CardHostProps = { access: createOpenedAccess({ opened, token: "synthetic-edit-token", proof: "synthetic-edit-proof", generation: 1,
    isLive: () => true, onDenied: () => {} }), transport: { fetcher: srv.fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000, gate: testGate() },
    language: "ru", pendingStore: new ManualPendingStore(storage), cardId: CARD, origin: { kind: "dictionary" }, newId: () => id(next++), onBack };
  return { srv, props, onBack };
}
/** The document's one screen-layer Back handler calls the card's slot (as ApplicationDocument does). */
function Document(props: CardHostProps) {
  const slot = useRef<(() => void) | null>(null);
  useBackLayer("screen", () => slot.current?.());
  return <CardHost {...props} backSlot={slot} />;
}
function nativeBack() {
  const handlers = new Set<() => void>();
  vi.stubGlobal("Telegram", { WebApp: { BackButton: { show() {}, hide() {}, onClick: (h: () => void) => { handlers.add(h); },
    offClick: (h: () => void) => { handlers.delete(h); } } } });
  return { click: () => act(async () => { for (const h of [...handlers]) h(); }) };
}
const translation = () => screen.getByRole("region", { name: "Перевод" });
const pencil = async (name: string) => {
  const button = await screen.findByRole("button", { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
};

describe("М12 own-field editors in the card host (M-EDIT CP2)", () => {
  it("E1 the pencil waits for the context; a save rereads the card and its context in place; «Шаг назад» restores the common one", async () => {
    const f = fixture();
    render(<CardHost {...f.props} />);
    await screen.findByRole("heading", { level: 2 });
    fireEvent.click(await pencil("Изменить личный перевод"));
    fireEvent.change(within(translation()).getByRole("textbox"), { target: { value: "домик" } });
    const views = f.srv.reads("/view"), contexts = f.srv.reads("/dictionary/contexts/");
    fireEvent.click(within(translation()).getByRole("button", { name: "Сохранить" }));
    await within(translation()).findByText("Личный перевод");
    expect(within(translation()).getByText("домик")).toBeTruthy();
    expect(within(translation()).getByText("Сохранено.")).toBeTruthy();
    const save = f.srv.posts.find(post => post.kind === "field.save")!;
    expect(save).toMatchObject({ context_id: [...f.srv.contexts.keys()][0], expected_field_version: "1",
      payload: { card_id: CARD, field_name: "translation", value: "домик", language: "ru", scope: "personal" } });
    await waitFor(() => expect(f.srv.reads("/view")).toBe(views + 1));
    expect(f.srv.reads("/dictionary/contexts/")).toBe(contexts + 1);
    fireEvent.click(within(translation()).getByRole("button", { name: "Шаг назад" }));
    await waitFor(() => expect(within(translation()).queryByText("домик")).toBeNull());
    expect(within(translation()).getByText("дом")).toBeTruthy();
    expect(f.srv.posts.at(-1)).toMatchObject({ kind: "field.undo", action_id: ACTION, expected_field_version: "2" });
  });

  it("E2 unsaved text: the screen and the native Back ask; leaving without saving closes the context", async () => {
    const back = nativeBack(), f = fixture();
    render(<Document {...f.props} />);
    await screen.findByRole("heading", { level: 2 });
    fireEvent.click(await pencil("Добавить ассоциацию"));
    fireEvent.change(within(screen.getByRole("region", { name: "Ассоциация" })).getByRole("textbox"), { target: { value: "Bild" } });
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(f.onBack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Продолжить редактирование" }));
    await back.click();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(f.onBack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Выйти без сохранения" }));
    expect(f.onBack).toHaveBeenCalledWith("sent");
    await waitFor(() => expect(f.srv.posts.at(-1)).toMatchObject({ kind: "context.close" }));
    expect(f.srv.posts.some(post => post.kind === "field.save")).toBe(false);
  });

  it("E3 without unsaved text Back leaves at once (no question)", async () => {
    const back = nativeBack(), f = fixture();
    render(<Document {...f.props} />);
    await screen.findByRole("heading", { level: 2 });
    fireEvent.click(await pencil("Добавить ассоциацию"));
    await back.click();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.onBack).toHaveBeenCalledWith("sent");
  });

  it("E4 the full own pair of a two-case preposition replaces both common examples after two role saves (Т85)", async () => {
    const f = fixture(() => preposition());
    render(<CardHost {...f.props} />);
    await screen.findByRole("heading", { level: 2 });
    fireEvent.click(await pencil("Добавить примеры"));
    const pair = screen.getByRole("group", { name: "Личные примеры Akkusativ / Dativ" });
    fireEvent.change(within(pair).getByLabelText("Akkusativ"), { target: { value: "Ich gehe ins Kino." } });
    fireEvent.click(within(pair).getByRole("button", { name: "Сохранить Akkusativ" }));
    await within(pair).findByText("Сохранено.");
    // One own role: the card still shows both common examples (К05-127).
    const examples = screen.getByRole("region", { name: "Примеры" });
    expect(within(examples).getByText("Ich gehe in die Stadt.")).toBeTruthy();
    fireEvent.change(within(pair).getByLabelText("Dativ"), { target: { value: "Ich bin im Kino." } });
    fireEvent.click(within(pair).getByRole("button", { name: "Сохранить Dativ" }));
    await waitFor(() => expect(within(examples).queryByText("Ich gehe in die Stadt.")).toBeNull());
    expect(f.srv.posts.filter(post => post.kind === "field.save").map(post => [post.payload.case_role, post.expected_field_version]))
      .toEqual([["akkusativ", "2"], ["dativ", "2"]]);
  });
  it("E5 after a save the context is read again even when the card read fails (onChanged; QA M-EDIT W1, M7)", async () => {
    const f = fixture();
    render(<CardHost {...f.props} />);
    await screen.findByRole("heading", { level: 2 });
    fireEvent.click(await pencil("Изменить личный перевод"));
    fireEvent.change(within(translation()).getByRole("textbox"), { target: { value: "домик" } });
    const base = f.srv.fetcher.getMockImplementation()!;
    f.srv.fetcher.mockImplementation(async (input, init) => String(input).includes("/view")
      ? json({ error: { code: "INTERNAL" } }, 500) : base(input, init));
    const contexts = f.srv.reads("/dictionary/contexts/");
    fireEvent.click(within(translation()).getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(f.srv.posts.some(post => post.kind === "field.save")).toBe(true));
    await waitFor(() => expect(f.srv.reads("/dictionary/contexts/")).toBe(contexts + 1));
  });
});
