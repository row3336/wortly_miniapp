import { describe, expect, it, vi } from "vitest";
import { cardActionIntentHash, createCardActionApi, type CardActionIntent } from "./cardActionApi";
import { actionFact, aid, CARD, command, current, excludeIntent, json, origin, profileCurrent, relearnIntent } from "./actionTestData.test-support";
import { readWithTicket, testGate } from "../../commands/testGate.test-support";

function api(...replies: Response[]) {
  const fetcher = vi.fn<typeof fetch>(async () => replies.shift() ?? json({}, 500));
  return { fetcher, api: createCardActionApi({ fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000, gate: testGate() }) };
}
const body = (fetcher: ReturnType<typeof api>["fetcher"], call = 0) => JSON.parse(String(fetcher.mock.calls[call][1]!.body));
const returnIntent = (version: string | null = "3"): CardActionIntent =>
  ({ kind: "card.return", command_id: aid(12), card_id: CARD, expected_card_state_version: version });

describe("card action wire (core card_exclusion, C-EXCL §9)", () => {
  it("B1 fingerprints match core identity.intent_hash; the command ID and ID case are not part of them", async () => {
    // Expected values: core .venv python, wortly.identity.service.intent_hash (M-ACTIONS logs/hash_reference.txt).
    expect(await cardActionIntentHash(excludeIntent())).toBe("725cf94db0c79a71f58a46152be70fc3238a503bb6da67b4238b3b429e26dbd1");
    expect(await cardActionIntentHash(excludeIntent({ expected_card_state_version: "3" } as Partial<CardActionIntent>)))
      .toBe("c0bdecc305a115c82608ade5d82915d906236971d4e45825a257f878369aa89b");
    expect(await cardActionIntentHash(returnIntent())).toBe("c974df9bb2193881e1140da484046338e7e5282acebf937709e64e8abd14add9");
    expect(await cardActionIntentHash(relearnIntent({ card_id: CARD.toUpperCase(), command_id: aid(99) })))
      .toBe("0a953f1e56d82d6927d05e3b65c454da43f6f8d5f7d5dce0296b3a5d117d12e7");
  });

  it("B2 exclude/return carry the card state version at the top level; relearn carries only its confirmation", async () => {
    const exclude = command(excludeIntent());
    const first = api(json({ command: actionFact(exclude), current: current(true, "1"), state_version: "11" }));
    expect((await first.api.send("token", "proof", exclude)).outcome).toBe("accepted");
    expect(body(first.fetcher)).toEqual({ command_id: aid(10), kind: "card.exclude", ...origin, expected_card_state_version: null,
      payload: { card_id: CARD } });
    expect(first.fetcher.mock.calls[0][1]!.headers).toMatchObject({ "X-Origin-Proof": "proof" });

    const relearn = command(relearnIntent());
    const second = api(json({ command: actionFact(relearn), current: current(false, null), state_version: "12", error: null }));
    expect((await second.api.send("token", "proof", relearn)).outcome).toBe("accepted");
    expect(body(second.fetcher)).toEqual({ command_id: aid(11), kind: "card.relearn", ...origin, payload: { card_id: CARD, confirmed: true } });
  });

  it("B3 a refusal with the full body is named; a payload mismatch is told apart", async () => {
    const back = command(returnIntent());
    const refusal = (code: string) => json({ command: { id: back.command_id, status: "rejected" }, current: current(false, "4"),
      state_version: "11", error: { code } }, 409);
    const { api: client } = api(refusal("VERSION_CONFLICT"), refusal("COMMAND_PAYLOAD_MISMATCH"),
      json({ command: { id: back.command_id, status: "rejected" }, current: { status: "unavailable" }, state_version: "11",
        error: { code: "FORBIDDEN" } }, 403));
    expect(await client.send("token", "proof", back)).toMatchObject({ outcome: "rejected", error: { code: "VERSION_CONFLICT" } });
    expect((await client.send("token", "proof", back)).outcome).toBe("mismatch");
    expect(await client.send("token", "proof", back)).toMatchObject({ outcome: "rejected", error: { code: "FORBIDDEN" } });
  });

  it("B4 strict replies: a foreign card, a wrong version step, a context or an error at 200 are never a success", async () => {
    const exclude = command(excludeIntent({ expected_card_state_version: "3" } as Partial<CardActionIntent>));
    const good = () => ({ command: actionFact(exclude), current: current(true, "4"), state_version: "11" });
    const broken = [
      { ...good(), current: { ...current(true, "4"), card_id: aid(902) } },
      { ...good(), current: { ...current(true, "4"), actions: { exclude: true, return: true, relearn: true } } },
      { ...good(), command: { ...actionFact(exclude), target_id: aid(902) } },
      { ...good(), command: { ...actionFact(exclude), context_id: aid(500) } },
      { ...good(), command: { ...actionFact(exclude), kind: "card.return" } },
      { ...good(), error: { code: "VERSION_CONFLICT" } },
      { ...good(), extra: true },
    ];
    for (const reply of broken) {
      const { api: client } = api(json(reply));
      await expect(client.send("token", "proof", exclude)).rejects.toMatchObject({ kind: "invalid_response" });
    }
  });

  it("B5 status: the verified hash proves this intent; not_found and a mismatch are their own outcomes", async () => {
    const exclude = command(excludeIntent());
    const hash = await cardActionIntentHash(excludeIntent());
    const stored = { ...actionFact(exclude), status: "already_applied" };
    const { fetcher, api: client } = api(
      json({ command: stored, current: current(true, "1"), state_version: "11", verified_intent_hash: hash }),
      json({ command: { id: exclude.command_id, status: "not_found" }, current: profileCurrent(), state_version: "11" }),
      json({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409),
      json({ command: stored, current: current(true, "1"), state_version: "11", verified_intent_hash: "0".repeat(64) }));
    expect((await readWithTicket(exclude, (__command, __ticket) => client.status("token", "proof", __command, __ticket))).outcome).toBe("accepted");
    const url = new URL(String(fetcher.mock.calls[0][0]), "http://local");
    expect(url.pathname).toBe(`/api/v1/commands/${exclude.command_id}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ ...origin, expected_intent_hash: hash });
    expect((await readWithTicket(exclude, (__command, __ticket) => client.status("token", "proof", __command, __ticket))).outcome).toBe("not_found");
    expect((await readWithTicket(exclude, (__command, __ticket) => client.status("token", "proof", __command, __ticket))).outcome).toBe("mismatch");
    await expect(readWithTicket(exclude, (__command, __ticket) => client.status("token", "proof", __command, __ticket))).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("B6 object_version is not the client's: any version (or none) of an accepted fact is a success (C-EXCL §9)", async () => {
    const exclude = command(excludeIntent({ expected_card_state_version: "3" } as Partial<CardActionIntent>));
    for (const objectVersion of ["4", "9", null]) {
      const { api: client } = api(json({ command: actionFact(exclude, { object_version: objectVersion }), current: current(true, "4"),
        state_version: "11" }));
      expect(await client.send("token", "proof", exclude)).toMatchObject({ outcome: "accepted", current: { version: "4" } });
    }
    const { api: client } = api(json({ command: actionFact(exclude, { object_version: "x" }), current: current(true, "4"), state_version: "11" }));
    await expect(client.send("token", "proof", exclude)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("B7 an invalid intent is never sent: relearn without confirmation, a bad version, a missing origin", async () => {
    const { fetcher, api: client } = api();
    await expect(client.send("token", "proof", command(relearnIntent({ confirmed: false } as unknown as Partial<CardActionIntent>))))
      .rejects.toThrow("invalid card action intent");
    await expect(client.send("token", "proof", command(excludeIntent({ expected_card_state_version: 3 } as unknown as Partial<CardActionIntent>))))
      .rejects.toThrow("invalid card action intent");
    await expect(client.send("token", "proof", { ...excludeIntent(), client_instance_id: "x", document_id: aid(2) } as never))
      .rejects.toThrow("invalid card action command");
    await expect(client.send("", "proof", command(excludeIntent()))).rejects.toThrow("invalid card action command");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
