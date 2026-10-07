import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictionaryCardView, OpenedClient } from "../../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../../app/openedAccess";
import { cardView, preposition } from "../card/cardTestData.test-support";
import { cardFieldSlots } from "./CardFieldSlots";
import { ACTION, CONTEXT, fid, json, pairOf, roleCurrent, scalarCurrent } from "./fieldTestData.test-support";
import { useFieldEditors, type FieldEditorsOptions } from "./useFieldEditors";

const CARD = "00000000-0000-4000-8000-000000000901";
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const flush = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });

/** Core-shaped field commands of one card (personal_fields + result_undo), one undo right per save. */
function server() {
  const s = { state: 20n, fields: new Map<string, { value: string | null; version: bigint }>(), right: null as string | null,
    posts: [] as Record<string, any>[], routes: [] as ((body: Record<string, any>) => Response | undefined)[] };
  const field = (key: string) => s.fields.get(key) ?? { value: null, version: 1n };
  const current = (key: string) => {
    const own = field(key), version = String(own.version);
    if (key === "akkusativ" || key === "dativ") {
      const role = (name: string) => ({ value: field(name).value, version: String(field(name).version) });
      return roleCurrent(key, pairOf(role("akkusativ"), role("dativ")));
    }
    return scalarCurrent(key as "translation", own.value, version,
      { undo: key === "translation" && s.right ? { action_id: s.right } : null, common: ["идти", "ходить"] });
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "http://local");
    if (url.pathname === "/api/v1/commands" && init!.method === "POST") {
      const body = JSON.parse(String(init!.body));
      s.posts.push(body);
      const routed = s.routes.shift()?.(body);
      if (routed) return routed;
      const key = body.kind === "field.undo" ? "translation" : body.payload.case_role ?? body.payload.field_name;
      const own = field(key);
      const refuse = (code: string) => json({ command: { id: body.command_id, status: "rejected" }, current: current(key),
        state_version: String(s.state), error: { code } }, 409);
      if (body.kind === "field.undo") {
        if (s.right !== body.action_id) return refuse("CAPABILITY_EXPIRED");
        s.fields.set(key, { value: null, version: own.version + 1n }); s.right = null;
      } else {
        if (String(own.version) !== body.expected_field_version) return refuse("VERSION_CONFLICT");
        const text = String(body.payload.value).trim() || null;
        const stored = key === "translation" && text === "идти, ходить" ? null : text;
        s.fields.set(key, { value: stored, version: own.version + 1n });
        s.right = key === "translation" ? ACTION : null;
      }
      s.state++;
      const fact = { id: body.command_id, kind: body.kind, status: "applied", applied_at: "2026-10-07T09:00:00Z", target_id: fid(600),
        action_id: body.kind === "field.undo" ? body.action_id : key === "translation" ? ACTION : null, result_id: null,
        context_id: body.context_id, object_version: String(own.version + 1n) };
      return json({ command: fact, current: current(key), state_version: String(s.state) });
    }
    throw new Error(`unexpected ${init!.method} ${String(input)}`);
  });
  return Object.assign(s, { fetcher });
}

function access(): OpenedAccess {
  const opened: OpenedClient = { status: "opened", client_instance_id: fid(1), document_id: fid(2), document_epoch: "1", proof_version: "1",
    profile: { profile_id: fid(3), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "20",
      access: { status: "admitted", version: "1", reason: null } }, session: null, compatibility: { compatible: true, contract_version: "1" } };
  return createOpenedAccess({ opened, token: "synthetic-editor-token", proof: "synthetic-editor-proof", generation: 1,
    isLive: () => true, onDenied: () => {} });
}

type HarnessProps = Omit<FieldEditorsOptions, "view" | "stateVersion"> & { view: DictionaryCardView };
function Harness(props: HarnessProps) {
  const { state, actions } = useFieldEditors({ ...props, stateVersion: "20" });
  const slots = cardFieldSlots({ state, actions, view: props.view, language: "ru" });
  return <main>
    <section aria-label="Перевод">{slots.translation}</section>
    <section aria-label="Примеры">{slots.examples}</section>
    <section aria-label="Ассоциация">{slots.association}</section>
    {slots.leave}
    <button type="button" onClick={actions.requestLeave}>Назад</button>
  </main>;
}
function setup(view = cardView(CARD), contextId: string | null = CONTEXT) {
  const srv = server(), onChanged = vi.fn(), onLeave = vi.fn();
  let next = 100;
  const props: HarnessProps = { access: access(), transport: { fetcher: srv.fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000 },
    view, contextId, newId: () => fid(next++), onChanged, onLeave };
  const ui = render(<Harness {...props} />);
  return { srv, onChanged, onLeave, props, ui };
}
const region = (name: string) => screen.getByRole("region", { name });
function nativeBack() {
  const handlers = new Set<() => void>();
  vi.stubGlobal("Telegram", { WebApp: { BackButton: { show() {}, hide() {}, onClick: (h: () => void) => { handlers.add(h); },
    offClick: (h: () => void) => { handlers.delete(h); } } } });
  return { click: () => act(async () => { for (const h of [...handlers]) h(); }) };
}

