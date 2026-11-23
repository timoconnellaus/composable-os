// Stage 45 step 5 (ADR 0628): a staff member's private calendar feed. Acceptance criterion 9 ("a
// person's feed shows exactly their own shifts in the range ... holds no other staff name and no
// member data; another person's token, a revoked, rotated or made-up token all answer 404;
// deactivation revokes it"), the part of 12 that is the feed (leaving revokes it), and the AI
// table's "a person's own act" for making and changing it. The HTTP route and its answer are
// tested in apps/app/test/staffing-feed.test.ts; the calendar file's format in
// packages/calendar-file.
//
// Every operation is called as a shipped pack's tool run calls it: the extension's account as
// `ctx.user`, the person as the verified caller. Every clock is injected. All names are fixture
// names.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName } from "../src/index.ts";
import { FEED_TOKEN_RE, feedTokenHash, newFeedToken, readStaffFeed } from "../src/staffing/feed.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const ext = extId("stfeed");
const COACH = `${ext}.coach`;
const KIND = `${ext}.kind`;
const ROOM = `${ext}.room`;
const KLASS = `${ext}.klass`;
const DUTY = `${ext}.duty`;
const ZONE = "Australia/Sydney";
const NOW = "2026-06-15T00:00:00.000Z";
const BEFORE = "2026-01-01T00:00:00.000Z";
const at = (days: number, hour = 8) =>
  new Date(Date.parse(NOW) + days * 86_400_000 + hour * 3_600_000).toISOString();
const plus = (iso: string, minutes = 60) =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

const PRIVATE_NOTE = "Zed Member has a knee injury";
const MEMBER_TITLE = "Private session with Zed Member";

const fixture = manifest(ext, {
  objects: {
    coach: {
      label: "Coach",
      plural: "Coaches",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        user: { type: "user", label: "Staff account" },
      },
      unique: [{ fields: ["user"] }],
    },
    kind: {
      label: "Kind",
      plural: "Kinds",
      titleField: "name",
      fields: { name: { type: "text", label: "Name", required: true } },
    },
    room: {
      label: "Room",
      plural: "Rooms",
      titleField: "name",
      fields: { name: { type: "text", label: "Name", required: true } },
    },
    klass: {
      label: "Class",
      plural: "Classes",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        kind: { type: "relation", label: "Kind", to: `${ext}.kind` },
        room: { type: "relation", label: "Room", to: `${ext}.room` },
        startsAt: { type: "datetime", label: "Starts at" },
        endsAt: { type: "datetime", label: "Ends at" },
        timezone: { type: "timezone", label: "Time zone" },
        coach: { type: "relation", label: "Coach", to: `${ext}.coach` },
        notes: { type: "longText", label: "Notes" },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "scheduled", label: "Scheduled" },
            { value: "cancelled", label: "Cancelled" },
            { value: "done", label: "Done" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "scheduled",
        moves: [
          { from: "scheduled", to: "cancelled", by: ["staff", "host"], final: true },
          { from: "scheduled", to: "done", by: ["staff", "host"], final: true },
        ],
      },
      staffed: {
        who: { field: "coach", account: "user" },
        starts: "startsAt",
        ends: "endsAt",
        zone: "timezone",
        kind: "kind",
        live: ["scheduled", "done"],
        place: "room.name",
      },
      indexes: [["startsAt"]],
    },
    duty: {
      label: "Duty shift",
      plural: "Duty shifts",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        kind: { type: "relation", label: "Duty", to: `${ext}.kind` },
        staff: { type: "user", label: "Staff" },
        startsAt: { type: "datetime", label: "Starts at" },
        endsAt: { type: "datetime", label: "Ends at" },
        place: { type: "text", label: "Place" },
        notes: { type: "longText", label: "Notes" },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "scheduled", label: "Scheduled" },
            { value: "cancelled", label: "Cancelled" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "scheduled",
        moves: [
          { from: "scheduled", to: "cancelled", by: ["staff"] },
          { from: "cancelled", to: "scheduled", by: ["staff"] },
        ],
      },
      staffed: {
        who: { field: "staff" },
        starts: "startsAt",
        ends: "endsAt",
        kind: "kind",
        live: ["scheduled"],
        place: "place",
      },
      indexes: [["startsAt"]],
    },
  },
});

