import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/http";
import type { FieldCommand, FieldCommandReply, FieldCommandStatus } from "./fieldEditorApi";
import { FieldEditorsController, type CardFields, type FieldEditorsPort } from "./fieldEditorsController";
import { ACTION, CARD_ID, CONTEXT, fid, fieldFact, origin, pairOf, roleCurrent, scalarCurrent } from "./fieldTestData.test-support";
import { testGate } from "../../commands/testGate.test-support";
import type { WriteGate } from "../../commands/writeGate";
import { WriteGate as RealWriteGate } from "../../commands/writeGate";
import { ManualClock } from "../../commands/writeGate.test-support";

type Step = (command: FieldCommand) => FieldCommandReply | Promise<FieldCommandReply>;
type Check = (command: FieldCommand) => FieldCommandStatus | Promise<FieldCommandStatus>;

const card = (change: Partial<CardFields> = {}): CardFields => ({ cardId: CARD_ID, language: "ru", stateVersion: "10",
  fields: { translation: { value: null, version: "1" }, example: { value: null, version: "1" }, association: { value: "Bild", version: "4" } },
  commonTranslations: ["идти", "ходить"], ...change });
const pairCard = () => card({ fields: { translation: { value: null, version: "1" }, association: { value: null, version: "1" },
  akkusativ: { value: "Ich gehe.", version: "2" }, dativ: { value: null, version: "3" } } });

function accepted(command: FieldCommand, stateVersion = "11"): FieldCommandReply {
  const key = command.kind === "field.save" ? command.case_role ?? command.field_name : "translation";
  const value = command.kind === "field.save" ? command.value?.trim() || null : null;
  const version = String(BigInt(command.expected_field_version) + 1n);
  const translationSave = command.kind === "field.save" && key === "translation";
  const current = key === "akkusativ" || key === "dativ"
    ? roleCurrent(key, pairOf(key === "akkusativ" ? { value, version } : { value: null, version: "1" },
      key === "dativ" ? { value, version } : { value: null, version: "1" }))
    : scalarCurrent(key, value, version, { undo: translationSave ? { action_id: ACTION } : null, common: ["идти", "ходить"] });
  return { outcome: "accepted", command: fieldFact(command) as never, current: current as never, state_version: stateVersion };
}
function rejected(command: FieldCommand, code: string, current: object, stateVersion = "11"): FieldCommandReply {
  return { outcome: "rejected", command: { id: command.command_id, status: "rejected" }, error: { code }, current: current as never,
    state_version: stateVersion };
}

