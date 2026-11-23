// Scrubbing an erased acceptance's copy (stage 44 step 8, ADR 0646): only the host's agreements
// queue may ask; a waiting send of the copy is dropped and never sent, a later send under its key
// (or a retry's) is refused, and its recipients and subject leave the sent history. It reads
// nothing back. All text here is fixture text.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { EmailSendReceipt } from "../src/types";
import { resetFakes, sentEmails, submissions } from "./fakes";

const SENDER_URL = "email-send://sender/crm%40example.com";

let seq = 0;
async function host(options: { hostAgreement?: boolean; hostPurpose?: string } = {}) {
  seq += 1;
  const stub = env.TEST_HOST.getByName(`scrub-${seq}-${crypto.randomUUID()}`);
  await stub.open(SENDER_URL, options);
  return stub;
}
type Host = Awaited<ReturnType<typeof host>>;
const AGREEMENTS = { hostAgreement: true, hostPurpose: "agreements" };

const copyOf = (acceptanceId: string, key = `agreement-copy:${acceptanceId}`) => ({
  to: ["member@members.test"],
  subject: "Fixture Studio: your copy of Fixture waiver",
  text: "This is your copy.",
  agreement: {
    business: "Fixture Studio",
    title: "Fixture waiver",
    versionNumber: 1,
    versionHash: "a".repeat(64),
    body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "Fixture." }] }] },
    tickLabel: "I have read this fixture",
    record: [{ label: "Name typed", value: "Fixture Name" }],
    acceptanceId,
    summary: "agreed by the person, 2026-11-23 09:00 UTC",
  },
  idempotencyKey: key,
});

const send = async (h: Host, message: unknown) =>
  (await h.call("send", [message])) as EmailSendReceipt;
// Not in the agent-facing types: called by name, as the integration host does.
const scrub = (h: Host, key: unknown) =>
  h.call("scrubAgreementCopy" as never, [{ key }]) as Promise<{
    done: boolean;
    dropped: number;
    redacted: number;
  }>;
const listed = async (h: Host) =>
  (await h.call("listSent", [])) as { id: number; to: string[]; subject: string; status: string }[];

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a refusal");
}

beforeEach(resetFakes);

describe("scrubAgreementCopy", () => {
  it("is refused to every queue but the host's agreements mail, whatever the key", async () => {
    for (const options of [
      {},
      { hostPurpose: "orders" },
      { hostPurpose: "sign-in" },
      { hostPurpose: "routine-mail" },
      { hostPurpose: "probe" },
    ]) {
      const h = await host(options);
      expect(
        await refusal(scrub(h, "agreement-copy:aga_fixture1")),
        JSON.stringify(options),
      ).toMatch(/only the host's own agreements mail/);
    }
    const h = await host(AGREEMENTS);
    for (const key of [
      undefined,
      "",
      "agreement-copy:",
      "routine:x",
      "agreement-copy:aga_1:2",
      7,
    ]) {
      expect(await refusal(scrub(h, key))).toMatch(/Invalid scrub/);
    }
  });

  it("drops a waiting send of the copy: never sent, and a later send under its key is refused", async () => {
    const h = await host(AGREEMENTS);
    const receipt = await send(h, copyOf("aga_wait1"));
    expect(receipt.status).toBe("pending");
    // Another acceptance's copy, whose id starts the same: untouched.
    const other = await send(h, copyOf("aga_wait10"));
    expect(await scrub(h, "agreement-copy:aga_wait1")).toEqual({
      done: true,
      found: true,
      dropped: 1,
      redacted: 0,
    });
    // A person approving the host's mirrored action later sends nothing.
    await expect(h.apply(receipt.id)).rejects.toThrow();
    expect(sentEmails).toEqual([]);
    // Nothing of it is listed any more; the other copy still waits.
    const rows = await listed(h);
    expect(rows.map((r) => r.id)).toEqual([other.id]);
    // The same key, and a retry's, are refused: it is not queued again.
    const before = submissions.length;
    for (const key of ["agreement-copy:aga_wait1", "agreement-copy:aga_wait1:3"]) {
      expect(await refusal(send(h, copyOf("aga_wait1", key)))).toMatch(/^Refused:/);
    }
    expect(submissions.length).toBe(before);
    // Scrubbing again finds nothing more.
    expect(await scrub(h, "agreement-copy:aga_wait1")).toMatchObject({ dropped: 0, redacted: 0 });
    // The other copy still goes.
    await h.apply(other.id);
    expect(sentEmails).toHaveLength(1);
  });

  it("blanks a sent copy's history line: who it went to and its subject", async () => {
    const h = await host(AGREEMENTS);
    const receipt = await send(h, copyOf("aga_sent1"));
    await h.apply(receipt.id);
    expect(sentEmails).toHaveLength(1);
    expect(JSON.stringify(await listed(h))).toContain("member@members.test");
    expect(await scrub(h, "agreement-copy:aga_sent1")).toMatchObject({ done: true, redacted: 1 });
    const rows = await listed(h);
    expect(rows).toEqual([
      expect.objectContaining({ id: receipt.id, to: [], subject: "[erased]" }),
    ]);
    expect(JSON.stringify(rows)).not.toContain("member@members.test");
    expect(JSON.stringify(rows)).not.toContain("Fixture waiver");
  });

  it("a scrub that arrives before the send: the send is refused and nothing is submitted", async () => {
    const h = await host(AGREEMENTS);
    expect(await scrub(h, "agreement-copy:aga_early1")).toMatchObject({
      done: true,
      found: false,
      dropped: 0,
    });
    expect(await refusal(send(h, copyOf("aga_early1")))).toMatch(/^Refused:/);
    expect(submissions).toEqual([]);
    expect(sentEmails).toEqual([]);
  });

  it("a copy that failed to send: its journal record holding the message is dropped", async () => {
    const h = await host(AGREEMENTS);
    const receipt = await send(h, copyOf("aga_fail1"));
    const { fakeEmail } = await import("./fakes");
    fakeEmail.failNext = true;
    // The provider fails mid-send: the outcome is unknown, and the record (the whole message)
    // is kept as failed.
    await expect(h.apply(receipt.id)).rejects.toThrow();
    expect(await scrub(h, "agreement-copy:aga_fail1")).toMatchObject({ dropped: 1 });
    expect(JSON.stringify(await listed(h))).not.toContain("member@members.test");
  });
});
