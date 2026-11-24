// Staff invites (ADR 0455): the operations, and accepting an invite under Cloudflare Access.
// Inviting, changing, revoking and listing invites are a human admin's: refused to every AI or
// MCP actor and to a member, not on MCP, and audited. Accepting under Access gives the account
// what the invite says on its first request, once.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  coreRegistry,
  customerCodeEmail,
  invoke,
  resolveActingUser,
  staffCodeEmail,
} from "../src/index.ts";
import { auditChanges, context, createUser, db, refusal, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;

const INVITE_OPS = ["user.invite", "user.invites", "user.updateInvite", "user.revokeInvite"];

/** The non-human callers: none may call an invite operation, whatever their user may do. */
const AI_ACTORS = [
  { actor: "mcp", origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: "s1" } },
  { actor: "assistant", origin: { surface: "assistant", sessionId: "ath_1" } },
  { actor: "automation", origin: { surface: "automation", automationId: "aut_1" } },
  { actor: "extension", origin: { surface: "extension", extensionId: "x" } },
] as const;

const DOOR_PACK = {
  id: "invitefix",
  label: "Invite fixture",
  version: "1.0.0",
  contractVersion: 1,
  objects: {},
  tools: {
    scan: {
      description: "Fixture: scans.",
      risk: "write",
      permission: "invitefix:scan",
      inputSchema: { type: "object" },
      outputSchema: {},
    },
  },
  roles: {
    door: { label: "Door", description: "Scans", permissions: ["invitefix:scan"], read: [] },
  },
};

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO core_extensions (id, source, status, version, commit_oid, manifest,
       user_id, installed_at, updated_at) VALUES ('invitefix', 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)`,
  )
    .bind(JSON.stringify(DOOR_PACK), admin.id, now, now)
    .run();
});

const invite = (input: Record<string, unknown>, by = admin, extra: Record<string, unknown> = {}) =>
  invoke("user.invite", input as never, context(by, extra as never));

describe("invite operations are a human admin's", () => {
  it("are not on MCP, and are human-only by declaration", () => {
    for (const name of INVITE_OPS) {
      const op = coreRegistry.get(name);
      expect(op?.mcp?.expose, name).toBe(false);
      expect(op?.actors, name).toEqual(["human"]);
      expect(op?.permission, name).toBe("users:manage");
      expect(op?.audiences ?? ["staff"], name).toEqual(["staff"]);
    }
  });

  it("refuses every AI and MCP actor acting as an admin, and a member, for each operation", async () => {
    const pending = await invite({ email: `${unique("p")}@example.com` });
    const inputs: Record<string, unknown> = {
      "user.invite": { email: `${unique("ai")}@example.com`, role: "admin" },
      "user.invites": {},
      "user.updateInvite": { id: pending.id, role: "admin" },
      "user.revokeInvite": { id: pending.id },
    };
    for (const name of INVITE_OPS) {
      for (const extra of AI_ACTORS) {
        const refused = await refusal(
          invoke(name as never, inputs[name] as never, context(admin, extra as never)),
        );
        expect(refused.code, `${name} as ${extra.actor}`).toBe("forbidden");
      }
      expect(
        (await refusal(invoke(name as never, inputs[name] as never, context(member)))).code,
        name,
      ).toBe("forbidden");
    }
    // Nothing those calls asked for happened.
    const listed = await invoke("user.invites", {}, context(admin));
    const still = listed.items.find((i) => i.id === pending.id);
    expect(still).toMatchObject({ role: "member", status: "pending" });
    expect(listed.items.some((i) => i.role === "admin")).toBe(false);
  });
});

describe("user.invite", () => {
  it("invites with a role, a pack role or grants, audited, and replaces a pending invite", async () => {
    const email = `${unique("Coach")}@Example.com`;
    const first = await invite({ email, role: "member", permissions: ["records:publish"] });
    expect(first).toMatchObject({
      email: email.toLowerCase(),
      role: "member",
      permissions: ["records:publish"],
      status: "pending",
      signIn: "code",
      invitationEmail: "not_sent",
    });
    const second = await invite({ email, packRole: "invitefix.door" });
    // A pack role is all the account may do: its role is viewer.
    expect(second).toMatchObject({ role: "viewer", packRole: "invitefix.door", permissions: [] });
    const pending = (await invoke("user.invites", {}, context(admin))).items.filter(
      (i) => i.email === email.toLowerCase(),
    );
    expect(pending.map((i) => i.id)).toEqual([second.id]);
    expect((await auditChanges(first.id)).map((c) => [c.operation, c.action])).toEqual([
      ["user.invite", "create"],
      ["user.invite", "delete"],
    ]);
  });

  it("refuses an address with an account, an admin with a pack role, and what cannot be granted", async () => {
    expect((await refusal(invite({ email: member.email }))).code).toBe("conflict");
    expect(
      (
        await refusal(
          invite({
            email: `${unique("a")}@example.com`,
            role: "admin",
            packRole: "invitefix.door",
          }),
        )
      ).code,
    ).toBe("conflict");
    expect(
      (await refusal(invite({ email: `${unique("b")}@example.com`, packRole: "nopack.door" })))
        .code,
    ).toBe("invalid_input");
    for (const bad of ["users:manage", "policy:manage"]) {
      expect(
        (await refusal(invite({ email: `${unique("c")}@example.com`, permissions: [bad] }))).code,
      ).toBe("invalid_input");
    }
    expect((await refusal(invite({ email: "not an address" }))).code).toBe("invalid_input");
    // A fixed role and a core permission: a core one is never a fixed role's (ADR 0600).
    const fixedCore = await refusal(
      invite({
        email: `${unique("d")}@example.com`,
        packRole: "invitefix.door",
        permissions: ["records:publish"],
      }),
    );
    expect(fixedCore.code).toBe("invalid_input");
    expect(fixedCore.message).toContain("fixed role invitefix.door");
    // Without a fixed role the same permission is granted as before.
    expect(
      await invite({ email: `${unique("e")}@example.com`, permissions: ["records:publish"] }),
    ).toMatchObject({ permissions: ["records:publish"] });
  });

  it("is changed and revoked by an admin, audited", async () => {
    const made = await invite({ email: `${unique("d")}@example.com` });
    const changed = await invoke(
      "user.updateInvite",
      { id: made.id, role: "viewer", permissions: ["orders:refund"] },
      context(admin),
    );
    expect(changed).toMatchObject({ role: "viewer", permissions: ["orders:refund"] });
    await invoke("user.revokeInvite", { id: made.id }, context(admin));
    expect((await refusal(invoke("user.revokeInvite", { id: made.id }, context(admin)))).code).toBe(
      "not_found",
    );
    expect((await auditChanges(made.id)).map((c) => [c.operation, c.diff])).toEqual([
      ["user.invite", expect.anything()],
      [
        "user.updateInvite",
        {
          role: { before: "member", after: "viewer" },
          permissions: { before: [], after: ["orders:refund"] },
        },
      ],
      ["user.revokeInvite", expect.anything()],
    ]);
  });
});

describe("under Cloudflare Access, the first request accepts the invite", () => {
  it("makes the account with the invite's role and pack role, once", async () => {
    const email = `${unique("access")}@example.com`;
    const made = await invite({ email, packRole: "invitefix.door" });
    const principal = { userId: "access-sub-1", email, name: "Door Person" };
    const acting = await resolveActingUser(db, principal);
    expect(acting.role).toBe("viewer");
    const row = await db.query
      .selectFrom("core_user")
      .select(["pack_role"])
      .where("id", "=", acting.id)
      .executeTakeFirstOrThrow();
    expect(row.pack_role).toBe("invitefix.door");
    const accepted = await db.query
      .selectFrom("core_user_invite")
      .select(["accepted_user_id"])
      .where("id", "=", made.id)
      .executeTakeFirstOrThrow();
    expect(accepted.accepted_user_id).toBe(acting.id);
    // Later requests find the account; the invite is not applied again.
    await env.DB.prepare("UPDATE core_user SET pack_role = NULL, role = 'member' WHERE id = ?")
      .bind(acting.id)
      .run();
    expect((await resolveActingUser(db, principal)).role).toBe("member");
  });

  it("without an invite the first request is a member, as before; an expired invite gives nothing", async () => {
    const email = `${unique("plain")}@example.com`;
    expect((await resolveActingUser(db, { userId: "s2", email, name: "P" })).role).toBe("member");
    const late = `${unique("late")}@example.com`;
    const made = await invite({ email: late, role: "admin" });
    await env.DB.prepare("UPDATE core_user_invite SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), made.id)
      .run();
    expect((await resolveActingUser(db, { userId: "s3", email: late, name: "L" })).role).toBe(
      "member",
    );
  });
});

describe("sign-in code emails", () => {
  it("keep the code out of the subject, which the audit log keeps as the send's title", () => {
    for (const mail of [staffCodeEmail("Gym", "482913"), customerCodeEmail("482913")]) {
      expect(mail.subject).not.toContain("482913");
      expect(mail.text).toContain("482913");
    }
  });
});
