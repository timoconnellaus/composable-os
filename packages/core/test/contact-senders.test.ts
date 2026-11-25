// Every sender asks (stage 30, ADR 0678): `checkSend`, the host's one check on an email or a text
// that is not a routine message, and `withStopLinks`, the stop links it makes for a stoppable one.
// The runner's tests (apps/runner/test/consent-senders.test.ts) prove it at the integration host,
// where every caller's send passes; these pin the rule for each kind of sender and message.
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  addressHash,
  checkSend,
  invokeByName,
  readStopToken,
  recipientsOfFields,
  recordFromForm,
  saltedHash,
  stopToken,
  suppress,
  tokenOfLink,
  withStopLinks,
} from "../src/index.ts";
import { context, createUser, db, unique } from "./helpers.ts";

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

  it("a child's own address gets nothing, whatever the purpose", async () => {
    const guardian = await person("Mum");
    const kid = await person("Teen");
    await run("person.link.add", { guardianId: guardian.id, dependantId: kid.id });
    expect((await check([kid.email], "other", "follow_up")).dropped).toBe(1);
  });
});

describe("texts", () => {
  it("a person's text to a number that said STOP is refused; nobody else texts at all", async () => {
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
    const other = await checkSend(db.query, {
      channel: "text",
      recipients: [open],
      sender: "other",
      purpose: "follow_up",
      at: at(),
    });
    expect(other).toMatchObject({ allowed: [], dropped: 1 });
  });
});

describe("stop links", () => {
  it("each Person's own link, naming them, email and the purpose; none for an address nobody holds", async () => {
    const p = await person("Linked");
    const stranger = `${unique("stranger")}@elsewhere.test`;
    const links = await withStopLinks(
      db.query,
      [
        { to: p.email, person: p.id },
        { to: stranger, person: null },
      ],
      "follow_up",
      at(),
    );
    expect(links[1]).toEqual({ to: stranger, stop: null });
    const token = tokenOfLink(links[0]?.stop ?? "", SITE);
    expect(token).not.toBeNull();
    expect(await readStopToken(db.query, token as string)).toEqual({
      person: p.id,
      channel: "email",
      scope: "follow_up",
    });
    // A person's own message (no purpose) needs none.
    expect(await withStopLinks(db.query, [{ to: p.email, person: p.id }], null, at())).toEqual([
      { to: p.email, stop: null },
    ]);
  });
});

describe("recipientsOfFields", () => {
  it("reads To, Cc and Bcc of any gatekeeper's description, a list or a line, names and notes too", () => {
    expect(
      recipientsOfFields([
        { label: "From", value: "crm@example.com" },
        { label: "To", items: ["Ada <Ada@X.test>", "bo@x.test (outside your organisation)"] },
        { label: "Cc", value: "cy@x.test, di@x.test" },
        { label: "Body", value: "write to eve@x.test" },
      ]),
    ).toEqual(["ada@x.test", "bo@x.test", "cy@x.test", "di@x.test"]);
  });
});