const TEAM = [`${ext}:team`, `${ext}:roster`];
const tool = (description: string, extra: Record<string, unknown> = {}) => ({
  description,
  risk: "write",
  permission: TEAM,
  grantLiftsRoleLimits: true,
  humanOnly: true,
  inputSchema: { type: "object", properties: {} },
  outputSchema: { type: "object", properties: {} },
  ...extra,
});

/** The installed manifest's parts the host reads: the team's tools, role, grants and rosterers. */
const installed = {
  id: ext,
  version: "1.0.0",
  label: "Feed fixture",
  grantable: [`${ext}:roster`, `${ext}:manage`],
  restricted: [`${ext}:manage`],
  roles: {
    team: {
      label: "Team",
      description: "The roster and their own shifts only, nothing else.",
      permissions: [`${ext}:team`],
      read: [],
    },
    coach: {
      label: "Coach",
      description: "Classes today only: nothing of the roster at all.",
      permissions: [`${ext}:coach`],
      read: [],
    },
  },
  staffing: { rosters: `${ext}:manage` },
  tools: {
    feedRotate: tool("A new feed address for yourself, shown once."),
    other: tool("A coach's own tool.", { permission: `${ext}:coach` }),
  },
};

const FEED_OPS = ["staffing.feed.status", "staffing.feed.rotate", "staffing.feed.revoke"];

let admin: ActingUser;
let extUser: ActingUser;
const people: Record<string, ActingUser> = {};
const profile: Record<string, string> = {};
const ids: Record<string, string> = {};

type Caller = { actor?: string; humanOnly?: boolean; source?: string };
const as = (user: ActingUser) => context(user, { clock: () => new Date(NOW) });
const feedTool = (user: ActingUser, caller: Caller = {}) =>
  context(extUser, {
    actor: "extension",
    clock: () => new Date(NOW),
    extension: {
      id: ext,
      permissions: { operations: FEED_OPS, objects: {} } as never,
      tool: {
        name: "feedRotate",
        humanOnly: caller.humanOnly ?? true,
        permission: TEAM,
        calledBy: { account: user.id, actor: caller.actor ?? "human" },
      },
    },
  });
const call = <T = Record<string, unknown>>(
  name: string,
  user: ActingUser,
  input = {},
  c?: Caller,
) => invokeByName(name, input, feedTool(user, c)) as Promise<T>;
/** A new address for `user`: the token from the path the person is shown once. */
async function rotate(user: ActingUser): Promise<string> {
  const { path } = await call<{ path: string }>("staffing.feed.rotate", user);
  const token = /^\/api\/v1\/staffing\/feed\/([A-Za-z0-9_-]{43})\.ics$/.exec(path)?.[1];
  expect(token).toBeTruthy();
  return token as string;
}
const read = (token: string, now = NOW) => readStaffFeed(db.query, token, new Date(now));

async function create(object: string, values: Record<string, unknown>) {
  return ((await invokeByName("record.create", { object, values }, as(admin))) as { id: string })
    .id;
}
async function update(object: string, id: string, values: Record<string, unknown>) {
  return invokeByName("record.update", { object, id, values }, as(admin));
}
async function newPerson(key: string, role: "member" | "viewer" = "member") {
  const user = await createUser(role);
  const name = `${key} Fixture`;
  await env.DB.prepare("UPDATE core_user SET name = ? WHERE id = ?").bind(name, user.id).run();
  people[key] = { ...user, name };
  return people[key] as ActingUser;
}
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeTruthy();
  return error as { code: string; message: string; details?: Record<string, unknown> };
}
/** Every stored text a secret could end up in: the audit log, notices, approvals, runs. */
async function storedText(): Promise<string> {
  const tables = [
    "SELECT input || coalesce(result, '') || coalesce(error, '') AS t FROM core_audit",
    "SELECT coalesce(diff, '') AS t FROM core_audit_changes",
    "SELECT coalesce(title, '') || coalesce(body, '') AS t FROM core_notifications",
    "SELECT coalesce(input, '') || coalesce(result, '') AS t FROM core_pending_action",
    "SELECT coalesce(response, '') AS t FROM core_idempotency_key",
  ];
  const out: string[] = [];
  for (const q of tables) {
    const { results } = await env.DB.prepare(q).all<{ t: string }>();
    out.push(...results.map((r) => r.t));
  }
  return out.join("\n");
}

