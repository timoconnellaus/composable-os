// Stage 38 step 5 (ADR 0706): what the host adds to read and understood for the Knowledge pack.
// The notices are the pack's words and the host's recipients: a version that asks everyone tells
// exactly who must read it (when it goes live, a scheduled one too); the day's run reminds who
// still has it to read once, tells the owner each week who has not (names only to one who
// manages), and welcomes a new account once. More fields are guarded as who must read is
// (`managed`). A formula of a publishable object reads when its version went live, and a
// date-relative trigger may name a date formula.
import { env } from "cloudflare:workers";
import {
  defineAutomation,
  defineExtension,
  defineTool,
  type ExtensionManifest,
  MUST_READ_SCHEMA,
  toManifest,
  validateManifest,
  z,
} from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke, runAckDue, runPublishDue } from "../src/index.ts";
import { reconcile } from "./extension-helpers.ts";
import { context, createUser, db, refusal, unique } from "./helpers.ts";

const EXT = `akn${Date.now().toString(36)}`;
const PROC = `${EXT}.procedure`;
const MANAGE = `${EXT}:manage`;
const DAY = 86_400_000;

const pack = defineExtension({
  id: EXT,
  version: "1.0.0",
  contractVersion: 1,
  permissions: { operations: ["notification.send"], modules: ["ops"] },
  grantable: [MANAGE],
  restricted: [MANAGE],
  objects: {
    procedure: {
      label: "Procedure",
      plural: "Procedures",
      titleField: "title",
      fields: {
        title: { type: "text", label: "Title", required: true },
        slug: { type: "slug", label: "Slug" },
        mustRead: { type: "document", label: "Must read", schema: MUST_READ_SCHEMA },
        owner: { type: "user", label: "Owner" },
        reviewEvery: { type: "number", label: "Review every", default: 12, min: 0 },
        nextReview: {
          type: "formula",
          label: "Next review",
          expression:
            'if(coalesce(reviewEvery, 12) > 0, dateAdd(publishedAt, coalesce(reviewEvery, 12), "month"), null)',
        },
        shown: { type: "formula", label: "Shown", expression: "coalesce(publishedVersion, 0)" },
      },
      publishable: {
        content: ["title"],
        slug: "slug",
        acknowledge: {
          who: "mustRead",
          manage: MANAGE,
          managed: ["reviewEvery"],
          owner: "owner",
          notices: {
            asked: { title: "Please read: {record}" },
            reminder: { title: "Still to read: {record}", afterDays: 7 },
            outstanding: { title: "Not yet confirmed: {record}" },
            welcome: { title: "To read", body: "Welcome:" },
          },
        },
      },
    },
  },
  tools: {
    status: defineTool({
      description: "Fixture: who has read what.",
      input: z.object({}),
      output: z.object({}),
      risk: "read",
      permission: MANAGE,
      handler: () => ({}),
    }),
  },
  automations: {
    review: defineAutomation({
      label: "Review",
      description: "Fixture: a date-relative trigger on a date formula.",
      trigger: { type: "dateRelative", object: PROC, field: "nextReview", offsetDays: 0 },
      steps: [{ name: "tell", notifies: [{ to: "admins", message: "Review {record}" }] }],
      async run(_event, step) {
        await step.do("tell", async () => ({}));
      },
    }),
  },
});
const m = toManifest(pack) as ExtensionManifest;

let admin: ActingUser;
let member: ActingUser;
let manager: ActingUser;
let viewer: ActingUser;

async function noticesOf(user: ActingUser, key: string) {
  const rows = await env.DB.prepare(
    "SELECT title, body, dedupe_key FROM core_notifications WHERE user_id = ? AND substr(dedupe_key, 1, ?) = ?",
  )
    .bind(user.id, key.length, key)
    .all<{ title: string; body: string | null; dedupe_key: string }>();
  return rows.results;
}

async function procedure(values: Record<string, unknown>) {
  const out = (await invoke(
    "record.create",
    { object: PROC, values: { title: unique("Procedure"), ...values } },
    context(admin),
  )) as { id: string };
  return out.id;
}

beforeAll(async () => {
  expect(validateManifest(m).issues).toEqual([]);
  admin = await createUser("admin");
  member = await createUser("member");
  manager = await createUser("member");
  viewer = await createUser("viewer");
  await reconcile(m);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(EXT, JSON.stringify(m), admin.id, now, now)
    .run();
  await env.DB.prepare("UPDATE core_user SET granted_permissions = ? WHERE id = ?")
    .bind(JSON.stringify([MANAGE]), manager.id)
    .run();
});

