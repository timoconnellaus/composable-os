// Every sender asks (stage 30, ADR 0678): `checkSend`, the host's one check on an email or a text
// that is not a routine message, `mintStopLinks`, the stop links of a stoppable one as it goes, and
// `peopleSendOf`, which actions send to people.
// The runner's tests (apps/runner/test/consent-senders.test.ts) prove it at the integration host,
// where every caller's send passes; these pin the rule for each kind of sender and message.
import { sql } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  addressHash,
  checkSend,
  checkSends,
  dropStopTokens,
  invokeByName,
  mintStopLinks,
  peopleSendOf,
  readStopToken,
  recipientKey,
  recordFromForm,
  saltedHash,
  stopToken,
  suppress,
  tokenOfLink,
} from "../src/index.ts";
import { mailboxSql } from "../src/visibility/guardians.ts";
import { context, createUser, db, unique } from "./helpers.ts";
import { meterStatements } from "./statement-meter.ts";

const SITE = "https://gym.example";
let admin: ActingUser;

const run = <T = Record<string, unknown>>(name: string, input: unknown) =>
  invokeByName(name, input, context(admin)) as Promise<T>;

/** A Person with one address; the address. */
async function person(label: string): Promise<{ id: string; email: string }> {
  const email = `${unique(label).toLowerCase()}@people.test`;
  const p = await run<{ id: string }>("person.create", {
    givenName: label,
    emails: [{ email }],
  });
  return { id: p.id, email };
}

/** A stop by the one-tap link: follow-ups off by email, as the member would. */
async function stopFollowUps(personId: string) {
  const token = await stopToken(db.query, {
    person: personId,
    channel: "email",
    scope: "follow_up",
  });
  await invokeByName("contact.stop", { token }, { principal: { kind: "public" }, db });
}

const at = () => new Date().toISOString();
const check = (
  recipients: string[],
  sender: "staff" | "other",
  purpose?: "follow_up" | "news_and_offers",
) => checkSend(db.query, { channel: "email", recipients, sender, purpose, at: at() });

beforeAll(async () => {
  admin = await createUser("admin");
  await run("routineMail.settings.update", { siteOrigin: SITE });
}, 60_000);

describe("a person's own message (staff, no purpose)", () => {
  it("goes to someone who turned news and offers off; never to a suppressed address or a child's", async () => {
    const said = await person("NoNews");
    await recordFromForm(db.query, {
      personId: said.id,
      channel: "email",
      yes: false,
      wording: "Send me news and offers",
      how: "form",
      at: at(),
    }).then((s) => s.execute());
    await stopFollowUps(said.id);
    const bounced = await person("Bounced");
    await suppress(
      db.query,
      "email",
      await addressHash(db.query, bounced.email),
      "provider_unsubscribed",
      at(),
    );
    const guardian = await person("Parent");
    const kid = await person("Kid");
    await run("person.link.add", { guardianId: guardian.id, dependantId: kid.id });

    const answer = await check([said.email, bounced.email, kid.email], "staff");
    expect(answer.allowed).toEqual([{ to: said.email, person: said.id }]);
    expect(answer.dropped).toBe(2);
    expect(answer.purposeRequired).toBe(false);
  });
});

