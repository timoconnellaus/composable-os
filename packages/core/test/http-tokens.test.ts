// Stage 23, acceptance criterion 4 (ADR 0419): sessions for native apps. A reused refresh token
// ends the session; a session unused past the setting is ended; tokens are one audience's; a
// person lists and ends their own sessions by device name.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_TTL_MS,
  type ActingUser,
  invoke,
  issueDeviceSession,
  refreshDeviceSession,
  resolveAccessToken,
} from "../src/index.ts";
import { context, createUser, db, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;
let customerId = "";
let personId = "";

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  const person = await invoke(
    "person.create",
    { givenName: "Token", familyName: unique("Holder") },
    context(admin),
  );
  personId = person.id;
  customerId = `cus_${unique("tok")}`;
  const at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_customer (id, person_id, email, email_verified, status, link_state, created_at, updated_at) VALUES (?, ?, ?, 1, 'active', 'linked', ?, ?)",
  )
    .bind(customerId, personId, `${unique("tok")}@example.com`, at, at)
    .run();
});

const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => "accepted",
    (error: { details?: { reason?: string } }) => error.details?.reason ?? String(error),
  );

const sessionExists = async (id: string) =>
  Boolean(
    await db.query
      .selectFrom("core_device_session")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst(),
  );

describe("tokens", () => {
  it("an access token resolves to its session's audience and subject, and expires in minutes", async () => {
    const now = new Date();
    const t = await issueDeviceSession(
      db,
      { audience: "customer", subjectId: customerId },
      "Phone",
      now,
    );
    expect(await resolveAccessToken(db, t.accessToken, now)).toEqual({
      audience: "customer",
      subjectId: customerId,
      sessionId: t.sessionId,
    });
    expect(Date.parse(t.accessExpiresAt) - now.getTime()).toBe(ACCESS_TOKEN_TTL_MS);
    const later = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS + 1);
    expect(await reason(resolveAccessToken(db, t.accessToken, later))).toBe("token_expired");
    // Only hashes are stored.
    const row = await env.DB.prepare("SELECT * FROM core_device_session WHERE id = ?")
      .bind(t.sessionId)
      .first<Record<string, string>>();
    expect(JSON.stringify(row)).not.toContain(t.accessToken);
    expect(JSON.stringify(row)).not.toContain(t.refreshToken);
  });

  it("a refresh rotates both tokens; the old access token stops working", async () => {
    const now = new Date();
    const t1 = await issueDeviceSession(
      db,
      { audience: "staff", subjectId: member.id },
      "Tablet",
      now,
    );
    const t2 = await refreshDeviceSession(db, t1.refreshToken, now);
    expect(t2.sessionId).toBe(t1.sessionId);
    expect(t2.refreshToken).not.toBe(t1.refreshToken);
    expect(await reason(resolveAccessToken(db, t1.accessToken, now))).toBe("token_invalid");
    expect((await resolveAccessToken(db, t2.accessToken, now)).audience).toBe("staff");
  });

  it("a reused refresh token ends the whole session", async () => {
    const now = new Date();
    const t1 = await issueDeviceSession(
      db,
      { audience: "customer", subjectId: customerId },
      "Phone",
      now,
    );
    const t2 = await refreshDeviceSession(db, t1.refreshToken, now);
    // Someone replays the first refresh token: the session ends, for the thief and the owner.
    expect(await reason(refreshDeviceSession(db, t1.refreshToken, now))).toBe("refresh_reused");
    expect(await sessionExists(t1.sessionId)).toBe(false);
    expect(await reason(resolveAccessToken(db, t2.accessToken, now))).toBe("token_invalid");
    expect(await reason(refreshDeviceSession(db, t2.refreshToken, now))).toBe("session_ended");
  });

  it("the same refresh token sent twice at once ends the session", async () => {
    const now = new Date();
    const t = await issueDeviceSession(
      db,
      { audience: "customer", subjectId: customerId },
      "Phone",
      now,
    );
    const results = await Promise.all([
      reason(refreshDeviceSession(db, t.refreshToken, now)),
      reason(refreshDeviceSession(db, t.refreshToken, now)),
    ]);
    expect(results).toContain("refresh_reused");
    expect(await sessionExists(t.sessionId)).toBe(false);
  });

  it("a forged refresh token is refused and ends nothing", async () => {
    const now = new Date();
    const t = await issueDeviceSession(
      db,
      { audience: "customer", subjectId: customerId },
      "Phone",
      now,
    );
    const forged = `${t.refreshToken.slice(0, t.refreshToken.indexOf("."))}.forged`;
    expect(await reason(refreshDeviceSession(db, forged, now))).toBe("token_invalid");
    expect(await sessionExists(t.sessionId)).toBe(true);
  });

  it("a session unused past the setting is ended; the setting is a human admin's", async () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const t = await issueDeviceSession(
      db,
      { audience: "customer", subjectId: customerId },
      "Old phone",
      start,
    );
    // 90 days by default: on day 89 it still refreshes.
    const day89 = new Date(start.getTime() + 89 * 86_400_000);
    const t2 = await refreshDeviceSession(db, t.refreshToken, day89);
    const day180 = new Date(day89.getTime() + 91 * 86_400_000);
    expect(await reason(refreshDeviceSession(db, t2.refreshToken, day180))).toBe("session_idle");
    expect(await sessionExists(t.sessionId)).toBe(false);

    // A shorter period, set by a human admin, ends sessions sooner.
    await expect(
      invoke("deviceSession.settings.update", { idleDays: 7 }, context(admin, { actor: "mcp" })),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      invoke("deviceSession.settings.update", { idleDays: 7 }, context(member)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await invoke("deviceSession.settings.update", { idleDays: 7 }, context(admin));
    expect(await invoke("deviceSession.settings.get", {}, context(member))).toEqual({
      idleDays: 7,
    });
    const t3 = await issueDeviceSession(
      db,
      { audience: "customer", subjectId: customerId },
      "Phone",
      start,
    );
    const day8 = new Date(start.getTime() + 8 * 86_400_000);
    expect(await reason(resolveAccessToken(db, t3.accessToken, day8))).toBe("session_idle");
    await invoke("deviceSession.settings.update", { idleDays: 90 }, context(admin));
  });
});

