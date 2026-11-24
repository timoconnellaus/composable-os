// The enrolled device (stage 51 step 1, built with stage 44 step 6; ADR 0780): a tablet or other
// browser a human admin enrolled as the business's own, for one use (signing, a device role, a
// till), and how the host knows it on each call.
//
// The device holds one thing: a credential (256 random bits) in a cookie on the desk origin, set
// when it was claimed with the admin's enrolment code. The host keeps its HMAC (secret.ts).
//
// On each call (`resolveDevice`):
//   - the current credential: the device. Its first call more than 24 hours after the last
//     rotation, and every call that asks to rotate (a signing claim), gets the next credential in
//     its response (`nextCredential` of the presented one), kept as pending: the current one
//     stays good, and every answer re-issues the same next one, until the device presents it;
//   - the pending one: it becomes the current one, and the old one is rotated away;
//   - the credential rotated away, within 60 seconds of that (the grace window): the device, and
//     the current credential again (calls made at once);
//   - the credential rotated away, later: two browsers hold it. The device is revoked as a clone
//     (its open signing session ends with it, migration 1130) and every admin is told;
//   - a device with no call for 30 days lapses (revoked, `lapsed`); an admin enrols it again;
//   - anything else: not an enrolled device.
// The browser (user agent) and the network address are recorded at the claim and at each
// rotation; a change from the last is flagged on the devices list (stage 44: the business's own
// tablet and premises, not a member's device).
//
// A refusal that must still change something (a clone revoked, a device lapsed, a lock-out
// counted) writes it at once with `runNow`, before the call is refused: a refused call commits
// nothing of its own batch.
import type { CoreDatabase } from "@composable-os/db";
import type { Compilable, CompiledQuery, Kysely } from "kysely";
import { ForbiddenError } from "../errors.ts";
import { notifyStatements } from "../notifications/send.ts";
import { loadDeviceRole } from "../pack-roles.ts";
import { nextCredential, secretHash } from "./secret.ts";

type Db = Kysely<CoreDatabase>;

export const DEVICE_USES = ["signing", "role", "till"] as const;
export type DeviceUse = (typeof DEVICE_USES)[number];

/** How long the credential just rotated away is still accepted. */
export const GRACE_MS = 60_000;
/** Every device rotates at least this often. */
export const ROTATE_MS = 24 * 60 * 60_000;
/** A device with no call for this long lapses. */
export const LAPSE_MS = 30 * 24 * 60 * 60_000;
/** An enrolment code is good for this long. */
export const ENROL_MS = 10 * 60_000;

/**
 * What the adapter gives the host for desk signing and enrolled devices: the env secret every
 * code, credential and token is HMACed under, and the desk origin (`https://desk.<host>`), or
 * null when this deployment has no desk hostname (then there is no desk mode at all).
 */
export interface DeskHost {
  readonly secret: string;
  readonly origin: string | null;
  /**
   * Set only on a call the desk origin's own handler makes, from the request: never from an
   * operation's input, and never on the staff origin or the HTTP surface.
   */
  readonly request?: DeskRequest | undefined;
}

/** What one request to the desk origin carries, and how its answer sets the cookies. */
export interface DeskRequest {
  /** The device credential cookie, if any. */
  readonly credential: string | null;
  /** The desk session token cookie, if any. */
  readonly token: string | null;
  readonly userAgent: string | null;
  readonly address: string | null;
  /**
   * Sets the cookies on the answer, once the call has succeeded: a new device credential, a
   * session token, or null to clear the token. Never in the answer's body.
   */
  issue(cookies: { credential?: string; token?: string | null }): void;
}

export type DeviceRow = Awaited<ReturnType<typeof loadDevice>>;

export function loadDevice(db: Db, id: string) {
  return db.selectFrom("core_device").selectAll().where("id", "=", id).executeTakeFirst();
}

/** Every statement, one after the other, now: for a refusal's own changes (see the header). */
export async function runNow(db: Db, statements: readonly (Compilable | CompiledQuery)[]) {
  for (const statement of statements) {
    await db.executeQuery("compile" in statement ? statement.compile() : statement);
  }
}

/** The one answer for a browser that is not an enrolled device, whatever the reason. */
export function notEnrolled(): ForbiddenError {
  return new ForbiddenError(
    "This device is not enrolled. An admin enrols it in Settings, Devices.",
    {
      rule: "device_not_enrolled",
      httpStatus: 401,
    },
  );
}