describe("card field editors on screen (TA §7, Т30, Т31, Т86)", () => {
  it("U1 pencil → editor with the common translation apart; substitution, save, saved note and «Шаг назад»", async () => {
    const f = setup();
    fireEvent.click(within(region("Перевод")).getByRole("button", { name: "Изменить личный перевод" }));
    const editor = region("Перевод");
    expect(within(editor).getByText("Общий перевод: дом")).toBeTruthy();
    const field = within(editor).getByLabelText("Личный перевод") as HTMLTextAreaElement;
    expect(field.value).toBe("");
    const save = within(editor).getByRole("button", { name: "Сохранить" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(field, { target: { value: " домик " } });
    fireEvent.click(save);
    expect(within(region("Перевод")).getByRole("status").textContent).toBe("Сохраняем…");
    await screen.findByText("Сохранено.");
    expect(f.srv.posts[0]).toMatchObject({ kind: "field.save", context_id: CONTEXT, expected_field_version: "1",
      payload: { field_name: "translation", value: " домик ", scope: "personal", language: "ru" } });
    expect(f.onChanged).toHaveBeenCalledTimes(1);
    fireEvent.click(within(region("Перевод")).getByRole("button", { name: "Шаг назад" }));
    await waitFor(() => expect(f.srv.posts[1]).toMatchObject({ kind: "field.undo", action_id: ACTION, expected_field_version: "2" }));
    await waitFor(() => expect(within(region("Перевод")).queryByRole("button", { name: "Шаг назад" })).toBeNull());
    expect(screen.queryByText("Сохранено.")).toBeNull();
  });

  it("U2 «Подставить общий» fills «идти, ходить» without sending; saving it unchanged removes the personal one (К07-036…038)", async () => {
    const view = cardView(CARD);
    view.content.translations = { common: ["идти", "ходить"], personal: { value: "шагать", version: "1" } };
    const f = setup(view);
    fireEvent.click(within(region("Перевод")).getByRole("button", { name: "Изменить личный перевод" }));
    fireEvent.click(screen.getByRole("button", { name: "Подставить общий" }));
    expect((screen.getByLabelText("Личный перевод") as HTMLTextAreaElement).value).toBe("идти, ходить");
    expect(f.srv.posts).toEqual([]);
    expect(screen.getByText("Текст совпадает с общим переводом: личный перевод будет снят.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Личный перевод снят — показан общий.");
  });

  it("U3 an emptied own example says it will be removed; «Добавить ассоциацию» without one (К07-042, К07-045)", async () => {
    const view = cardView(CARD);
    view.content.examples = { common: [], personal: { value: "Mein Haus.", version: "1" } };
    setup(view);
    expect(within(region("Ассоциация")).getByRole("button", { name: "Добавить ассоциацию" }).textContent).toBe("Добавить ассоциацию");
    fireEvent.click(within(region("Примеры")).getByRole("button", { name: "Изменить личный пример" }));
    fireEvent.change(screen.getByLabelText("Личный пример"), { target: { value: "  " } });
    expect(screen.getByText("Пустое поле удалит личный пример — будут показаны общие.")).toBeTruthy();
    // One editor at a time (Р2).
    expect((within(region("Ассоциация")).getByRole("button", { name: "Добавить ассоциацию" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Личный пример удалён — показаны общие.");
  });

  it("U4 conflict: the typed text stays, the saved value is shown, the choice is explicit (Т61)", async () => {
    const f = setup();
    f.srv.fields.set("association", { value: "Чужое", version: 3n });
    fireEvent.click(within(region("Ассоциация")).getByRole("button", { name: "Добавить ассоциацию" }));
    fireEvent.change(within(region("Ассоциация")).getByRole("textbox"), { target: { value: "Моё" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Это поле уже изменено в другом месте.");
    expect(screen.getByText("Сейчас сохранено: «Чужое».")).toBeTruthy();
    expect((within(region("Ассоциация")).getByRole("textbox") as HTMLTextAreaElement).value).toBe("Моё");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить моё" }));
    await screen.findByText("Сохранено.");
    expect(f.srv.posts[1]).toMatchObject({ expected_field_version: "3", payload: { value: "Моё" } });
  });

  it("U5 a lost reply keeps the text and «Повторить» resends the same command (Т31)", async () => {
    const f = setup();
    f.srv.routes.push(() => { throw new TypeError("network down"); });
    fireEvent.click(within(region("Ассоциация")).getByRole("button", { name: "Добавить ассоциацию" }));
    fireEvent.change(within(region("Ассоциация")).getByRole("textbox"), { target: { value: "Bild" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    // The status check by the same ID also fails here (no route): the text stays, the same command may be repeated.
    await screen.findByRole("button", { name: "Повторить" });
    expect(screen.getByRole("alert").textContent).toBe("Нет подтверждения сохранения. Текст остался в поле.");
    expect((within(region("Ассоциация")).getByRole("textbox") as HTMLTextAreaElement).value).toBe("Bild");
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByText("Сохранено.");
    expect(f.srv.posts).toHaveLength(2);
    expect(f.srv.posts[1]).toEqual(f.srv.posts[0]);
  });

  it("U6 leaving with unsaved text asks first, by the screen Back and the native Back (К07-039, Т31)", async () => {
    const back = nativeBack(), f = setup();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(f.onLeave).toHaveBeenCalledTimes(1);
    fireEvent.click(within(region("Ассоциация")).getByRole("button", { name: "Добавить ассоциацию" }));
    fireEvent.change(within(region("Ассоциация")).getByRole("textbox"), { target: { value: "Bild" } });
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Есть несохранённые изменения.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Продолжить редактирование" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((within(region("Ассоциация")).getByRole("textbox") as HTMLTextAreaElement).value).toBe("Bild");
    await flush();
    await back.click();
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Native Back over the question continues editing; the explicit choice leaves without saving.
    await back.click();
    expect(screen.queryByRole("dialog")).toBeNull();
    await back.click();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Выйти без сохранения" }));
    expect(f.onLeave).toHaveBeenCalledTimes(2);
    expect(f.srv.posts).toEqual([]);
  });

  it("U7 the two-case preposition: two signed fields, each role saved by its own command (Т85)", async () => {
    const f = setup(preposition({ akkusativ: "Ich gehe ins Kino.", dativ: null }));
    expect(within(region("Примеры")).queryByRole("button", { name: "Изменить личный пример" })).toBeNull();
    fireEvent.click(within(region("Примеры")).getByRole("button", { name: "Изменить личные примеры" }));
    const pair = screen.getByRole("group", { name: "Личные примеры Akkusativ / Dativ" });
    expect((within(pair).getByLabelText("Akkusativ") as HTMLTextAreaElement).value).toBe("Ich gehe ins Kino.");
    expect(within(pair).getByText("Личные примеры показываются в карточке, когда заполнены оба поля.")).toBeTruthy();
    fireEvent.change(within(pair).getByLabelText("Dativ"), { target: { value: "Ich bin im Kino." } });
    f.srv.fields.set("dativ", { value: null, version: 2n });
    const saveDativ = within(pair).getByRole("button", { name: "Сохранить Dativ" });
    fireEvent.click(saveDativ);
    await within(pair).findByText("Сохранено.");
    expect(f.srv.posts[0]).toMatchObject({ expected_field_version: "2", payload: { field_name: "example", case_role: "dativ", value: "Ich bin im Kino." } });
    expect(screen.getByRole("group", { name: "Личные примеры Akkusativ / Dativ" })).toBeTruthy();
    fireEvent.click(within(pair).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("group", { name: "Личные примеры Akkusativ / Dativ" })).toBeNull();
  });

  it("U8 without the open card context the pencils wait", () => {
    setup(cardView(CARD), null);
    expect((within(region("Перевод")).getByRole("button", { name: "Изменить личный перевод" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("U9 the leave question is a window (RA 6.1.12): focus on «Продолжить редактирование», Escape continues, focus returns", async () => {
    setup();
    fireEvent.click(within(region("Ассоциация")).getByRole("button", { name: "Добавить ассоциацию" }));
    const field = within(region("Ассоциация")).getByRole("textbox") as HTMLTextAreaElement;
    field.focus();
    fireEvent.change(field, { target: { value: "Bild" } });
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    const dialog = screen.getByRole("dialog", { name: "Есть несохранённые изменения. Выйти без сохранения?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Продолжить редактирование" }));
    expect(within(dialog).getByRole("button", { name: "Выйти без сохранения" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("Bild");
  });

  it("U10 a typed translation or association carries the dictionary language, an example German (as CardDescription)", () => {
    setup(cardView(CARD, "uk-de"));
    fireEvent.click(within(region("Перевод")).getByRole("button", { name: "Изменить личный перевод" }));
    expect(within(region("Перевод")).getByRole("textbox").getAttribute("lang")).toBe("uk");
    fireEvent.click(within(region("Перевод")).getByRole("button", { name: "Отмена" }));
    fireEvent.click(within(region("Ассоциация")).getByRole("button", { name: "Добавить ассоциацию" }));
    expect(within(region("Ассоциация")).getByRole("textbox").getAttribute("lang")).toBe("uk");
    fireEvent.click(within(region("Ассоциация")).getByRole("button", { name: "Отмена" }));
    fireEvent.click(within(region("Примеры")).getByRole("button", { name: "Добавить пример" }));
    expect(within(region("Примеры")).getByRole("textbox").getAttribute("lang")).toBe("de");
  });
});
