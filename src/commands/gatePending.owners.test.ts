// The owners of pending records and the write gate (P03 §4.1 K03–K14, §4.11 R1–R9, M-P03-8; AC-16, AC-34, AC-54).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFeedbackApi } from "../feedback/feedbackApi";
import { FeedbackController } from "../feedback/feedbackController";
import { FeedbackPendingStore } from "../feedback/feedbackPending";
import { feedbackWorld, TEXT } from "../feedback/feedbackFixtures.test-support";
import { id } from "../learning/learningFixtures.test-support";
import { CardActionsController, type CardActionsPort } from "../dictionary/actions/cardActionsController";
import { failureProblem } from "./commandLane";
import { PausedBeforeSendError, WriteGate } from "./writeGate";
import { ManualClock, scriptedProbe, settle } from "./writeGate.test-support";

function gateWithClock(answers: Parameters<typeof scriptedProbe>[1] = []) {
  const clock = new ManualClock();
  const script = scriptedProbe(clock, answers);
  return { clock, gate: new WriteGate({ clock, probe: script.probe }) };
}

describe("PAUSED_BEFORE_SEND is its own outcome in the owners (AC-34)", () => {
  it("commandLane: problem paused, not network", () => {
    expect(failureProblem(new PausedBeforeSendError("paused"))).toBe("paused");
    expect(failureProblem(new TypeError("Failed to fetch"))).toBe("network");
  });

  it("K09 feedback: the buttons wait for the gate; a send the gate kept on the client is paused, the record stays, and the same ID goes after ready", async () => {
    const world = feedbackWorld();
    const { gate, clock } = gateWithClock([{ status: "ready" }, { status: "ready" }]);
    const store = new FeedbackPendingStore(world.f.storage);
    let next = 100;
    const controller = new FeedbackController({ gate, api: createFeedbackApi({ fetcher: world.f.fetcher, timeoutMs: 1000,
      maxResponseBytes: 100000, gate }), pendingStore: store, access: () => world.f.access(), newId: () => id(next++), onUpdate: vi.fn() });
    await controller.refresh();
    controller.edit(TEXT);
    expect(controller.snapshot().canSend).toBe(true);
    gate.closeByFailure();
    // M01: inactive while the gate holds writes; a press queues nothing.
    expect(controller.snapshot().canSend).toBe(false);
    await controller.send();
    expect(world.posts).toHaveLength(0);
    await clock.advanceTo(5_000);
    expect(controller.snapshot().canSend).toBe(true);
    // The race of M02: the gate closes after the press, before the request.
    const sending = controller.send();
    gate.closeByFailure();
    await sending;
    expect(controller.snapshot()).toMatchObject({ problem: "paused", phase: "unresolved", text: TEXT, canRetry: false });
    expect(world.posts).toHaveLength(0);
    const stored = await store.load(id(50), new AbortController().signal);
    expect(stored?.intent.command_id).toBe(id(100));
    // The gate opens (the same episode: the next probe at 5 + 10 s): the same ID is read (not found), then sent once (M03/M04).
    await clock.advanceTo(15_000);
    await settle();
    expect(controller.snapshot().canRetry).toBe(true);
    await controller.retry();
    expect(world.gets).toEqual([id(100)]);
    expect(world.posts.map(post => post.command_id)).toEqual([id(100)]);
    expect(controller.snapshot()).toMatchObject({ confirmed: true, problem: null });
    controller.dispose();
  });

  it("K10 card: paused before commandOutcomeUnknown — no check; the gate opens; the same button repeats the same ID", async () => {
    const { gate, clock } = gateWithClock([{ status: "ready" }]);
    const sent: string[] = [];
    const port: CardActionsPort = {
      origin: () => ({ client_instance_id: id(1), document_id: id(2) }),
      send: vi.fn(async command => {
        sent.push(command.command_id);
        if (sent.length === 1) { gate.closeByFailure(); throw new PausedBeforeSendError("paused"); }
        return { outcome: "accepted", command: {} , state_version: "9" } as never;
      }),
      status: vi.fn(async () => { throw new Error("no status expected"); }),
    };
    const controller = new CardActionsController({ gate, port, newId: () => id(70), onUpdate: vi.fn(), onApplied: vi.fn(), onRefused: vi.fn() });
    controller.setCard({ cardId: id(5), stateVersion: "3", exclusionVersion: "1", actions: { exclude: true, return: false, relearn: false } });
    await controller.exclude();
    expect(controller.snapshot()).toMatchObject({ status: "paused", problem: { reason: "paused" }, offered: { exclude: false } });
    expect(port.status).not.toHaveBeenCalled();
    await clock.advanceTo(5_000);
    expect(controller.snapshot().offered).toEqual({ exclude: true, return: false, relearn: false });
    await controller.exclude();
    expect(sent).toEqual([id(70), id(70)]);
    expect(port.status).not.toHaveBeenCalled();
    controller.dispose();
  });
});

