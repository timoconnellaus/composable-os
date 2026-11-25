// Consent to be contacted (stage 30 step 5, ADR 0675): the consent register, the one question
// every sender asks (`contactDecision`), the stop link and the public `contact.stop`, the member's
// Contact preferences, staff recording a choice, a merge and an erase.
//   - criterion 15: a member turns a kind off by text in their account; they cannot turn an
//     essential kind's email off;
//   - criterion 16: the one-tap stop turns that scope off for that recipient without signing in;
//     its token cannot turn anything on, works for one Person, channel and scope, and a bad token
//     is answered as a good one is;
//   - criterion 17: news and offers with no recorded yes is `no_consent`, for a child `child`; a
//     follow-up stopped by email is still sent by text; a refusal is final (the tests the Journeys
//     and inbox builds reuse);
//   - criterion 19 (the register's part): erase deletes the choices, a STOP's hash stays;
//   - criterion 20: no AI actor records a choice, a yes or lifts a stop.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  addressHash,
  type ChannelReach,
  type CustomerPrincipal,
  choicesInForce,
  contactDecision,
  declareHostRoutineKind,
  invokeByName,
  type OutsideInvocationContext,
  readStopToken,
  recordFromForm,
  saltedHash,
  stopHeldRoutineMessage,
  stopLink,
  stopToken,
  suppress,
} from "../src/index.ts";
import { context, createUser, db, refusal, unique } from "./helpers.ts";

const SITE = "https://gym.example";
const OPTIONAL = "core.contactTestReminder";
const ESSENTIAL = "core.contactTestReceipt";
const FOLLOW_UP = "core.contactTestReview";

let admin: ActingUser;
const PUBLIC = { kind: "public" } as const;
const outside = (principal: CustomerPrincipal | typeof PUBLIC): OutsideInvocationContext => ({
  principal,
  db,
});
const run = <T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: Parameters<typeof invokeByName>[2],
) => invokeByName(name, input, ctx) as Promise<T>;

