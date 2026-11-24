// The text gatekeeper (stage 30 step 3, ADR 0672), through its real facet, events and fake
// provider:
//   - only the host's own queues use it, each for its own purpose; every caller's queue (a person,
//     MCP, the assistant, an extension, an automation's own call, Code Mode) is refused, as is any
//     other host purpose (acceptance criterion 7);
//   - a routine text decided routine, of routine shape, is `text.routine`; anything else from the
//     routine queue is `text.send`, which a person reviews with the number partly masked;
//   - one pool of 500 pending sends: full, a send is refused (the host's row waits), and there is
//     room again once one is decided (criterion 12);
//   - verified receipts carry the host's key back; STOP stops every text to the number here too,
//     START lifts it, HELP is answered once a day; other replies are not passed on (criterion 9);
//   - the fake is refused without its own secret off localhost, and no provider is no text; a
//     second provider module behind the same interface gives the host the same events (criterion 8).
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eventsStub } from "../src/events";
import { signFakeWebhook } from "../src/fake";
import { MAX_PENDING_TEXTS } from "../src/kinds";
import { providerFor, providerModule, TEXT_PROVIDERS } from "../src/provider";
import { REFUSED } from "../src/queue-class";
import { helpAnswer, isRoutineShaped, keywordOf, parseText, segmentsOf } from "../src/text";
import type { TextReceipt } from "../src/types";
import { received, resetFakes, submissions } from "./fakes";
import { SECOND_MODULE, secondSent } from "./second-fake";

const SITE = "https://gym.example";
const BASE = "https://crm.example.com/gatekeeper/text";
const control = exports.FakeTextControl as unknown as {
  sent(): Promise<{ providerRef: string; to: string; text: string }[]>;
  codeFor(to: string): Promise<string | null>;
};

let seq = 0;
async function host(purpose: string | null, routine: { siteOrigin: string | null } | null = null) {
  seq += 1;
  const stub = env.TEST_HOST.getByName(`h-${seq}-${crypto.randomUUID()}`);
  await stub.open(purpose, routine);
  return stub;
}
type Host = Awaited<ReturnType<typeof host>>;

let numberSeq = 100_000;
const number = () => `+614${String(++numberSeq).padStart(8, "0")}`;
const words = (body = "Reminder: Strength at 6:00am Mon.") =>
  `Example Gym: ${body} Reply STOP to stop`;

async function webhook(events: unknown[], id = `evt_${crypto.randomUUID()}`, secret?: string) {
  const body = JSON.stringify({ id, events });
  return exports.default.fetch(
    new Request(`${BASE}/in/fake`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fake-signature": await signFakeWebhook(secret ?? "fake-text-test-secret", body),
      },
      body,
    }),
  );
}

beforeEach(resetFakes);

describe("who may use it", () => {
  // The runner's queue for each caller: an actor's answers no host purpose; the host's other
  // purposes are its own, but not for texts.
  const callers: [string, string | null][] = [
    ["a person", null],
    ["MCP", null],
    ["the assistant", null],
    ["extension code", null],
    ["an automation's own call", null],
    ["Code Mode", null],
    ["the host's orders", "orders"],
    ["the host's sign-in mail", "sign-in"],
    ["the host's agreements", "agreements"],
    ["payment events", "payments"],
    ["sync", "sync"],
  ];
  for (const [who, purpose] of callers) {
    it(`refuses ${who}: no send, no code, no check, no hook`, async () => {
      const h = await host(purpose, { siteOrigin: SITE });
      const to = number();
      await expect(
        h.call("send", [{ to, text: words(), business: "Example Gym" }]),
      ).rejects.toThrow(REFUSED);
      await expect(h.call("startCheck", [{ to }])).rejects.toThrow(REFUSED);
      await expect(h.call("check", [{ to, code: "123456" }])).rejects.toThrow(REFUSED);
      await expect(h.call("subscribe", [{}])).rejects.toThrow(REFUSED);
      expect(submissions).toEqual([]);
      expect(await control.codeFor(to)).toBeNull();
    });
  }

  it("each host purpose only for its own work", async () => {
    const routine = await host("routine-mail", { siteOrigin: SITE });
    await expect(routine.call("startCheck", [{ to: number() }])).rejects.toThrow(REFUSED);
    const check = await host("phone-check");
    await expect(
      check.call("send", [{ to: number(), text: words(), business: "Example Gym" }]),
    ).rejects.toThrow(REFUSED);
    const events = await host("text-events");
    await expect(events.call("check", [{ to: number(), code: "1" }])).rejects.toThrow(REFUSED);
  });
});

