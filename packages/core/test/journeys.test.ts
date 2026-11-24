// Stage 53 step 3 (ADR 0800): journeys, versions, publish, preview, entries and the starter drafts,
// against the real D1 binding. A version is never changed; only a person publishes, an AI's publish
// is a request only a person with journeys:publish approves (never the adjudicator); the reply-to
// is an address an admin allowed; the words follow routine mail's rules; going live and resuming
// are a person's; a manual entry of 500 people runs in a handful of statements. Nothing sends.
// The words here are fixture text.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type AdjudicatorDeps,
  adjudicatePendingAction,
  coreRegistry,
  type InvocationContext,
  invoke,
  type ModelRunner,
  type PendingApproval,
  PendingApprovalError,
} from "../src/index.ts";
import { journeyProblems, parseDefinition } from "../src/journeys/index.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;
let viewer: ActingUser;
let publisher: ActingUser;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

async function queued(promise: Promise<unknown>): Promise<PendingApproval> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PendingApprovalError);
  return (error as PendingApprovalError).pending;
}

const assistant = (user: ActingUser = admin, extra: Partial<InvocationContext> = {}) =>
  context(user, {
    actor: "assistant",
    origin: { surface: "assistant", sessionId: `ath_${unique()}` },
    ...extra,
  });

const welcome = (replyTo: string | null, overrides: Record<string, unknown> = {}) =>
  ({
    entry: { type: "signal", signal: "memberships.started" },
    exits: ["memberships.ended"],
    reentry: { rule: "once" },
    replyTo,
    steps: [
      {
        id: "day0",
        type: "send",
        channel: "email",
        subject: "Welcome to {business}",
        body: "Hi {firstName},\n\nWelcome. Book your first class on {site:/classes}.\n\n{unsubscribe}",
      },
      { id: "wait3", type: "wait", days: 3 },
      {
        id: "day3",
        type: "send",
        channel: "email",
        subject: "Your first week",
        body: "Hi {firstName}, how is it going?\n\n{unsubscribe}",
      },
      { id: "wait7", type: "wait", days: 7 },
      {
        id: "day10",
        type: "send",
        channel: "email",
        subject: "Ten days in",
        body: "Hi {firstName}, keep going.\n\n{unsubscribe}",
      },
      { id: "end", type: "end" },
    ],
    ...overrides,
  }) as never; // Fixture JSON: the operation's schema checks it, as it would a client's.

async function createPerson(givenName: string | null = "Robin") {
  const out = await invoke(
    "person.create",
    givenName ? { givenName, familyName: unique("F") } : { displayName: unique("Nameless") },
    context(admin),
  );
  return (out as { id: string }).id;
}

/** A journey with a publishable working copy, by `by`. */
async function draftJourney(
  kind: "service" | "promotional" = "service",
  overrides: Record<string, unknown> = {},
) {
  const { id } = await invoke(
    "journey.create",
    { name: unique("Welcome"), kind, definition: welcome(admin.email, overrides) },
    context(admin),
  );
  return id;
}

async function publish(id: string, user = publisher) {
  const preview = await invoke("journey.preview", { id }, context(user));
  expect(preview.problems).toEqual([]);
  return invoke(
    "journey.publish",
    {
      id,
      draftHash: preview.draftHash as string,
      draftRev: preview.draftRev as number,
      number: preview.number,
    },
    context(user),
  );
}

async function liveJourney(kind: "service" | "promotional" = "service", overrides = {}) {
  const id = await draftJourney(kind, overrides);
  await publish(id);
  await invoke("journey.goLive", { id }, context(admin));
  return id;
}

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  viewer = await createUser("viewer");
  publisher = await createUser("member");
  await invoke(
    "user.setPermissions",
    { id: publisher.id, permissions: ["journeys:publish", "journeys:manage"] },
    context(admin),
  );
  await invoke("journey.settings.update", { replyToUserIds: [admin.id] }, context(admin));
  await env.DB.prepare(
    "INSERT OR REPLACE INTO core_settings (key, value, updated_at) VALUES ('routine_mail', ?, ?)",
  )
    .bind(JSON.stringify({ siteOrigin: "https://gym.example" }), new Date().toISOString())
    .run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO core_settings (key, value, updated_at) VALUES ('org_name', ?, ?)",
  )
    .bind(JSON.stringify("Fixture Gym"), new Date().toISOString())
    .run();
  await setPreset("balanced");
}, 60_000);