describe("anyone else's message (an automation, a tool, the assistant, MCP, an extension)", () => {
  it("must declare a purpose to email a Person; an address nobody holds needs none", async () => {
    const p = await person("Known");
    const stranger = `${unique("stranger")}@elsewhere.test`;
    expect(await check([p.email], "other")).toMatchObject({ allowed: [], purposeRequired: true });
    expect(await check([stranger], "other")).toEqual({
      allowed: [{ to: stranger, person: null }],
      dropped: 0,
      purposeRequired: false,
    });
  });

  it("a follow-up asks the register in full: a stop holds, five with two stopped sends three", async () => {
    const people = await Promise.all(["A", "B", "C", "D", "E"].map((l) => person(`Five${l}`)));
    await stopFollowUps(people[1]?.id as string);
    await stopFollowUps(people[3]?.id as string);
    const answer = await check(
      people.map((p) => p.email),
      "other",
      "follow_up",
    );
    expect(answer.allowed.map((r) => r.person)).toEqual([
      people[0]?.id,
      people[2]?.id,
      people[4]?.id,
    ]);
    expect(answer.dropped).toBe(2);
  });

  it("news and offers need a recorded yes: none for an address nobody holds", async () => {
    const yes = await person("Yes");
    await recordFromForm(db.query, {
      personId: yes.id,
      channel: "email",
      yes: true,
      wording: "Send me news and offers",
      how: "form",
      at: at(),
    }).then((s) => s.execute());
    const silent = await person("Silent");
    const stranger = `${unique("stranger")}@elsewhere.test`;
    const answer = await check([yes.email, silent.email, stranger], "other", "news_and_offers");
    expect(answer.allowed).toEqual([{ to: yes.email, person: yes.id }]);
    expect(answer.dropped).toBe(2);
  });

  it("an address several People hold is no one's: a stoppable message is refused, a person's own goes", async () => {
    const base = unique("shared").toLowerCase();
    await run("person.create", { givenName: "One", emails: [{ email: `${base}@people.test` }] });
    await run("person.create", {
      givenName: "Two",
      emails: [{ email: `${base}+gym@people.test` }],
    });
    expect((await check([`${base}@people.test`], "other", "follow_up")).dropped).toBe(1);
    expect(await check([`${base}@people.test`], "staff")).toMatchObject({
      allowed: [{ to: `${base}@people.test`, person: null }],
      dropped: 0,
    });
  });

  it("a child's own address: a machine's message never; a person's own one to one, yes", async () => {
    const guardian = await person("Mum");
    const kid = await person("Teen");
    await run("person.link.add", { guardianId: guardian.id, dependantId: kid.id });
    expect((await check([kid.email], "other", "follow_up")).dropped).toBe(1);
    expect((await check([kid.email], "other")).purposeRequired).toBe(true);
    // A coach's reply to the member's own email goes; news and offers never.
    expect((await check([kid.email], "staff")).allowed).toEqual([
      { to: kid.email, person: kid.id },
    ]);
    expect((await check([kid.email], "staff", "news_and_offers")).dropped).toBe(1);
  });
});