describe("the routine queue", () => {
  const send = async (h: Host, message: unknown) =>
    (await h.call("send", [message])) as TextReceipt;

  it("a text decided routine, of routine shape, is text.routine; a held one text.send, masked", async () => {
    const h = await host("routine-mail", { siteOrigin: SITE });
    const to = number();
    const out = await send(h, {
      to,
      text: words(`Booked. See ${SITE}/bookings`),
      business: "Example Gym",
      idempotencyKey: "routine:rm_1",
    });
    expect(out).toMatchObject({ status: "pending", segments: 1 });
    expect(submissions[0]?.[1]).toMatchObject({
      actionKind: { tag: "text.routine" },
      autoApprovable: false,
    });
    const held = await host("routine-mail", null);
    await send(held, { to, text: words(), business: "Example Gym" });
    const review = submissions[1]?.[1];
    expect(review?.actionKind?.tag).toBe("text.send");
    // The approver sees the words and the number partly masked.
    expect(JSON.stringify(review)).not.toContain(to);
    expect(review?.title).toContain(`${to.slice(0, 4)}`);
    expect(JSON.stringify(review)).toContain("Strength at 6:00am");
  });

  it("not of routine shape: a person reviews it", async () => {
    const h = await host("routine-mail", { siteOrigin: SITE });
    for (const text of [
      words("See https://elsewhere.example/x"),
      words("See elsewhere.example now"),
      "Reminder: no business name first. Reply STOP to stop",
    ]) {
      await send(h, { to: number(), text, business: "Example Gym" });
    }
    expect(submissions.map(([, d]) => d.actionKind?.tag)).toEqual([
      "text.send",
      "text.send",
      "text.send",
    ]);
  });

  it("refuses what is not one text: no number, a long text, a field it does not know", async () => {
    const h = await host("routine-mail", { siteOrigin: SITE });
    for (const bad of [
      { to: "0400000000", text: words(), business: "Example Gym" },
      { to: number(), text: words("x".repeat(320)), business: "Example Gym" },
      { to: number(), text: words(), business: "Example Gym", cc: number() },
      { to: [number()], text: words() },
    ]) {
      await expect(send(h, bad)).rejects.toThrow(/Invalid text/);
    }
    expect(submissions).toEqual([]);
  });

  it("the same key answers the same send, never a second one", async () => {
    const h = await host("routine-mail", { siteOrigin: SITE });
    const message = { to: number(), text: words(), business: "Example Gym", idempotencyKey: "k-1" };
    const first = await send(h, message);
    const again = await send(h, message);
    expect(again.id).toBe(first.id);
    expect(submissions).toHaveLength(1);
  });

  it("applied, it goes through the provider from the business's number", async () => {
    const h = await host("routine-mail", { siteOrigin: SITE });
    const to = number();
    const out = await send(h, { to, text: words(), business: "Example Gym" });
    await h.apply(out.id);
    const sent = (await control.sent()).filter((s) => s.to === to);
    expect(sent).toEqual([expect.objectContaining({ to, text: words() })]);
  });

  it("holds 500 waiting sends: the next is refused until one is decided", async () => {
    const h = await host("routine-mail", null);
    const ids: number[] = [];
    for (let i = 0; i < MAX_PENDING_TEXTS; i += 1) {
      ids.push((await send(h, { to: number(), text: words(), business: "Example Gym" })).id);
    }
    await expect(send(h, { to: number(), text: words(), business: "Example Gym" })).rejects.toThrow(
      /Too many pending actions/,
    );
    await h.reject(ids[0] as number);
    await expect(
      send(h, { to: number(), text: words(), business: "Example Gym" }),
    ).resolves.toMatchObject({ status: "pending" });
  }, 120_000);
});

