// Stage 38 step 3 (ADR 0702): read and understood. A publishable object that declares
// `acknowledge` asks the staff its "must read" names to confirm the current version with one
// tap. Only the person confirms, only the current version, once; a confirmation is a row nobody
// changes. A read-again version asks everyone again; a small fix keeps their confirmations; the
// first version always asks. Who must read is everyone, or staff roles, pack roles and granted
// pack permissions, checked on the day. Who manages (admins, and a grant of the object's restricted
// permission) reads who has confirmed; no AI actor does, and none confirms, lists or changes who
// must read. An AI's publish request carries a suggestion and the approver chooses.
import { env } from "cloudflare:workers";
import {
  defineExtension,
  defineTool,
  type ExtensionManifest,
  MUST_READ_SCHEMA,
  toManifest,
  validateManifest,
  z,
} from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type Actor,
  coreRegistry,
  invoke,
  PendingApprovalError,
} from "../src/index.ts";
import { reconcile } from "./extension-helpers.ts";
import { context, createUser, setPreset, unique } from "./helpers.ts";

const EXT = `ack${Date.now().toString(36)}`;
const PROC = `${EXT}.procedure`;
const MANAGE = `${EXT}:manage`;
const DESK = `${EXT}:desk`;
const TEAM = `${EXT}.team`;

const pack = defineExtension({
  id: EXT,
  version: "1.0.0",
  contractVersion: 1,
  permissions: { modules: ["ops"] },
  grantable: [MANAGE, DESK],
  restricted: [MANAGE],
  roles: {
    team: {
      label: "Team",
      description: "Fixture: a cleaner's tools only.",
      permissions: [`${EXT}:team`],
      read: [],
    },
  },
  objects: {
    procedure: {
      label: "Procedure",
      plural: "Procedures",
      titleField: "title",
      fields: {
        title: { type: "text", label: "Title", required: true },
        slug: { type: "slug", label: "Slug" },
        body: { type: "richText", label: "Body" },
        mustRead: { type: "document", label: "Must read", schema: MUST_READ_SCHEMA },
      },
      publishable: {
        content: ["title", "body"],
        slug: "slug",
        acknowledge: { who: "mustRead", manage: MANAGE },
      },
    },
    post: {
      label: "Post",
      plural: "Posts",
      titleField: "title",
      fields: { title: { type: "text", label: "Title" } },
      publishable: { content: ["title"] },
    },
  },
  tools: {
    week: defineTool({
      description: "Fixture: the cleaner's own tool.",
      input: z.object({}),
      output: z.object({}),
      risk: "read",
      permission: `${EXT}:team`,
      handler: () => ({}),
    }),
    desk: defineTool({
      description: "Fixture: the front desk's tool.",
      input: z.object({}),
      output: z.object({}),
      risk: "read",
      permission: DESK,
      handler: () => ({}),
    }),
    status: defineTool({
      description: "Fixture: who has read what.",
      input: z.object({}),
      output: z.object({}),
      risk: "read",
      permission: MANAGE,
      handler: () => ({}),
    }),
  },
});
const m = toManifest(pack) as ExtensionManifest;

let admin: ActingUser;
let member: ActingUser;
let viewer: ActingUser;
let cleaner: ActingUser;
let desk: ActingUser;
let manager: ActingUser;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

const as = (user: ActingUser, actor: Actor = "human") =>
  context(user, {
    actor,
    ...(actor === "human"
      ? {}
      : { origin: { surface: actor === "mcp" ? "mcp" : "assistant", sessionId: unique("s") } }),
    ...(actor === "mcp" ? { grantedPermissions: ["records:read", "records:write"] } : {}),
  } as never);

const EVERYONE = { everyone: true };

async function procedure(values: Record<string, unknown>) {
  const out = (await invoke(
    "record.create",
    { object: PROC, values: { mustRead: EVERYONE, ...values } },
    context(admin),
  )) as { id: string };
  return out.id;
}
const publish = (id: string, readAgain?: boolean) =>
  invoke(
    "record.publish",
    { object: PROC, id, ...(readAgain === undefined ? {} : { readAgain }) },
    context(admin),
  ) as Promise<{ version: number; readAgain: boolean | null }>;
const edit = (id: string, title: string) =>
  invoke("record.update", { object: PROC, id, values: { title } }, context(admin));
const confirm = (user: ActingUser, id: string, version: number, actor: Actor = "human") =>
  invoke("ack.confirm", { object: PROC, id, version }, as(user, actor));
interface Mine {
  toRead: { id: string; version: number }[];
  confirmed: { id: string; version: number }[];
}
const mine = async (user: ActingUser) => (await invoke("ack.mine", {}, as(user))) as Mine;
const toRead = async (user: ActingUser, id: string) =>
  (await mine(user)).toRead.some((r) => r.id === id);
