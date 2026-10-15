// R17-02 вар.1 (П5-026, К19-059): the owner edits the common translation of every other language in place, under its
// badge, with the same fields and outcomes as the dictionary's own; the reply's current shows the dictionary language,
// so the saved list of another language is read again (C333/A-1).
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/http";
import type { CommonTranslationsResponse } from "../../api/generated";
import { testGate } from "../../commands/testGate.test-support";
import type { CommonCommand, CommonCommandReply, CommonCommandStatus, CommonLanguage } from "./commonFieldApi";
import { OwnerEditorController, type CommonSource } from "./ownerEditorController";
import { CARD_ID, CONTEXT, NOUN_GRAMMAR, commonCurrent, commonFact, fid, origin } from "./ownerTestData.test-support";

type Lists = Record<CommonLanguage, string[]>;
const LISTS: Lists = { ru: ["дом", "жилище"], uk: ["будинок", "житло"], en: [] };

function source(change: Partial<CommonSource> = {}): CommonSource {
  return { cardId: CARD_ID, cardType: "noun", language: "ru", revision: "1", stateVersion: "10", translations: [...LISTS.ru],
    grammar: { ...NOUN_GRAMMAR }, ...change };
}
const read = (revision = "1", lists: Partial<Lists> = {}): CommonTranslationsResponse => ({ state_version: "10",
  current: { status: "available", card_id: CARD_ID, card_revision: revision, language: "ru",
    translations: { ...structuredClone(LISTS), ...structuredClone(lists) } } });

type Reply = CommonCommandReply | Error | ((command: CommonCommand) => CommonCommandReply);
type Read = CommonTranslationsResponse | Error | Promise<CommonTranslationsResponse>;

function harness(options: { replies?: Reply[]; statuses?: (CommonCommandStatus | Error)[]; reads?: Read[] } = {}) {
  const replies = [...(options.replies ?? [])], statuses = [...(options.statuses ?? [])], reads = [...(options.reads ?? [])];
  const sent: CommonCommand[] = [], checked: CommonCommand[] = [];
  const readTranslations = vi.fn(async (cardId: string) => {
    void cardId;
    const next = reads.shift() ?? read();
    if (next instanceof Error) throw next;
    return next;
  });
  const onChanged = vi.fn();
  let next = 100;
  // Built apart from the call: the page's write gate (P03) is an option of the controller wherever it exists.
  const settings = {
    gate: testGate(),
    port: {
      origin: () => origin,
      send: async (command: CommonCommand) => {
        sent.push(command);
        const reply = replies.shift();
        if (!reply) throw new Error("no reply scripted");
        if (reply instanceof Error) throw reply;
        return typeof reply === "function" ? reply(command) : reply;
      },
      status: async (command: CommonCommand) => {
        checked.push(command);
        const status = statuses.shift();
        if (!status || status instanceof Error) throw status ?? new Error("no status scripted");
        return status;
      },
      readTranslations,
    },
    newId: () => fid(next++),
    onUpdate: () => {},
    onChanged,
  };
  const controller = new OwnerEditorController(settings);
  controller.setCard(source());
  controller.setContext(CONTEXT);
  const snapshot = () => controller.snapshot();
  const other = (language: CommonLanguage) => snapshot().translations!.others.languages.find(item => item.language === language)!;
  const texts = (language: CommonLanguage) => other(language).editor.items.map(item => item.text);
  const open = async () => {
    controller.openTranslations();
    await vi.waitFor(() => expect(snapshot().translations!.others.status).toBe("ready"));
  };
  return { controller, sent, checked, readTranslations, onChanged, snapshot, other, texts, open };
}

const accepted = (current = commonCurrent(), stateVersion = "11") => (command: CommonCommand): CommonCommandReply =>
  ({ outcome: "accepted", command: commonFact(command), current, state_version: stateVersion });
const rejected = (code: string, current: CommonCommandReply["current"] = commonCurrent(), stateVersion = "11",
  outcome: "rejected" | "mismatch" = "rejected") => (command: CommonCommand): CommonCommandReply =>
  ({ outcome, command: { id: command.command_id, status: "rejected" }, error: { code }, current, state_version: stateVersion });
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