describe("receipts and replies", () => {
  it("a receipt names the host's key; a replay is answered and not delivered twice", async () => {
    const events = await host("text-events");
    await events.bindAndEnable();
    const h = await host("routine-mail", { siteOrigin: SITE });
    const to = number();
    const out = (await h.call("send", [
      { to, text: words(), business: "Example Gym", idempotencyKey: "routine:rm_receipt" },
    ])) as TextReceipt;
    await h.apply(out.id);
    const ref = (await control.sent()).find((s) => s.to === to)?.providerRef as string;
    const id = `evt_${crypto.randomUUID()}`;
    expect(
      (await webhook([{ type: "receipt", ref, status: "delivered", costMinor: 9 }], id)).status,
    ).toBe(200);
    expect(
      await (await webhook([{ type: "receipt", ref, status: "delivered" }], id)).json(),
    ).toEqual({
      ok: true,
      duplicate: true,
    });
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 });
    expect(received[0]).toMatchObject({
      kind: "receipt",
      ref: "routine:rm_receipt",
      providerRef: ref,
      status: "delivered",
      costMinor: 9,
    });
  });

  it("refuses a delivery whose signature does not check out", async () => {
    const response = await webhook(
      [{ type: "reply", from: number(), text: "STOP" }],
      undefined,
      "wrong",
    );
    expect(response.status).toBe(401);
  });

  it("STOP stops every text to the number here too; START lifts it", async () => {
    const events = await host("text-events");
    await events.bindAndEnable();
    const to = number();
    await webhook([{ type: "reply", from: to, text: " Stop " }]);
    expect(await eventsStub(env).isStopped(to)).toBe(true);
    const h = await host("routine-mail", { siteOrigin: SITE });
    const out = (await h.call("send", [
      { to, text: words(), business: "Example Gym" },
    ])) as TextReceipt;
    await expect(h.apply(out.id)).rejects.toThrow(/replied STOP/);
    const check = await host("phone-check");
    await expect(check.call("startCheck", [{ to }])).rejects.toThrow(/replied STOP/);
    await webhook([{ type: "reply", from: to, text: "START" }]);
    expect(await eventsStub(env).isStopped(to)).toBe(false);
    await vi.waitFor(
      () => expect(received.map((e) => e.kind === "reply" && e.keyword)).toEqual(["stop", "start"]),
      {
        timeout: 5_000,
      },
    );
    expect(received[0]).toMatchObject({ kind: "reply", from: to, keyword: "stop" });
  });

  it("HELP is answered with the business's name, once a day; other replies are not passed on", async () => {
    const events = await host("text-events");
    await events.bindAndEnable();
    const h = await host("routine-mail", { siteOrigin: SITE });
    const out = (await h.call("send", [
      { to: number(), text: words(), business: "Example Gym" },
    ])) as TextReceipt;
    await h.apply(out.id);
    const to = number();
    await webhook([{ type: "reply", from: to, text: "HELP" }]);
    await webhook([{ type: "reply", from: to, text: "help" }]);
    await webhook([{ type: "reply", from: to, text: "Can I bring a friend?" }]);
    const answers = (await control.sent()).filter((s) => s.to === to);
    expect(answers.map((a) => a.text)).toEqual([helpAnswer("Example Gym")]);
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5_000 });
    expect(received[0]).toMatchObject({ kind: "reply", keyword: "help", answeredSegments: 1 });
    expect(received[1]).toMatchObject({ kind: "reply", keyword: "help" });
    expect(received[1]).not.toHaveProperty("answeredSegments");
  });
});

describe("the review of PR #435", () => {
  it("finding 7: a STOP that came while no host hook was bound reaches the host once one is", async () => {
    await eventsStub(env).setHook(null);
    const to = number();
    await webhook([{ type: "reply", from: to, text: "STOP" }]);
    expect(received).toEqual([]);
    const events = await host("text-events");
    await events.bindAndEnable();
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 });
    expect(received[0]).toMatchObject({ kind: "reply", from: to, keyword: "stop" });
  });

  it("finding 6: a stopped number is kept under this deployment's salt, not as a bare hash", async () => {
    const to = number();
    await webhook([{ type: "reply", from: to, text: "STOP" }]);
    expect(await eventsStub(env).isStopped(to)).toBe(true);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(to));
    const bare = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const stored = await runInDurableObject(eventsStub(env), async (_instance, state) =>
      state.storage.sql
        .exec<{ number_hash: string }>("SELECT number_hash FROM stops")
        .toArray()
        .map((r) => r.number_hash),
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(stored).not.toContain(bare);
  });
});