describe("the mailbox an address reaches (B3)", () => {
  it("a Person who stopped at john@gmail.com is not mailed at j.ohn+x@googlemail.com", async () => {
    const local = unique("john").toLowerCase().replaceAll(".", "");
    const p = await run<{ id: string }>("person.create", {
      givenName: "John",
      emails: [{ email: `${local}@gmail.com` }],
    });
    await stopFollowUps(p.id);
    const dotted = `${local.slice(0, 1)}.${local.slice(1)}+gym@googlemail.com`;
    const answer = await check([dotted], "other", "follow_up");
    expect(answer).toMatchObject({ allowed: [], dropped: 1 });
    // And with no purpose, it is a Person's: the machine must declare one.
    expect((await check([dotted], "other")).purposeRequired).toBe(true);
  });

  it("migration 0916's index and `mailboxKey` fold an address alike, and the lookup uses the index", async () => {
    const addresses = [
      "a.b.c@gmail.com",
      "a.b+c@googlemail.com",
      "x+y@example.com",
      "+x@example.com",
      "plain@example.com",
      "dots.kept@example.com",
    ];
    for (const address of addresses) {
      const row = await sql<{
        key: string;
      }>`SELECT ${mailboxSql("t.email")} AS key FROM (SELECT ${address} AS email) t`.execute(
        db.query,
      );
      expect(row.rows[0]?.key, address).toBe(recipientKey("email", address));
    }
    const plan = await sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT e.person_id FROM core_person_emails e WHERE ${mailboxSql("e.email")} IN ('a@gmail.com')`.execute(
      db.query,
    );
    expect(plan.rows.map((r) => r.detail).join(" ")).toContain("core_person_emails_mailbox_idx");
  });
});

describe("texts", () => {
  it("a person's text to a number that said STOP is refused; a machine's to a Person's number needs what it cannot have", async () => {
    const stopped = `+6140${Math.floor(Math.random() * 1e7)}`.slice(0, 12);
    const open = `+6141${Math.floor(Math.random() * 1e7)}`.slice(0, 12);
    await suppress(db.query, "text", await saltedHash(db.query, stopped), "stop_reply", at());
    const staff = await checkSend(db.query, {
      channel: "text",
      recipients: [stopped, open],
      sender: "staff",
      at: at(),
    });
    expect(staff.allowed.map((r) => r.to)).toEqual([open]);
    expect(staff.dropped).toBe(1);
    // A machine: refused when a Person holds the number, or it said STOP; never with a purpose.
    const holder = await run<{ id: string }>("person.create", {
      givenName: "Texted",
      phones: [{ number: open }],
    });
    const machine = (recipients: string[], purpose?: "follow_up") =>
      checkSend(db.query, { channel: "text", recipients, sender: "other", purpose, at: at() });
    expect((await machine([open])).purposeRequired).toBe(true);
    expect((await machine([stopped])).dropped).toBe(1);
    expect((await machine([open], "follow_up")).dropped).toBe(1);
    void holder;
  });
});

describe("stop links, made when the message goes", () => {
  it("each Person's own link, naming them, email and the purpose; taken back when it did not go", async () => {
    const p = await person("Linked");
    const { links, tokens } = await mintStopLinks(db.query, {
      purpose: "follow_up",
      recipients: [{ to: p.email, person: p.id }],
    });
    const token = tokenOfLink(links[p.email] ?? "", SITE);
    expect(token).not.toBeNull();
    expect(await readStopToken(db.query, token as string)).toEqual({
      person: p.id,
      channel: "email",
      scope: "follow_up",
    });
    await dropStopTokens(db.query, tokens);
    expect(await readStopToken(db.query, token as string)).toBeNull();
  });
});

describe("which actions send to people (B1, B2)", () => {
  const google = (fields: { label: string; value: string }[], tag?: string) =>
    peopleSendOf("google", { fields, actionKind: tag ? { tag } : null });

  it("a Google calendar event invites its attendees unless updates go to nobody", () => {
    const event = JSON.stringify({ title: "20% off", attendees: [{ email: "Ada@X.test" }] });
    expect(
      google([
        { label: "Send updates", value: "all" },
        { label: "Event", value: event },
      ]),
    ).toMatchObject({ shape: "invitation", emails: ["ada@x.test"], complete: true });
    expect(
      google([
        { label: "Send updates", value: "none" },
        { label: "Event", value: event },
      ]),
    ).toBeNull();
    // An event with nobody invited tells nobody.
    expect(
      google([
        { label: "Send updates", value: "all" },
        { label: "Event", value: JSON.stringify({ title: "Gym" }) },
      ]),
    ).toBeNull();
    // An update tells attendees its description does not list: not complete.
    expect(
      google([
        { label: "Send updates", value: "all" },
        { label: "Changes", value: JSON.stringify({ title: "Moved" }) },
      ]),
    ).toMatchObject({ shape: "invitation", complete: false });
  });

  it("Outlook's invitations, Gmail's and Outlook's sends; drafts and colleagues' mail exempt by vendor", () => {
    expect(
      peopleSendOf("microsoft", {
        fields: [{ label: "Invites", items: ["Ada Lovelace <ada@x.test> (required)"] }],
        actionKind: { tag: "calendar.invitations" },
      }),
    ).toMatchObject({ shape: "invitation", emails: ["ada@x.test"] });
    expect(
      google([
        { label: "From", value: "me@x.test" },
        { label: "To", value: "ada@x.test" },
      ]),
    ).toMatchObject({ shape: "mailbox", to: ["ada@x.test"], copied: false });
    expect(google([{ label: "To", value: "ada@x.test" }], "draftCreate")).toBeNull();
    expect(
      peopleSendOf("microsoft", {
        fields: [{ label: "To", value: "ada@x.test" }],
        actionKind: { tag: "outlook.drafts" },
      }),
    ).toBeNull();
    // A tag exempt for one vendor is not exempt for another.
    expect(
      peopleSendOf("mcp", {
        title: "Run draftCreate",
        fields: [{ label: "Arguments", value: '{"to":"ada@x.test"}' }],
        actionKind: { tag: "draftCreate" },
      }),
    ).toMatchObject({ shape: "scan", emails: ["ada@x.test"] });
  });

  it("an MCP tool call is scanned for addresses and numbers", () => {
    expect(
      peopleSendOf("mcp", {
        title: "Call send_sms",
        description: "Tool send_sms",
        fields: [{ label: "Arguments", value: '{"to":"+61 400 123 456","cc":"bo@x.test"}' }],
      }),
    ).toMatchObject({ shape: "scan", emails: ["bo@x.test"], numbers: ["+61400123456"] });
    expect(peopleSendOf("mcp", { fields: [{ label: "Arguments", value: '{"id":7}' }] })).toBeNull();
  });
});

describe("cost", () => {
  it("a send to many reads the same few statements as a send to one", async () => {
    const many = await Promise.all(Array.from({ length: 30 }, (_, i) => person(`Many${i}`)));
    const once = async (recipients: string[]) => {
      // A fresh handle each time, so the salt is read in both runs alike.
      const meter = meterStatements();
      await checkSends(meter.db.query, [
        { channel: "email", recipients, sender: "other", purpose: "follow_up", at: at() },
        { channel: "text", recipients: ["+61499999999"], sender: "staff", at: at() },
      ]);
      return meter.bound.length;
    };
    const one = await once([many[0]?.email as string]);
    const thirty = await once(many.map((p) => p.email));
    expect(thirty).toBe(one);
    expect(thirty).toBeLessThanOrEqual(7);
  });
});
