// Stage 44 step 6 (ADR 0649) and stage 51 step 1 (ADR 0780): signing at the desk, on the
// enrolled device. An admin who is a person enrols a tablet (every admin told); the tablet claims
// its enrolment code at the desk origin and holds a credential that alone reads nothing; a person
// on the staff with agreements:desk (a coach granted it too) starts a session for a named Person
// on the device they chose; the tablet claims it with the code and the member signs what is due,
// recorded as their own acceptance at the desk, its session naming who started it and the device.
// The host keeps every limit from the rows: codes, lock-outs, rotation and its grace, clones,
// lapsing, the idle and total limits, and the heartbeat's bound. All text here is fixture text.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { deskMarks } from "../src/agreements/desk-marks.ts";
import {
  type ActingUser,
  coreRegistry,
  type DeskHost,
  invoke,
  invokeByName,
  type OutsideInvocationContext,
  staffAuthority,
} from "../src/index.ts";
import { publishAgreement } from "./agreement-fixtures.ts";
import { outside } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, refusal, unique } from "./helpers.ts";

const SECRET = "fixture-desk-secret-fixture-desk-secret";
const ORIGIN = "https://desk.crm.example.test";
const DESK: DeskHost = { secret: SECRET, origin: ORIGIN };
const POINT = `pd${Date.now().toString(36)}`;
const MINUTE = 60_000;

let admin: ActingUser;
let otherAdmin: ActingUser;
let member: ActingUser;

const staff = (user: ActingUser, extra: Parameters<typeof context>[1] = {}) =>
  context(user, { desk: DESK, ...extra });

/** A published document attached to the fixture point. */
async function liveDocument(
  kind: "waiver" | "terms" | "guardian" = "waiver",
  forWhom?: "everyone" | "dependants",
) {
  return publishAgreement((name, input) => invokeByName(name, input, context(admin)), kind, {
    title: unique("Doc"),
    points: [POINT],
    ...(forWhom ? { forWhom } : {}),
  });
}

async function person(options: { email?: string | null; given?: string } = {}) {
  const email = options.email === undefined ? `${unique("m")}@example.com` : options.email;
  const made = await invoke(
    "person.create",
    {
      givenName: options.given ?? "Sam",
      familyName: unique("Fixture"),
      ...(email ? { emails: [{ email }] } : {}),
    },
    context(admin),
  );
  return made.id as string;
}

/** A browser on the desk origin: its cookies, set only by answers that succeeded. */
class Tablet {
  credential: string | null = null;
  token: string | null = null;
  userAgent = "Fixture tablet browser";
  address = "192.0.2.10";

  ctx(at?: Date, pending: { credential?: string; token?: string | null } = {}) {
    return outside({ kind: "public" }, {
      desk: {
        ...DESK,
        request: {
          credential: this.credential,
          token: this.token,
          userAgent: this.userAgent,
          address: this.address,
          issue: (cookies) => Object.assign(pending, cookies),
        },
      },
      ...(at ? { clock: () => at } : {}),
    } as Partial<OutsideInvocationContext>);
  }

  async call(name: string, input: unknown = {}, at?: Date): Promise<Record<string, unknown>> {
    const pending: { credential?: string; token?: string | null } = {};
    const result = await invokeByName(name, input, this.ctx(at, pending));
    if (pending.credential !== undefined) this.credential = pending.credential;
    if (pending.token !== undefined) this.token = pending.token;
    return result as Record<string, unknown>;
  }

  clone(): Tablet {
    const copy = new Tablet();
    copy.credential = this.credential;
    copy.token = this.token;
    return copy;
  }
}

/** An enrolled, claimed signing tablet. */
async function enrolled(name = unique("Front desk tablet")) {
  const made = await invoke("device.enrol", { name, use: "signing" }, staff(admin));
  const tablet = new Tablet();
  await tablet.call("device.claim", { code: made.code });
  return { tablet, deviceId: made.device.id as string };
}

async function start(
  personId: string,
  deviceId: string,
  by: ActingUser = admin,
  dependantIds?: string[],
) {
  return invoke(
    "agreement.desk.start",
    { personId, deviceId, ...(dependantIds ? { dependantIds } : {}) },
    staff(by),
  );
}