/** A Person with a customer account. */
async function member(label: string): Promise<CustomerPrincipal & { email: string }> {
  const tag = unique(label).toLowerCase();
  const email = `${tag}@members.test`;
  const person = await run<{ id: string }>(
    "person.create",
    { givenName: `Given-${tag}`, emails: [{ email }] },
    context(admin),
  );
  const customerId = `cus_${tag}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(customerId, person.id, email, now, now)
    .run();
  return { kind: "customer", customerId, personId: person.id, email };
}

/** A child, linked by staff to `guardian`. */
async function child(guardian: string): Promise<string> {
  const kid = await run<{ id: string }>(
    "person.create",
    { givenName: unique("Kid") },
    context(admin),
  );
  await run("person.link.add", { guardianId: guardian, dependantId: kid.id }, context(admin));
  return kid.id;
}

/** Everyone reached by text and push, as the text and push steps would (a test's stand-in). */
const everyone: ChannelReach = {
  text: async (_db, personId) => ({ to: "+61400000000", key: `text:${personId}` }),
  push: async (_db, personId) => ({ to: `device:${personId}`, key: `push:${personId}` }),
};

const ask = (
  person: string,
  channel: "email" | "text" | "push",
  purpose: "account" | "follow_up" | "news_and_offers",
  kind?: string,
  essential?: boolean,
) =>
  contactDecision(
    db.query,
    {
      person,
      channel,
      purpose,
      kind,
      essential,
      at: new Date().toISOString(),
      // An email names its address, as a sender does.
      ...(channel === "email" ? { address: `${person}@members.test` } : {}),
    },
    { reach: everyone },
  );

const words = {
  subject: "A test",
  text: "A test message.",
  textMessage: "A test message.",
};

beforeAll(async () => {
  admin = await createUser("admin");
  // Host kinds stand in for a pack's: one optional, one essential, one follow-up.
  declareHostRoutineKind("contactTestReminder", {
    label: "Test reminders",
    description: "An optional kind for the consent tests.",
    about: "order",
    essential: false,
    channels: ["email", "text"],
    messages: { m: words },
  });
  declareHostRoutineKind("contactTestReceipt", {
    label: "Test receipts",
    description: "An essential kind for the consent tests.",
    about: "order",
    channels: ["email", "text"],
    messages: { m: words },
  });
  declareHostRoutineKind("contactTestReview", {
    label: "Test review asks",
    description: "A follow-up kind for the consent tests.",
    about: "order",
    purpose: "follow_up",
    messages: { m: { subject: "A test", text: "A test message." } },
  });
  await run(
    "routineMail.settings.update",
    {
      siteOrigin: SITE,
      quietZone: "Australia/Sydney",
      senderName: "Example Gym",
      kinds: { [OPTIONAL]: true, [ESSENTIAL]: true, [FOLLOW_UP]: true },
      channels: { [OPTIONAL]: { text: true }, [ESSENTIAL]: { text: true } },
    },
    context(admin),
  );
}, 60_000);

describe("contactDecision: the one question", () => {
  it("news and offers with no recorded yes is no_consent; with a yes it goes; never to a child", async () => {
    const m = await member("news");
    expect(await ask(m.personId, "email", "news_and_offers")).toMatchObject({
      send: false,
      reason: "no_consent",
    });
    await run(
      "me.contact.setChoices",
      {
        choices: [{ scope: "news_and_offers", channel: "email", value: "yes" }],
        wording: "Yes, send me news and offers by email.",
      },
      outside(m),
    );
    expect(await ask(m.personId, "email", "news_and_offers")).toEqual({
      send: true,
      to: `${m.personId}@members.test`,
      key: `${m.personId}@members.test`,
    });
    // Only on the channel the yes was given for.
    expect(await ask(m.personId, "text", "news_and_offers")).toMatchObject({
      send: false,
      reason: "no_consent",
    });
    const kid = await child(m.personId);
    expect(await ask(kid, "email", "news_and_offers")).toMatchObject({
      send: false,
      reason: "child",
    });
    // Nobody, not even their guardian, records a yes for a child.
    const refused = await refusal(
      run(
        "me.contact.setChoices",
        {
          personId: kid,
          choices: [{ scope: "news_and_offers", channel: "email", value: "yes" }],
          wording: "Yes.",
        },
        outside(m),
      ),
    );
    expect(refused?.code).toBe("invalid_input");
    // Nor does a form's or a checkout's consent question (F6).
    await expect(
      recordFromForm(db.query, {
        personId: kid,
        channel: "email",
        yes: true,
        wording: "Keep me updated.",
        how: "form",
        at: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await (
      await recordFromForm(db.query, {
        personId: m.personId,
        channel: "text",
        yes: true,
        wording: "Text me news and offers.",
        how: "form",
        at: new Date().toISOString(),
      })
    ).execute();
    expect(await ask(m.personId, "text", "news_and_offers")).toMatchObject({ send: true });
  });

  it("a follow-up stopped by email is still sent by text, and the refusal is final", async () => {
    const m = await member("follow");
    const token = await stopToken(db.query, {
      person: m.personId,
      channel: "email",
      scope: "follow_up",
    });
    expect(token).toBeTruthy();
    await run("contact.stop", { token }, outside(PUBLIC));
    const email = await ask(m.personId, "email", "follow_up", FOLLOW_UP);
    expect(email).toMatchObject({ send: false, reason: "stopped" });
    expect(await ask(m.personId, "text", "follow_up", FOLLOW_UP)).toMatchObject({
      send: true,
      to: "+61400000000",
    });
    // A refusal says only why: there is nothing in it to approve, hold or send.
    expect(Object.keys(email).sort()).toEqual(["detail", "reason", "send"]);
  });

  it("a kind turned off is off on that channel only; an essential kind's email always goes", async () => {
    const m = await member("kinds");
    await run(
      "me.contact.setChoices",
      { choices: [{ scope: OPTIONAL, channel: "text", value: "off" }] },
      outside(m),
    );
    expect(await ask(m.personId, "text", "account", OPTIONAL)).toMatchObject({
      send: false,
      reason: "off",
    });
    expect(await ask(m.personId, "email", "account", OPTIONAL)).toMatchObject({ send: true });
    expect(await ask(m.personId, "email", "account", ESSENTIAL, true)).toMatchObject({
      send: true,
    });
  });

  it("a number that replied STOP is suppressed, whoever it is on", async () => {
    const m = await member("suppressed");
    const reach: ChannelReach = {
      ...everyone,
      text: async () => ({ reason: "the number replied STOP", stopped: true }),
    };
    expect(
      await contactDecision(
        db.query,
        { person: m.personId, channel: "text", purpose: "account", at: new Date().toISOString() },
        { reach },
      ),
    ).toMatchObject({ send: false, reason: "suppressed" });
  });

  it("reads a batch of recipients' choices in one statement", async () => {
    const a = await member("batch-a");
    const b = await member("batch-b");
    await run(
      "me.contact.setChoices",
      { choices: [{ scope: OPTIONAL, channel: "email", value: "off" }] },
      outside(a),
    );
    const batch = await choicesInForce(db.query, [a.personId, b.personId]);
    expect(batch.get(a.personId)?.get(`email:${OPTIONAL}`)?.value).toBe("off");
    expect(batch.get(b.personId)).toBeUndefined();
    expect(
      await contactDecision(
        db.query,
        {
          person: a.personId,
          channel: "email",
          purpose: "account",
          kind: OPTIONAL,
          at: new Date().toISOString(),
        },
        { choices: batch },
      ),
    ).toMatchObject({ send: false, reason: "off" });
  });
});

describe("the one-tap stop", () => {
  it("turns that scope off for that Person on that channel, without signing in", async () => {
    const m = await member("stop");
    const other = await member("stop-other");
    const link = await stopLink(db.query, SITE, {
      person: m.personId,
      channel: "email",
      scope: OPTIONAL,
    });
    expect(link).toMatch(/^https:\/\/gym\.example\/stop\?t=[A-Za-z0-9_-]{43}$/);
    const token = new URL(link as string).searchParams.get("t") as string;
    expect(await readStopToken(db.query, token)).toEqual({
      person: m.personId,
      channel: "email",
      scope: OPTIONAL,
    });
    expect(await run("contact.stop", { token }, outside(PUBLIC))).toEqual({ done: true });
    expect(await ask(m.personId, "email", "account", OPTIONAL)).toMatchObject({
      send: false,
      reason: "stopped",
    });
    // Nothing else: their texts of the kind, their other kinds, and anyone else.
    expect(await ask(m.personId, "text", "account", OPTIONAL)).toMatchObject({ send: true });
    expect(await ask(m.personId, "email", "follow_up", FOLLOW_UP)).toMatchObject({ send: true });
    expect(await ask(other.personId, "email", "account", OPTIONAL)).toMatchObject({ send: true });
    // Used again, it writes nothing more.
    await run("contact.stop", { token }, outside(PUBLIC));
    const rows = await env.DB.prepare(
      "SELECT how, value FROM core_contact_choice WHERE person_id = ?",
    )
      .bind(m.personId)
      .all();
    expect(rows.results).toEqual([{ how: "stop_link", value: "off" }]);
    // Only its hash is kept: the token itself is in no table.
    const kept = await env.DB.prepare(
      "SELECT token_hash FROM core_contact_stop_token WHERE person_id = ?",
    )
      .bind(m.personId)
      .all<{ token_hash: string }>();
    expect(kept.results).toHaveLength(1);
    expect(kept.results[0]?.token_hash).not.toContain(token);
    expect(kept.results[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cannot turn anything on, and answers a bad token as a good one", async () => {
    const m = await member("stop-bad");
    await run(
      "me.contact.setChoices",
      { choices: [{ scope: OPTIONAL, channel: "email", value: "off" }] },
      outside(m),
    );
    const token = (await stopToken(db.query, {
      person: m.personId,
      channel: "email",
      scope: OPTIONAL,
    })) as string;
    // Tokens the host never made: a changed one, one of the right shape, nonsense.
    const changed = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    const answers = [];
    for (const t of [changed, "A".repeat(43), "nonsense", ""]) {
      answers.push(await run("contact.stop", { token: t }, outside(PUBLIC)));
    }
    answers.push(await run("contact.stop", { token }, outside(PUBLIC)));
    expect(answers).toEqual(Array(5).fill({ done: true }));
    // The made-up ones wrote nothing; the real one made the member's "off" a stop (a stop is
    // theirs to lift only), and nothing was turned on.
    const rows = await env.DB.prepare(
      "SELECT scope, how, value FROM core_contact_choice WHERE person_id = ? ORDER BY seq",
    )
      .bind(m.personId)
      .all();
    expect(rows.results).toEqual([
      { scope: OPTIONAL, how: "member", value: "off" },
      { scope: OPTIONAL, how: "stop_link", value: "off" },
    ]);
  });

  it("an essential kind's email has no stop, and a token for one does nothing", async () => {
    const m = await member("stop-essential");
    const token = await stopToken(db.query, {
      person: m.personId,
      channel: "email",
      scope: ESSENTIAL,
    });
    await run("contact.stop", { token }, outside(PUBLIC));
    expect(await ask(m.personId, "email", "account", ESSENTIAL, true)).toMatchObject({
      send: true,
    });
  });

  it("the member may turn back on what they stopped; staff may not", async () => {
    const m = await member("lift");
    const token = await stopToken(db.query, {
      person: m.personId,
      channel: "email",
      scope: OPTIONAL,
    });
    await run("contact.stop", { token }, outside(PUBLIC));
    const staffLift = await refusal(
      run(
        "person.contact.record",
        {
          personId: m.personId,
          choices: [{ scope: OPTIONAL, channel: "email", value: "on" }],
          how: "staff_on_request",
          reason: "Asked at the desk",
        },
        context(admin),
      ),
    );
    expect(staffLift?.code).toBe("forbidden");
    await run(
      "me.contact.setChoices",
      { choices: [{ scope: OPTIONAL, channel: "email", value: "on" }] },
      outside(m),
    );
    expect(await ask(m.personId, "email", "account", OPTIONAL)).toMatchObject({ send: true });
  });
});

describe("a held routine message approved after its kind is gone", () => {
  it("is still stopped by the suppression list", async () => {
    const m = await member("gone");
    const address = `${m.personId}@members.test`;
    const now = new Date().toISOString();
    const id = `rml_${unique("gone")}`;
    const action = `pa_${unique("gone")}`;
    await env.DB.prepare(
      `INSERT INTO core_routine_mail (id, kind, message, extension_id, record_object, record_id,
         channel, recipient, recipient_rule, recipient_key, recipient_person_id, trigger_type,
         idempotency_key, routine, status, subject, body, pending_action_id, created_at, updated_at)
       VALUES (?, 'uninstalled.reminder', 'm', 'uninstalled', 'x', 'rec_1', 'email', ?, 'person', ?,
         ?, 'record', ?, 0, 'waiting', 'Hi', 'Hello', ?, ?, ?)`,
    )
      .bind(id, address, address, m.personId, id, action, now, now)
      .run();
    // The kind is gone and the address is not suppressed: nothing to stop it.
    expect(await stopHeldRoutineMessage(db.query, action, now)).toBeNull();
    await suppress(
      db.query,
      "email",
      await addressHash(db.query, address),
      "provider_unsubscribed",
      now,
    );
    expect(await stopHeldRoutineMessage(db.query, action, now)).toBe(
      "the address asked not to be sent to",
    );
    const row = await env.DB.prepare("SELECT status, body FROM core_routine_mail WHERE id = ?")
      .bind(id)
      .first();
    expect(row).toEqual({ status: "stopped", body: null });
  });
});

describe("Contact preferences in My account", () => {
  it("lists each kind on its channels, the essential email fixed, and a child's without news and offers", async () => {
    const m = await member("prefs");
    const kid = await child(m.personId);
    const { people } = await run<{
      people: {
        personId: string;
        self: boolean;
        child: boolean;
        lines: { scope: string; channels: { channel: string; value: string; fixed: boolean }[] }[];
      }[];
    }>("me.contact.choices", {}, outside(m));
    expect(people.map((p) => [p.personId, p.self, p.child])).toEqual([
      [m.personId, true, false],
      [kid, false, true],
    ]);
    const mine = people[0]?.lines ?? [];
    expect(mine.find((l) => l.scope === ESSENTIAL)?.channels).toEqual([
      expect.objectContaining({ channel: "email", value: "on", fixed: true }),
      expect.objectContaining({ channel: "text", value: "on", fixed: false }),
    ]);
    expect(mine.find((l) => l.scope === "news_and_offers")?.channels[0]).toMatchObject({
      value: "no",
    });
    expect(people[1]?.lines.some((l) => l.scope === "news_and_offers")).toBe(false);
    // An essential kind's email cannot be turned off.
    const refused = await refusal(
      run(
        "me.contact.setChoices",
        { choices: [{ scope: ESSENTIAL, channel: "email", value: "off" }] },
        outside(m),
      ),
    );
    expect(refused?.code).toBe("invalid_input");
    // Someone else's Person is not theirs to change.
    const stranger = await member("stranger");
    const notTheirs = await refusal(
      run(
        "me.contact.setChoices",
        {
          personId: stranger.personId,
          choices: [{ scope: OPTIONAL, channel: "text", value: "off" }],
        },
        outside(m),
      ),
    );
    expect(notTheirs?.code).toBe("not_found");
  });
});

describe("no AI actor writes the register", () => {
  it("person.contact.record is a person's only; the customer operations are not staff calls", async () => {
    const m = await member("ai");
    for (const actor of ["assistant", "mcp"] as const) {
      const refused = await refusal(
        run(
          "person.contact.record",
          {
            personId: m.personId,
            choices: [{ scope: "news_and_offers", channel: "email", value: "yes" }],
            how: "staff_on_request",
            reason: "They asked",
            wording: "Yes.",
          },
          context(admin, {
            actor,
            origin:
              actor === "mcp"
                ? { surface: "mcp", sessionId: unique("s"), clientName: "Bot" }
                : { surface: "assistant" },
          }),
        ),
      );
      expect(refused?.code, actor).toBe("forbidden");
      // Inputs each would take from the member or the public: a staff caller (an AI's included)
      // is answered as for an operation that does not exist, before the input is looked at.
      const valid: Record<string, unknown> = {
        "me.contact.setChoices": {
          choices: [{ scope: "news_and_offers", channel: "email", value: "yes" }],
          wording: "Yes.",
        },
        "contact.stop": {
          token: await stopToken(db.query, {
            person: m.personId,
            channel: "email",
            scope: OPTIONAL,
          }),
        },
      };
      for (const [name, input] of Object.entries(valid)) {
        const closed = await refusal(run(name, input, context(admin, { actor })));
        expect(closed?.code, `${name} for ${actor}`).toBe("unknown_operation");
      }
    }
    expect((await choicesInForce(db.query, [m.personId])).get(m.personId)).toBeUndefined();
  });

  it("a person records a member's yes from paper, with why and the words", async () => {
    const m = await member("paper");
    await run(
      "person.contact.record",
      {
        personId: m.personId,
        choices: [{ scope: "news_and_offers", channel: "email", value: "yes" }],
        how: "staff_from_paper",
        reason: "Joining form, signed",
        wording: "Send me news and offers by email.",
      },
      context(admin),
    );
    const view = await run<{ history: { how: string; by: string; reason: string }[] }>(
      "contact.forPerson",
      { personId: m.personId },
      context(admin),
    );
    expect(view.history).toEqual([
      expect.objectContaining({
        how: "staff_from_paper",
        by: admin.id,
        reason: "Joining form, signed",
        wording: "Send me news and offers by email.",
      }),
    ]);
  });
});

describe("merge and erase", () => {
  /** Merges `merged` into `survivor` (the duplicate's account goes first: two would refuse it). */
  const merge = async (
    survivor: { personId: string },
    merged: typeof survivor & { customerId: string },
  ) => {
    await env.DB.prepare("DELETE FROM core_customer WHERE id = ?").bind(merged.customerId).run();
    await run(
      "person.merge",
      { survivorId: survivor.personId, mergedId: merged.personId },
      context(admin),
    );
  };
  const staffLift = (personId: string) =>
    refusal(
      run(
        "person.contact.record",
        {
          personId,
          choices: [{ scope: OPTIONAL, channel: "email", value: "on" }],
          how: "staff_on_request",
          reason: "Asked at the desk",
        },
        context(admin),
      ),
    );

  it("a stop on the duplicate stays a stop the survivor's later choices do not undo (B1)", async () => {
    // The duplicate tapped the stop; later the survivor turned the kind off, then on again.
    const survivor = await member("b1a-s");
    const merged = await member("b1a-m");
    const token = await stopToken(db.query, {
      person: merged.personId,
      channel: "email",
      scope: OPTIONAL,
    });
    await run("contact.stop", { token }, outside(PUBLIC));
    for (const value of ["off", "on"] as const) {
      await run(
        "me.contact.setChoices",
        { choices: [{ scope: OPTIONAL, channel: "email", value }] },
        outside(survivor),
      );
    }
    await merge(survivor, merged);
    expect(await ask(survivor.personId, "email", "account", OPTIONAL)).toMatchObject({
      send: false,
      reason: "stopped",
    });
    // Still the member's alone to lift.
    expect((await staffLift(survivor.personId))?.code).toBe("forbidden");
  });

  it("a stop on one side and a later member's off on the other is still a stop (B1)", async () => {
    const survivor = await member("b1b-s");
    const merged = await member("b1b-m");
    await run(
      "contact.stop",
      {
        token: await stopToken(db.query, {
          person: survivor.personId,
          channel: "email",
          scope: OPTIONAL,
        }),
      },
      outside(PUBLIC),
    );
    await run(
      "me.contact.setChoices",
      { choices: [{ scope: OPTIONAL, channel: "email", value: "off" }] },
      outside(merged),
    );
    await merge(survivor, merged);
    expect(await ask(survivor.personId, "email", "account", OPTIONAL)).toMatchObject({
      send: false,
      reason: "stopped",
    });
    expect((await staffLift(survivor.personId))?.code).toBe("forbidden");
  });

  it("a stop link of the merged-away Person stops the survivor; one of a Person in the Trash does nothing (B2)", async () => {
    const survivor = await member("b2-s");
    const merged = await member("b2-m");
    const token = await stopToken(db.query, {
      person: merged.personId,
      channel: "email",
      scope: OPTIONAL,
    });
    await merge(survivor, merged);
    await run("contact.stop", { token }, outside(PUBLIC));
    expect(await ask(survivor.personId, "email", "account", OPTIONAL)).toMatchObject({
      send: false,
      reason: "stopped",
    });
    const onMerged = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_contact_choice WHERE person_id = ?",
    )
      .bind(merged.personId)
      .first<{ n: number }>();
    expect(onMerged?.n).toBe(0);
    // A token whose row still names the merged Person (made before the move, say) follows the
    // merge too.
    const late = await stopToken(db.query, {
      person: merged.personId,
      channel: "email",
      scope: "follow_up",
    });
    await run("contact.stop", { token: late }, outside(PUBLIC));
    expect(await ask(survivor.personId, "email", "follow_up", FOLLOW_UP)).toMatchObject({
      send: false,
      reason: "stopped",
    });
    // In the Trash and not merged: nothing is written.
    const trashed = await member("b2-trash");
    const trashedToken = await stopToken(db.query, {
      person: trashed.personId,
      channel: "email",
      scope: OPTIONAL,
    });
    await run("person.delete", { id: trashed.personId }, context(admin));
    expect(await run("contact.stop", { token: trashedToken }, outside(PUBLIC))).toEqual({
      done: true,
    });
    const onTrashed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_contact_choice WHERE person_id = ?",
    )
      .bind(trashed.personId)
      .first<{ n: number }>();
    expect(onTrashed?.n).toBe(0);
  });

  it("the register refuses a rewrite, a move to anyone but the merged-into Person, and a delete (F4)", async () => {
    const a = await member("f4-a");
    const b = await member("f4-b");
    await run(
      "contact.stop",
      {
        token: await stopToken(db.query, {
          person: a.personId,
          channel: "email",
          scope: OPTIONAL,
        }),
      },
      outside(PUBLIC),
    );
    const attempts = [
      env.DB.prepare("UPDATE core_contact_choice SET value = 'on' WHERE person_id = ?").bind(
        a.personId,
      ),
      env.DB.prepare("UPDATE core_contact_choice SET person_id = ? WHERE person_id = ?").bind(
        b.personId,
        a.personId,
      ),
      env.DB.prepare("DELETE FROM core_contact_choice WHERE person_id = ?").bind(a.personId),
    ];
    for (const attempt of attempts) {
      await expect(attempt.run()).rejects.toThrow(/core_contact_choice_append_only/);
    }
    expect(await ask(a.personId, "email", "account", OPTIONAL)).toMatchObject({
      send: false,
      reason: "stopped",
    });
  });

  it("a merge keeps the later choice, and a stop on either side", async () => {
    const survivor = await member("merge-s");
    const merged = await member("merge-m");
    // The duplicate stopped reminders by email; the survivor turned them on later.
    await run(
      "contact.stop",
      {
        token: await stopToken(db.query, {
          person: merged.personId,
          channel: "email",
          scope: OPTIONAL,
        }),
      },
      outside(PUBLIC),
    );
    await run(
      "me.contact.setChoices",
      { choices: [{ scope: OPTIONAL, channel: "text", value: "off" }] },
      outside(survivor),
    );
    // Accounts on both would refuse the merge: the duplicate's goes first.
    await env.DB.prepare("DELETE FROM core_customer WHERE id = ?").bind(merged.customerId).run();
    await run(
      "person.merge",
      { survivorId: survivor.personId, mergedId: merged.personId },
      context(admin),
    );
    expect(await ask(survivor.personId, "email", "account", OPTIONAL)).toMatchObject({
      send: false,
      reason: "stopped",
    });
    expect(await ask(survivor.personId, "text", "account", OPTIONAL)).toMatchObject({
      send: false,
      reason: "off",
    });
  });

  it("erase deletes a Person's choices; a number's STOP stays as a hash", async () => {
    const m = await member("erase");
    await run(
      "me.contact.setChoices",
      { choices: [{ scope: OPTIONAL, channel: "text", value: "off" }] },
      outside(m),
    );
    const hash = await saltedHash(db.query, `+6140${Date.now() % 10_000_000}`);
    await env.DB.prepare(
      "INSERT INTO core_contact_suppression (channel, value_hash, how, at) VALUES ('text', ?, 'stop_reply', ?)",
    )
      .bind(hash, new Date().toISOString())
      .run();
    const token = await stopToken(db.query, {
      person: m.personId,
      channel: "email",
      scope: OPTIONAL,
    });
    await run("person.erase", { id: m.personId }, context(admin));
    for (const table of ["core_contact_choice", "core_contact_stop_token"]) {
      const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE person_id = ?`)
        .bind(m.personId)
        .first<{ n: number }>();
      expect(left?.n, table).toBe(0);
    }
    const kept = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_contact_suppression WHERE value_hash = ?",
    )
      .bind(hash)
      .first<{ n: number }>();
    expect(kept?.n).toBe(1);
    // A stop link of someone erased does nothing, and fails nothing.
    expect(await run("contact.stop", { token }, outside(PUBLIC))).toEqual({ done: true });
  });
});