interface Status {
  version: number;
  askedVersion: number;
  people: { account: string; confirmed: { version: number } | null; since: string | null }[];
}
const status = (id: string, user = admin) =>
  invoke("ack.status", { object: PROC, id }, as(user)) as Promise<Status>;

beforeAll(async () => {
  expect(validateManifest(m).issues).toEqual([]);
  admin = await createUser("admin");
  member = await createUser("member");
  viewer = await createUser("viewer");
  cleaner = await createUser("viewer");
  desk = await createUser("member");
  manager = await createUser("member");
  await reconcile(m);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(EXT, JSON.stringify(m), admin.id, now, now)
    .run();
  await env.DB.prepare("UPDATE core_user SET pack_role = ? WHERE id = ?")
    .bind(TEAM, cleaner.id)
    .run();
  for (const [user, grant] of [
    [desk, DESK],
    [manager, MANAGE],
  ] as const) {
    await env.DB.prepare("UPDATE core_user SET granted_permissions = ? WHERE id = ?")
      .bind(JSON.stringify([grant]), user.id)
      .run();
  }
});

describe("the declaration", () => {
  const issues = (change: (o: Record<string, unknown>) => void) => {
    const copy = structuredClone(m) as unknown as {
      objects: Record<string, Record<string, unknown>>;
    };
    change(copy.objects.procedure as Record<string, unknown>);
    return validateManifest(copy as unknown as ExtensionManifest).issues.map((i) => i.message);
  };

  it("names a must-read document outside the content and a restricted, grantable permission", () => {
    expect(
      issues((o) => {
        (o.fields as Record<string, unknown>).mustRead = { type: "text", label: "Must read" };
      }).join(),
    ).toMatch(/MUST_READ_SCHEMA/);
    expect(
      issues((o) => {
        (o.publishable as { content: string[] }).content.push("mustRead");
      }).join(),
    ).toMatch(/not content/);
    expect(
      issues((o) => {
        (o.publishable as { acknowledge: { manage: string } }).acknowledge.manage = DESK;
      }).join(),
    ).toMatch(/restricted and grantable/);
    expect(
      issues((o) => {
        o.public = { read: ["title", "slug"] };
      }).join(),
    ).toMatch(/declares no public or signedIn/);
  });
});

describe("read again and small fix (criterion 5)", () => {
  it("the first version always asks; later ones must say", async () => {
    const id = await procedure({ title: "Opening up" });
    expect(
      (
        await refusal(
          invoke("record.publish", { object: PROC, id, readAgain: false }, context(admin)),
        )
      ).details,
    ).toMatchObject({ reason: "first_version_asks" });
    expect((await publish(id)).readAgain).toBe(true);
    await edit(id, "Opening up the hall");
    expect((await refusal(publish(id))).details).toMatchObject({ reason: "read_again_required" });
    expect((await publish(id, false)).readAgain).toBe(false);
    // An object that asks nobody takes no choice.
    const post = (await invoke(
      "record.create",
      { object: `${EXT}.post`, values: { title: "News" } },
      context(admin),
    )) as { id: string };
    expect(
      (
        await refusal(
          invoke(
            "record.publish",
            { object: `${EXT}.post`, id: post.id, readAgain: true },
            context(admin),
          ),
        )
      ).details,
    ).toMatchObject({ reason: "not_acknowledged" });
  });

  it("a small fix keeps confirmations; a read-again version asks everyone again", async () => {
    const id = await procedure({ title: "Closing up" });
    const v1 = await publish(id);
    expect(await toRead(member, id)).toBe(true);
    await confirm(member, id, v1.version);
    expect(await toRead(member, id)).toBe(false);
    await edit(id, "Closing up the hall");
    const v2 = await publish(id, false);
    expect(await toRead(member, id)).toBe(false);
    expect((await status(id)).people.find((p) => p.account === member.id)?.confirmed).toEqual({
      version: 1,
      confirmedAt: expect.any(String),
    });
    await edit(id, "Closing up the hall at night");
    const v3 = await publish(id, true);
    expect(await toRead(member, id)).toBe(true);
    expect((await status(id)).askedVersion).toBe(v3.version);
    // The superseded version cannot be confirmed now; the current one can.
    expect((await refusal(confirm(member, id, v2.version))).details).toMatchObject({
      reason: "not_current",
    });
    await confirm(member, id, v3.version);
    expect(await toRead(member, id)).toBe(false);
  });

  it("a scheduled read-again version asks nobody until it goes live", async () => {
    const id = await procedure({ title: "Fire alarm" });
    const v1 = await publish(id);
    await confirm(viewer, id, v1.version);
    await edit(id, "Fire alarm drill");
    const at = new Date(Date.now() + 3_600_000).toISOString();
    await invoke(
      "record.schedulePublish",
      { object: PROC, id, at, readAgain: true },
      context(admin),
    );
    expect(await toRead(viewer, id)).toBe(false);
    await invoke(
      "record.publishDue",
      {},
      { ...context(admin, { actor: "automation" }), clock: () => new Date(Date.now() + 7_200_000) },
    );
    expect(await toRead(viewer, id)).toBe(true);
  });
});