async function deviceRow(id: string) {
  return env.DB.prepare("SELECT * FROM core_device WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

async function sessionRow(id: string) {
  return env.DB.prepare("SELECT * FROM core_agreement_desk_session WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

beforeAll(async () => {
  admin = await createUser("admin");
  otherAdmin = await createUser("admin");
  member = await createUser("member");
  await reconcile(
    manifest(extId("desk"), {
      objects: {
        plan: {
          label: "Plan",
          plural: "Plans",
          titleField: "name",
          fields: { name: { type: "text", label: "Name", required: true } },
          agreements: { point: POINT, label: "Starting a plan" },
        },
      },
    }),
  );
}, 60_000);

describe("enrolling a device (ADR 0780)", () => {
  it("is an admin's who is a person, and every admin is told", async () => {
    const name = unique("Tablet");
    const made = await invoke("device.enrol", { name, use: "signing" }, staff(admin));
    expect(made.code).toMatch(/^[A-Z0-9]{10}$/);
    expect(made.enrolUrl).toBe(`${ORIGIN}/enrol`);
    expect(made.device.state).toBe("waiting");
    const told = await env.DB.prepare(
      "SELECT user_id FROM core_notifications WHERE title LIKE ? ORDER BY user_id",
    )
      .bind(`%enrolled a device, ${name}%`)
      .all<{ user_id: string }>();
    const ids = told.results.map((r) => r.user_id);
    expect(ids).toContain(admin.id);
    expect(ids).toContain(otherAdmin.id);
    expect(ids).not.toContain(member.id);
    // The code is never stored in the clear, nor in the audit.
    const row = await deviceRow(made.device.id);
    expect(JSON.stringify(row)).not.toContain(made.code);
    const audit = await env.DB.prepare(
      "SELECT input, result FROM core_audit WHERE operation = 'device.enrol' AND result LIKE ?",
    )
      .bind(`%${made.device.id}%`)
      .first<{ input: string; result: string }>();
    expect(`${audit?.input}${audit?.result}`).not.toContain(made.code);
  });

  it("a member, a coach granted agreements:desk and every AI actor are refused, and audited", async () => {
    expect(
      (await refusal(invoke("device.enrol", { name: "x", use: "signing" }, staff(member)))).code,
    ).toBe("forbidden");
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      const error = await refusal(
        invoke("device.enrol", { name: "x", use: "signing" }, staff(admin, { actor })),
      );
      expect(error.code).not.toBe(undefined);
    }
    const coach = await createUser("member");
    await env.DB.prepare(
      "UPDATE core_user SET pack_role = 'bookings.coach', role = 'viewer', granted_permissions = ? WHERE id = ?",
    )
      .bind(JSON.stringify(["agreements:desk"]), coach.id)
      .run();
    expect(
      (await refusal(invoke("device.enrol", { name: "x", use: "signing" }, staff(coach)))).code,
    ).toBe("forbidden");
    const { deviceId } = await enrolled();
    expect((await refusal(invoke("device.revoke", { deviceId }, staff(member)))).code).toBe(
      "forbidden",
    );
    expect(
      (await refusal(invoke("device.setUse", { deviceId, use: "signing" }, staff(member)))).code,
    ).toBe("forbidden");
    const refused = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_audit WHERE operation = 'device.enrol' AND outcome = 'forbidden' AND user_id = ?",
    )
      .bind(member.id)
      .first<{ n: number }>();
    expect(Number(refused?.n)).toBeGreaterThan(0);
  });

  it("refuses without the desk's secret and hostname, a till, and a role no pack declares", async () => {
    expect(
      (await refusal(invoke("device.enrol", { name: "x", use: "signing" }, context(admin)))).details
        ?.rule,
    ).toBe("desk_not_configured");
    expect(
      (await refusal(invoke("device.enrol", { name: "x", use: "till" }, staff(admin)))).details
        ?.rule,
    ).toBe("device_use");
    expect(
      (
        await refusal(
          invoke(
            "device.enrol",
            { name: "x", use: "role", role: "bookings.checkin" },
            staff(admin),
          ),
        )
      ).details?.rule,
    ).toBe("device_role");
  });

  it("the tablet claims the code once, within 10 minutes, and gets a credential in a cookie", async () => {
    const made = await invoke("device.enrol", { name: unique("T"), use: "signing" }, staff(admin));
    const tablet = new Tablet();
    const answer = await tablet.call("device.claim", { code: made.code.toLowerCase() });
    expect(answer).toEqual({ name: made.device.name, use: "signing" });
    expect(tablet.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(answer)).not.toContain(tablet.credential);
    const row = await deviceRow(made.device.id);
    expect(row?.credential_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(tablet.credential);
    expect(row?.claim_user_agent).toBe("Fixture tablet browser");
    // Used once.
    const second = new Tablet();
    expect((await refusal(second.call("device.claim", { code: made.code }))).details?.rule).toBe(
      "device_code",
    );
    // Run out.
    const late = await invoke("device.enrol", { name: unique("T"), use: "signing" }, staff(admin));
    expect(
      (
        await refusal(
          new Tablet().call(
            "device.claim",
            { code: late.code },
            new Date(Date.now() + 11 * MINUTE),
          ),
        )
      ).details?.rule,
    ).toBe("device_code");
    expect((await tablet.call("desk.status")).enrolled).toBe(true);
    expect((await new Tablet().call("desk.status")).enrolled).toBe(false);
  });

  it("the desk calls exist only for the desk origin's handler", async () => {
    const plain = outside({ kind: "public" });
    for (const name of ["device.claim", "desk.claim", "desk.documents", "desk.status"]) {
      expect((await refusal(invokeByName(name, {}, plain))).code).toBe("unknown_operation");
    }
    // And a desk request reaches nothing else.
    const tablet = new Tablet();
    expect((await refusal(invokeByName("agreement.guestVersions", {}, tablet.ctx()))).code).toBe(
      "unknown_operation",
    );
    // None of them is a staff operation either.
    expect((await refusal(invoke("desk.status" as never, {} as never, staff(admin)))).code).toBe(
      "unknown_operation",
    );
  });
});

describe("starting a session (agreements:desk, a person)", () => {
  it("answers a code and pins the address; refuses who may not and whom it may not be for", async () => {
    await liveDocument();
    const { deviceId } = await enrolled();
    const signer = await person();
    const started = await start(signer, deviceId);
    expect(started.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(started.session.state).toBe("waiting");
    const row = await sessionRow(started.session.id);
    expect(row?.email).toMatch(/@example\.com$/);
    expect(JSON.stringify(row)).not.toContain(started.code);

    // A member without the permission; every AI actor.
    expect((await refusal(start(signer, deviceId, member))).code).toBe("forbidden");
    for (const actor of ["assistant", "mcp"] as const) {
      expect(
        (
          await refusal(
            invoke("agreement.desk.start", { personId: signer, deviceId }, staff(admin, { actor })),
          )
        ).code,
      ).not.toBe(undefined);
    }
    // In the Trash; a minor for themselves; no address; a child not linked; a revoked device.
    const trashed = await person();
    await invoke("person.delete", { id: trashed }, context(admin));
    expect((await refusal(start(trashed, deviceId))).code).toBe("not_found");
    const minor = await person();
    await invoke("agreement.setMinor", { personId: minor, minor: true }, context(admin));
    expect((await refusal(start(minor, deviceId))).details?.rule).toBe("agreement_minor");
    const noAddress = await person({ email: null });
    expect((await refusal(start(noAddress, deviceId))).details?.rule).toBe("desk_no_address");
    const stranger = await person();
    expect((await refusal(start(signer, deviceId, admin, [stranger]))).code).toBe("not_found");
    const gone = await enrolled();
    await invoke("device.revoke", { deviceId: gone.deviceId }, staff(admin));
    expect((await refusal(start(signer, gone.deviceId))).details?.rule).toBe("device_use");
  });

  it("a coach (a pack role) granted agreements:desk may start one, and reaches nothing more", async () => {
    const coach = await createUser("member");
    await env.DB.prepare(
      "UPDATE core_user SET pack_role = 'bookings.coach', role = 'viewer', granted_permissions = ? WHERE id = ?",
    )
      .bind(JSON.stringify(["agreements:desk"]), coach.id)
      .run();
    const { deviceId } = await enrolled();
    const started = await start(await person(), deviceId, coach);
    expect(started.session.state).toBe("waiting");
    // Registry-wide: the grant opens exactly the agreements:desk operations.
    const rights = {
      packRole: {
        name: "bookings.coach",
        extension: "bookings",
        label: "Coach",
        permissions: [],
        read: [],
      },
      grants: ["agreements:desk"],
    };
    // Registry-wide: the grant adds exactly the agreements:desk operations to what the role
    // reaches without it (every pack role's own core reads, such as screens.mine).
    const reach = (grants: string[]) =>
      coreRegistry
        .list()
        .filter((op) => staffAuthority({ role: "viewer" }, { ...rights, grants }, op, {}) !== null)
        .map((op) => op.name);
    const without = new Set(reach([]));
    expect(without.has("screens.mine")).toBe(true);
    expect(
      reach(["agreements:desk"])
        .filter((name) => !without.has(name))
        .sort(),
    ).toEqual([
      "agreement.desk.devices",
      "agreement.desk.end",
      "agreement.desk.find",
      "agreement.desk.get",
      "agreement.desk.prepare",
      "agreement.desk.start",
    ]);
  });
});

describe("claiming a session on the tablet", () => {
  it("the credential alone reads nothing; the claim binds the session, rotates the credential and sets the token", async () => {
    const doc = await liveDocument();
    const { tablet, deviceId } = await enrolled();
    expect((await refusal(tablet.call("desk.documents"))).details?.rule).toBe("desk_session_ended");
    const signer = await person({ given: "Robin" });
    const { code, session } = await start(signer, deviceId);
    const before = tablet.credential;
    const greeting = await tablet.call("desk.claim", { code });
    expect(greeting.signer).toBe("Robin");
    expect(tablet.credential).not.toBe(before);
    expect(tablet.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(greeting)).not.toContain(tablet.token as string);
    const docs = await tablet.call("desk.documents");
    const items = docs.items as { version: { id: string }; forPersonId: string | null }[];
    expect(items.map((i) => i.version.id)).toContain(doc.versionId);
    expect(docs.copyTo).toMatch(/^m•••@e•••\.com$/);
    expect(
      (await invoke("agreement.desk.get", { sessionId: session.id }, staff(admin))).session,
    ).toMatchObject({
      state: "claimed",
      claimedOn: { id: deviceId },
    });
  });

  it("a claim from another device, or a wrong code on the chosen one, ends the session", async () => {
    const chosen = await enrolled();
    const other = await enrolled();
    const signer = await person();
    const first = await start(signer, chosen.deviceId);
    expect(
      (await refusal(other.tablet.call("desk.claim", { code: first.code }))).details?.rule,
    ).toBe("desk_wrong_device");
    const seen = (await invoke("agreement.desk.get", { sessionId: first.session.id }, staff(admin)))
      .session;
    expect(seen).toMatchObject({
      state: "ended",
      endReason: "wrong_device",
      claimedOn: { id: other.deviceId },
    });
    // Ended: the code claims nothing on the right device either.
    expect(
      (await refusal(chosen.tablet.call("desk.claim", { code: first.code }))).details?.rule,
    ).toBe("desk_code");
    const second = await start(signer, chosen.deviceId);
    await refusal(chosen.tablet.call("desk.claim", { code: "WRONGWRONG" }));
    expect((await sessionRow(second.session.id))?.end_reason).toBe("failed_claim");
  });

  it("five wrong codes in a minute lock the device for five minutes", async () => {
    const { tablet, deviceId } = await enrolled();
    for (let i = 0; i < 5; i++) await refusal(tablet.call("desk.claim", { code: `NOPE${i}` }));
    const { code } = await start(await person(), deviceId);
    expect((await refusal(tablet.call("desk.claim", { code }))).details?.rule).toBe("desk_locked");
    const sixLater = new Date(Date.now() + 6 * MINUTE);
    const later = await invoke(
      "agreement.desk.start",
      { personId: await person(), deviceId },
      staff(admin, { clock: () => sixLater }),
    );
    await tablet.call("desk.claim", { code: later.code }, sixLater);
    expect(tablet.token).not.toBe(null);
  });

  it("a retry within 60 seconds with the old credential and the code gets the same answer; later it is a clone", async () => {
    const { tablet, deviceId } = await enrolled();
    const { code, session } = await start(await person(), deviceId);
    const retry = tablet.clone();
    await tablet.call("desk.claim", { code });
    // The response was lost: the tablet tries again with what it had.
    await retry.call("desk.claim", { code });
    expect(retry.credential).toBe(tablet.credential);
    expect(retry.token).toBe(tablet.token);
    expect((await sessionRow(session.id))?.ended_at).toBe(null);
    // The next credential becomes the current one once the tablet presents it (its next claim);
    // the one after, once the tablet's next call presents that. The credential so rotated away,
    // presented after the grace window, means two browsers hold it.
    const next = await start(await person(), deviceId);
    const kept = tablet.credential;
    await tablet.call("desk.claim", { code: next.code });
    await tablet.call("desk.documents");
    const late = new Tablet();
    late.credential = kept;
    expect(
      (await refusal(late.call("desk.documents", {}, new Date(Date.now() + 2 * MINUTE)))).details
        ?.rule,
    ).toBe("device_not_enrolled");
    const row = await deviceRow(deviceId);
    expect(row?.revoke_reason).toBe("clone");
    expect((await sessionRow(next.session.id))?.end_reason).toBe("revoked");
    const told = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE dedupe_key = ?",
    )
      .bind(`device-clone:${deviceId}`)
      .first<{ n: number }>();
    expect(Number(told?.n)).toBeGreaterThanOrEqual(2);
    // Revoked: the tablet itself is refused at its next call.
    expect((await refusal(tablet.call("desk.documents"))).details?.rule).toBe(
      "device_not_enrolled",
    );
  });

  it("a device of another use cannot claim a signing session", async () => {
    const { tablet, deviceId } = await enrolled();
    const { code } = await start(await person(), deviceId);
    // A check-in tablet (stage 51 step 2 declares the role; set here as a row would hold it).
    await env.DB.prepare(
      "UPDATE core_device SET use = 'role', role = 'bookings.checkin' WHERE id = ?",
    )
      .bind(deviceId)
      .run();
    expect((await refusal(tablet.call("desk.claim", { code }))).details?.rule).toBe("device_use");
  });
});

describe("the session's limits, held by the host", () => {
  async function claimed() {
    await liveDocument();
    const { tablet, deviceId } = await enrolled();
    const signer = await person();
    const started = await start(signer, deviceId);
    const at = new Date();
    await tablet.call("desk.claim", { code: started.code }, at);
    return { tablet, deviceId, signer, session: started.session.id, at: at.getTime() };
  }

  it("3 minutes idle ends it on the server", async () => {
    const { tablet, session, at } = await claimed();
    await tablet.call("desk.documents", {}, new Date(at + 2 * MINUTE));
    expect(
      (await refusal(tablet.call("desk.documents", {}, new Date(at + 5.5 * MINUTE)))).details?.rule,
    ).toBe("desk_session_ended");
    expect((await sessionRow(session))?.end_reason).toBe("idle");
  });

  it("heartbeats keep it alive, but not faster than every 20 seconds and never past 20 minutes", async () => {
    const { tablet, session, at } = await claimed();
    for (let t = 1; t < 20; t += 2) {
      await tablet.call("desk.heartbeat", {}, new Date(at + t * MINUTE));
    }
    const row = await sessionRow(session);
    expect(Date.parse(row?.last_activity_at as string)).toBeGreaterThan(at + 18 * MINUTE);
    expect(
      (await refusal(tablet.call("desk.heartbeat", {}, new Date(at + 20.5 * MINUTE)))).details
        ?.rule,
    ).toBe("desk_session_ended");
    expect((await sessionRow(session))?.end_reason).toBe("limit");

    // A script beating every 10 seconds gains nothing over one beat per 20.
    const fast = await claimed();
    await fast.tablet.call("desk.heartbeat", {}, new Date(fast.at + 10_000));
    const unmoved = await sessionRow(fast.session);
    expect(unmoved?.last_activity_at).toBe(new Date(fast.at).toISOString());
  });

  it("a new claim on the device ends the session open on it", async () => {
    const { tablet, deviceId, session, at } = await claimed();
    const next = await start(await person(), deviceId);
    await tablet.call("desk.claim", { code: next.code }, new Date(at + 10_000));
    expect((await sessionRow(session))?.end_reason).toBe("replaced");
  });

  it("staff ending it, the tablet finishing, revoking the device and changing its use end it", async () => {
    const one = await claimed();
    await invoke("agreement.desk.end", { sessionId: one.session }, staff(admin));
    expect((await refusal(one.tablet.call("desk.documents"))).details?.rule).toBe(
      "desk_session_ended",
    );
    const two = await claimed();
    await two.tablet.call("desk.finish");
    expect(two.tablet.token).toBe(null);
    expect((await sessionRow(two.session))?.end_reason).toBe("finished");
    const three = await claimed();
    await invoke("device.revoke", { deviceId: three.deviceId }, staff(admin));
    expect((await sessionRow(three.session))?.end_reason).toBe("revoked");
    expect((await refusal(three.tablet.call("desk.documents"))).details?.rule).toBe(
      "device_not_enrolled",
    );
  });
});

describe("signing, and what the record says", () => {
  it("records the member's own acceptance at the desk with its session; only what is due, only theirs", async () => {
    const doc = await liveDocument();
    const { tablet, deviceId } = await enrolled(unique("Desk iPad"));
    const signer = await person();
    const started = await start(signer, deviceId);
    await tablet.call("desk.claim", { code: started.code });
    // Another Person's id, and a version not asked of them, are refused.
    const stranger = await person();
    expect(
      (
        await refusal(
          tablet.call("desk.accept", {
            versionId: doc.versionId,
            forPersonId: stranger,
            typedName: "Fixture Name",
          }),
        )
      ).code,
    ).toBe("not_found");
    expect(
      (
        await refusal(
          tablet.call("desk.accept", { versionId: "agv_nope", typedName: "Fixture Name" }),
        )
      ).details?.rule,
    ).toBe("agreement_not_asked");
    await tablet.call("desk.accept", { versionId: doc.versionId, typedName: "Fixture Name" });
    const row = await env.DB.prepare(
      "SELECT * FROM core_agreement_acceptance WHERE person_id = ? AND version_id = ?",
    )
      .bind(signer, doc.versionId)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      by: "self",
      channel: "desk",
      desk_session_id: started.session.id,
      account_id: null,
    });
    // The copy is queued to the pinned address.
    const copy = await env.DB.prepare(
      "SELECT to_address FROM core_agreement_copy WHERE acceptance_id = ?",
    )
      .bind(row?.id)
      .first<{ to_address: string }>();
    expect(copy?.to_address).toBe((await sessionRow(started.session.id))?.email);
    // Shown as the session records it: never "in person", never paper.
    const listed = await invoke(
      "agreement.acceptances",
      { channel: "desk", deviceId },
      context(admin),
    );
    const item = listed.items.find((i) => i.id === row?.id);
    expect(item?.desk?.words).toMatch(/^Agreed at the desk on the device enrolled as Desk iPad/);
    expect(item?.desk?.words).toContain("session started by admin user");
    expect(item?.desk?.words).not.toMatch(/in person|paper/);
    // Nothing left: the same version is not offered again.
    const after = await tablet.call("desk.documents");
    expect((after.items as { version: { id: string } }[]).map((i) => i.version.id)).not.toContain(
      doc.versionId,
    );
    // The database holds every writer to it: no desk acceptance without a claimed, open session.
    await expect(
      env.DB.prepare(
        "INSERT INTO core_agreement_acceptance (id, document_id, version_id, shown_hash, person_id, by, how, typed_name, channel, desk_session_id, accepted_at) SELECT 'aga_forged', document_id, version_id, shown_hash, person_id, 'self', how, 'x', 'desk', 'ads_nope', accepted_at FROM core_agreement_acceptance WHERE id = ?",
      )
        .bind(row?.id)
        .run(),
    ).rejects.toThrow(/core_agreement_acceptance_desk/);
  });

  it("a parent signs for a child the session lists, while the link is live", async () => {
    const doc = await liveDocument("guardian", "dependants");
    const { tablet, deviceId } = await enrolled();
    const parent = await person({ given: "Alex" });
    const child = await person({ email: null, given: "Kim" });
    const link = await invoke(
      "person.link.add",
      { guardianId: parent, dependantId: child },
      context(admin),
    );
    const started = await start(parent, deviceId, admin, [child]);
    const greeting = await tablet.call("desk.claim", { code: started.code });
    expect(greeting.children).toEqual(["Kim"]);
    const docs = await tablet.call("desk.documents");
    const forChild = (docs.items as { forPersonId: string | null; version: { id: string } }[]).find(
      (i) => i.forPersonId === child && i.version.id === doc.versionId,
    );
    expect(forChild?.version.id).toBe(doc.versionId);
    await invoke("person.link.end", { id: link.id }, context(admin));
    expect(
      (
        await refusal(
          tablet.call("desk.accept", {
            versionId: doc.versionId,
            forPersonId: child,
            typedName: "Alex",
          }),
        )
      ).details?.rule,
    ).toBe("agreement_not_asked");
  });

  it("the copy says what it proves and no more", async () => {
    const doc = await liveDocument();
    const { tablet, deviceId } = await enrolled(unique("Copy tablet"));
    const signer = await person();
    const started = await start(signer, deviceId);
    await tablet.call("desk.claim", { code: started.code });
    await tablet.call("desk.accept", { versionId: doc.versionId, typedName: "Fixture Name" });
    const { copyMessage } = await import("../src/agreements/copy.ts");
    const row = await env.DB.prepare(
      "SELECT id FROM core_agreement_acceptance WHERE desk_session_id = ?",
    )
      .bind(started.session.id)
      .first<{ id: string }>();
    const message = await copyMessage(db.query, row?.id as string);
    expect(message.text).toMatch(
      /was accepted for you at .*'s desk, on the device enrolled as Copy tablet/,
    );
    expect(message.text).toContain("in a session started by admin user");
    expect(message.text).toContain("If this was not you, reply to this email");
    expect(message.text).not.toMatch(/proves|in person/);
  });
});

describe("rotation, lapsing and erase", () => {
  it("rotates at least daily, and a device unused for 30 days is refused", async () => {
    const { tablet, deviceId } = await enrolled();
    const first = tablet.credential;
    await tablet
      .call("desk.documents", {}, new Date(Date.now() + 25 * 60 * MINUTE))
      .catch(() => {});
    // A refused call commits nothing of its own: the rotation goes with an answer that succeeds.
    expect(tablet.credential).toBe(first);
    const { code } = await start(await person(), deviceId);
    await tablet.call("desk.claim", { code });
    expect(tablet.credential).not.toBe(first);
    await refusal(tablet.call("desk.documents", {}, new Date(Date.now() + 31 * 24 * 60 * MINUTE)));
    expect((await deviceRow(deviceId))?.revoke_reason).toBe("lapsed");
  });

  it("the first call more than 24 hours after the last rotation gets a new credential", async () => {
    const { resolveDevice } = await import("../src/devices/devices.ts");
    const { tablet } = await enrolled();
    const issued: { credential?: string } = {};
    const request = {
      credential: tablet.credential,
      token: null,
      userAgent: "Another fixture browser",
      address: "198.51.100.7",
      issue: (c: { credential?: string }) => Object.assign(issued, c),
    };
    const soon = await resolveDevice(
      db.query,
      DESK,
      request,
      new Date(Date.now() + MINUTE).toISOString(),
    );
    expect(soon.rotated).toBe(false);
    const day = await resolveDevice(
      db.query,
      DESK,
      request,
      new Date(Date.now() + 25 * 60 * MINUTE).toISOString(),
    );
    expect(day.rotated).toBe(true);
    expect(issued.credential).toBeTruthy();
    await db.batch(day.statements);
    const row = await deviceRow(day.device.id);
    // A different browser and network at the rotation are flagged on the devices list.
    expect(JSON.parse(row?.flags as string).map((f: { kind: string }) => f.kind)).toEqual([
      "browser",
      "network",
    ]);
  });

  it("erase ends a Person's open session and keeps it detached", async () => {
    const { tablet, deviceId } = await enrolled();
    const signer = await person();
    const started = await start(signer, deviceId);
    await tablet.call("desk.claim", { code: started.code });
    await invoke("person.erase", { id: signer }, context(admin));
    const row = await sessionRow(started.session.id);
    expect(row).toMatchObject({ person_id: null, email: null, end_reason: "erased" });
    expect(row?.erased_at).not.toBe(null);
  });
});

describe("the marks on a desk acceptance", () => {
  it("created that day, and a staff account's address (by mailbox)", async () => {
    const walkIn = await person();
    // Signed just after the Person was made (a walk-in).
    const at = new Date(Date.now() + 1_000).toISOString();
    const marks = await deskMarks(db.query, [
      {
        id: "a1",
        personId: walkIn,
        email: admin.email.replace("@", "+desk@").toUpperCase(),
        acceptedAt: at,
      },
    ]);
    expect(
      marks
        .get("a1")
        ?.map((m) => m.kind)
        .sort(),
    ).toEqual(["created_that_day", "staff_address"]);
  });

  it("a primary address changed in the 30 days before or after, by any path the audit records", async () => {
    const signer = await person();
    const at = new Date().toISOString();
    await invoke(
      "person.update",
      { id: signer, emails: [{ email: `${unique("new")}@example.com` }] },
      context(admin),
    );
    const marks = await deskMarks(db.query, [
      { id: "a2", personId: signer, email: null, acceptedAt: at },
    ]);
    const change = marks.get("a2")?.find((m) => m.kind === "changed_recently");
    expect(change).toMatchObject({ by: "admin user", how: "person.update" });
  });
});

describe("cost", () => {
  it("documents and accept read a bounded number of statements, whatever the family", async () => {
    let statements = 0;
    const metered = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            statements += 1;
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const counted = createCrmDb(metered);
    const doc = await liveDocument("guardian", "dependants");
    const { tablet, deviceId } = await enrolled();
    const parent = await person();
    const children: string[] = [];
    for (let i = 0; i < 10; i++) {
      const child = await person({ email: null });
      await invoke("person.link.add", { guardianId: parent, dependantId: child }, context(admin));
      children.push(child);
    }
    const started = await start(parent, deviceId, admin, children);
    await tablet.call("desk.claim", { code: started.code });
    const ctx = (pending = {}) => ({ ...tablet.ctx(undefined, pending), db: counted });
    statements = 0;
    await invokeByName("desk.documents", {}, ctx());
    // Per person a handful of reads (facts, documents, acceptances, versions): bounded by the
    // family's size (at most 10 children), never by the host's size.
    expect(statements).toBeLessThan(150);
    statements = 0;
    await invokeByName(
      "desk.accept",
      { versionId: doc.versionId, forPersonId: children[0], typedName: "Fixture Parent" },
      ctx(),
    );
    expect(statements).toBeLessThan(200);
  });
});

describe("after the review of PR #390", () => {
  it("wrong codes sent at once each count: twelve together lock the device", async () => {
    const { tablet, deviceId } = await enrolled();
    await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => tablet.call("desk.claim", { code: `NOPE${i}X` })),
    );
    const row = await deviceRow(deviceId);
    expect(row?.locked_until).not.toBe(null);
  });

  it("a claim that loses a race to the session's end is refused, never answered with a dead token", async () => {
    const { claimSession, endStatement } = await import("../src/agreements/desk.ts");
    const { runNow } = await import("../src/devices/devices.ts");
    const { tablet, deviceId } = await enrolled();
    const other = await enrolled();
    const { code, session } = await start(await person(), deviceId);
    const issued: { credential?: string; token?: string | null } = {};
    const claim = await claimSession(
      db.query,
      DESK,
      {
        credential: tablet.credential,
        token: null,
        userAgent: tablet.userAgent,
        address: tablet.address,
        issue: (c) => Object.assign(issued, c),
      },
      code,
      new Date().toISOString(),
    );
    // Another device's claim of the same code commits first and ends the session.
    await runNow(db.query, [
      endStatement(db.query, session.id, "wrong_device", new Date().toISOString(), other.deviceId),
    ]);
    await expect(db.batch(claim.statements)).rejects.toThrow(/core_agreement_desk_claim_lost/);
    expect((await sessionRow(session.id))?.end_reason).toBe("wrong_device");
  });

  it("two browsers claiming one enrolment code at once: one is enrolled, the other refused", async () => {
    const made = await invoke("device.enrol", { name: unique("T"), use: "signing" }, staff(admin));
    const [a, b] = [new Tablet(), new Tablet()];
    const results = await Promise.allSettled([
      a.call("device.claim", { code: made.code }),
      b.call("device.claim", { code: made.code }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const statuses = [await a.call("desk.status"), await b.call("desk.status")].map(
      (s) => s.enrolled,
    );
    expect(statuses.sort()).toEqual([false, true]);
  });

  it("an answer lost on a rotation never makes a healthy tablet look copied", async () => {
    const { tablet, deviceId } = await enrolled();
    const { code } = await start(await person(), deviceId);
    const before = tablet.clone();
    await tablet.call("desk.claim", { code });
    // The claim's answer never arrived: the tablet still holds its old credential and no token,
    // and is offline for five minutes.
    const later = new Date(Date.now() + 5 * MINUTE);
    expect((await before.call("desk.status", {}, later)).enrolled).toBe(true);
    const again = await invoke(
      "agreement.desk.start",
      { personId: await person(), deviceId },
      staff(admin, { clock: () => later }),
    );
    await before.call("desk.claim", { code: again.code }, later);
    expect(before.credential).toBe(tablet.credential);
    expect((await deviceRow(deviceId))?.revoked_at).toBe(null);
  });

  it("a device unused for 30 days is not enrolled anywhere it is shown, nor offered", async () => {
    const { tablet, deviceId } = await enrolled(unique("Idle tablet"));
    const month = new Date(Date.now() + 31 * 24 * 60 * MINUTE);
    const later = (extra: Parameters<typeof context>[1] = {}) =>
      staff(admin, { clock: () => month, ...extra });
    expect((await tablet.call("desk.status", {}, month)).enrolled).toBe(false);
    const offered = await invoke("agreement.desk.devices", {}, later());
    expect(offered.devices.map((d) => d.id)).not.toContain(deviceId);
    expect(
      (
        await refusal(
          invoke("agreement.desk.start", { personId: await person(), deviceId }, later()),
        )
      ).details?.rule,
    ).toBe("device_use");
    const listed = await invoke("device.list", {}, later());
    expect(listed.devices.find((d) => d.id === deviceId)?.state).toBe("lapsed");
  });

  it("finding a Person takes their full name or an address exactly, lists nobody else, and is audited", async () => {
    const family = unique("Exactname");
    const email = `${unique("found")}@example.com`;
    const made = await invoke(
      "person.create",
      { givenName: "Quinn", familyName: family, emails: [{ email }] },
      context(admin),
    );
    const find = (query: string) => invoke("agreement.desk.find", { query }, staff(admin));
    expect((await find(family.slice(0, 6))).people).toEqual([]);
    expect((await find("Quinn")).people).toEqual([]);
    expect((await find(`quinn ${family.toLowerCase()}`)).people.map((p) => p.personId)).toEqual([
      made.id,
    ]);
    expect((await find(email.toUpperCase())).people.map((p) => p.personId)).toEqual([made.id]);
    const audited = await env.DB.prepare(
      "SELECT input FROM core_audit WHERE operation = 'agreement.desk.find' AND user_id = ? ORDER BY at DESC LIMIT 1",
    )
      .bind(admin.id)
      .first<{ input: string }>();
    expect(audited).not.toBe(null);
    expect(audited?.input).not.toContain(email);
  });

  it("preparing names the children by given name only", async () => {
    const parent = await person();
    const child = await invoke(
      "person.create",
      { givenName: "Kit", familyName: unique("Childfamily") },
      context(admin),
    );
    await invoke("person.link.add", { guardianId: parent, dependantId: child.id }, context(admin));
    const prepared = await invoke("agreement.desk.prepare", { personId: parent }, staff(admin));
    expect(prepared.dependants.map((d) => d.name)).toEqual(["Kit"]);
  });

  it("a session is watched and ended by whoever started it, or an admin; nobody else", async () => {
    const { deviceId } = await enrolled();
    const started = await start(await person(), deviceId);
    const granted = await createUser("member");
    await env.DB.prepare("UPDATE core_user SET granted_permissions = ? WHERE id = ?")
      .bind(JSON.stringify(["agreements:desk"]), granted.id)
      .run();
    const sessionId = started.session.id;
    expect((await refusal(invoke("agreement.desk.get", { sessionId }, staff(granted)))).code).toBe(
      "not_found",
    );
    expect((await refusal(invoke("agreement.desk.end", { sessionId }, staff(granted)))).code).toBe(
      "not_found",
    );
    expect((await sessionRow(sessionId))?.ended_at).toBe(null);
    const mine = await start(await person(), deviceId, granted);
    expect(
      (await invoke("agreement.desk.get", { sessionId: mine.session.id }, staff(granted))).session
        .state,
    ).toBe("waiting");
    expect(
      (await invoke("agreement.desk.get", { sessionId: mine.session.id }, staff(admin))).session
        .state,
    ).toBe("waiting");
  });

  it("a session started for someone whose address changed recently tells every admin", async () => {
    const { deviceId } = await enrolled();
    const signer = await person();
    await invoke(
      "person.update",
      { id: signer, emails: [{ email: `${unique("changed")}@example.com` }] },
      context(admin),
    );
    const before = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE user_id = ? AND title = 'A desk signing session was started for someone whose address changed recently'",
    )
      .bind(otherAdmin.id)
      .first<{ n: number }>();
    await start(signer, deviceId);
    const after = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE user_id = ? AND title = 'A desk signing session was started for someone whose address changed recently'",
    )
      .bind(otherAdmin.id)
      .first<{ n: number }>();
    expect(Number(after?.n)).toBe(Number(before?.n) + 1);
  });

  it("the device list is a person's: an AI actor acting for an admin is refused", async () => {
    expect(
      (await refusal(invoke("device.list", {}, staff(admin, { actor: "assistant" })))).code,
    ).not.toBe(undefined);
  });

  it("the mark filter reads past a page of unmarked acceptances", async () => {
    const doc = await liveDocument();
    const { tablet, deviceId } = await enrolled();
    // A signer whose address is a staff account's: marked.
    const marked = await person({ email: `${unique("staffbox")}@example.com` });
    const box = (await env.DB.prepare("SELECT email FROM core_person_emails WHERE person_id = ?")
      .bind(marked)
      .first<{ email: string }>()) as { email: string };
    const staffer = await createUser("member");
    await env.DB.prepare("UPDATE core_user SET email = ? WHERE id = ?")
      .bind(box.email, staffer.id)
      .run();
    const one = await start(marked, deviceId);
    await tablet.call("desk.claim", { code: one.code });
    await tablet.call("desk.accept", { versionId: doc.versionId, typedName: "Fixture Name" });
    // Then newer unmarked desk acceptances, more than a page of the list's limit.
    for (let i = 0; i < 3; i++) {
      const plain = await start(await person(), deviceId);
      await tablet.call("desk.claim", { code: plain.code });
      await tablet.call("desk.accept", { versionId: doc.versionId, typedName: "Fixture Name" });
    }
    const listed = await invoke(
      "agreement.acceptances",
      { mark: "staff_address", deviceId, limit: 2 },
      context(admin),
    );
    expect(listed.items.map((i) => i.personId)).toContain(marked);
  });
});
