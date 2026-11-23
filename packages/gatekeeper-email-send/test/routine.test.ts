// Routine mail (ADR 0590): a send gets the routine kind only when the host's own queue says it is
// routine mail decided routine, and only when the message has routine shape. Anything else is an
// ordinary send, which the host holds for a person.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isRoutineShaped } from "../src/routine";
import type { EmailSendReceipt } from "../src/types";
import { resetFakes, sentEmails, submissions } from "./fakes";

const SENDER_URL = "email-send://sender/crm%40example.com";
const SITE = "https://gym.example";

let seq = 0;
async function host(options: { hostRoutine?: { siteOrigin: string | null } } = {}) {
  seq += 1;
  const stub = env.TEST_HOST.getByName(`routine-${seq}-${crypto.randomUUID()}`);
  await stub.open(SENDER_URL, options);
  return stub;
}
type Host = Awaited<ReturnType<typeof host>>;
const send = async (h: Host, message: unknown) =>
  (await h.call("send", [message])) as EmailSendReceipt;
const kindOf = () => submissions[0]?.[1].actionKind?.tag;

const routine = {
  to: ["member@members.test"],
  subject: "Booked: Strength",
  text: `You are booked into Strength on Monday 7 December at 06:00.\n\nYou can see your bookings when you sign in: ${SITE}/bookings.`,
  relatedRecords: ["rec_1"],
  calendar: {
    uid: "rec_1",
    start: "2026-12-07T06:00:00.000Z",
    end: "2026-12-07T07:00:00.000Z",
    title: "Strength",
    url: `${SITE}/bookings`,
  },
};

beforeEach(resetFakes);

describe("the routine kind", () => {
  it("is given only by the host's routine queue, and is not auto-approvable", async () => {
    const h = await host({ hostRoutine: { siteOrigin: SITE } });
    await send(h, routine);
    expect(kindOf()).toBe("email.routine");
    expect(submissions[0]?.[1].autoApprovable).toBe(false);
    expect(sentEmails).toEqual([]);
  });

  it("every other queue sending the same message gets the ordinary kind", async () => {
    const h = await host();
    await send(h, routine);
    expect(kindOf()).toBe("email.send");
  });

  it("a message not of routine shape from the routine queue is ordinary", async () => {
    const variants = [
      { ...routine, to: ["a@members.test", "b@members.test"] },
      { ...routine, cc: ["c@members.test"] },
      { ...routine, bcc: ["c@members.test"] },
      { ...routine, replyTo: "phish@evil.test" },
      { ...routine, html: "<p>Click</p>" },
      { ...routine, text: `${routine.text}\nhttps://evil.test/login` },
      { ...routine, text: `${routine.text}\nhttp://gym.example/bookings` },
      { ...routine, text: `${routine.text}\nwww.evil.test` },
      { ...routine, text: `${routine.text}\nhttps://gym.example.evil.test/` },
      { ...routine, subject: "Click https://evil.test" },
      { ...routine, calendar: { ...routine.calendar, url: "https://evil.test/" } },
      { ...routine, calendar: { ...routine.calendar, description: "Anything at all" } },
    ];
    for (const message of variants) {
      resetFakes();
      const h = await host({ hostRoutine: { siteOrigin: SITE } });
      await send(h, message);
      expect(kindOf(), JSON.stringify(message)).not.toBe("email.routine");
    }
  });

  it("with no site configured, a message with any link is ordinary; without links it is routine", async () => {
    expect(isRoutineShaped(routine, null)).toBe(false);
    expect(
      isRoutineShaped(
        { to: ["m@members.test"], subject: "Reminder: Strength", text: "A reminder." },
        null,
      ),
    ).toBe(true);
  });

  it("applies like any send: the host decides, the gatekeeper delivers once", async () => {
    const h = await host({ hostRoutine: { siteOrigin: SITE } });
    const receipt = await send(h, { ...routine, idempotencyKey: "routine:rml_1" });
    await h.apply(receipt.id);
    expect(sentEmails.map((e) => e.to)).toEqual([["member@members.test"]]);
    // The same key again (a retried step): the first send's receipt, nothing queued.
    expect(await send(h, { ...routine, idempotencyKey: "routine:rml_1" })).toEqual({
      status: "sent",
      id: receipt.id,
    });
    expect(submissions).toHaveLength(1);
  });
});