beforeAll(async () => {
  admin = await createUser("admin");
  extUser = await createUser("member");
  await env.DB.prepare("UPDATE core_user SET kind = 'extension' WHERE id = ?")
    .bind(extUser.id)
    .run();
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES ('org_timezone', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify(ZONE), BEFORE)
    .run();
  await reconcile(fixture, BEFORE);
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify(installed), admin.id, BEFORE, BEFORE)
    .run();
  for (const key of ["Sam", "Ann"]) {
    const user = await newPerson(key);
    profile[key] = await create(COACH, { name: user.name, user: user.id });
  }
  ids.strength = await create(KIND, { name: "Strength" });
  ids.cleaning = await create(KIND, { name: "Cleaning" });
  ids.studio = await create(ROOM, { name: "Studio A" });
  const klass = (key: string, coach: string, starts: string, extra = {}) =>
    create(KLASS, {
      name: MEMBER_TITLE,
      kind: ids.strength,
      room: ids.studio,
      coach: profile[coach],
      startsAt: starts,
      endsAt: plus(starts),
      timezone: ZONE,
      notes: PRIVATE_NOTE,
      ...extra,
    }).then((id) => {
      ids[key] = id;
    });
  await klass("past", "Sam", at(-10));
  await klass("tooOld", "Sam", at(-20));
  await klass("soon", "Sam", at(2));
  await klass("cancelled", "Sam", at(3, 10));
  await klass("reassigned", "Sam", at(4));
  await klass("annOwn", "Ann", at(2));
  await klass("tooFar", "Sam", at(130));
  ids.duty = await create(DUTY, {
    name: "Close-down clean",
    kind: ids.cleaning,
    staff: people.Sam?.id,
    startsAt: at(5, 20),
    endsAt: plus(at(5, 20), 45),
    place: "Main floor",
    notes: PRIVATE_NOTE,
  });
  ids.trashed = await create(DUTY, {
    kind: ids.cleaning,
    staff: people.Sam?.id,
    startsAt: at(6),
    endsAt: plus(at(6)),
  });
  await update(KLASS, ids.cancelled as string, { state: "cancelled" });
  await update(KLASS, ids.reassigned as string, { coach: profile.Ann });
  await invokeByName("record.delete", { object: DUTY, id: ids.trashed }, as(admin));
});

describe("the feed's address (a person's own, shown once, kept as a hash)", () => {
  it("is made by the person themselves, answered once, and stored only as its SHA-256", async () => {
    const sam = people.Sam as ActingUser;
    expect(await call("staffing.feed.status", sam)).toEqual({ active: false, createdAt: null });
    const token = await rotate(sam);
    expect(token).toMatch(FEED_TOKEN_RE);
    expect(await call("staffing.feed.status", sam)).toEqual({ active: true, createdAt: NOW });
    const row = await env.DB.prepare("SELECT * FROM core_staff_feed WHERE account_id = ?")
      .bind(sam.id)
      .first<Record<string, string>>();
    expect(row).toMatchObject({
      token_hash: await feedTokenHash(token),
      tool: `x.${ext}.feedRotate`,
      created_at: NOW,
    });
    expect(JSON.stringify(row)).not.toContain(token);
    // Not in the audit log (the rotation is recorded, never the address), a notice, an approval or
    // a stored reply.
    expect(await storedText()).not.toContain(token);
    const audit = await env.DB.prepare(
      "SELECT result FROM core_audit WHERE operation = 'staffing.feed.rotate' ORDER BY at DESC LIMIT 1",
    ).first<{ result: string }>();
    expect(JSON.parse(audit?.result ?? "null")).toEqual({ feed: "rotated" });
  });

  it("is never made, changed or revoked by an assistant, an MCP client or an automation", async () => {
    const sam = people.Sam as ActingUser;
    for (const actor of ["assistant", "mcp"]) {
      for (const name of ["staffing.feed.rotate", "staffing.feed.revoke"]) {
        const error = await refusal(call(name, sam, {}, { actor }));
        expect(error.code, `${name} ${actor}`).toBe("forbidden");
        expect(error.details?.rule).toBe("human_only");
      }
    }
    // A tool that is not a person's own (no humanOnly) cannot either.
    const error = await refusal(call("staffing.feed.rotate", sam, {}, { humanOnly: false }));
    expect(error.details?.rule).toBe("human_only");
    // Called directly, not as a tool's run, it does not exist.
    const direct = await refusal(invokeByName("staffing.feed.rotate", {}, as(sam)));
    expect(direct.code).toBe("unknown_operation");
  });

  it("an admin may revoke anyone's; anyone else is told it does not exist", async () => {
    const ann = people.Ann as ActingUser;
    const sam = people.Sam as ActingUser;
    const token = await rotate(ann);
    const error = await refusal(call("staffing.feed.revoke", sam, { account: ann.id }));
    expect(error.code).toBe("not_found");
    expect(await read(token)).not.toBeNull();
    expect(await call("staffing.feed.revoke", admin, { account: ann.id })).toEqual({
      account: ann.id,
      revoked: true,
    });
    expect(await read(token)).toBeNull();
    // The person revokes their own.
    const again = await rotate(ann);
    expect(await call("staffing.feed.revoke", ann)).toEqual({ account: ann.id, revoked: true });
    expect(await read(again)).toBeNull();
  });
});