describe("checking a number by code", () => {
  it("sends a code and checks it once; three codes a day per number", async () => {
    const h = await host("phone-check");
    const to = number();
    await h.call("startCheck", [{ to }]);
    const code = (await control.codeFor(to)) as string;
    expect(await h.call("check", [{ to, code: "000000" === code ? "111111" : "000000" }])).toEqual({
      checked: false,
    });
    expect(await h.call("check", [{ to, code }])).toEqual({ checked: true });
    expect(await h.call("check", [{ to, code }])).toEqual({ checked: false });
    await h.call("startCheck", [{ to }]);
    await h.call("startCheck", [{ to }]);
    await expect(h.call("startCheck", [{ to }])).rejects.toThrow(/codes for today/);
  });
});

describe("the provider", () => {
  it("the fake needs its own secret off localhost; none set up sends nothing", () => {
    const base = { TEXT_SENDER_NUMBER: "+61400000999" };
    expect(
      providerModule({
        ...base,
        TEXT_PROVIDER: "fake",
        BASE_URL: "https://staging.example/gatekeeper/text",
      }),
    ).toMatchObject({ problem: expect.stringMatching(/FAKE_WEBHOOK_SECRET/) });
    expect(
      providerModule({
        ...base,
        TEXT_PROVIDER: "fake",
        BASE_URL: "http://localhost:5173/gatekeeper/text",
      }),
    ).toMatchObject({ name: "fake" });
    expect(providerModule({ ...base, TEXT_PROVIDER: "" })).toMatchObject({
      problem: expect.stringMatching(/No text provider/),
    });
    expect(providerModule({ ...base, TEXT_PROVIDER: "nope" })).toMatchObject({
      problem: expect.stringMatching(/no text provider nope/),
    });
    expect(
      providerModule({ TEXT_PROVIDER: "fake", FAKE_WEBHOOK_SECRET: "s", TEXT_SENDER_NUMBER: "" }),
    ).toMatchObject({ problem: expect.stringMatching(/sender number/) });
  });

  it("two providers behind one interface: one setting picks the module, the host sees the same", async () => {
    const modules = { ...TEXT_PROVIDERS, second: SECOND_MODULE };
    const results: unknown[] = [];
    for (const name of ["fake", "second"]) {
      const provider = providerFor({ ...env, TEXT_PROVIDER: name }, modules);
      const to = number();
      const { providerRef } = await provider.send({ from: "+61400000999", to, text: words() });
      await provider.startCheck({ from: "+61400000999", to });
      const code = name === "fake" ? ((await control.codeFor(to)) as string) : "424242";
      const checked = await provider.check({ to, code });
      const body =
        name === "fake"
          ? JSON.stringify({
              id: "e1",
              events: [{ type: "receipt", ref: providerRef, status: "delivered" }],
            })
          : new URLSearchParams({
              MessageId: "e1",
              Kind: "status",
              Ref: providerRef,
              Status: "DELIVRD",
            }).toString();
      const headers: Record<string, string> =
        name === "fake"
          ? { "x-fake-signature": await signFakeWebhook("fake-text-test-secret", body) }
          : { "x-second-token": "second-secret" };
      const verified = await provider.verifyWebhook(
        headers,
        new TextEncoder().encode(body),
        Math.floor(Date.now() / 1000),
      );
      results.push({
        checked,
        verified: verified.ok
          ? verified.events.map((e) =>
              e.type === "receipt" ? { ...e, providerRef: "-", at: "-" } : e,
            )
          : verified,
      });
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual({
      checked: true,
      verified: [{ type: "receipt", providerRef: "-", status: "delivered", at: "-" }],
    });
    expect(secondSent).toHaveLength(1);
  });
});

describe("words", () => {
  it("counts segments as the host does, reads keywords, and knows routine shape", () => {
    expect(segmentsOf("a".repeat(160))).toBe(1);
    expect(segmentsOf("a".repeat(161))).toBe(2);
    expect(segmentsOf(`€${"a".repeat(159)}`)).toBe(2);
    expect(segmentsOf(`ä${"a".repeat(69)}`)).toBe(1);
    expect(segmentsOf(`✓${"a".repeat(70)}`)).toBe(2);
    expect(["STOP", "stop.", "Unsubscribe", "START", "help", "hello"].map(keywordOf)).toEqual([
      "stop",
      "stop",
      "stop",
      "start",
      "help",
      null,
    ]);
    const t = parseText({
      to: "+61400000001",
      text: words(`at ${SITE}/b`),
      business: "Example Gym",
    });
    expect(isRoutineShaped(t, SITE)).toBe(true);
    expect(isRoutineShaped(t, null)).toBe(false);
  });
});