describe("listing and ending one's own sessions, by device name", () => {
  it("staff see and end only their own", async () => {
    const now = new Date();
    const mine = await issueDeviceSession(
      db,
      { audience: "staff", subjectId: member.id },
      "Member's iPad",
      now,
    );
    const theirs = await issueDeviceSession(
      db,
      { audience: "staff", subjectId: admin.id },
      "Admin's phone",
      now,
    );
    const list = await invoke("deviceSession.list", {}, context(member));
    expect(list.items.map((s) => s.deviceName)).toContain("Member's iPad");
    expect(list.items.map((s) => s.id)).not.toContain(theirs.sessionId);
    await expect(
      invoke("deviceSession.revoke", { id: theirs.sessionId }, context(member)),
    ).rejects.toMatchObject({ code: "not_found" });
    await invoke("deviceSession.revoke", { id: mine.sessionId }, context(member));
    expect(await sessionExists(mine.sessionId)).toBe(false);
    expect(await sessionExists(theirs.sessionId)).toBe(true);
  });

  it("a customer sees their device sessions in me.sessions.list and ends one there", async () => {
    const now = new Date();
    const t = await issueDeviceSession(
      db,
      { audience: "customer", subjectId: customerId },
      "Ada's iPhone",
      now,
    );
    const me = {
      principal: { kind: "customer" as const, customerId, personId },
      db,
      origin: { surface: "client" as const, sessionId: t.sessionId },
    };
    const list = await invoke("me.sessions.list", {}, me);
    const device = list.items.find((s) => s.id === t.sessionId);
    expect(device).toMatchObject({ kind: "device", deviceName: "Ada's iPhone", current: true });
    await invoke("me.sessions.revoke", { id: t.sessionId }, me);
    expect(await sessionExists(t.sessionId)).toBe(false);
  });

  it("disabling a customer ends their device sessions", async () => {
    const now = new Date();
    const t = await issueDeviceSession(
      db,
      { audience: "customer", subjectId: customerId },
      "Phone",
      now,
    );
    await invoke("customer.disable", { id: customerId }, context(admin));
    expect(await sessionExists(t.sessionId)).toBe(false);
    await invoke("customer.enable", { id: customerId }, context(admin));
  });
});