describe("the starter journeys (criterion 19)", () => {
  it("are four drafts, never live, that cannot be published until a person chooses a reply-to", async () => {
    const { items } = await invoke("journey.list", {}, context(member));
    const starters = items.filter((j) => j.starter);
    expect(starters.map((j) => j.starter).sort()).toEqual([
      "not_seen",
      "trial_ended",
      "welcome",
      "win_back",
    ]);
    for (const starter of starters) {
      expect(starter).toMatchObject({ status: "draft", current: null });
      const got = await invoke("journey.get", { id: starter.id }, context(member));
      // Everything but the reply-to (and, where a task goes to the owner, the owner) is ready.
      expect(got.problems.map((p) => p.path).sort()).toEqual(
        starter.starter === "not_seen" ? ["ownerId", "replyTo"] : ["replyTo"],
      );
      const definition = parseDefinition(JSON.stringify(got.draft));
      if (!definition) throw new Error(`${starter.starter} does not parse`);
      expect(
        journeyProblems(definition, starter.kind, { allowedReplyTo: [] }).map((p) => p.path),
      ).toEqual(["replyTo"]);
      expect(
        (await refusal(invoke("journey.goLive", { id: starter.id }, context(admin)))).details,
      ).toMatchObject({ rule: "journey_unpublished" });
    }
    const winBack = starters.find((j) => j.starter === "win_back");
    expect(winBack?.kind).toBe("promotional");
  });
});

describe("the working copy's checks", () => {
  const send = (body: string, extra: Record<string, unknown> = {}) => ({
    steps: [
      { id: "a", type: "send", channel: "email", subject: "Hello {firstName}", body, ...extra },
      { id: "end", type: "end" },
    ],
  });
  const problems = async (
    overrides: Record<string, unknown>,
    kind: "service" | "promotional" = "service",
  ) => {
    const id = await draftJourney(kind, overrides);
    return (await invoke("journey.get", { id }, context(admin))).problems.map((p) => p.message);
  };

  it("needs the unsubscribe slot once in every body", async () => {
    expect((await problems(send("Hi there"))).join()).toMatch(/unsubscribe/);
    expect(await problems(send("Hi there\n{unsubscribe}"))).toEqual([]);
  });

  it("refuses typed links, addresses, phone numbers and slots not on the list", async () => {
    for (const body of [
      "See gymhelp.com now {unsubscribe}",
      "Write to desk@gym.example {unsubscribe}",
      "Call us on 0400 000 000 {unsubscribe}",
      "Hi {lastName} {unsubscribe}",
      "Go to {site:https://elsewhere.example} {unsubscribe}",
    ]) {
      expect((await problems(send(body))).length, body).toBeGreaterThan(0);
    }
    expect(await problems(send("Book on {site:/classes/today}\n{unsubscribe}"))).toEqual([]);
  });

  it("refuses a loop, a branch to nowhere and more than 8 messages", async () => {
    const loop = {
      steps: [
        { id: "a", type: "send", channel: "email", subject: "S", body: "B {unsubscribe}" },
        { id: "w", type: "wait", days: 1 },
        {
          id: "b",
          type: "branch",
          condition: { test: "liveMembership" },
          goTo: "a",
          otherwise: "nope",
        },
        { id: "end", type: "end" },
      ],
    };
    const messages = (await problems(loop)).join("\n");
    expect(messages).toMatch(/never loops/);
    expect(messages).toMatch(/not a step/);
    const many = {
      steps: [
        ...Array.from({ length: 9 }, (_, i) => ({
          id: `s${i}`,
          type: "send",
          channel: "email",
          subject: "S",
          body: "B {unsubscribe}",
        })),
        { id: "end", type: "end" },
      ],
    };
    expect((await problems(many)).join()).toMatch(/At most 8 messages/);
  });

  it("gives a promotional journey no guardian's version", async () => {
    const withGuardian = send("B {unsubscribe}", {
      guardian: {
        subject: "About {member}",
        body: "Hi {firstName}, about {member}. {unsubscribe}",
      },
    });
    expect(await problems(withGuardian)).toEqual([]);
    expect((await problems(withGuardian, "promotional")).join()).toMatch(
      /never sent about a child/,
    );
  });
});