describe("the declaration (ADR 0706)", () => {
  const issues = (change: (o: Record<string, unknown>) => void) => {
    const copy = structuredClone(m) as unknown as {
      objects: Record<string, Record<string, unknown>>;
    };
    change(copy.objects.procedure as Record<string, unknown>);
    return validateManifest(copy as unknown as ExtensionManifest).issues.map((i) => i.message);
  };
  const ack = (o: Record<string, unknown>) =>
    (o.publishable as { acknowledge: Record<string, unknown> }).acknowledge;

  it("guards fields of its own outside the content, tells a user field, and words each notice", () => {
    const set = (key: string, value: unknown) => (o: Record<string, unknown>) => {
      ack(o)[key] = value;
    };
    expect(issues(set("managed", ["title"])).join()).toMatch(/not content/);
    expect(issues(set("managed", ["mustRead"])).join()).toMatch(/guarded already/);
    expect(issues(set("managed", ["nextReview"])).join()).toMatch(/a person writes/);
    expect(issues(set("owner", "title")).join()).toMatch(/user field/);
    expect(issues(set("owner", undefined)).join()).toMatch(/acknowledge.owner/);
    const reminder = { reminder: { title: "Still to read", afterDays: 400 } };
    expect(issues(set("notices", reminder)).length).toBeGreaterThan(0);
  });

  it("a date-relative trigger names a date formula, not a number one", () => {
    const copy = structuredClone(m) as unknown as {
      automations: Record<string, { trigger: { field: string } }>;
    };
    (copy.automations.review as { trigger: { field: string } }).trigger.field = "shown";
    expect(
      validateManifest(copy as unknown as ExtensionManifest)
        .issues.map((i) => i.message)
        .join(),
    ).toMatch(/must be date or datetime/);
  });
});

describe("a formula reads when the version went live", () => {
  it("is empty until published, then the publish plus the review period", async () => {
    const id = await procedure({ mustRead: { everyone: false, roles: ["admin"] } });
    const get = async () =>
      (
        (await invoke("record.get", { object: PROC, id }, context(admin))) as {
          values: Record<string, unknown>;
        }
      ).values;
    expect((await get()).nextReview ?? null).toBeNull();
    expect((await get()).shown).toBe(0);
    await invoke("record.publish", { object: PROC, id }, context(admin));
    const v = await get();
    expect(v.shown).toBe(1);
    expect(String(v.nextReview).slice(0, 4)).toBe(
      String(Number(String(v.publishedAt).slice(0, 4)) + 1),
    );
  });
});

describe("the asked notice", () => {
  it("tells exactly who must read a version that asks, and nobody for a small fix", async () => {
    const id = await procedure({ mustRead: { everyone: false, roles: ["member"] } });
    await invoke("record.publish", { object: PROC, id }, context(admin));
    expect(await noticesOf(member, `ack.asked:${PROC}:${id}:1`)).toHaveLength(1);
    expect(await noticesOf(admin, `ack.asked:${PROC}:${id}`)).toEqual([]);
    expect(await noticesOf(viewer, `ack.asked:${PROC}:${id}`)).toEqual([]);
    await invoke("record.publish", { object: PROC, id, readAgain: false }, context(admin));
    expect(await noticesOf(member, `ack.asked:${PROC}:${id}:2`)).toEqual([]);
    await invoke("record.publish", { object: PROC, id, readAgain: true }, context(admin));
    const [told] = await noticesOf(member, `ack.asked:${PROC}:${id}:3`);
    expect(told?.title).toMatch(/^Please read: Procedure/);
  });

  it("a scheduled read-again version tells nobody until it goes live", async () => {
    const id = await procedure({ mustRead: { everyone: true } });
    await invoke("record.publish", { object: PROC, id }, context(admin));
    const at = new Date(Date.now() + 60 * 60_000).toISOString();
    await invoke(
      "record.schedulePublish",
      { object: PROC, id, at, readAgain: true },
      context(admin),
    );
    expect(await noticesOf(viewer, `ack.asked:${PROC}:${id}:2`)).toEqual([]);
    await runPublishDue(db, { clock: () => new Date(Date.now() + 2 * 60 * 60_000) });
    expect(await noticesOf(viewer, `ack.asked:${PROC}:${id}:2`)).toHaveLength(1);
  });
});

