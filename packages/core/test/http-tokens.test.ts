// Stage 23, acceptance criterion 4 (ADR 0419): sessions for native apps. A reused refresh token
// ends the session; a session unused past the setting is ended; tokens are one audience's; a
// person lists and ends their own sessions by device name.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_TTL_MS,
  type ActingUser,
  clearStaleGraceSeals,
  DEVICE_REFRESH_REPLAYED_AUDIT,
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
    const rowOf = (id: string) =>
      db.query
        .selectFrom("core_device_session")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    const replays = async (sessionId: string) =>
      (
        await db.query
          .selectFrom("core_audit")
          .select(["operation", "actor", "user_id", "origin", "input", "result"])
          .where("operation", "=", DEVICE_REFRESH_REPLAYED_AUDIT)
          .where("input", "like", `%${sessionId}%`)
          .execute()
      ).map((row) => ({ ...row, origin: JSON.parse(row.origin ?? "{}") }));
    const seconds = (at: Date, n: number) => new Date(at.getTime() + n * 1000);

    it("the token just rotated past, sent again before its answer is used, gets the same tokens once, audited", async () => {
      const t1 = await start();
      const at = new Date();
      const t2 = await refreshDeviceSession(db, t1.refreshToken, at);
      expect((await rowOf(t1.sessionId)).successor_sealed).toBeTruthy();
      // The answer never reached the phone; it tries again with t1, 59 seconds on.
      const again = await refreshDeviceSession(db, t1.refreshToken, seconds(at, 59));
      expect(again).toEqual(t2);
      const row = await rowOf(t1.sessionId);
      expect(row.successor_sealed).toBeNull();
      expect(row.grace_answered_at).toBeTruthy();
      // Audited: who, which session, when; no token.
      const audit = await replays(t1.sessionId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor: "customer",
        user_id: customerId,
        origin: { surface: "client", sessionId: t1.sessionId },
      });
      const written = JSON.stringify(audit);
      for (const secret of [t1.refreshToken, t2.refreshToken, t2.accessToken]) {
        expect(written).not.toContain(secret);
      }
      // Still signed in on the one session: its tokens work and refresh as usual.
      expect((await resolveAccessToken(db, again.accessToken, at)).sessionId).toBe(t1.sessionId);
      const t3 = await refreshDeviceSession(db, again.refreshToken, at);
      expect(t3.refreshToken).not.toBe(t2.refreshToken);
      expect(await sessionExists(t1.sessionId)).toBe(true);
    });

    it("is given once: the same token a third time ends the session (the answer lost twice: signed out, as before)", async () => {
      const t1 = await start();
      const at = new Date();
      await refreshDeviceSession(db, t1.refreshToken, at);
      await refreshDeviceSession(db, t1.refreshToken, seconds(at, 5));
      expect(await reason(refreshDeviceSession(db, t1.refreshToken, seconds(at, 10)))).toBe(
        "refresh_reused",
      );
      expect(await sessionExists(t1.sessionId)).toBe(false);
      expect(await replays(t1.sessionId)).toHaveLength(1);
    });

    it("is not given once the answer's access token has been used: the seal is cleared at its first use", async () => {
      const t1 = await start();
      const at = new Date();
      const t2 = await refreshDeviceSession(db, t1.refreshToken, at);
      await resolveAccessToken(db, t2.accessToken, at);
      expect((await rowOf(t1.sessionId)).successor_sealed).toBeNull();
      expect(await reason(refreshDeviceSession(db, t1.refreshToken, seconds(at, 1)))).toBe(
        "refresh_reused",
      );
      expect(await sessionExists(t1.sessionId)).toBe(false);
      expect(await replays(t1.sessionId)).toHaveLength(0);
    });

    it("is not given once the answer's refresh token has been used, and a token two rotations back ends the session at once", async () => {
      const t1 = await start();
      const at = new Date();
      const t2 = await refreshDeviceSession(db, t1.refreshToken, at);
      const t3 = await refreshDeviceSession(db, t2.refreshToken, at);
      // The seal now is t3's, for t2 only.
      const row = await rowOf(t1.sessionId);
      expect(row.previous_refresh_hash).not.toBeNull();
      expect(await reason(refreshDeviceSession(db, t1.refreshToken, at))).toBe("refresh_reused");
      expect(await sessionExists(t1.sessionId)).toBe(false);
      expect(await reason(resolveAccessToken(db, t3.accessToken, at))).toBe("token_invalid");
    });

    it("is not given after the window, which ends the session as reuse; the daily run clears a seal past it", async () => {
      const t1 = await start();
      const at = new Date();
      const t2 = await refreshDeviceSession(db, t1.refreshToken, at);
      expect(await reason(refreshDeviceSession(db, t1.refreshToken, seconds(at, 61)))).toBe(
        "refresh_reused",
      );
      expect(await sessionExists(t1.sessionId)).toBe(false);
      expect(await reason(refreshDeviceSession(db, t2.refreshToken, at))).toBe("session_ended");

      // A device that never came back: its seal is cleared once the window has passed.
      const u1 = await start();
      const when = new Date();
      await refreshDeviceSession(db, u1.refreshToken, when);
      expect(await clearStaleGraceSeals(db, seconds(when, 30))).toBe(0);
      expect((await rowOf(u1.sessionId)).successor_sealed).toBeTruthy();
      expect(await clearStaleGraceSeals(db, seconds(when, 61))).toBeGreaterThanOrEqual(1);
      expect((await rowOf(u1.sessionId)).successor_sealed).toBeNull();
    });

    it("is given once in a session's life: a second lost answer, rotations later, ends the session", async () => {
      const t1 = await start();
      const at = new Date();
      const t2 = await refreshDeviceSession(db, t1.refreshToken, at);
      await refreshDeviceSession(db, t1.refreshToken, seconds(at, 2));
      await resolveAccessToken(db, t2.accessToken, at);
      const t3 = await refreshDeviceSession(db, t2.refreshToken, seconds(at, 600));
      // No seal is kept for a session that has had its answer again.
      expect((await rowOf(t1.sessionId)).successor_sealed).toBeNull();
      expect(await reason(refreshDeviceSession(db, t2.refreshToken, seconds(at, 601)))).toBe(
        "refresh_reused",
      );
      expect(await sessionExists(t1.sessionId)).toBe(false);
      expect(t3.sessionId).toBe(t1.sessionId);
    });

    it("keeps no token as given, and a forged token opens nothing", async () => {
      const t1 = await start();
      const at = new Date();
      const t2 = await refreshDeviceSession(db, t1.refreshToken, at);
      const stored = JSON.stringify(await rowOf(t1.sessionId));
      for (const secret of [t1.refreshToken, t2.refreshToken, t2.accessToken]) {
        expect(stored).not.toContain(secret);
        expect(stored).not.toContain(secret.slice(secret.indexOf(".") + 1));
      }
      const forged = `${t1.refreshToken.slice(0, t1.refreshToken.indexOf("."))}.forged`;
      expect(await reason(refreshDeviceSession(db, forged, at))).toBe("token_invalid");
      expect(await sessionExists(t1.sessionId)).toBe(true);
    });

    describe("a thief replaying the previous token (each interleaving)", () => {
      it("device used its answer first: the thief's replay ends the session for both", async () => {
        const r1 = await start();
        const at = new Date();
        const device = await refreshDeviceSession(db, r1.refreshToken, at);
        await resolveAccessToken(db, device.accessToken, at);
        expect(await reason(refreshDeviceSession(db, r1.refreshToken, seconds(at, 3)))).toBe(
          "refresh_reused",
        );
        expect(await reason(resolveAccessToken(db, device.accessToken, at))).toBe("token_invalid");
        expect(await replays(r1.sessionId)).toHaveLength(0);
      });

      it("the device's answer was lost and the thief replays first: the thief gets it, audited; the device's retry ends the session", async () => {
        const r1 = await start();
        const at = new Date();
        const lost = await refreshDeviceSession(db, r1.refreshToken, at);
        const thief = await refreshDeviceSession(db, r1.refreshToken, seconds(at, 2));
        expect(thief).toEqual(lost);
        expect(await replays(r1.sessionId)).toHaveLength(1);
        expect(await reason(refreshDeviceSession(db, r1.refreshToken, seconds(at, 4)))).toBe(
          "refresh_reused",
        );
        expect(await reason(resolveAccessToken(db, thief.accessToken, at))).toBe("token_invalid");
      });

      it("the device has its answer but has not used it, and the thief replays: both hold live tokens, audited, until the next rotation ends the session", async () => {
        const r1 = await start();
        const at = new Date();
        const device = await refreshDeviceSession(db, r1.refreshToken, at);
        const thief = await refreshDeviceSession(db, r1.refreshToken, seconds(at, 1));
        // Undetected for now: the same live tokens in two hands. Audited.
        expect(thief).toEqual(device);
        expect(await replays(r1.sessionId)).toHaveLength(1);
        expect((await resolveAccessToken(db, device.accessToken, at)).sessionId).toBe(r1.sessionId);
        // The device's next refresh rotates; the thief's next presentation of the old one ends it.
        const next = await refreshDeviceSession(db, device.refreshToken, seconds(at, 570));
        await resolveAccessToken(db, next.accessToken, seconds(at, 570));
        expect(await reason(resolveAccessToken(db, thief.accessToken, seconds(at, 571)))).toBe(
          "token_invalid",
        );
        expect(await reason(refreshDeviceSession(db, thief.refreshToken, seconds(at, 572)))).toBe(
          "refresh_reused",
        );
        expect(await sessionExists(r1.sessionId)).toBe(false);
      });

      it("the thief refreshes a stolen current token first: the device's own refresh gets the same answer once, audited, then the next rotation ends the session", async () => {
        const r1 = await start();
        const at = new Date();
        const thief = await refreshDeviceSession(db, r1.refreshToken, at);
        const device = await refreshDeviceSession(db, r1.refreshToken, seconds(at, 20));
        expect(device).toEqual(thief);
        expect(await replays(r1.sessionId)).toHaveLength(1);
        const next = await refreshDeviceSession(db, thief.refreshToken, seconds(at, 300));
        await resolveAccessToken(db, next.accessToken, seconds(at, 300));
        expect(await reason(refreshDeviceSession(db, device.refreshToken, seconds(at, 570)))).toBe(
          "refresh_reused",
        );
        expect(await sessionExists(r1.sessionId)).toBe(false);
      });

      it("the thief refreshes a stolen current token and uses it: the device's refresh ends the session, as before", async () => {
        const r1 = await start();
        const at = new Date();
        const thief = await refreshDeviceSession(db, r1.refreshToken, at);
        await resolveAccessToken(db, thief.accessToken, at);
        expect(await reason(refreshDeviceSession(db, r1.refreshToken, seconds(at, 20)))).toBe(
          "refresh_reused",
        );
        expect(await sessionExists(r1.sessionId)).toBe(false);
      });
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
