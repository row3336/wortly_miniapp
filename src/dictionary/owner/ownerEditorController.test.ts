import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/http";
import type { CommonTranslationsResponse } from "../../api/generated";
import type { CommonCommand, CommonCommandReply, CommonCommandStatus } from "./commonFieldApi";
import { OwnerEditorController, grammarValueOf, type CommonSource, type OwnerEditorSnapshot } from "./ownerEditorController";
import { CARD_ID, CONTEXT, NOUN_GRAMMAR, commonCurrent, commonFact, fid, origin } from "./ownerTestData.test-support";
import { testGate } from "../../commands/testGate.test-support";

function source(change: Partial<CommonSource> = {}): CommonSource {
  return { cardId: CARD_ID, cardType: "noun", language: "ru", revision: "1", stateVersion: "10", translations: ["дом", "жилище"],
    grammar: { ...NOUN_GRAMMAR }, ...change };
}

type Reply = CommonCommandReply | Error | ((command: CommonCommand) => CommonCommandReply);
const ALL = { ru: ["дом", "жилище"], uk: ["будинок"], en: [] as string[] };
const translationsRead = (change: Partial<{ language: "ru" | "uk" | "en"; status: "unavailable" }> = {}): CommonTranslationsResponse =>
  change.status ? { state_version: "10", current: { status: "unavailable" } }
    : { state_version: "10", current: { status: "available", card_id: CARD_ID, card_revision: "1", language: change.language ?? "ru",
      translations: structuredClone(ALL) } };

function harness(options: { replies?: Reply[]; statuses?: (CommonCommandStatus | Error)[];
  reads?: (CommonTranslationsResponse | Error)[] } = {}) {
  const replies = [...(options.replies ?? [])], statuses = [...(options.statuses ?? [])], reads = [...(options.reads ?? [])];
  const read = vi.fn(async (cardId: string) => {
    void cardId;
    const next = reads.shift() ?? translationsRead();
    if (next instanceof Error) throw next;
    return next;
  });
  const sent: CommonCommand[] = [], checked: CommonCommand[] = [];
  let next = 100, last: OwnerEditorSnapshot | null = null;
  const onChanged = vi.fn();
  const controller = new OwnerEditorController({ gate: testGate(),
    port: {
      origin: () => origin,
      send: async command => {
        sent.push(command);
        const reply = replies.shift();
        if (!reply) throw new Error("no reply scripted");
        if (reply instanceof Error) throw reply;
        return typeof reply === "function" ? reply(command) : reply;
      },
      status: async command => {
        checked.push(command);
        const status = statuses.shift();
        if (!status || status instanceof Error) throw status ?? new Error("no status scripted");
        return status;
      },
      readTranslations: read,
    },
    newId: () => fid(next++),
    onUpdate: snapshot => { last = snapshot; },
    onChanged,
  });
  controller.setCard(source());
  controller.setContext(CONTEXT);
  return { controller, sent, checked, read, onChanged, snapshot: () => controller.snapshot(), last: () => last };
}

const accepted = (current = commonCurrent(), stateVersion = "11") => (command: CommonCommand): CommonCommandReply =>
  ({ outcome: "accepted", command: commonFact(command), current, state_version: stateVersion });
const rejected = (code: string, current: CommonCommandReply["current"] = commonCurrent(), stateVersion = "11") =>
  (command: CommonCommand): CommonCommandReply => ({ outcome: "rejected", command: { id: command.command_id, status: "rejected" },
    error: { code }, current, state_version: stateVersion });