describe("the reply-to (criterion 17)", () => {
  it("is only an address a human admin allowed, and only a person changes the list", async () => {
    const outside = await refusal(
      invoke(
        "journey.create",
        { name: unique("J"), kind: "service", definition: welcome("someone@elsewhere.example") },
        context(admin),
      ),
    );
    expect(outside.details).toMatchObject({ rule: "journey_reply_to" });
    // The member's own address, until an admin allows it.
    expect(
      (
        await refusal(
          invoke(
            "journey.create",
            { name: unique("J"), kind: "service", definition: welcome(member.email) },
            context(admin),
          ),
        )
      ).details,
    ).toMatchObject({ rule: "journey_reply_to" });
    const refused = await refusal(
      invoke("journey.settings.update", { replyToUserIds: [admin.id, member.id] }, assistant()),
    );
    expect(refused.code).toBe("forbidden");
    expect(
      (await refusal(invoke("journey.settings.update", { sendOnOwn: true }, context(member)))).code,
    ).toBe("forbidden");
    const settings = await invoke("journey.settings", {}, context(member));
    expect(settings).toMatchObject({ sendOnOwn: false, weekCap: 3, dayCap: 1 });
    expect(settings.replyTo.map((r) => r.address)).toEqual([admin.email.toLowerCase()]);
  });
});