/** The desk origin's calls need its secret and its request, or there is nothing to answer. */
export function deskRequestOf(desk: DeskHost | undefined): {
  desk: DeskHost;
  request: DeskRequest;
} {
  if (!desk?.request) throw notEnrolled();
  return { desk, request: desk.request };
}

/** Clips what a browser says about itself to what the row keeps. */
const clip = (value: string | null, max: number) => (value ? value.slice(0, max) : null);

export interface ResolvedDevice {
  device: NonNullable<DeviceRow>;
  /** The statements that record this call on the device, for the call's own batch. */
  statements: Compilable[];
  /** A new credential was issued with this answer. */
  rotated: boolean;
  /** The credential presented was the one rotated away, within the grace window. */
  viaGrace: boolean;
  /** The credential the device holds once this answer arrives (new, or the one presented). */
  credential: string;
}

/**
 * The enrolled device a desk request comes from, or `notEnrolled`. `rotate`: this call rotates
 * the credential whatever its age (a signing claim, stage 44).
 *
 * Rotation is confirmed by use (after the review of PR #390): the host issues the next credential
 * (`pending`) and keeps the current one good until the device presents the next, so an answer lost
 * on the way (premises Wi-Fi) never makes a healthy tablet look copied. The next one is derived
 * from the current under the secret, so every answer until then re-issues the same one. Once the
 * device presents it, the old one is rotated away: accepted for 60 seconds more (calls made at
 * once), and presented after that it means two browsers hold it.
 */
export async function resolveDevice(
  db: Db,
  desk: DeskHost,
  request: DeskRequest,
  now: string,
  options: { rotate?: boolean } = {},
): Promise<ResolvedDevice> {
  const presented = request.credential;
  if (!presented || presented.length > 200) throw notEnrolled();
  const hash = await secretHash(desk.secret, "credential", presented);
  const at = Date.parse(now);
  const row = await db
    .selectFrom("core_device")
    .selectAll()
    .where((eb) =>
      eb.or([
        eb("credential_hash", "=", hash),
        eb("pending_credential_hash", "=", hash),
        eb("previous_credential_hash", "=", hash),
      ]),
    )
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (!row) throw notEnrolled();
  if (lapsed(row, now)) {
    await runNow(db, revokeStatements(db, row.id, "lapsed", null, now));
    throw new ForbiddenError(
      "This device has not been used for 30 days, so it was revoked. An admin enrols it again.",
      { rule: "device_lapsed", httpStatus: 401 },
    );
  }
  const seen = db
    .updateTable("core_device")
    .set({ last_seen_at: now })
    .where("id", "=", row.id)
    .where("revoked_at", "is", null);

  if (row.pending_credential_hash === hash || row.credential_hash === hash) {
    const promoting = row.pending_credential_hash === hash;
    // The device presents the next credential: it is now the current one, and the old one is
    // rotated away. A claim then rotates again.
    const statements: Compilable[] = promoting
      ? [
          db
            .updateTable("core_device")
            .set({
              previous_credential_hash: row.credential_hash,
              credential_hash: hash,
              pending_credential_hash: null,
              rotated_at: now,
              last_seen_at: now,
            })
            .where("id", "=", row.id)
            .where("pending_credential_hash", "=", hash)
            .where("revoked_at", "is", null),
        ]
      : [seen];
    const pendingOpen = !promoting && row.pending_credential_hash !== null;
    const due =
      at - Date.parse((promoting ? now : row.rotated_at) ?? row.claimed_at ?? now) >= ROTATE_MS;
    if (options.rotate || due || pendingOpen) {
      const next = await nextCredential(desk.secret, presented);
      const nextHash = await secretHash(desk.secret, "credential", next);
      request.issue({ credential: next });
      if (row.pending_credential_hash !== nextHash || promoting) {
        statements.push(
          db
            .updateTable("core_device")
            .set({ pending_credential_hash: nextHash, ...seenFrom(row, request, now) })
            .where("id", "=", row.id)
            .where("revoked_at", "is", null),
        );
      }
      return { device: row, statements, rotated: true, viaGrace: pendingOpen, credential: next };
    }
    return { device: row, statements, rotated: false, viaGrace: false, credential: presented };
  }

  // The credential rotated away: within the grace window, the current one again (calls made at
  // once); later, two browsers hold it, and the device is revoked as a clone.
  const next = await nextCredential(desk.secret, presented);
  const sameNext = row.credential_hash === (await secretHash(desk.secret, "credential", next));
  if (sameNext && at - Date.parse(row.rotated_at ?? now) <= GRACE_MS) {
    request.issue({ credential: next });
    return { device: row, statements: [seen], rotated: true, viaGrace: true, credential: next };
  }
  await runNow(db, [
    ...revokeStatements(db, row.id, "clone", null, now),
    ...(await adminNotice(db, now, {
      title: `The device ${row.name} was revoked: it looked copied`,
      body:
        `A credential the host had replaced on ${row.name} was used again, so two ` +
        "browsers held it. The device was revoked and any signing session on it ended. Enrol " +
        "it again in Settings, Devices if it is still the business's.",
      dedupeKey: `device-clone:${row.id}`,
    })),
  ]);
  throw notEnrolled();
}