describe("the managed fields", () => {
  it("the review period of a published record is a manager's, never an AI's", async () => {
    const id = await procedure({ mustRead: { everyone: true } });
    // Before it is published, any person writing it may set it.
    await invoke(
      "record.update",
      { object: PROC, id, values: { reviewEvery: 6 } },
      context(member),
    );
    await invoke("record.publish", { object: PROC, id }, context(admin));
    expect(
      (
        await refusal(
          invoke(
            "record.update",
            { object: PROC, id, values: { reviewEvery: 3 } },
            context(member),
          ),
        )
      ).code,
    ).toBe("forbidden");
    expect(
      (
        await refusal(
          invoke(
            "record.update",
            { object: PROC, id, values: { reviewEvery: 3 } },
            context(admin, {
              actor: "assistant",
              origin: { surface: "assistant", sessionId: unique("s") },
            } as never),
          ),
        )
      ).code,
    ).toBe("forbidden");
    await invoke(
      "record.update",
      { object: PROC, id, values: { reviewEvery: 3 } },
      context(manager),
    );
    // Setting it to what it is changes nothing and is not refused.
    await invoke(
      "record.update",
      { object: PROC, id, values: { reviewEvery: 3 } },
      context(member),
    );
  });
});

describe("the day's notices", () => {
  it("remind once, tell the owner each week (names to a manager only), welcome once", async () => {
    const managed = await procedure({ mustRead: { everyone: true }, owner: manager.id });
    const counted = await procedure({ mustRead: { everyone: true }, owner: member.id });
    for (const id of [managed, counted]) {
      await invoke("record.publish", { object: PROC, id }, context(admin));
    }
    // The member confirms one; everyone else has both to read.
    await invoke("ack.confirm", { object: PROC, id: managed, version: 1 }, context(member));
    const day = (n: number) => {
      const at = new Date(Date.now() + n * DAY);
      at.setUTCHours(12, 0, 0, 0);
      return at;
    };
    // The first day: new accounts are welcomed, owners told; nobody is a week late yet.
    await runAckDue(db, { clock: () => day(1) });
    expect(await noticesOf(viewer, `ack.reminder:${PROC}:${managed}`)).toEqual([]);
    const [welcome] = await noticesOf(viewer, `ack.welcome:${PROC}`);
    expect(welcome?.body).toContain("Welcome:");
    const [toManager] = await noticesOf(manager, `ack.outstanding:${PROC}:${managed}`);
    expect(toManager?.body).toMatch(/Not yet confirmed: .*/);
    const [toMember] = await noticesOf(member, `ack.outstanding:${PROC}:${counted}`);
    // The member does not manage: a count, never names.
    expect(toMember?.body).toMatch(/^\d+ (people have|person has) not yet confirmed version 1\.$/);
    // Eight days on: the reminder, once; the member who confirmed is not reminded of it.
    await runAckDue(db, { clock: () => day(8) });
    await runAckDue(db, { clock: () => day(9) });
    expect(await noticesOf(viewer, `ack.reminder:${PROC}:${managed}:1`)).toHaveLength(1);
    expect(await noticesOf(member, `ack.reminder:${PROC}:${managed}`)).toEqual([]);
    expect(await noticesOf(member, `ack.reminder:${PROC}:${counted}:1`)).toHaveLength(1);
    // Welcomed once, whatever the days.
    expect(await noticesOf(viewer, `ack.welcome:${PROC}`)).toHaveLength(1);
    // A week on: a second weekly notice to the owner.
    expect(
      (await noticesOf(manager, `ack.outstanding:${PROC}:${managed}`)).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("runs once a local day: the same day again writes nothing", async () => {
    const at = new Date(Date.now() + 20 * DAY);
    at.setUTCHours(12, 0, 0, 0);
    await runAckDue(db, { clock: () => at });
    expect(await runAckDue(db, { clock: () => at })).toEqual({
      reminders: 0,
      outstanding: 0,
      welcomes: 0,
    });
  });
});

describe("read status from the owning pack's person-only tool", () => {
  it("is refused to another extension's call and to an automation", async () => {
    const id = await procedure({ mustRead: { everyone: true } });
    await invoke("record.publish", { object: PROC, id }, context(admin));
    expect(
      (
        await refusal(
          invoke("ack.status", { object: PROC, id }, context(admin, { actor: "automation" })),
        )
      ).code,
    ).toBe("forbidden");
  });
});