describe("R17-02: the other languages are edited in place under their badges", () => {
  it("E1 an opened badge has the same fields: edit, add, reorder; the save goes with its language and the revision of its read", async () => {
    const h = harness({ reads: [read("1")], replies: [accepted(commonCurrent())] });
    await h.open();
    expect(h.other("uk")).toMatchObject({ expanded: false, texts: ["будинок", "житло"],
      editor: { phase: "editing", dirty: false, canEdit: true, canSave: false, canRemove: true } });
    h.controller.toggleLanguage("uk");
    h.controller.addTranslation("uk");
    h.controller.editTranslation(2, " оселя ", "uk");
    h.controller.moveTranslation(2, 0, "uk");
    h.controller.moveTranslationDown(1, "uk");
    h.controller.moveTranslationUp(2, "uk");
    expect(h.texts("uk")).toEqual([" оселя ", "будинок", "житло"]);
    // The dictionary's list is untouched; leaving now would lose the uk list.
    expect(h.snapshot().translations!.items.map(item => item.text)).toEqual(["дом", "жилище"]);
    expect(h.snapshot()).toMatchObject({ unsaved: true, translations: { dirty: false, canSave: false } });
    expect(h.other("uk").editor).toMatchObject({ dirty: true, canSave: true });
    await h.controller.saveTranslations("uk");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ field_name: "translation", language: "uk", value: [" оселя ", "будинок", "житло"],
      expected_field_version: "1", card_id: CARD_ID, context_id: CONTEXT });
  });

  it("E2 C333/A-1: after the save the editor stays, the saved list is read again and shown in its own panel", async () => {
    let release!: (value: CommonTranslationsResponse) => void;
    const again = new Promise<CommonTranslationsResponse>(resolve => { release = resolve; });
    const h = harness({ reads: [read("1"), again], replies: [accepted(commonCurrent({ card_revision: "2" })),
      accepted(commonCurrent({ card_revision: "3", translations: ["жилище", "дом"] }))] });
    await h.open();
    h.controller.toggleLanguage("uk");
    h.controller.editTranslation(1, " житло, оселя ", "uk");
    await h.controller.saveTranslations("uk");
    // The reply's current is the dictionary's (ru): nothing of uk in it; the panel holds the sent list, edges trimmed.
    expect(h.snapshot()).toMatchObject({ open: "translations", savedNote: false, unsaved: false });
    expect(h.other("uk")).toMatchObject({ expanded: true, texts: ["будинок", "житло, оселя"], editor: { phase: "saved" } });
    expect(h.readTranslations).toHaveBeenCalledTimes(2);
    expect(h.onChanged).toHaveBeenCalledTimes(1);
    release(read("2", { uk: ["будинок", "житло", "оселя"] }));
    await settled();
    // The server's list of that language, not a guess: it lands in the panel that was edited, not in another one.
    expect(h.other("uk")).toMatchObject({ texts: ["будинок", "житло", "оселя"], editor: { phase: "saved", dirty: false } });
    expect(h.texts("uk")).toEqual(["будинок", "житло", "оселя"]);
    expect(h.other("en")).toMatchObject({ texts: [], editor: { dirty: false } });
    expect(h.snapshot().translations!.items.map(item => item.text)).toEqual(["дом", "жилище"]);
    // The dictionary's list follows the new revision: its save expects 2.
    h.controller.moveTranslation(1, 0);
    await h.controller.saveTranslations();
    expect(h.sent[1]).toMatchObject({ language: "ru", value: ["жилище", "дом"], expected_field_version: "2" });
    expect(h.snapshot()).toMatchObject({ open: null, savedNote: true });
  });

  it("E3 the dictionary's save with another language unsaved keeps the editor and that list; their next save expects the new revision", async () => {
    const h = harness({ reads: [read("1")], replies: [accepted(commonCurrent({ card_revision: "2", translations: ["жилище", "дом"] })),
      accepted(commonCurrent({ card_revision: "3", translations: ["жилище", "дом"] })),
      accepted(commonCurrent({ card_revision: "4", translations: ["дом", "жилище"] }))] });
    await h.open();
    h.controller.editTranslation(0, "будинок!", "uk");
    h.controller.moveTranslation(1, 0);
    await h.controller.saveTranslations();
    expect(h.snapshot()).toMatchObject({ open: "translations", savedNote: false, unsaved: true,
      translations: { phase: "saved", dirty: false, items: [{ text: "жилище" }, { text: "дом" }] } });
    expect(h.other("uk").editor).toMatchObject({ dirty: true, canSave: true, items: [{ text: "будинок!" }, { text: "житло" }] });
    // Only my save lies between: no read is needed for the uk list to stand on revision 2.
    expect(h.readTranslations).toHaveBeenCalledTimes(1);
    await h.controller.saveTranslations("uk");
    expect(h.sent[1]).toMatchObject({ language: "uk", value: ["будинок!", "житло"], expected_field_version: "2" });
    // The dictionary's own next save stands on its saved revision too (not the one it was opened with).
    h.controller.moveTranslation(1, 0);
    await h.controller.saveTranslations();
    expect(h.sent[2]).toMatchObject({ language: "ru", value: ["дом", "жилище"], expected_field_version: "3" });
  });

  it("E4 a conflict of another language: the list saved elsewhere is read, shown, and «Сохранить моё» expects its revision", async () => {
    let release!: (value: CommonTranslationsResponse) => void;
    const again = new Promise<CommonTranslationsResponse>(resolve => { release = resolve; });
    const h = harness({ reads: [read("1"), again], replies: [
      rejected("VERSION_CONFLICT", commonCurrent({ card_revision: "4", translations: ["квартира"] }), "12"),
      accepted(commonCurrent({ card_revision: "5", translations: ["квартира"] }))] });
    await h.open();
    h.controller.moveTranslationUp(1, "uk");
    await h.controller.saveTranslations("uk");
    expect(h.other("uk").editor).toMatchObject({ phase: "conflict", reading: true, items: [{ text: "житло" }, { text: "будинок" }] });
    // The choice waits for the list saved elsewhere.
    h.controller.acceptCurrentTranslations("uk");
    await h.controller.keepMineTranslations("uk");
    expect(h.sent).toHaveLength(1);
    expect(h.other("uk").editor.phase).toBe("conflict");
    // The dictionary's untouched list follows the reply's current.
    expect(h.snapshot().translations!.items.map(item => item.text)).toEqual(["квартира"]);
    expect(h.onChanged).toHaveBeenCalledTimes(1);
    release(read("4", { ru: ["квартира"], uk: ["хата"] }));
    await settled();
    expect(h.other("uk")).toMatchObject({ texts: ["хата"], editor: { phase: "conflict", reading: false, current: ["хата"],
      items: [{ text: "житло" }, { text: "будинок" }] } });
    expect(h.snapshot().unsaved).toBe(true);
    await h.controller.keepMineTranslations("uk");
    expect(h.sent[1]).toMatchObject({ language: "uk", value: ["житло", "будинок"], expected_field_version: "4" });
  });

  it("E5 «Взять сохранённое» replaces only that language's list", async () => {
    const h = harness({ reads: [read("1"), read("2", { uk: ["хата"] })],
      replies: [rejected("VERSION_CONFLICT", commonCurrent({ card_revision: "2" }), "12")] });
    await h.open();
    h.controller.editTranslation(0, "домик");
    h.controller.editTranslation(0, "будиночок", "uk");
    await h.controller.saveTranslations("uk");
    await vi.waitFor(() => expect(h.other("uk").editor.reading).toBe(false));
    h.controller.acceptCurrentTranslations("uk");
    expect(h.other("uk").editor).toMatchObject({ phase: "editing", dirty: false, items: [{ text: "хата" }] });
    expect(h.snapshot().translations).toMatchObject({ dirty: true, items: [{ text: "домик" }, { text: "жилище" }] });
  });

  it("E6 422, a payload mismatch and FORBIDDEN of another language read as the dictionary's own and keep its list", async () => {
    const h = harness({ reads: [read("1")], replies: [rejected("VALIDATION_FAILED"),
      rejected("COMMAND_PAYLOAD_MISMATCH", commonCurrent(), "11", "mismatch"), rejected("FORBIDDEN", { status: "unavailable" })] });
    await h.open();
    h.controller.editTranslation(1, "житло2", "uk");
    await h.controller.saveTranslations("uk");
    expect(h.other("uk").editor).toMatchObject({ phase: "failed", problem: { reason: "invalid", code: "VALIDATION_FAILED" },
      canRetry: true, items: [{ text: "будинок" }, { text: "житло2" }] });
    expect(h.onChanged).not.toHaveBeenCalled();
    await h.controller.retryTranslations("uk");
    expect(h.other("uk").editor).toMatchObject({ phase: "failed", problem: { reason: "mismatch" } });
    expect(h.sent[1].command_id).not.toBe(h.sent[0].command_id);
    await h.controller.retryTranslations("uk");
    expect(h.other("uk").editor).toMatchObject({ phase: "failed", problem: { reason: "forbidden" }, canRetry: false, canSave: false });
    expect(h.onChanged).toHaveBeenCalledTimes(1);
    // The dictionary's list never took any of these outcomes.
    expect(h.snapshot().translations).toMatchObject({ phase: "editing", problem: null });
  });

  it("E7 an unknown outcome is checked by the same ID; not_found repeats the same command of that language", async () => {
    const h = harness({ reads: [read("1")], replies: [new ApiError("network"), accepted(commonCurrent({ card_revision: "2" }))],
      statuses: [{ outcome: "not_found", command: { id: fid(100), status: "not_found" }, current: {} as never, state_version: "11" }] });
    await h.open();
    h.controller.moveTranslation(1, 0, "uk");
    await h.controller.saveTranslations("uk");
    expect(h.checked).toHaveLength(1);
    expect(h.checked[0]).toMatchObject({ language: "uk", command_id: fid(100) });
    expect(h.other("uk").editor).toMatchObject({ phase: "failed", problem: { reason: "unknown" }, canRetry: true, canEdit: false });
    // One command at a time: no list changes while that outcome is open.
    expect(h.snapshot().translations).toMatchObject({ canEdit: false, canSave: false });
    await h.controller.retryTranslations("uk");
    expect(h.sent.map(command => [command.command_id, command.language])).toEqual([[fid(100), "uk"], [fid(100), "uk"]]);
    expect(h.other("uk").editor.phase).toBe("saved");
  });

  it("E8 R12-06 in every language: the last field stays; a language without a translation starts with one empty field", async () => {
    const h = harness({ reads: [read("1", { uk: ["будинок"] })] });
    await h.open();
    expect(h.other("uk").editor.canRemove).toBe(false);
    h.controller.removeTranslation(0, "uk");
    expect(h.other("uk").editor).toMatchObject({ lastRefused: true, items: [{ text: "будинок" }] });
    expect(h.other("en")).toMatchObject({ texts: [], editor: { items: [{ text: "" }], blank: true, dirty: false, canSave: false } });
    expect(h.snapshot().unsaved).toBe(false);
    h.controller.editTranslation(0, "house", "en");
    expect(h.other("en").editor).toMatchObject({ blank: false, dirty: true, canSave: true });
    h.controller.editTranslation(0, "   ", "en");
    await h.controller.saveTranslations("en");
    expect(h.sent).toHaveLength(0);
  });

  it("E9 folding keeps an unsaved list; «Отмена» drops every list; the dictionary's own language never gets a badge", async () => {
    const h = harness({ reads: [read("1")] });
    await h.open();
    expect(h.snapshot().translations!.others.languages.map(item => item.language)).toEqual(["uk", "en"]);
    h.controller.toggleLanguage("en");
    h.controller.editTranslation(0, "house", "en");
    h.controller.toggleLanguage("en");
    expect(h.other("en")).toMatchObject({ expanded: false, editor: { dirty: true, items: [{ text: "house" }] } });
    expect(h.snapshot().unsaved).toBe(true);
    h.controller.cancel();
    expect(h.snapshot()).toMatchObject({ open: null, unsaved: false });
    expect(h.sent).toHaveLength(0);
  });

  it("E10 a newer card read renews the other lists once: untouched follow, a touched one changed elsewhere is a conflict", async () => {
    const h = harness({ reads: [read("1"), read("3", { uk: ["хата"], en: ["house"] }), new ApiError("network"), read("5")] });
    await h.open();
    h.controller.editTranslation(0, "будиночок", "uk");
    h.controller.setCard(source({ revision: "3", stateVersion: "12" }));
    await vi.waitFor(() => expect(h.readTranslations).toHaveBeenCalledTimes(2));
    await settled();
    expect(h.other("uk")).toMatchObject({ texts: ["хата"], editor: { phase: "conflict", items: [{ text: "будиночок" }, { text: "житло" }] } });
    expect(h.other("en")).toMatchObject({ texts: ["house"], editor: { phase: "editing", dirty: false, items: [{ text: "house" }] } });
    // The same revision again reads nothing; a failed read keeps the lists and waits for a tap.
    h.controller.setCard(source({ revision: "3", stateVersion: "13" }));
    expect(h.readTranslations).toHaveBeenCalledTimes(2);
    h.controller.setCard(source({ revision: "4", stateVersion: "14" }));
    await vi.waitFor(() => expect(h.snapshot().translations!.others.refresh).toBe("failed"));
    expect(h.other("uk").editor.items.map(item => item.text)).toEqual(["будиночок", "житло"]);
    h.controller.setCard(source({ revision: "5", stateVersion: "15" }));
    expect(h.readTranslations).toHaveBeenCalledTimes(3);
    await h.controller.retryOthers();
    expect(h.readTranslations).toHaveBeenCalledTimes(4);
    expect(h.snapshot().translations!.others.refresh).toBe("idle");
  });

  it("E11 an older read adds nothing; another save is not offered while the lists are read again", async () => {
    let release!: (value: CommonTranslationsResponse) => void;
    const slow = new Promise<CommonTranslationsResponse>(resolve => { release = resolve; });
    const h = harness({ reads: [read("2"), slow], replies: [accepted(commonCurrent({ card_revision: "3" }))] });
    await h.open();
    h.controller.editTranslation(0, "будиночок", "uk");
    h.controller.setCard(source({ revision: "3", stateVersion: "12" }));
    expect(h.snapshot().translations!.others.refresh).toBe("loading");
    expect(h.other("uk").editor).toMatchObject({ canSave: false, canEdit: true });
    await h.controller.saveTranslations("uk");
    expect(h.sent).toHaveLength(0);
    release(read("1", { uk: ["старе"] }));
    await settled();
    expect(h.other("uk")).toMatchObject({ texts: ["будинок", "житло"], editor: { phase: "editing", canSave: true } });
    // Its save expects the revision its list stands on (2), not the dictionary's (3): the server checks the rest.
    await h.controller.saveTranslations("uk");
    expect(h.sent[0]).toMatchObject({ language: "uk", value: ["будиночок", "житло"], expected_field_version: "2" });
  });

  it("E12 only a language names another list: a click event, the dictionary's own or a foreign code never do", async () => {
    const h = harness({ reads: [read("1")] });
    await h.open();
    h.controller.editTranslation(0, "домик", "ru");
    expect(h.snapshot().translations!.items[0].text).toBe("домик");
    h.controller.editTranslation(0, "x", "de" as CommonLanguage);
    h.controller.addTranslation({} as CommonLanguage);
    expect(h.texts("uk")).toEqual(["будинок", "житло"]);
    expect(h.texts("en")).toEqual([""]);
    expect(h.snapshot().translations!.items.map(item => item.text)).toEqual(["домик", "жилище"]);
  });

  it("F1 QA P2-1: a conflict whose read fails shows no list as saved; the choice waits, only the read is repeated", async () => {
    const h = harness({ reads: [read("1"), new ApiError("network"), read("2", { uk: ["хата"] })],
      replies: [rejected("VERSION_CONFLICT", commonCurrent({ card_revision: "2" }), "12"), accepted(commonCurrent({ card_revision: "3" }))] });
    await h.open();
    h.controller.moveTranslationUp(1, "uk");
    await h.controller.saveTranslations("uk");
    await vi.waitFor(() => expect(h.snapshot().translations!.others.refresh).toBe("failed"));
    expect(h.other("uk").editor).toMatchObject({ phase: "conflict", reading: true });
    h.controller.acceptCurrentTranslations("uk");
    await h.controller.keepMineTranslations("uk");
    expect(h.sent).toHaveLength(1);
    expect(h.other("uk").editor).toMatchObject({ phase: "conflict", items: [{ text: "житло" }, { text: "будинок" }] });
    await h.controller.retryOthers();
    expect(h.other("uk").editor).toMatchObject({ phase: "conflict", reading: false, current: ["хата"] });
    await h.controller.keepMineTranslations("uk");
    expect(h.sent[1]).toMatchObject({ language: "uk", value: ["житло", "будинок"], expected_field_version: "2" });
  });

  it("F2 QA P3: a newer card read during the first read of the other languages reads them again before a save", async () => {
    let release!: (value: CommonTranslationsResponse) => void;
    const first = new Promise<CommonTranslationsResponse>(resolve => { release = resolve; });
    const h = harness({ reads: [first, read("3")], replies: [accepted(commonCurrent({ card_revision: "4" }))] });
    h.controller.openTranslations();
    h.controller.setCard(source({ revision: "3", stateVersion: "12" }));
    release(read("1"));
    await vi.waitFor(() => expect(h.readTranslations).toHaveBeenCalledTimes(2));
    await settled();
    expect(h.snapshot().translations!.others.refresh).toBe("idle");
    h.controller.editTranslation(0, "x", "uk");
    await h.controller.saveTranslations("uk");
    expect(h.sent[0]).toMatchObject({ language: "uk", expected_field_version: "3" });
    // The save reads its list again (3); a newer card reads once (4); a read that still answers older starts no other one.
    await settled();
    expect(h.readTranslations).toHaveBeenCalledTimes(3);
    h.controller.setCard(source({ revision: "5", stateVersion: "13" }));
    await settled();
    h.controller.setCard(source({ revision: "5", stateVersion: "14" }));
    await settled();
    expect(h.readTranslations).toHaveBeenCalledTimes(4);
  });

  it("F3 QA P3: a read again that finds the card unavailable keeps every list and draft; saves wait, a tap reads again", async () => {
    const h = harness({ reads: [read("1"), { state_version: "10", current: { status: "unavailable" } }, read("3")] });
    await h.open();
    h.controller.editTranslation(0, "чернетка", "en");
    h.controller.setCard(source({ revision: "3", stateVersion: "12" }));
    await vi.waitFor(() => expect(h.snapshot().translations!.others.refresh).toBe("unavailable"));
    expect(h.snapshot()).toMatchObject({ unsaved: true, translations: { others: { status: "ready" } } });
    expect(h.other("en").editor).toMatchObject({ dirty: true, canSave: false, items: [{ text: "чернетка" }] });
    await h.controller.retryOthers();
    expect(h.snapshot().translations!.others.refresh).toBe("idle");
    expect(h.other("en").editor).toMatchObject({ dirty: true, canSave: true });
  });

  it("F4 QA N10: a failed save of another language is not retried while its lists are read again", async () => {
    let release!: (value: CommonTranslationsResponse) => void;
    const slow = new Promise<CommonTranslationsResponse>(resolve => { release = resolve; });
    const h = harness({ reads: [read("1"), slow], replies: [rejected("VALIDATION_FAILED")] });
    await h.open();
    h.controller.editTranslation(0, "будиночок", "uk");
    await h.controller.saveTranslations("uk");
    expect(h.other("uk").editor).toMatchObject({ phase: "failed", canRetry: true });
    h.controller.setCard(source({ revision: "2", stateVersion: "12" }));
    expect(h.snapshot().translations!.others.refresh).toBe("loading");
    expect(h.other("uk").editor).toMatchObject({ phase: "failed", canRetry: false, canSave: false });
    await h.controller.retryTranslations("uk");
    expect(h.sent).toHaveLength(1);
    release(read("2"));
    await settled();
    expect(h.other("uk").editor).toMatchObject({ canRetry: true });
  });

  it("F5 QA N11: the dictionary's save that keeps the editor open is the base of its next save", async () => {
    const h = harness({ reads: [read("1")], replies: [accepted(commonCurrent({ card_revision: "2", translations: ["жилище", "дом"] })),
      accepted(commonCurrent({ card_revision: "3" }))] });
    await h.open();
    h.controller.editTranslation(0, "house", "en");
    h.controller.moveTranslation(1, 0);
    await h.controller.saveTranslations();
    h.controller.moveTranslation(1, 0);
    await h.controller.saveTranslations();
    expect(h.sent.map(command => [command.language, command.expected_field_version])).toEqual([["ru", "1"], ["ru", "2"]]);
  });
});