/** Whether a device has had no call for 30 days (it is refused, and revoked at its next call). */
export function lapsed(
  device: { last_seen_at: string | null; claimed_at: string | null; enrolled_at: string },
  now: string,
): boolean {
  const last = device.last_seen_at ?? device.claimed_at ?? device.enrolled_at;
  return Date.parse(now) - Date.parse(last) > LAPSE_MS;
}

/** The browser and address seen now, and a flag for each that changed since the last. */
function seenFrom(
  device: NonNullable<DeviceRow>,
  request: DeskRequest,
  now: string,
): {
  last_user_agent: string | null;
  last_address: string | null;
  flags: string;
} {
  const userAgent = clip(request.userAgent, 400);
  const address = clip(request.address, 64);
  const flags = parseFlags(device.flags);
  const before = { agent: device.last_user_agent, address: device.last_address };
  if (before.agent !== null && userAgent !== before.agent) flags.push({ kind: "browser", at: now });
  if (before.address !== null && address !== before.address)
    flags.push({ kind: "network", at: now });
  return {
    last_user_agent: userAgent,
    last_address: address,
    flags: JSON.stringify(flags.slice(-20)),
  };
}

export interface DeviceFlag {
  kind: "browser" | "network";
  at: string;
}

export function parseFlags(text: string): DeviceFlag[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value)
      ? value.filter(
          (f): f is DeviceFlag =>
            typeof f === "object" &&
            f !== null &&
            (f.kind === "browser" || f.kind === "network") &&
            typeof f.at === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/** Revokes a device: no credential or code is accepted again (migration 1130 ends its sessions). */
export function revokeStatements(
  db: Db,
  deviceId: string,
  reason: "admin" | "clone" | "lapsed",
  by: string | null,
  now: string,
): Compilable[] {
  return [
    db
      .updateTable("core_device")
      .set({
        revoked_at: now,
        revoke_reason: reason,
        revoked_by: by,
        credential_hash: null,
        previous_credential_hash: null,
        pending_credential_hash: null,
        enrol_code_hash: null,
      })
      .where("id", "=", deviceId)
      .where("revoked_at", "is", null),
  ];
}

/** Every admin who is a person (the notices about devices go to them all). */
export async function adminNotice(
  db: Db,
  now: string,
  notice: { title: string; body: string; dedupeKey?: string },
): Promise<Compilable[]> {
  const plan = await notifyStatements(
    db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title: notice.title,
      body: notice.body,
      link: null,
      ...(notice.dedupeKey ? { dedupeKey: notice.dedupeKey } : {}),
      source: { actor: "system" },
    },
    now,
  );
  return plan.statements;
}

/** A use in words, as notices and the devices list say it. */
export function useWords(use: DeviceUse, role: string | null): string {
  if (use === "signing") return "desk signing";
  if (use === "till") return "a till";
  return `the device role ${role ?? ""}`.trim();
}

/** A time in UTC to the minute, as a notice says it. */
export function noticeTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * Whether an installed, active, shipped pack declares this device role (`deviceRoles` in its
 * manifest, ADR 0781): a device of use `role` holds one, and nothing else. Until a pack declares
 * one, no device can be given the `role` use.
 */
export async function deviceRoleDeclared(db: Db, role: string): Promise<boolean> {
  return (await loadDeviceRole(db, role)) !== null;
}

/** The names of the staff users `ids`, for lists and notices. */
export async function userNamesOf(db: Db, ids: readonly (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map<string, string>();
  const rows = await db
    .selectFrom("core_user")
    .select(["id", "name"])
    .where("id", "in", wanted)
    .execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The most devices a list reads (a business has a handful). */
export const DEVICE_LIST_LIMIT = 200;