describe("publishing (criterion 6)", () => {
  it("makes a version nobody can change, from exactly the reviewed copy, by a person", async () => {
    const id = await draftJourney();
    const out = await publish(id);
    expect(out.version).toMatchObject({
      number: 1,
      publishedBy: publisher.id,
      requestedBy: null,
      draftedBy: "person",
      intact: true,
    });
    expect(out.version.summary).toMatch(/Starts when a Person gets memberships.started/);
    for (const statement of [
      "UPDATE core_journey_version SET summary = 'x' WHERE id = ?",
      "DELETE FROM core_journey_version WHERE id = ?",
    ]) {
      await expect(env.DB.prepare(statement).bind(out.version.id).run()).rejects.toThrow(
        /core_journey_version_immutable/,
      );
    }
    // Nothing changed: nothing to publish.
    expect((await refusal(publish(id))).details).toMatchObject({ rule: "journey_unchanged" });
    // A copy changed after the preview is refused.
    const preview = await invoke("journey.preview", { id }, context(publisher));
    await invoke(
      "journey.update",
      { id, definition: welcome(admin.email, { includeBulk: true }) },
      context(admin),
    );
    expect(
      (
        await refusal(
          invoke(
            "journey.publish",
            {
              id,
              draftHash: preview.draftHash as string,
              draftRev: preview.draftRev as number,
              number: preview.number,
            },
            context(publisher),
          ),
        )
      ).details,
    ).toMatchObject({ rule: "journey_draft_changed" });
    // A version made by raw SQL from anything but the working copy is refused by the database.
    await expect(
      env.DB.prepare(
        `INSERT INTO core_journey_version (id, journey_id, number, definition, summary, hash,
          draft_rev, drafted_by, published_at, published_by)
         VALUES (?, ?, 2, '{}', 's', ?, 1, 'person', ?, ?)`,
      )
        .bind(`jnv_${unique()}`, id, "0".repeat(64), new Date().toISOString(), admin.id)
        .run(),
    ).rejects.toThrow(/core_journey_draft_changed/);
  });

  it("needs journeys:publish: a member without it is refused", async () => {
    const id = await draftJourney();
    expect((await refusal(publish(id, member))).code).toBe("forbidden");
  });

  it("an AI's draft cannot run until a person publishes it; its publish is a request a person with the right approves, never the adjudicator", async () => {
    await setPreset("autonomous");
    const { id } = await invoke(
      "journey.create",
      { name: unique("AI"), kind: "service", definition: welcome(admin.email) },
      assistant(),
    );
    const got = await invoke("journey.get", { id }, context(admin));
    expect(got).toMatchObject({ draftedByAssistant: true, current: null });
    // Not publishable means not runnable: going live needs a version.
    expect((await refusal(invoke("journey.goLive", { id }, context(admin)))).details).toMatchObject(
      { rule: "journey_unpublished" },
    );
    const preview = await invoke("journey.preview", { id }, assistant());
    expect(preview.draftedByAssistant).toBe(true);
    const ask = {
      id,
      draftHash: preview.draftHash as string,
      draftRev: preview.draftRev as number,
      number: 1,
    };
    // Even under Autonomous, the assistant's publish waits for a person.
    const asked = await queued(invoke("journey.publish", ask, assistant()));
    expect((await invoke("journey.get", { id }, context(admin))).versions).toEqual([]);

    // The adjudicator, sure and active, never approves it.
    await env.DB.prepare(
      "INSERT OR REPLACE INTO core_settings (key, value, updated_at) VALUES ('adjudicator', ?, ?)",
    )
      .bind(
        JSON.stringify({ mode: "active", threshold: 0.5, enabledAt: "2000-01-01T00:00:00.000Z" }),
        new Date().toISOString(),
      )
      .run();
    const models: ModelRunner = {
      async run() {
        return {
          text: JSON.stringify({ verdict: "approve", confidence: 0.99, reason: "Fine." }),
          model: "fake-reviewer",
          provider: "fake",
        };
      },
    };
    const deps: AdjudicatorDeps = { db, models, resolveOperation: (n) => coreRegistry.get(n) };
    await adjudicatePendingAction(deps, asked.actionId);
    const pending = await env.DB.prepare("SELECT status FROM core_pending_action WHERE id = ?")
      .bind(asked.actionId)
      .first<{ status: string }>();
    expect(pending?.status).toBe("pending");
    await env.DB.prepare("DELETE FROM core_settings WHERE key = 'adjudicator'").run();

    // A member without journeys:publish cannot approve it; the publisher can.
    expect(
      (await refusal(invoke("approval.approve", { actionIds: [asked.actionId] }, context(member))))
        .code,
    ).toBe("forbidden");
    await invoke("approval.approve", { actionIds: [asked.actionId] }, context(publisher));
    const after = await invoke("journey.get", { id }, context(admin));
    expect(after.versions).toHaveLength(1);
    expect(after.versions[0]).toMatchObject({
      number: 1,
      publishedBy: publisher.id,
      requestedBy: admin.id,
      requestedVia: "assistant",
      draftedBy: "assistant",
    });
    expect(after.draftedByAssistant).toBe(false);
    await setPreset("balanced");
  });
});