describe("structure of the readback registry (AC-54, R1, R6, M-P03-8)", () => {
  const sources = (() => {
    const out = new Map<string, string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.test-support\./.test(name)) out.set(relative("src", path), readFileSync(path, "utf8"));
      }
    };
    walk("src");
    return out;
  })();

  /** The owners of R1 (§4.11) and where each takes part in the registry. */
  const owners: [string, string, string][] = [
    ["written/writtenDocumentCommands.ts", "written", "lanes K01/K01s/K03 (written)"],
    ["learning/learningDocumentCommands.ts", "learning", "lanes K01/K01s/K03 (Learning)"],
    ["oral/oralDocumentController.ts", "oral", "oral K05"],
    ["conjugation/conjugationCommandController.ts", "conjugation", "conjugation K06"],
    ["study/remoteStopController.ts", "stop_remote", "stop_remote K07"],
    ["settings/settingsController.ts", "settings", "settings/reset K08"],
    ["feedback/feedbackController.ts", "feedback", "feedback K09"],
    ["dictionary/actions/cardActionsController.ts", "card", "card K10"],
    ["dictionary/editors/fieldEditorsController.ts", "field", "field K11"],
    ["dictionary/dictionaryIntervalController.ts", "interval", "interval/context K12"],
    ["learning/manualSelectionController.ts", "manual_selection", "manual selection K04"],
    ["app/entryController.ts", "reapply", "reapply K13"],
    ["dictionary/owner/ownerEditorController.ts", "owner_field", "owner editor (not in R1; same rules)"],
  ];

  it.each(owners)("%s registers as %s (%s)", (file, family) => {
    const code = sources.get(file);
    expect(code, file).toBeDefined();
    expect(code).toMatch(new RegExp(`new GatePending\\([^)]*"${family}"\\)|family: "${family}"`));
  });

  it("the shared lane core and the owners register on load and send, settle definite answers and release on dispose", () => {
    const lane = sources.get("commands/commandLane.ts")!;
    expect(lane).toMatch(/this\.registry\?\.hold\(this\.pending\.intent\.command_id\)/);
    expect(lane).toMatch(/dispose\(\): void \{ this\.registry\?\.release\(\);/);
    for (const [file] of owners.filter(([file]) => !/DocumentCommands|oralDocumentController/.test(file))) {
      const code = sources.get(file)!;
      expect(code, file).toMatch(/[rR]egistry\??\.hold\(/);
      expect(code, file).toMatch(/[rR]egistry\??\.(settled|cleared)\(/);
      expect(code, file).toMatch(/[rR]egistry\??\.release\(\)/);
    }
  });

  it("R6: no production code makes a readback ticket but the gate, and every API status function takes one", () => {
    for (const [file, code] of sources) if (file !== join("commands", "writeGate.ts")) {
      expect(code, file).not.toMatch(/readbackTicket:\s*true/);
    }
    const apis = [...sources].filter(([, code]) => /readbackTicket: ticket/.test(code)).map(([file]) => file).sort();
    expect(apis).toHaveLength(14);
    for (const file of apis) {
      const code = sources.get(file)!;
      expect(code, file).not.toMatch(/async (status|resetStatus|commandStatus)\((?![^)]*ticket: ReadbackTicket)[^)]*\)/);
    }
  });

  it("AC-54 (г): every status call of production code passes the ticket of gate.runReadback (cancel_start: not wired yet, MA-13)", () => {
    const missing: string[] = [];
    for (const [file, code] of sources) {
      for (const match of code.matchAll(/\.(status|resetStatus|commandStatus)\(/g)) {
        let depth = 0, end = match.index! + match[0].length - 1;
        for (; end < code.length; end++) {
          if (code[end] === "(") depth++;
          else if (code[end] === ")" && --depth === 0) break;
        }
        const args = code.slice(match.index! + match[0].length, end);
        if (!/\bticket\s*$/.test(args) && !(file === join("commands", "startCancel.ts"))) missing.push(`${file}: ${match[0]}${args})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("L1 stands before transmitted in both automatic families (M-P03-5)", () => {
    for (const file of ["written/writtenDocumentCommands.ts", "learning/learningDocumentCommands.ts"]) {
      const code = sources.get(file)!;
      const l1 = code.indexOf("if (!gate.mayWrite(intent.command_id)) throw new PausedBeforeSendError(\"paused\");");
      expect(l1, file).toBeGreaterThan(0);
      expect(code.indexOf("transmitted?.();", l1), file).toBeGreaterThan(l1);
    }
  });
});

describe("P2-1 of QA M4–M8: a family lock of the own ID never keeps the check-first «Повторить» (C335)", () => {
  function world() {
    const w = feedbackWorld(["lose-after"]);
    const clock = new ManualClock();
    const gate = new WriteGate({ clock, probe: scriptedProbe(clock, Array.from({ length: 10 }, () => ({ status: "ready" as const }))).probe });
    const store = new FeedbackPendingStore(w.f.storage);
    let next = 100;
    const make = () => new FeedbackController({ gate, api: createFeedbackApi({ fetcher: w.f.fetcher, timeoutMs: 1000,
      maxResponseBytes: 100000, gate }), pendingStore: store, access: () => w.f.access(), newId: () => id(next++), onUpdate: vi.fn() });
    return { w, clock, gate, make };
  }

  it("K09 feedback: R3 locks the ID on dispose; after a failed automatic read «Повторить» still reads it, then sends once", async () => {
    const { w, clock, gate, make } = world();
    const first = make();
    await first.refresh(); first.edit(TEXT);
    await first.send();
    expect(first.snapshot().problem).toBe("network");
    first.dispose();
    // R17 of QA: an owner gone with an unknown outcome leaves its ID locked to itself (R3).
    expect(gate.snapshot().familyLocks).toEqual([id(100)]);
    await clock.advanceTo(60_000); await settle();
    w.state.statusFailures = 1;
    const second = make();
    await second.refresh();
    expect(second.snapshot().problem).toBe("network");
    await clock.advanceTo(200_000); await settle();
    expect(gate.snapshot().net).toEqual({ kind: "open" });
    expect(second.snapshot().canRetry).toBe(true);
    const gets = w.gets.length;
    await second.retry();
    // The read came first (it lifts the lock, R5); the server already holds the message, so nothing is sent again.
    expect(w.gets.length).toBe(gets + 1);
    expect(gate.snapshot().familyLocks).toEqual([]);
    expect(w.posts.map(post => post.command_id)).toEqual([id(100)]);
    expect(second.snapshot()).toMatchObject({ confirmed: true });
    second.dispose();
  });

  it("K09 feedback: with the gate closed the check-first «Повторить» waits too (checkButtonActive)", async () => {
    const { clock, gate, make } = world();
    const first = make();
    await first.refresh(); first.edit(TEXT);
    await first.send();
    await clock.advanceTo(60_000); await settle();
    expect(first.snapshot().canRetry).toBe(true);
    gate.closeByFailure();
    expect(first.snapshot().canRetry).toBe(false);
    gate.extendHold(30);
    await clock.advanceTo(80_000); await settle();
    expect(first.snapshot().canRetry).toBe(false);
    first.dispose();
  });

  it("K10 card: a retry that reads first follows checkButtonActive; after not_found the send follows mayWrite of the ID", async () => {
    const { gate, clock } = gateWithClock(Array.from({ length: 5 }, () => ({ status: "ready" as const })));
    const sent: string[] = [];
    let statusReplies: (() => Promise<unknown>)[] = [async () => { throw new TypeError("network"); }];
    const port: CardActionsPort = {
      origin: () => ({ client_instance_id: id(1), document_id: id(2) }),
      send: vi.fn(async command => {
        sent.push(command.command_id);
        if (sent.length === 1) throw new TypeError("network");
        return { outcome: "accepted", command: {}, state_version: "9" } as never;
      }),
      status: vi.fn(async () => (statusReplies.shift() ?? (async () => ({ outcome: "not_found", state_version: "4" })))() as never),
    };
    const controller = new CardActionsController({ gate, port, newId: () => id(71), onUpdate: vi.fn(), onApplied: vi.fn(), onRefused: vi.fn() });
    controller.setCard({ cardId: id(5), stateVersion: "3", exclusionVersion: "1", actions: { exclude: true, return: false, relearn: false } });
    await controller.exclude(); await settle();
    // The lost reply and the failed automatic check: unknown, not found yet.
    expect(controller.snapshot()).toMatchObject({ status: "unknown", canRetry: true });
    gate.resolvePending(id(71), "stale");
    expect(controller.snapshot().canRetry).toBe(true);
    gate.closeByFailure();
    expect(controller.snapshot().canRetry).toBe(false);
    await clock.advanceTo(5_000); await settle();
    statusReplies = [];
    await controller.retry();
    expect(port.status).toHaveBeenCalledTimes(2);
    expect(gate.snapshot().familyLocks).toEqual([]);
    expect(sent).toEqual([id(71), id(71)]);
    controller.dispose();
  });
});