describe("what the feed shows (criterion 9)", () => {
  it("exactly the person's own live shifts from 14 days back to the horizon, kind and place only", async () => {
    const token = await rotate(people.Sam as ActingUser);
    const feed = await read(token);
    expect(feed?.account).toBe(people.Sam?.id);
    expect(feed?.shifts.map((s) => s.id)).toEqual([ids.past, ids.soon, ids.duty]);
    expect(feed?.shifts[1]).toEqual({
      object: KLASS,
      id: ids.soon,
      title: "Strength",
      place: "Studio A",
      startsAt: at(2),
      endsAt: plus(at(2)),
      updatedAt: expect.any(String),
    });
    expect(feed?.shifts[2]).toMatchObject({
      object: DUTY,
      title: "Cleaning",
      place: "Main floor",
      startsAt: at(5, 20),
      endsAt: plus(at(5, 20), 45),
    });
    // Nothing a business typed on a class (a member's name), no notes, no other person.
    const text = JSON.stringify(feed);
    for (const secret of [MEMBER_TITLE, "Zed", PRIVATE_NOTE, "Ann", people.Ann?.id as string]) {
      expect(text).not.toContain(secret);
    }
  });

  it("a shift done stays; one cancelled, in the Trash or given to someone else drops out", async () => {
    const token = await rotate(people.Sam as ActingUser);
    await update(KLASS, ids.past as string, { state: "done" });
    const shown = (await read(token))?.shifts.map((s) => s.id) ?? [];
    expect(shown).toContain(ids.past);
    for (const gone of [ids.cancelled, ids.trashed, ids.reassigned, ids.tooOld, ids.tooFar]) {
      expect(shown).not.toContain(gone);
    }
    // Ann's feed has the class given to her, and her own.
    const annToken = await rotate(people.Ann as ActingUser);
    expect((await read(annToken))?.shifts.map((s) => s.id).sort()).toEqual(
      [ids.annOwn, ids.reassigned].sort(),
    );
    // The window moves with the clock: two weeks later the past class has dropped out.
    expect((await read(token, at(14)))?.shifts.map((s) => s.id)).not.toContain(ids.past);
  });
});

describe("tokens that open nothing (criterion 9)", () => {
  it("a made-up, malformed, rotated or revoked token reads nothing, and another person's only theirs", async () => {
    const sam = people.Sam as ActingUser;
    const first = await rotate(sam);
    const second = await rotate(sam);
    expect(await read(first)).toBeNull();
    expect((await read(second))?.account).toBe(sam.id);
    expect(await read(newFeedToken())).toBeNull();
    expect(await read(`${second.slice(0, 42)}x`)).toBeNull();
    for (const bad of ["", "x", `${second}x`, second.replace(/./, "!"), `../${second}`]) {
      expect(await read(bad)).toBeNull();
    }
    // Ann's token reads Ann's, never Sam's.
    const annToken = await rotate(people.Ann as ActingUser);
    expect((await read(annToken))?.shifts.map((s) => s.id)).not.toContain(ids.soon);
    await call("staffing.feed.revoke", sam);
    expect(await read(second)).toBeNull();
  });
});