describe("preview", () => {
  it("fills every message for a sample Person and says what would hold one", async () => {
    const id = await draftJourney();
    const robin = await createPerson("Robin");
    const preview = await invoke("journey.preview", { id, personId: robin }, context(member));
    expect(preview.person?.id).toBe(robin);
    expect(preview.messages.map((m) => m.step)).toEqual(["day0", "day3", "day10"]);
    expect(preview.messages[0]?.member.subject).toBe("Welcome to Fixture Gym");
    expect(preview.messages[0]?.member.body).toContain("Hi Robin,");
    expect(preview.messages[0]?.member.body).toContain("https://gym.example/classes");
    expect(preview.messages[0]?.member.body).toMatch(/Stop these messages/);
    expect(preview.messages[0]?.member.holds).toEqual([]);
    // A first name that is not routine (a link in it), or none at all, holds the message.
    const odd = await createPerson("Visit gymhelp.com");
    const held = await invoke("journey.preview", { id, personId: odd }, context(member));
    expect(held.messages[0]?.member.holds.join()).toMatch(/firstName/);
    const nameless = await createPerson(null);
    const none = await invoke("journey.preview", { id, personId: nameless }, context(member));
    expect(none.messages[0]?.member.holds.join()).toMatch(/no value/);
    // A viewer may not read journeys.
    expect((await refusal(invoke("journey.preview", { id }, context(viewer)))).code).toBe(
      "forbidden",
    );
  });
});

