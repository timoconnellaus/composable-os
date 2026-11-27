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
  REFRESH_GRACE_MS,
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
    // Someone replays the first refresh token after the grace: the session ends, for the thief
    // and the owner.
    const later = new Date(now.getTime() + REFRESH_GRACE_MS + 1);
    expect(await reason(refreshDeviceSession(db, t1.refreshToken, later))).toBe("refresh_reused");
    expect(await sessionExists(t1.sessionId)).toBe(false);
    expect(await reason(resolveAccessToken(db, t2.accessToken, now))).toBe("token_invalid");
    expect(await reason(refreshDeviceSession(db, t2.refreshToken, now))).toBe("session_ended");
  });

  it("the same refresh token sent twice at once gets one rotation: both answers are the same tokens", async () => {
    const now = new Date();
    const t = await issueDeviceSession(
      db,
      { audience: "customer", subjectId: customerId },
      "Phone",
      now,
    );
    const [a, b] = await Promise.all([
      refreshDeviceSession(db, t.refreshToken, now),
      refreshDeviceSession(db, t.refreshToken, now),
    ]);
    expect(a).toEqual(b);
    expect(await sessionExists(t.sessionId)).toBe(true);
    expect((await resolveAccessToken(db, a.accessToken, now)).sessionId).toBe(t.sessionId);
  });

  describe("a refresh whose answer was lost (ADR 0419, amended 2026-11-27)", () => {
    const start = () =>
      issueDeviceSession(db, { audience: "customer", subjectId: customerId }, "Phone", new Date());

    it("the token just rotated past, sent again within the grace, gets the same tokens: no second rotation", async () => {
      const t1 = await start();
      const at = new Date();
      const t2 = await refreshDeviceSession(db, t1.refreshToken, at);
      // The answer never reached the phone; it tries again with t1, 59 seconds on.
      const again = await refreshDeviceSession(
        db,
        t1.refreshToken,
        new Date(at.getTime() + REFRESH_GRACE_MS - 1_000),
      );
      expect(again).toEqual(t2);
      // Still signed in, on the one session: the tokens it now holds work, and refresh as usual.
      expect((await resolveAccessToken(db, again.accessToken, at)).sessionId).toBe(t1.sessionId);
      const t3 = await refreshDeviceSession(db, again.refreshToken, at);
      expect(t3.refreshToken).not.toBe(t2.refreshToken);
      expect(await sessionExists(t1.sessionId)).toBe(true);
    });

    it("the same token after the grace ends the session, as reuse always has", async () => {
      const t1 = await start();
      const at = new Date();
      const t2 = await refreshDeviceSession(db, t1.refreshToken, at);
      const late = new Date(at.getTime() + REFRESH_GRACE_MS + 1_000);
      expect(await reason(refreshDeviceSession(db, t1.refreshToken, late))).toBe("refresh_reused");
      expect(await sessionExists(t1.sessionId)).toBe(false);
      expect(await reason(refreshDeviceSession(db, t2.refreshToken, late))).toBe("session_ended");
    });

    it("a token two rotations back ends the session at once, inside any grace", async () => {
      const t1 = await start();
      const at = new Date();
      const t2 = await refreshDeviceSession(db, t1.refreshToken, at);
      await refreshDeviceSession(db, t2.refreshToken, at);
      expect(await reason(refreshDeviceSession(db, t1.refreshToken, at))).toBe("refresh_reused");
      expect(await sessionExists(t1.sessionId)).toBe(false);
    });

    it("the previous token gets nothing once the session has rotated on: only the current answer is kept", async () => {
      const t1 = await start();
      const at = new Date();
      const t2 = await refreshDeviceSession(db, t1.refreshToken, at);
      const t3 = await refreshDeviceSession(db, t2.refreshToken, at);
      // t2 is now the token just rotated past: it gets t3 again, and t1 (older) ends it.
      expect(await refreshDeviceSession(db, t2.refreshToken, at)).toEqual(t3);
      expect(await reason(refreshDeviceSession(db, t1.refreshToken, at))).toBe("refresh_reused");
    });

    it("keeps no token as given: the answer is sealed, and opens only with the previous token", async () => {
      const t1 = await start();
      const at = new Date();
      const t2 = await refreshDeviceSession(db, t1.refreshToken, at);
      const row = await db.query
        .selectFrom("core_device_session")
        .selectAll()
        .where("id", "=", t1.sessionId)
        .executeTakeFirstOrThrow();
      const stored = JSON.stringify(row);
      for (const secret of [t1.refreshToken, t2.refreshToken, t2.accessToken]) {
        expect(stored).not.toContain(secret);
        expect(stored).not.toContain(secret.slice(secret.indexOf(".") + 1));
      }
      // A forged token with the session's id cannot open it, and is refused as before.
      const forged = `${t1.refreshToken.slice(0, t1.refreshToken.indexOf("."))}.forged`;
      expect(await reason(refreshDeviceSession(db, forged, at))).toBe("token_invalid");
      expect(await sessionExists(t1.sessionId)).toBe(true);
    });
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
