// Consent to be contacted (stage 30, ADR 0678): a caller's email asks the host before it is
// queued. Who the host drops is left out (the receipt says how many), nobody left is the plain
// refusal, and a stoppable email goes to each recipient on their own, ending with their own stop
// link, which the approver and the caller never see. The host's own mail is not asked here.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { EmailSendReceipt } from "../src/types";
import { resetFakes, sentEmails, submissions } from "./fakes";

const SENDER_URL = "email-send://sender/crm%40example.com";
const LINK_A = "https://gym.example/stop?t=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const LINK_B = "https://gym.example/stop?t=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

let seq = 0;
async function host(options: Record<string, unknown>) {
  seq += 1;
  const stub = env.TEST_HOST.getByName(`consent-${seq}-${crypto.randomUUID()}`);
  await stub.open(SENDER_URL, options);
  return stub;
}
type Host = Awaited<ReturnType<typeof host>>;
const send = async (h: Host, message: unknown) =>
  (await h.call("send", [message])) as EmailSendReceipt;

beforeEach(resetFakes);

describe("a caller's email asks the host first", () => {
  it("drops who the host drops, says how many, and sends the rest", async () => {
    const h = await host({ contact: { drop: ["b@x.test", "d@x.test"], stops: {} } });
    const receipt = await send(h, {
      to: ["a@x.test", "b@x.test", "c@x.test", "d@x.test", "e@x.test"],
      subject: "Hello",
      text: "Hi",
    });
    expect(receipt.dropped).toBe(2);
    const fields = submissions[0]?.[1].fields ?? [];
    const to = fields.find((f) => f.label === "To") as { items?: string[] } | undefined;
    expect(to?.items).toEqual(["a@x.test", "c@x.test", "e@x.test"]);
    expect(JSON.stringify(fields)).toContain("2 recipients who cannot be contacted this way");
    expect(await h.contactAsked()).toEqual([
      { to: ["a@x.test", "b@x.test", "c@x.test", "d@x.test", "e@x.test"], purpose: undefined },
    ]);
  });

  it("queues nothing when the host refuses", async () => {
    const h = await host({ contact: "refuse" });
    await expect(send(h, { to: ["a@x.test"], subject: "Hello", text: "Hi" })).rejects.toThrow(
      /^Refused: recipient_stopped/,
    );
    expect(submissions).toEqual([]);
  });

  it("a stoppable email goes to each on their own, with their own link the approver never sees", async () => {
    const h = await host({
      contact: { drop: [], stops: { "a@x.test": LINK_A, "b@x.test": LINK_B } },
    });
    const receipt = await send(h, {
      to: ["a@x.test", "b@x.test"],
      subject: "We miss you",
      text: "Come back soon.",
      purpose: "follow_up",
    });
    expect(receipt).not.toHaveProperty("dropped");
    const described = JSON.stringify(submissions[0]?.[1]);
    expect(described).not.toContain(LINK_A);
    expect(described).toContain("their own one-tap stop link");
    await h.applyStoppable(receipt.id, { "a@x.test": LINK_A, "b@x.test": LINK_B });
    expect(sentEmails.map((e) => [e.to, e.text])).toEqual([
      [["a@x.test"], `Come back soon.\n\nTo stop getting these emails: ${LINK_A}`],
      [["b@x.test"], `Come back soon.\n\nTo stop getting these emails: ${LINK_B}`],
    ]);
    // Never a header outside the host's routine mail.
    expect(sentEmails.every((e) => !e.headers)).toBe(true);
  });

  it("a stoppable email is never sent without the links the host gives as it applies it", async () => {
    const h = await host({ contact: { drop: [], stops: { "a@x.test": LINK_A } } });
    const receipt = await send(h, {
      to: ["a@x.test"],
      subject: "News",
      text: "Hi",
      purpose: "follow_up",
    });
    // The journal holds no link: only who gets one.
    expect(JSON.stringify(submissions)).not.toContain("/stop?t=");
    await expect(h.apply(receipt.id)).rejects.toThrow(/stop links were not given/);
    expect(sentEmails).toEqual([]);
  });

  it("the stop paragraph goes inside an HTML body", async () => {
    const h = await host({ contact: { drop: [], stops: { "a@x.test": LINK_A } } });
    const receipt = await send(h, {
      to: ["a@x.test"],
      subject: "News",
      html: "<html><body><p>Hello</p></body></html>",
      purpose: "follow_up",
    });
    await h.applyStoppable(receipt.id, { "a@x.test": LINK_A });
    expect(sentEmails[0]?.html).toMatch(
      /<p>Hello<\/p><p>To stop getting these emails: <a href="https:[^"]+">[^<]+<\/a><\/p>\n<\/body><\/html>$/,
    );
  });

  it("a purpose with cc or bcc is refused before the host is asked", async () => {
    const h = await host({ contact: { drop: [], stops: {} } });
    await expect(
      send(h, {
        to: ["a@x.test"],
        cc: ["b@x.test"],
        subject: "Hi",
        text: "Hi",
        purpose: "follow_up",
      }),
    ).rejects.toThrow(/each recipient on their own/);
    expect(await h.contactAsked()).toEqual([]);
  });

  it("a host that cannot ask: a purpose is refused (no stop links); without one the host's own check holds", async () => {
    const h = await host({});
    await expect(
      send(h, { to: ["a@x.test"], subject: "Hi", text: "Hi", purpose: "news_and_offers" }),
    ).rejects.toThrow(/cannot add its stop links/);
    await send(h, { to: ["a@x.test"], subject: "Hi", text: "Hi" });
    expect(submissions).toHaveLength(1);
  });

  it("the host's own queues are not asked here", async () => {
    const h = await host({ hostPurpose: "orders", contact: "refuse" });
    await send(h, { to: ["a@x.test"], subject: "Your order", text: "Thanks" });
    expect(submissions).toHaveLength(1);
  });

  it("a purpose other than the two is invalid", async () => {
    const h = await host({ contact: { drop: [], stops: {} } });
    await expect(
      send(h, { to: ["a@x.test"], subject: "Hi", text: "Hi", purpose: "account" }),
    ).rejects.toThrow(/Invalid email: purpose/);
  });
});