describe("going live, pausing and resuming", () => {
  it("a person sets it live and resumes it; an AI may pause, never set live or resume", async () => {
    const id = await draftJourney();
    await publish(id);
    expect((await refusal(invoke("journey.goLive", { id }, assistant()))).code).toBe("forbidden");
    await invoke("journey.goLive", { id }, context(admin));
    expect((await invoke("journey.pause", { id }, assistant())).status).toBe("paused");
    expect((await refusal(invoke("journey.resume", { id }, assistant()))).code).toBe("forbidden");
    expect((await invoke("journey.resume", { id }, context(admin))).status).toBe("live");
    // The database refuses a journey live without a version, or back to draft.
    const draft = await draftJourney();
    await expect(
      env.DB.prepare("UPDATE core_journey SET status = 'live' WHERE id = ?").bind(draft).run(),
    ).rejects.toThrow(/core_journey_status/);
    await expect(
      env.DB.prepare("UPDATE core_journey SET status = 'draft' WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/core_journey_status/);
  });
});

describe("entries", () => {
  it("adds people by hand, leaving out who may not enter and saying why", async () => {
    const id = await liveJourney("promotional");
    const adult = await createPerson("Adult");
    const child = await createPerson("Child");
    await env.DB.prepare(
      "INSERT INTO core_agreement_minor (person_id, set_by, set_at) VALUES (?, ?, ?)",
    )
      .bind(child, admin.id, new Date().toISOString())
      .run();
    const out = await invoke(
      "journey.enter",
      { id, personIds: [adult, child, "per_missing"] },
      context(admin),
    );
    expect(out.entered.map((e) => e.personId)).toEqual([adult]);
    expect(out.excluded).toEqual(
      expect.arrayContaining([
        { personId: child, why: "minor" },
        { personId: "per_missing", why: "not_found" },
      ]),
    );
    const again = await invoke("journey.enter", { id, personIds: [adult] }, context(admin));
    expect(again.excluded).toEqual([{ personId: adult, why: "already_on" }]);
    const { items } = await invoke("journey.entries", { journeyId: id }, context(member));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      personId: adult,
      state: "active",
      step: "day0",
      versionNumber: 1,
      enteredBy: "person",
      causeStanding: "person",
    });
    const log = await invoke("journey.log", { entryId: items[0]?.id ?? "" }, context(member));
    expect(log.items.map((l) => l.what)).toEqual(["entered"]);
    // A viewer reads a Person's entries, not a journey's.
    expect(
      (await invoke("journey.entries", { personId: adult }, context(viewer))).items,
    ).toHaveLength(1);
    expect(
      (await refusal(invoke("journey.entries", { journeyId: id }, context(viewer)))).code,
    ).toBe("forbidden");
    // Stopped, it may not be entered again: the re-entry rule is "once".
    expect((await invoke("journey.stop", { personId: adult }, assistant())).stopped).toHaveLength(
      1,
    );
    const once = await invoke("journey.enter", { id, personIds: [adult] }, context(admin));
    expect(once.excluded).toEqual([{ personId: adult, why: "once" }]);
  });

  it("an AI's manual entry no person approved is the AI's; one a person approved is the person's", async () => {
    const id = await liveJourney();
    // A few people under Balanced: the gate's bulk threshold lets it through, as the AI's.
    const few = await createPerson("Few");
    await invoke("journey.enter", { id, personIds: [few] }, assistant());
    // Under Cautious it waits for a person; approved, it stands as theirs.
    await setPreset("cautious");
    const someone = await createPerson("Someone");
    const asked = await queued(invoke("journey.enter", { id, personIds: [someone] }, assistant()));
    await invoke("approval.approve", { actionIds: [asked.actionId] }, context(admin));
    await setPreset("balanced");
    const standing = async (personId: string) =>
      (await invoke("journey.entries", { personId }, context(admin))).items[0]?.causeStanding;
    expect(await standing(few)).toBe("ai");
    expect(await standing(someone)).toBe("person");
  });

  it("enters nobody on a journey that is not live, and the database agrees", async () => {
    const id = await draftJourney();
    const someone = await createPerson("Draft");
    expect(
      (await refusal(invoke("journey.enter", { id, personIds: [someone] }, context(admin))))
        .details,
    ).toMatchObject({ rule: "journey_status" });
  });

  it("archiving stops every entry", async () => {
    const id = await liveJourney();
    const someone = await createPerson("Archived");
    await invoke("journey.enter", { id, personIds: [someone] }, context(admin));
    const out = await invoke("journey.archive", { id }, context(admin));
    expect(out.stopped).toBe(1);
    const { items } = await invoke("journey.entries", { personId: someone }, context(admin));
    expect(items[0]).toMatchObject({ state: "stopped", stopReason: "archived" });
    expect(
      (await refusal(invoke("journey.update", { id, name: "Again" }, context(admin)))).details,
    ).toMatchObject({ rule: "journey_archived" });
  });

  it("erase removes a Person's entries and step log", async () => {
    const id = await liveJourney();
    const someone = await createPerson("Erased");
    const { entered } = await invoke("journey.enter", { id, personIds: [someone] }, context(admin));
    await invoke("person.erase", { id: someone }, context(admin));
    const left = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM core_journey_entry WHERE person_id = ?1) AS entries,
        (SELECT COUNT(*) FROM core_journey_step_log WHERE entry_id = ?2) AS log`,
    )
      .bind(someone, entered[0]?.entryId ?? "")
      .first<{ entries: number; log: number }>();
    expect(left).toEqual({ entries: 0, log: 0 });
  });
});

describe("cost (criterion 16): a manual entry of 500 people", () => {
  /** Each statement's bound variables, for one call. */
  let ran: number[] = [];
  const counted = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(inner, name) {
              if (name === "bind") {
                return (...values: unknown[]) => {
                  ran.push(values.length);
                  return inner.bind(...values);
                };
              }
              const value = Reflect.get(inner, name);
              if (typeof value === "function") {
                if (name === "all" || name === "first" || name === "run" || name === "raw") {
                  ran.push(0);
                }
                return value.bind(inner);
              }
              return value;
            },
          });
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  it("runs a handful of statements, each with few bound variables", async () => {
    const id = await liveJourney();
    const now = new Date().toISOString();
    const ids = Array.from({ length: 500 }, () => `per_${unique("bulk")}`);
    for (let i = 0; i < ids.length; i += 50) {
      await env.DB.batch(
        ids
          .slice(i, i + 50)
          .map((pid) =>
            env.DB.prepare(
              "INSERT INTO core_person (id, display_name, name_key, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)",
            ).bind(pid, pid, now, now),
          ),
      );
    }
    ran = [];
    const out = await invoke(
      "journey.enter",
      { id, personIds: ids },
      context(admin, { db: createCrmDb(counted) }),
    );
    expect(out.entered).toHaveLength(500);
    expect(Math.max(...ran)).toBeLessThanOrEqual(100);
    // Reads, the gate and the audit included: far from D1's 1,000 a call.
    expect(ran.length).toBeLessThan(60);
  });
});