describe("leaving, and losing the pack's permission, kill the feed at once", () => {
  it("deactivating the person revokes it in the same batch; reactivating brings nothing back", async () => {
    const leaver = await newPerson("Lee");
    profile.Lee = await create(COACH, { name: leaver.name, user: leaver.id });
    await create(KLASS, {
      kind: ids.strength,
      coach: profile.Lee,
      startsAt: at(1, 18),
      endsAt: plus(at(1, 18)),
      timezone: ZONE,
    });
    const token = await rotate(leaver);
    expect((await read(token))?.shifts).toHaveLength(1);
    const refused = await refusal(invokeByName("user.deactivate", { id: leaver.id }, as(admin)));
    const count = refused.details?.count as number;
    await invokeByName("user.deactivate", { id: leaver.id, confirm: count }, as(admin));
    expect(
      await env.DB.prepare("SELECT 1 FROM core_staff_feed WHERE account_id = ?")
        .bind(leaver.id)
        .first(),
    ).toBeNull();
    expect(await read(token)).toBeNull();
    await invokeByName("user.reactivate", { id: leaver.id }, as(admin));
    expect(await read(token)).toBeNull();
  });

  it("a deactivated account's feed answers nothing even if its row were left", async () => {
    const gone = await newPerson("Gil");
    const token = await rotate(gone);
    await env.DB.prepare("UPDATE core_user SET deactivated_at = ? WHERE id = ?")
      .bind(NOW, gone.id)
      .run();
    expect(await read(token)).toBeNull();
  });

  it("the team role taken away revokes it; a role change that keeps the tools does not", async () => {
    const tia = await newPerson("Tia", "viewer");
    await invokeByName("user.setPackRole", { id: tia.id, role: `${ext}.team` }, as(admin));
    const token = await rotate(tia);
    expect(await read(token)).not.toBeNull();
    // Without the role she is a viewer, who holds no write tool: no feed.
    await invokeByName("user.setPackRole", { id: tia.id, role: null }, as(admin));
    expect(await read(token)).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM core_staff_feed WHERE account_id = ?")
        .bind(tia.id)
        .first(),
    ).toBeNull();
    // A member made an admin keeps hers.
    const mae = await newPerson("Mae");
    const kept = await rotate(mae);
    await invokeByName("user.updateRole", { id: mae.id, role: "admin" }, as(admin));
    expect(await read(kept)).not.toBeNull();
    // Made a viewer, she loses it.
    await invokeByName("user.updateRole", { id: mae.id, role: "viewer" }, as(admin));
    expect(await read(kept)).toBeNull();
  });

  it("a coach whose grant of the team's tools is taken away loses it; another grant keeps it", async () => {
    const cal = await newPerson("Cal", "viewer");
    await invokeByName("user.setPackRole", { id: cal.id, role: `${ext}.coach` }, as(admin));
    await invokeByName(
      "user.setPermissions",
      { id: cal.id, permissions: [`${ext}:roster`] },
      as(admin),
    );
    const token = await rotate(cal);
    expect(await read(token)).not.toBeNull();
    await invokeByName(
      "user.setPermissions",
      { id: cal.id, permissions: [`${ext}:roster`, `${ext}:manage`] },
      as(admin),
    );
    expect(await read(token)).not.toBeNull();
    await invokeByName("user.setPermissions", { id: cal.id, permissions: [] }, as(admin));
    expect(await read(token)).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM core_staff_feed WHERE account_id = ?")
        .bind(cal.id)
        .first(),
    ).toBeNull();
    // The grant given back does not bring the old address back.
    await invokeByName(
      "user.setPermissions",
      { id: cal.id, permissions: [`${ext}:roster`] },
      as(admin),
    );
    expect(await read(token)).toBeNull();
  });

  it("the pack disabled answers nothing", async () => {
    const pia = await newPerson("Pia");
    const token = await rotate(pia);
    await env.DB.prepare("UPDATE core_extensions SET status = 'disabled' WHERE id = ?")
      .bind(ext)
      .run();
    try {
      expect(await read(token)).toBeNull();
    } finally {
      await env.DB.prepare("UPDATE core_extensions SET status = 'active' WHERE id = ?")
        .bind(ext)
        .run();
    }
    expect(await read(token)).not.toBeNull();
  });
});