describe("owner common editor (R12-04…06, R14-01)", () => {
  it("K1 a user never gets the editors; the owner opens one at a time and only with the open card context", () => {
    const h = harness();
    h.controller.setCard(null);
    expect(h.snapshot()).toMatchObject({ available: false, canOpen: false });
    h.controller.openTranslations();
    expect(h.snapshot().open).toBeNull();
    h.controller.setCard(source());
    h.controller.setContext(null);
    expect(h.snapshot().canOpen).toBe(false);
    h.controller.setContext(CONTEXT);
    h.controller.setBlocked(true);
    h.controller.openTranslations();
    expect(h.snapshot().open).toBeNull();
    h.controller.setBlocked(false);
    h.controller.openTranslations();
    expect(h.snapshot()).toMatchObject({ open: "translations", canOpen: false });
    h.controller.openGrammar();
    expect(h.snapshot().open).toBe("translations");
  });

  it("K2 reorder, add and edit; the save sends the whole list in the new order with the card revision", async () => {
    const h = harness({ replies: [accepted(commonCurrent({ translations: ["здание", "жилище", "дом"] }))] });
    h.controller.openTranslations();
    h.controller.addTranslation();
    expect(h.snapshot().translations).toMatchObject({ blank: true, canSave: false });
    h.controller.editTranslation(2, "здание");
    h.controller.moveTranslation(2, 0);
    h.controller.moveTranslationDown(1);
    expect(h.snapshot().translations!.items.map(item => item.text)).toEqual(["здание", "жилище", "дом"]);
    expect(h.snapshot()).toMatchObject({ unsaved: true, translations: { dirty: true, canSave: true } });
    await h.controller.saveTranslations();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ field_name: "translation", language: "ru", value: ["здание", "жилище", "дом"],
      expected_field_version: "1", context_id: CONTEXT, card_id: CARD_ID });
    expect(h.snapshot()).toMatchObject({ open: null, savedNote: true, unsaved: false });
    expect(h.onChanged).toHaveBeenCalledTimes(1);
  });

  it("K3 an unchanged order or only edge spaces is not a change to save", () => {
    const h = harness();
    h.controller.openTranslations();
    h.controller.moveTranslation(0, 1);
    h.controller.moveTranslation(1, 0);
    expect(h.snapshot().translations).toMatchObject({ dirty: false, canSave: false });
    h.controller.editTranslation(0, " дом ");
    expect(h.snapshot().translations).toMatchObject({ dirty: true, canSave: false });
  });

  it("K4 R12-06: removing the last translation is refused with an explanation and the list stays", async () => {
    const h = harness();
    h.controller.setCard(source({ translations: ["дом"], stateVersion: "12" }));
    h.controller.openTranslations();
    expect(h.snapshot().translations!.canRemove).toBe(false);
    h.controller.removeTranslation(0);
    expect(h.snapshot().translations).toMatchObject({ lastRefused: true, items: [{ text: "дом" }] });
    await h.controller.saveTranslations();
    expect(h.sent).toHaveLength(0);
    h.controller.addTranslation();
    expect(h.snapshot().translations!.lastRefused).toBe(false);
    h.controller.removeTranslation(0);
    expect(h.snapshot().translations!.items).toHaveLength(1);
    // A blank single field cannot be saved either: the empty list never goes.
    h.controller.editTranslation(0, "  ");
    expect(h.snapshot().translations).toMatchObject({ blank: true, canSave: false });
  });

  it("K5 VERSION_CONFLICT shows the list saved elsewhere; «Сохранить моё» goes against its revision, «Взять сохранённое» replaces mine", async () => {
    const h = harness({ replies: [rejected("VERSION_CONFLICT", commonCurrent({ card_revision: "3", translations: ["первый"] }), "12"),
      accepted(commonCurrent({ card_revision: "4", translations: ["жилище", "дом"] }), "13")] });
    h.controller.openTranslations();
    h.controller.moveTranslationUp(1);
    await h.controller.saveTranslations();
    expect(h.snapshot().translations).toMatchObject({ phase: "conflict", current: ["первый"],
      items: [{ text: "жилище" }, { text: "дом" }] });
    expect(h.snapshot().unsaved).toBe(true);
    expect(h.onChanged).toHaveBeenCalledTimes(1);
    await h.controller.keepMineTranslations();
    expect(h.sent[1]).toMatchObject({ value: ["жилище", "дом"], expected_field_version: "3" });
    expect(h.snapshot().savedNote).toBe(true);

    const other = harness({ replies: [rejected("VERSION_CONFLICT", commonCurrent({ card_revision: "3", translations: ["первый"] }), "12")] });
    other.controller.openTranslations();
    other.controller.editTranslation(0, "домик");
    await other.controller.saveTranslations();
    other.controller.acceptCurrentTranslations();
    expect(other.snapshot().translations).toMatchObject({ phase: "editing", items: [{ text: "первый" }], dirty: false });
  });

  it("K6 422 and FORBIDDEN keep the list with their own explanation; FORBIDDEN and stale codes reread the card", async () => {
    const h = harness({ replies: [rejected("VALIDATION_FAILED"), rejected("FORBIDDEN", { status: "unavailable" })] });
    h.controller.openTranslations();
    h.controller.editTranslation(0, "домик");
    await h.controller.saveTranslations();
    expect(h.snapshot().translations).toMatchObject({ phase: "failed", problem: { reason: "invalid", code: "VALIDATION_FAILED" },
      canSave: true, canRetry: true, items: [{ text: "домик" }, { text: "жилище" }] });
    expect(h.onChanged).not.toHaveBeenCalled();
    await h.controller.retryTranslations();
    expect(h.snapshot().translations).toMatchObject({ phase: "failed", problem: { reason: "forbidden" }, canSave: false, canRetry: false });
    expect(h.onChanged).toHaveBeenCalledTimes(1);
  });

  it("K7 a 422 without a fact is a refusal too; nothing is checked by status", async () => {
    const h = harness({ replies: [new ApiError("http", 422, "VALIDATION_FAILED")] });
    h.controller.openTranslations();
    h.controller.editTranslation(1, "здание");
    await h.controller.saveTranslations();
    expect(h.snapshot().translations).toMatchObject({ phase: "failed", problem: { reason: "invalid" } });
    expect(h.checked).toHaveLength(0);
  });

  it("K8 an unknown outcome is checked by the same ID; not_found repeats the same command; accepted settles", async () => {
    const h = harness({ replies: [new ApiError("network"), accepted()],
      statuses: [{ outcome: "not_found", command: { id: fid(100), status: "not_found" }, current: {} as never, state_version: "11" }] });
    h.controller.openTranslations();
    h.controller.moveTranslation(1, 0);
    await h.controller.saveTranslations();
    expect(h.checked).toHaveLength(1);
    expect(h.snapshot().translations).toMatchObject({ phase: "failed", problem: { reason: "unknown" }, canRetry: true, canEdit: false });
    await h.controller.retryTranslations();
    expect(h.sent.map(command => command.command_id)).toEqual([fid(100), fid(100)]);
    expect(h.sent[1].value).toEqual(["жилище", "дом"]);
    expect(h.snapshot().savedNote).toBe(true);
  });

  it("K9 grammar: one field per command; the next field expects the new revision; untouched fields follow the reply", async () => {
    const after = commonCurrent({ card_revision: "2", grammar: { ...NOUN_GRAMMAR, plural: "Häuschen" } });
    const h = harness({ replies: [accepted(after), accepted(commonCurrent({ card_revision: "3",
      grammar: { ...NOUN_GRAMMAR, plural: "Häuschen", gender: "masculine" } }), "12")] });
    h.controller.openGrammar();
    expect(h.snapshot().grammar!.fields.map(field => field.name)).toEqual(["gender", "singular", "plural", "article"]);
    h.controller.editGrammar("plural", { status: "applicable", value: "Häuschen" });
    h.controller.editGrammar("gender", { status: "applicable", value: "masculine" });
    await h.controller.saveGrammar("plural");
    expect(h.sent[0]).toMatchObject({ field_name: "plural", language: null, value: { status: "applicable", value: "Häuschen" },
      expected_field_version: "1" });
    const fields = Object.fromEntries(h.snapshot().grammar!.fields.map(field => [field.name, field]));
    expect(fields.plural).toMatchObject({ phase: "saved", dirty: false });
    expect(fields.gender).toMatchObject({ dirty: true, canSave: true });
    await h.controller.saveGrammar("gender");
    expect(h.sent[1]).toMatchObject({ field_name: "gender", value: { status: "applicable", value: "masculine" }, expected_field_version: "2" });
    expect(h.snapshot().open).toBe("grammar");
  });

  it("K10 grammar wire values: no form where none can be; an empty text is an explicit clearing", () => {
    expect(grammarValueOf("article", { status: "applicable", value: "das" })).toEqual({ status: "applicable", value: null });
    expect(grammarValueOf("plural", { status: "not_applicable", value: "Häuser" })).toEqual({ status: "not_applicable", value: null });
    expect(grammarValueOf("plural", { status: "applicable", value: "  " })).toEqual({ status: "applicable", value: null });
    expect(grammarValueOf("plural", { status: "applicable", value: " Häuser " })).toEqual({ status: "applicable", value: " Häuser " });
    expect(grammarValueOf("separability", "inseparable")).toBe("inseparable");
    const h = harness();
    h.controller.openGrammar();
    h.controller.editGrammar("gender", { status: "applicable", value: "female" });
    h.controller.editGrammar("plural", "separable");
    expect(h.snapshot().grammar!.fields.every(field => !field.dirty)).toBe(true);
  });

  it("K11 a newer card read rebases the open editor: untouched fields follow, a touched field changed elsewhere is a conflict", async () => {
    const h = harness({ replies: [accepted(commonCurrent({ card_revision: "3",
      grammar: { ...NOUN_GRAMMAR, plural: "Häuschen", singular: "Hause" } }), "13")] });
    h.controller.openGrammar();
    h.controller.editGrammar("singular", { status: "applicable", value: "Hause" });
    h.controller.setCard(source({ revision: "2", stateVersion: "12",
      grammar: { ...NOUN_GRAMMAR, plural: "Häuschen", singular: "Haus!" } }));
    const fields = Object.fromEntries(h.snapshot().grammar!.fields.map(field => [field.name, field]));
    expect(fields.plural).toMatchObject({ draft: { value: "Häuschen" }, dirty: false, phase: "editing" });
    expect(fields.singular).toMatchObject({ phase: "conflict", current: { value: "Haus!" }, draft: { value: "Hause" } });
    await h.controller.keepMineGrammar("singular");
    expect(h.sent[0]).toMatchObject({ field_name: "singular", expected_field_version: "2" });
    // An older read adds nothing.
    h.controller.setCard(source({ revision: "1", stateVersion: "11" }));
    expect(h.snapshot().grammar!.fields.find(field => field.name === "plural")!.draft).toMatchObject({ value: "Häuschen" });
  });

  it("K12 cancel closes without saving; a save in flight cannot be cancelled; the personal editors wait meanwhile", async () => {
    let release!: (reply: CommonCommandReply) => void;
    const h = harness({ replies: [command => { void command; throw new Error("unused"); }] });
    const pending = new Promise<CommonCommandReply>(resolve => { release = resolve; });
    const send = vi.fn(() => pending);
    const controller = new OwnerEditorController({ gate: testGate(), port: { origin: () => origin, send, status: vi.fn(),
      readTranslations: vi.fn(async () => translationsRead()) }, newId: () => fid(200),
      onUpdate: () => {}, onChanged: () => {} });
    controller.setCard(source()); controller.setContext(CONTEXT);
    controller.openTranslations();
    controller.editTranslation(0, "домик");
    const saving = controller.saveTranslations();
    expect(controller.snapshot()).toMatchObject({ busy: true, translations: { phase: "saving", canCancel: false, canEdit: false } });
    controller.cancel();
    expect(controller.snapshot().open).toBe("translations");
    release(accepted()({ ...(send.mock.calls[0] as unknown as [CommonCommand])[0] }));
    await saving;
    expect(controller.snapshot()).toMatchObject({ busy: false, open: null });
    h.controller.openTranslations();
    h.controller.editTranslation(0, "x");
    h.controller.cancel();
    expect(h.snapshot()).toMatchObject({ open: null, unsaved: false });
    expect(h.sent).toHaveLength(0);
  });

  it("K13 R12-04: the other languages are read on opening, folded under badges and opened by a tap; never the dictionary's own", async () => {
    const h = harness({ reads: [new ApiError("network"), translationsRead()] });
    h.controller.openTranslations();
    expect(h.snapshot().translations!.others).toEqual({ status: "loading", languages: [], refresh: "idle" });
    await vi.waitFor(() => expect(h.snapshot().translations!.others.status).toBe("failed"));
    expect(h.read).toHaveBeenCalledWith(CARD_ID);
    await h.controller.retryOthers();
    expect(h.snapshot().translations!.others).toMatchObject({ status: "ready", refresh: "idle", languages: [
      { language: "uk", texts: ["будинок"], expanded: false }, { language: "en", texts: [], expanded: false }] });
    h.controller.toggleLanguage("uk");
    h.controller.toggleLanguage("ru");
    expect(h.snapshot().translations!.others.languages.map(item => item.expanded)).toEqual([true, false]);
    h.controller.toggleLanguage("uk");
    expect(h.snapshot().translations!.others.languages[0].expanded).toBe(false);
    // Folding is not an edit: nothing is unsaved and nothing is sent.
    expect(h.snapshot().unsaved).toBe(false);
    expect(h.sent).toHaveLength(0);
  });

  it("K14 an unavailable read or another L1 shows no other languages; a stale read after closing is dropped", async () => {
    const h = harness({ reads: [translationsRead({ status: "unavailable" }), translationsRead({ language: "uk" })] });
    h.controller.openTranslations();
    await vi.waitFor(() => expect(h.snapshot().translations!.others.status).toBe("unavailable"));
    h.controller.cancel();
    h.controller.openTranslations();
    await vi.waitFor(() => expect(h.snapshot().translations!.others.status).toBe("unavailable"));
    let release!: (value: CommonTranslationsResponse) => void;
    const slow = harness();
    slow.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    slow.controller.openTranslations();
    slow.controller.cancel();
    release(translationsRead());
    await Promise.resolve();
    expect(slow.snapshot().translations).toBeNull();
  });
});