describe("confirming (criterion 4)", () => {
  it("is the person's own, once, for the current version", async () => {
    const id = await procedure({ title: "First aid kit" });
    const { version } = await publish(id);
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      const refused = await refusal(confirm(member, id, version, actor));
      expect(refused.code, actor).toBe("forbidden");
    }
    await confirm(member, id, version);
    expect((await refusal(confirm(member, id, version))).details).toMatchObject({
      reason: "already_confirmed",
    });
    // A version that was never published, or a record that is not published, is refused.
    expect((await refusal(confirm(member, id, version + 1))).code).toBe("conflict");
    const draft = await procedure({ title: "Draft only" });
    expect((await refusal(confirm(member, draft, 1))).code).toBe("not_found");
  });

  it("is a row nobody changes or deletes, host code included", async () => {
    const id = await procedure({ title: "Spills" });
    const { version } = await publish(id);
    await confirm(admin, id, version);
    const where = "WHERE object_type = ? AND record_id = ? AND account_id = ?";
    await expect(
      env.DB.prepare(`UPDATE core_publish_ack SET confirmed_at = 'x' ${where}`)
        .bind(PROC, id, admin.id)
        .run(),
    ).rejects.toThrow(/core_publish_ack_immutable/);
    await expect(
      env.DB.prepare(`DELETE FROM core_publish_ack ${where}`).bind(PROC, id, admin.id).run(),
    ).rejects.toThrow(/core_publish_ack_immutable/);
    // Not for a version that is not current, nor for someone else's dead account.
    await expect(
      env.DB.prepare(
        "INSERT INTO core_publish_ack (object_type, record_id, version, account_id, confirmed_at) VALUES (?, ?, ?, ?, 'x')",
      )
        .bind(PROC, id, version + 5, member.id)
        .run(),
    ).rejects.toThrow(/core_publish_ack_not_current/);
  });
});

describe("who must read (criterion 6)", () => {
  it("is everyone, or roles, pack roles and grants, on the day, losing no confirmation", async () => {
    const id = await procedure({
      title: "Front desk routine",
      mustRead: { everyone: false, roles: ["viewer", TEAM, DESK] },
    });
    const { version } = await publish(id);
    expect(await toRead(viewer, id)).toBe(true);
    expect(await toRead(cleaner, id)).toBe(true);
    expect(await toRead(desk, id)).toBe(true);
    expect(await toRead(member, id)).toBe(false);
    expect(await toRead(admin, id)).toBe(false);
    // A member is not asked, so cannot confirm.
    expect((await refusal(confirm(member, id, version))).details).toMatchObject({
      reason: "not_asked",
    });
    await confirm(desk, id, version);
    expect((await status(id)).people.map((p) => p.account).sort()).toEqual(
      [viewer.id, cleaner.id, desk.id].sort(),
    );
    // A person's grant changes, and who must read follows, from that moment.
    await env.DB.prepare("UPDATE core_user SET granted_permissions = ? WHERE id = ?")
      .bind(JSON.stringify([DESK]), member.id)
      .run();
    expect(await toRead(member, id)).toBe(true);
    await env.DB.prepare("UPDATE core_user SET granted_permissions = NULL WHERE id = ?")
      .bind(member.id)
      .run();
    // A deactivated account has nothing to read and keeps its confirmation.
    await env.DB.prepare("UPDATE core_user SET deactivated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), desk.id)
      .run();
    expect((await status(id)).people.map((p) => p.account)).not.toContain(desk.id);
    const kept = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_publish_ack WHERE record_id = ? AND account_id = ?",
    )
      .bind(id, desk.id)
      .first<{ n: number }>();
    expect(kept?.n).toBe(1);
    await env.DB.prepare("UPDATE core_user SET deactivated_at = NULL WHERE id = ?")
      .bind(desk.id)
      .run();
    expect((await status(id)).people.find((p) => p.account === desk.id)?.confirmed?.version).toBe(
      version,
    );
  });

  it("is changed by a person; once published, by one who manages; never by an AI", async () => {
    const id = await procedure({ title: "Lost child" });
    const set = (user: ActingUser, actor: Actor = "human", roles = ["member"]) =>
      invoke(
        "record.update",
        { object: PROC, id, values: { mustRead: { everyone: false, roles } } },
        as(user, actor),
      );
    await setPreset("autonomous");
    expect((await refusal(set(admin, "assistant"))).code).toBe("forbidden");
    await set(member);
    await publish(id);
    expect((await refusal(set(member, "human", ["viewer"]))).code).toBe("forbidden");
    // Setting it to what it is already changes nothing, and is not refused.
    await set(member);
    await invoke(
      "record.update",
      { object: PROC, id, values: { mustRead: EVERYONE } },
      as(manager),
    );
    // Other fields are anyone's who writes records, AI included.
    await invoke(
      "record.update",
      { object: PROC, id, values: { title: "Lost child!" } },
      as(member),
    );
    await setPreset("balanced");
  });
});