function setup(options: { send?: Step[]; status?: Check[]; card?: CardFields; context?: string | null; writeGate?: WriteGate } = {}) {
  const sends = [...(options.send ?? [])], checks = [...(options.status ?? [])];
  let next = 100, live = { ...origin };
  const sent: FieldCommand[] = [], checked: FieldCommand[] = [];
  const port: FieldEditorsPort = {
    origin: () => live,
    send: vi.fn(async command => { sent.push(structuredClone(command)); const step = sends.shift(); if (!step) throw new Error("no send"); return step(command); }),
    status: vi.fn(async command => { checked.push(structuredClone(command)); const step = checks.shift(); if (!step) throw new ApiError("network"); return step(command); }),
  };
  const onChanged = vi.fn();
  const controller = new FieldEditorsController({ gate: options.writeGate ?? testGate(), port, newId: () => fid(next++), onUpdate: () => {}, onChanged });
  controller.setCard(options.card ?? card());
  controller.setContext(options.context === undefined ? CONTEXT : options.context);
  return { controller, sent, checked, onChanged, port, moveDocument: (documentId: string) => { live = { ...live, document_id: documentId }; } };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe("own-field editors of one card (TA §7)", () => {
  it("C1 opens from the own value; substitution fills the field only; cancel sends nothing (К07-036, Т86)", () => {
    const { controller, sent } = setup();
    controller.open("translation");
    let editor = controller.snapshot().editors.translation!;
    expect(editor).toMatchObject({ phase: "editing", original: "", draft: "", fieldVersion: "1", dirty: false, canSave: false });
    controller.substitute();
    editor = controller.snapshot().editors.translation!;
    expect(editor).toMatchObject({ draft: "идти, ходить", dirty: true, canSave: true });
    expect(controller.snapshot().unsaved).toBe(true);
    controller.cancel();
    expect(controller.snapshot()).toMatchObject({ open: null, editors: {}, unsaved: false });
    expect(sent).toEqual([]);
  });

  it("C2 save: saving locks a repeat; the reply shows the stored value, offers the undo of this save and rereads", async () => {
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const { controller, sent, onChanged } = setup({ send: [async command => { await gate; return accepted(command); }] });
    controller.open("translation");
    controller.edit("translation", "  мой дом ");
    const saving = controller.save("translation");
    void controller.save("translation");
    await flush();
    expect(controller.snapshot().editors.translation).toMatchObject({ phase: "saving", canSave: false, canEdit: false, canCancel: false });
    expect(controller.snapshot().unsaved).toBe(true);
    controller.edit("translation", "другое");
    expect(controller.snapshot().editors.translation!.draft).toBe("  мой дом ");
    release(); await saving;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "field.save", value: "  мой дом ", expected_field_version: "1", context_id: CONTEXT,
      field_name: "translation", case_role: null });
    const state = controller.snapshot();
    expect(state.open).toBeNull();
    expect(state.editors.translation).toMatchObject({ phase: "saved", saved: "мой дом", draft: "мой дом", dirty: false });
    expect(state.undo).toMatchObject({ status: "offered", canUndo: true });
    expect(state.unsaved).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
    // The next editor starts from the saved version, even before the card read arrives.
    controller.open("translation");
    expect(controller.snapshot().editors.translation).toMatchObject({ original: "мой дом", fieldVersion: "2" });
  });

  it("C3 an undo_target of another action is not this save's undo", async () => {
    const { controller } = setup({ send: [command => ({ ...accepted(command), current: scalarCurrent("translation", "x", "2",
      { undo: { action_id: fid(778) } }) as never })] });
    controller.open("translation"); controller.edit("translation", "x");
    await controller.save("translation");
    expect(controller.snapshot().undo).toBeNull();
  });

  it("C4 conflict keeps the text, shows the actual value; «Сохранить моё» is a new command with the new version (Т61)", async () => {
    const { controller, sent, onChanged } = setup({ send: [
      command => rejected(command, "VERSION_CONFLICT", scalarCurrent("translation", "первый", "2")),
      command => rejected(command, "VERSION_CONFLICT", scalarCurrent("translation", "второй", "3")),
      command => accepted(command, "13"),
    ] });
    controller.open("translation"); controller.edit("translation", "набранный");
    await controller.save("translation");
    let editor = controller.snapshot().editors.translation!;
    expect(editor).toMatchObject({ phase: "conflict", draft: "набранный", current: { value: "первый", version: "2" }, fieldVersion: "2" });
    expect(controller.snapshot().unsaved).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
    await controller.keepMine("translation");
    expect(sent[1]).toMatchObject({ value: "набранный", expected_field_version: "2" });
    expect(sent[1].command_id).not.toBe(sent[0].command_id);
    // A repeated conflict is checked again, never overwritten silently (К11-011, К11-012).
    editor = controller.snapshot().editors.translation!;
    expect(editor).toMatchObject({ phase: "conflict", current: { value: "второй", version: "3" } });
    await controller.keepMine("translation");
    expect(sent[2]).toMatchObject({ expected_field_version: "3" });
    expect(controller.snapshot().editors.translation!.phase).toBe("saved");
  });

  it("C5 «Взять сохранённое» replaces the draft only by that choice", async () => {
    const { controller, sent } = setup({ send: [command => rejected(command, "VERSION_CONFLICT", scalarCurrent("association", null, "5"))] });
    controller.open("association"); controller.edit("association", "Neu");
    await controller.save("association");
    controller.acceptCurrent("association");
    expect(controller.snapshot().editors.association).toMatchObject({ phase: "editing", draft: "", original: "", fieldVersion: "5", dirty: false });
    expect(sent).toHaveLength(1);
  });

  it("C6 unknown outcome: one status check by the same ID; «Повторить» resends the same command (CON:149)", async () => {
    const { controller, sent, checked } = setup({
      send: [() => { throw new ApiError("network"); }, command => accepted(command)],
      status: [command => ({ outcome: "not_found", command: { id: command.command_id, status: "not_found" }, current: {} as never, state_version: "10" })],
    });
    controller.open("association"); controller.edit("association", "Haus am See");
    await controller.save("association");
    await flush();
    expect(checked).toHaveLength(1);
    expect(checked[0].command_id).toBe(sent[0].command_id);
    let editor = controller.snapshot().editors.association!;
    expect(editor).toMatchObject({ phase: "failed", problem: { reason: "unknown" }, canRetry: true, canSave: false, canEdit: false });
    await controller.retry("association");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    editor = controller.snapshot().editors.association!;
    expect(editor).toMatchObject({ phase: "saved", saved: "Haus am See" });
  });

  it("C7 an unknown outcome whose status shows the fact settles without a second send", async () => {
    const { controller, sent } = setup({ send: [() => { throw new ApiError("http", 503); }],
      status: [command => { const reply = accepted(command); return { outcome: "accepted", command: { ...reply.command, status: "already_applied" } as never,
        current: reply.current, state_version: reply.state_version }; }] });
    controller.open("translation"); controller.edit("translation", "дом");
    await controller.save("translation"); await flush();
    expect(sent).toHaveLength(1);
    expect(controller.snapshot().editors.translation!.phase).toBe("saved");
    expect(controller.snapshot().undo?.status).toBe("offered");
  });

  it("C8 a known refusal keeps the text; «Повторить» is a new command; the card is reread", async () => {
    const { controller, sent, onChanged } = setup({ send: [
      command => rejected(command, "WRITE_UNAVAILABLE", scalarCurrent("example", null, "1")), command => accepted(command)] });
    controller.open("example"); controller.edit("example", "Mein Satz.");
    await controller.save("example");
    expect(controller.snapshot().editors.example).toMatchObject({ phase: "failed", problem: { reason: "refused", code: "WRITE_UNAVAILABLE" },
      draft: "Mein Satz.", canRetry: true });
    expect(onChanged).toHaveBeenCalledTimes(1);
    await controller.retry("example");
    expect(sent[1].command_id).not.toBe(sent[0].command_id);
    expect(sent[1]).toMatchObject({ value: "Mein Satz.", field_name: "example" });
  });

  it("C9 VERSION_CONFLICT of another language is unavailable: no retry, the card is reread (C-FIELDS-1 §12 Н3)", async () => {
    const { controller, onChanged } = setup({ send: [command => rejected(command, "VERSION_CONFLICT", { status: "unavailable" })] });
    controller.open("translation"); controller.edit("translation", "x");
    await controller.save("translation");
    expect(controller.snapshot().editors.translation).toMatchObject({ phase: "failed", problem: { reason: "unavailable" }, canRetry: false, canSave: false });
    expect(onChanged).toHaveBeenCalled();
  });

  it("C10 «Шаг назад» sends field.undo of that save; afterwards no undo remains", async () => {
    const { controller, sent, onChanged } = setup({ send: [command => accepted(command), command => accepted(command, "12")] });
    controller.open("translation"); controller.edit("translation", "мой");
    await controller.save("translation");
    await controller.undo();
    expect(sent[1]).toMatchObject({ kind: "field.undo", action_id: ACTION, expected_action_version: "1", expected_field_version: "2",
      context_id: CONTEXT, card_id: CARD_ID, language: "ru" });
    expect(controller.snapshot().undo).toBeNull();
    expect(controller.snapshot().editors.translation).toBeUndefined();
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("C11 a refused undo says it is no longer available and rereads", async () => {
    const { controller, onChanged } = setup({ send: [command => accepted(command),
      command => rejected(command, "CAPABILITY_EXPIRED", scalarCurrent("translation", "мой", "2"))] });
    controller.open("translation"); controller.edit("translation", "мой");
    await controller.save("translation");
    await controller.undo();
    expect(controller.snapshot().undo).toMatchObject({ status: "failed", canUndo: false, problem: { code: "CAPABILITY_EXPIRED" } });
    expect(onChanged).toHaveBeenCalledTimes(2);
    controller.open("association");
    expect(controller.snapshot().undo).toBeNull();
  });

  it("C12 the next own action ends the undo; opening an editor or a background does not (CT 2.3, К05-073)", async () => {
    const { controller } = setup({ send: [command => accepted(command), command => accepted(command, "12")] });
    controller.open("translation"); controller.edit("translation", "мой");
    await controller.save("translation");
    controller.open("association");
    expect(controller.snapshot().undo?.status).toBe("offered");
    expect(controller.snapshot().undo?.canUndo).toBe(true);
    await controller.resume();
    expect(controller.snapshot().undo?.status).toBe("offered");
    controller.edit("association", "Neu");
    await controller.save("association");
    expect(controller.snapshot().undo).toBeNull();
  });

  it("C13 a newer state elsewhere asks the server about the save's undo; the same version asks nothing", async () => {
    const statusOf = (keep: boolean): Check => command => { const reply = accepted(command);
      return { outcome: "accepted", command: { ...reply.command, status: "already_applied" } as never,
        current: scalarCurrent("translation", "мой", "2", { undo: keep ? { action_id: ACTION } : null }) as never, state_version: "13" }; };
    const { controller, checked } = setup({ send: [command => accepted(command)], status: [statusOf(true), statusOf(false)] });
    controller.open("translation"); controller.edit("translation", "мой");
    await controller.save("translation");
    controller.observe("11");
    controller.setCard(card({ stateVersion: "11" }));
    await flush();
    expect(checked).toHaveLength(0);
    controller.observe("13");
    await flush();
    expect(checked).toHaveLength(1);
    expect(checked[0]).toMatchObject({ kind: "field.save", command_id: fid(100) });
    expect(controller.snapshot().undo?.status).toBe("offered");
    controller.observe("14");
    await flush();
    expect(controller.snapshot().undo).toBeNull();
  });

  it("C14 a new document or another context ends the undo; a retry keeps its ID with the current document", async () => {
    const first = setup({ send: [command => accepted(command)] });
    first.controller.open("translation"); first.controller.edit("translation", "мой");
    await first.controller.save("translation");
    first.controller.resetDocument();
    expect(first.controller.snapshot().undo).toBeNull();

    const second = setup({ send: [command => accepted(command)] });
    second.controller.open("translation"); second.controller.edit("translation", "мой");
    await second.controller.save("translation");
    second.controller.setContext(fid(501));
    expect(second.controller.snapshot().undo).toBeNull();

    const third = setup({ send: [() => { throw new ApiError("network"); }, command => accepted(command)],
      status: [() => { throw new ApiError("network"); }] });
    third.controller.open("association"); third.controller.edit("association", "x");
    await third.controller.save("association"); await flush();
    third.moveDocument(fid(3));
    await third.controller.retry("association");
    expect(third.sent[1]).toEqual({ ...third.sent[0], document_id: fid(3) });
  });

  it("C15 the pair: two role editors, one command per role with case_role and its own version (К07-121, Т85)", async () => {
    const { controller, sent } = setup({ card: pairCard(), send: [command => accepted(command), command => accepted(command)] });
    controller.open("example");
    expect(controller.snapshot().open).toBeNull();
    controller.open("pair");
    const state = controller.snapshot();
    expect(state.editors.akkusativ).toMatchObject({ original: "Ich gehe.", fieldVersion: "2" });
    expect(state.editors.dativ).toMatchObject({ original: "", fieldVersion: "3" });
    controller.edit("dativ", "Ich bin hier.");
    controller.edit("akkusativ", "");
    await controller.save("dativ");
    expect(sent[0]).toMatchObject({ field_name: "example", case_role: "dativ", value: "Ich bin hier.", expected_field_version: "3" });
    // The pair stays open; the other role keeps its unsaved text and version.
    expect(controller.snapshot()).toMatchObject({ open: "pair", unsaved: true });
    expect(controller.snapshot().editors.dativ!.phase).toBe("saved");
    expect(controller.snapshot().editors.akkusativ).toMatchObject({ draft: "", dirty: true, fieldVersion: "2" });
    await controller.save("akkusativ");
    expect(sent[1]).toMatchObject({ case_role: "akkusativ", value: "", expected_field_version: "2" });
    expect(controller.snapshot().editors.akkusativ).toMatchObject({ phase: "saved", saved: null });
    expect(controller.snapshot().undo).toBeNull();
  });

  it("C16 one group at a time; no pencil without the open card context", () => {
    const { controller } = setup();
    controller.open("translation");
    controller.open("association");
    expect(controller.snapshot().open).toBe("translation");
    expect(controller.snapshot().canOpen).toBe(false);
    const closed = setup({ context: null });
    expect(closed.controller.snapshot().canOpen).toBe(false);
    closed.controller.open("translation");
    expect(closed.controller.snapshot().open).toBeNull();
  });

  it("C17 cancel forgets an unresolved save and rereads the card; a save in flight cannot be cancelled", async () => {
    let release!: () => void;
    const { controller, onChanged } = setup({ send: [async () => { await new Promise<void>(done => { release = done; }); throw new ApiError("network"); }],
      status: [() => { throw new ApiError("network"); }] });
    controller.open("association"); controller.edit("association", "x");
    const saving = controller.save("association");
    await flush();
    controller.cancel();
    expect(controller.snapshot().open).toBe("association");
    release(); await saving; await flush();
    expect(controller.snapshot().editors.association!.problem?.reason).toBe("unknown");
    controller.cancel();
    expect(controller.snapshot()).toMatchObject({ open: null, canOpen: true, unsaved: false });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("C18 a newer card read updates the version used by the next editor; an older one is ignored", () => {
    const { controller } = setup();
    controller.setCard(card({ stateVersion: "12", fields: { ...card().fields, translation: { value: "дом", version: "5" } } }));
    controller.setCard(card({ stateVersion: "11", fields: { ...card().fields, translation: { value: "старый", version: "4" } } }));
    controller.open("translation");
    expect(controller.snapshot().editors.translation).toMatchObject({ original: "дом", fieldVersion: "5" });
  });
});

describe("the buttons and the write gate (P03 M-P03-8, C335)", () => {
  it("«Повторить» after the check found nothing sends the same command at once: it follows mayWrite of that ID", async () => {
    const clock = new ManualClock();
    const writeGate = new RealWriteGate({ clock, probe: async () => ({ status: "ready" }) });
    const { controller, sent } = setup({ writeGate,
      send: [() => { throw new ApiError("network"); }, command => accepted(command)],
      status: [command => ({ outcome: "not_found", command: { id: command.command_id, status: "not_found" }, current: {} as never, state_version: "10" })],
    });
    controller.open("association"); controller.edit("association", "Haus am See");
    await controller.save("association");
    await flush();
    const retryOn = () => controller.snapshot().editors.association!.canRetry;
    expect(retryOn()).toBe(true);
    writeGate.closeByFailure();
    expect(retryOn()).toBe(false);
    await controller.retry("association");
    expect(sent).toHaveLength(1);
    await clock.advanceTo(5_000);
    expect(retryOn()).toBe(true);
    // A family lock of this very ID (an indefinite answer) keeps the send off until a definite one lifts it (R5).
    writeGate.resolvePending(sent[0].command_id, "stale");
    expect(retryOn()).toBe(false);
    writeGate.resolvePending(sent[0].command_id, "not_recorded");
    expect(retryOn()).toBe(true);
    await controller.retry("association");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    controller.dispose();
  });
});