describe("read status (criterion 7)", () => {
  it("lists exactly who must read, who confirmed and when, and who has not", async () => {
    const id = await procedure({ title: "Injuries" });
    const { version } = await publish(id);
    await confirm(viewer, id, version);
    const s = await status(id);
    const viewerRow = s.people.find((p) => p.account === viewer.id);
    expect(viewerRow?.confirmed?.version).toBe(version);
    expect(viewerRow?.since).toBeNull();
    const memberRow = s.people.find((p) => p.account === member.id);
    expect(memberRow?.confirmed).toBeNull();
    expect(memberRow?.since).toEqual(expect.any(String));
    expect(s.people.map((p) => p.account)).toEqual(
      expect.arrayContaining([admin.id, member.id, viewer.id, cleaner.id, manager.id]),
    );
    // The manager's grant reads it; a member's role does not; no AI actor does.
    await status(id, manager);
    expect((await refusal(status(id, member))).code).toBe("forbidden");
    for (const actor of ["assistant", "mcp"] as const) {
      const out = await refusal(invoke("ack.status", { object: PROC, id }, as(admin, actor)));
      expect(out.code, actor).toBe("forbidden");
    }
    const overview = (await invoke("ack.overview", {}, as(admin))) as {
      items: { id: string; mustRead: number; confirmed: number }[];
    };
    const row = overview.items.find((i) => i.id === id);
    expect(row?.confirmed).toBe(1);
    expect(row?.mustRead).toBe(s.people.length);
    expect((await refusal(invoke("ack.overview", {}, as(member)))).code).toBe("forbidden");
  });
});

describe("pack roles (criterion 3)", () => {
  it("a cleaner reads their own list and confirms, and is refused everything else", async () => {
    const id = await procedure({ title: "Cleaning the mats" });
    const { version } = await publish(id);
    expect(await toRead(cleaner, id)).toBe(true);
    await confirm(cleaner, id, version);
    expect(await toRead(cleaner, id)).toBe(false);
    for (const [name, input] of [
      ["ack.status", { object: PROC, id }],
      ["ack.overview", {}],
      ["record.list", { object: PROC }],
      ["record.publish", { object: PROC, id, readAgain: true }],
    ] as const) {
      const out = await refusal(invoke(name, input, as(cleaner)));
      expect(out.code, name).toBe("forbidden");
    }
  });
});

describe("an AI's publish request (criterion 5, ADR 0480)", () => {
  it("shows its suggestion, and the approver chooses", async () => {
    const id = await procedure({ title: "Complaints" });
    await publish(id);
    await edit(id, "Handling a complaint");
    const asked = await invoke(
      "record.publish",
      { object: PROC, id, readAgain: false },
      as(admin, "assistant"),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(asked).toBeInstanceOf(PendingApprovalError);
    const pending = (asked as PendingApprovalError).pending;
    const row = await env.DB.prepare("SELECT preview FROM core_pending_action WHERE id = ?")
      .bind(pending.actionId)
      .first<{ preview: string }>();
    const diff = (JSON.parse(row?.preview ?? "[]") as { diff: Record<string, unknown> }[])[0]?.diff;
    expect(diff?.readAgain).toEqual({ before: null, after: false });
    await invoke(
      "approval.approve",
      { actionIds: [pending.actionId], readAgain: { [pending.actionId]: true } },
      context(admin),
    );
    const live = (await invoke("record.version", { object: PROC, id }, context(admin))) as {
      version: number;
      readAgain: boolean | null;
    };
    expect(live).toMatchObject({ version: 2, readAgain: true });
  });

  it("the operations are a person's, reached by every staff role and pack role", () => {
    for (const name of ["ack.confirm", "ack.mine", "ack.status", "ack.overview"]) {
      const op = coreRegistry.get(name);
      expect(op?.actors, name).toEqual(["human", "extension"]);
      expect(op?.audiences ?? ["staff"], name).toEqual(["staff"]);
    }
  });
});
