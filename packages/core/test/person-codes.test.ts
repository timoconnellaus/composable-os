// Stage 51 step 3 (ADR 0783): a person's check-in code and PIN, against real D1.
//
// - `me.code` makes a rotating code for this sign-in and one per live dependant; a native app's
//   sign-in also gets the secret; a code is good for 60 seconds and ends with its sign-in.
// - Cards: issued and revoked by staff with `people:cards`, never by an AI; the code never stored
//   or audited.
// - The PIN: 4 digits, common ones refused; name and PIN identify exactly one Person; every miss
//   answers the same; the device and Person lock-outs.
// - Identification: a Person in the Trash, an ended link, a revoked card find no one.
// - Erase and merge; and what one identification costs.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type CustomerPrincipal,
  coreRegistry,
  grantOpens,
  identifyPerson,
  invoke,
  newId,
  type OutsideInvocationContext,
  personCodeKeys,
  staffAuthority,
} from "../src/index.ts";
import {
  appCodePayload,
  appCodeStep,
  appCodeValue,
  parseAppPayload,
} from "../src/people-codes/keys.ts";
import { context, createUser, db, unique } from "./helpers.ts";

const keys = personCodeKeys("test-auth-secret-for-person-codes");

let admin: ActingUser;
let member: ActingUser;
let viewer: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  viewer = await createUser("viewer");
});

interface Member {
  principal: CustomerPrincipal;
  given: string;
  family: string;
}

async function person(given: string, family: string): Promise<string> {
  const created = await invoke(
    "person.create",
    { givenName: given, familyName: family },
    context(admin, { personCodes: keys }),
  );
  return created.id;
}

/** A Person with a customer account. */
async function customer(given = unique("Sam"), family = unique("Rivers")): Promise<Member> {
  const personId = await person(given, family);
  const id = `cus_${unique("c")}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  )
    .bind(id, personId, `${unique("m")}@customers.example`, now, now)
    .run();
  return { principal: { kind: "customer", customerId: id, personId }, given, family };
}

async function browserSession(m: Member): Promise<string> {
  const id = unique("ses");
  const now = new Date();
  await env.DB.prepare(
    `INSERT INTO core_customer_session (id, customer_id, token, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      m.principal.customerId,
      unique("tok"),
      new Date(now.getTime() + 86_400_000).toISOString(),
      now.toISOString(),
      now.toISOString(),
    )
    .run();
  return id;
}

async function deviceSession(m: Member): Promise<string> {
  const id = newId("deviceSession");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO core_device_session (id, audience, customer_id, device_name, access_hash,
       access_expires_at, refresh_hash, created_at, last_used_at)
     VALUES (?, 'customer', ?, 'Phone', ?, ?, ?, ?, ?)`,
  )
    .bind(id, m.principal.customerId, unique("a"), now, unique("r"), now, now)
    .run();
  return id;
}

function as(m: Member, sessionId?: string): OutsideInvocationContext {
  return {
    principal: m.principal,
    db,
    origin: { surface: "client", ...(sessionId ? { sessionId } : {}) },
    personCodes: keys,
  };
}

const staff = (user: ActingUser, extra: Parameters<typeof context>[1] = {}) =>
  context(user, { personCodes: keys, ...extra });

const at = (deviceId = unique("dev"), now = new Date()) => ({ deviceId, now });

async function refused(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  throw new Error("expected a refusal");
}

describe("me.code", () => {
  it("makes this sign-in's code, which identifies the member for 60 seconds", async () => {
    const m = await customer();
    const session = await browserSession(m);
    const first = await invoke("me.code", {}, as(m, session));
    expect(first.codes).toHaveLength(1);
    const own = first.codes[0];
    expect(own?.own).toBe(true);
    // A browser holds no secret.
    expect(own?.secret).toBeNull();
    const payload = own?.payload as string;
    const found = await identifyPerson(db.query, keys, at(), { code: payload });
    expect(found).toEqual({
      outcome: "found",
      personId: m.principal.personId,
      via: "app",
      family: true,
    });
    // Asked again, the same code (one per sign-in), and nothing new is written.
    const again = await invoke("me.code", {}, as(m, session));
    expect(parseAppPayload(again.codes[0]?.payload as string)?.codeId).toBe(
      parseAppPayload(payload)?.codeId,
    );
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_person_code WHERE person_id = ?",
    )
      .bind(m.principal.personId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    // The step before is still good; two steps back is "not found".
    const later = new Date(Date.now() + 30_000);
    expect(
      (await identifyPerson(db.query, keys, at(undefined, later), { code: payload })).outcome,
    ).toBe("found");
    const tooLate = new Date(Date.now() + 61_000);
    expect(
      (await identifyPerson(db.query, keys, at(undefined, tooLate), { code: payload })).outcome,
    ).toBe("not_found");
  });

  it("gives a native app the secret, from which it makes the same code offline", async () => {
    const m = await customer();
    const session = await deviceSession(m);
    const out = await invoke("me.code", {}, as(m, session));
    const code = out.codes[0];
    expect(code?.secret).toMatch(/^[A-Z2-7]+$/);
    expect(out.algorithm).toEqual({ kind: "totp", hash: "SHA-1", periodSeconds: 30, digits: 8 });
    const secret = fromBase32(code?.secret as string);
    const codeId = parseAppPayload(code?.payload as string)?.codeId as string;
    const offline = appCodePayload(codeId, await appCodeValue(secret, appCodeStep(new Date())));
    expect((await identifyPerson(db.query, keys, at(), { code: offline })).outcome).toBe("found");
  });

  it("ends with its sign-in, and with the account", async () => {
    const m = await customer();
    const session = await browserSession(m);
    const { codes } = await invoke("me.code", {}, as(m, session));
    const payload = codes[0]?.payload as string;
    await env.DB.prepare("DELETE FROM core_customer_session WHERE id = ?").bind(session).run();
    expect((await identifyPerson(db.query, keys, at(), { code: payload })).outcome).toBe(
      "not_found",
    );
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_person_code WHERE person_id = ?",
    )
      .bind(m.principal.personId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);

    const n = await customer();
    const device = await deviceSession(n);
    const shown = await invoke("me.code", {}, as(n, device));
    await env.DB.prepare("UPDATE core_customer SET status = 'disabled' WHERE id = ?")
      .bind(n.principal.customerId)
      .run();
    expect(
      (await identifyPerson(db.query, keys, at(), { code: shown.codes[0]?.payload as string }))
        .outcome,
    ).toBe("not_found");
  });

  it("refuses a call without a sign-in, and another account's session", async () => {
    const m = await customer();
    const other = await customer();
    const theirs = await browserSession(other);
    expect(await refused(invoke("me.code", {}, as(m)))).toBe("invalid_input");
    expect(await refused(invoke("me.code", {}, as(m, theirs)))).toBe("invalid_input");
  });

  it("shows a live dependant's code by given name, which finds only the child while linked", async () => {
    const parent = await customer();
    const childGiven = unique("Kit");
    const childFamily = unique("Rivers");
    const child = await person(childGiven, childFamily);
    const link = await invoke(
      "person.link.add",
      { guardianId: parent.principal.personId, dependantId: child },
      staff(admin),
    );
    const session = await deviceSession(parent);
    const out = await invoke("me.code", {}, as(parent, session));
    expect(out.codes.map((c) => [c.own, c.givenName])).toEqual([
      [true, null],
      [false, childGiven],
    ]);
    // Never a family name in the output.
    expect(JSON.stringify(out)).not.toContain(childFamily);
    const childCode = out.codes[1]?.payload as string;
    expect(await identifyPerson(db.query, keys, at(), { code: childCode })).toEqual({
      outcome: "found",
      personId: child,
      via: "app",
      family: false,
    });
    await invoke("person.link.end", { id: link.id }, staff(admin));
    expect((await identifyPerson(db.query, keys, at(), { code: childCode })).outcome).toBe(
      "not_found",
    );
    // And the next me.code shows only the parent's own.
    expect((await invoke("me.code", {}, as(parent, session))).codes).toHaveLength(1);
  });

  it("finds no one in the Trash", async () => {
    const m = await customer();
    const session = await browserSession(m);
    const { codes } = await invoke("me.code", {}, as(m, session));
    await invoke("person.delete", { id: m.principal.personId }, staff(admin));
    expect(
      (await identifyPerson(db.query, keys, at(), { code: codes[0]?.payload as string })).outcome,
    ).toBe("not_found");
  });

  it("is refused without the host's keys", async () => {
    const m = await customer();
    const session = await browserSession(m);
    const { personCodes: _none, ...bare } = as(m, session);
    expect(await refused(invoke("me.code", {}, bare))).toBe("config");
  });
});

describe("cards", () => {
  it("a member issues a card; it identifies its Person until revoked; the code is never kept", async () => {
    const holder = await person(unique("Ana"), unique("Lake"));
    const code = `KT-${unique("card").toUpperCase()}`;
    const card = await invoke(
      "personCode.issueCard",
      { personId: holder, code, label: "blue key tag" },
      staff(member),
    );
    expect(card).toMatchObject({ kind: "card", label: "blue key tag", revokedAt: null });
    // Scanned as printed, or typed in lower case without the hyphen.
    for (const typed of [code, code.toLowerCase().replace("-", "")]) {
      expect(await identifyPerson(db.query, keys, at(), { code: typed })).toEqual({
        outcome: "found",
        personId: holder,
        via: "card",
        family: false,
      });
    }
    // The same code on a second live card is refused.
    expect(
      await refused(
        invoke("personCode.issueCard", { personId: holder, code, label: "again" }, staff(admin)),
      ),
    ).toBe("conflict");
    // Never stored, never audited.
    const stored = await env.DB.prepare("SELECT * FROM core_person_code WHERE id = ?")
      .bind(card.id)
      .first();
    expect(JSON.stringify(stored)).not.toContain(code);
    const audit = await env.DB.prepare(
      "SELECT input, result FROM core_audit WHERE operation = 'personCode.issueCard'",
    ).all();
    expect(JSON.stringify(audit.results)).not.toContain(code);
    const listed = await invoke("personCode.list", { personId: holder }, staff(member));
    expect(listed.items.map((i) => i.id)).toEqual([card.id]);
    expect(JSON.stringify(listed)).not.toContain(code);

    await invoke("personCode.revokeCard", { codeId: card.id }, staff(member));
    expect((await identifyPerson(db.query, keys, at(), { code })).outcome).toBe("not_found");
    // Revoked, the code may go on a new card.
    await invoke("personCode.issueCard", { personId: holder, code, label: "new" }, staff(admin));
    expect((await identifyPerson(db.query, keys, at(), { code })).outcome).toBe("found");
  });

  it("is refused to a viewer, to every AI actor, and for a short or app-shaped code", async () => {
    const holder = await person(unique("Ana"), unique("Lake"));
    const input = { personId: holder, code: unique("CARDCODE"), label: "tag" };
    expect(await refused(invoke("personCode.issueCard", input, staff(viewer)))).toBe("forbidden");
    for (const actor of ["assistant", "mcp", "automation", "extension"] as const) {
      expect(await refused(invoke("personCode.issueCard", input, staff(admin, { actor })))).toBe(
        "forbidden",
      );
      expect(
        await refused(invoke("personCode.list", { personId: holder }, staff(admin, { actor }))),
      ).toBe("forbidden");
    }
    for (const code of ["1234567", "pc_01ABC.12345678"]) {
      expect(await refused(invoke("personCode.issueCard", { ...input, code }, staff(admin)))).toBe(
        "invalid_input",
      );
    }
  });

  it("no operation of this step is open to MCP or an AI", () => {
    for (const name of [
      "me.code",
      "me.pin.set",
      "me.pin.clear",
      "personCode.issueCard",
      "personCode.revokeCard",
      "personCode.list",
    ]) {
      const op = coreRegistry.get(name);
      expect(op?.mcp?.expose, name).toBe(false);
      if (op?.audiences?.includes("customer")) expect(op.audiences).toEqual(["customer"]);
      else expect(op?.actors, name).toEqual(["human"]);
    }
  });

  it("people:cards may be granted to a fixed-role account, and opens only the card operations", () => {
    const issue = coreRegistry.get("personCode.issueCard");
    const list = coreRegistry.get("person.list");
    if (!issue || !list) throw new Error("missing");
    const rights = {
      packRole: {
        name: "bookings.desk",
        extension: "bookings",
        label: "Desk",
        permissions: [],
        read: [],
      },
      grants: ["people:cards"],
    };
    expect(grantOpens(rights.grants, issue)).toBe(true);
    expect(staffAuthority({ role: "viewer" }, rights, issue, {})).toBe("grant");
    expect(staffAuthority({ role: "viewer" }, rights, list, {})).toBeNull();
    expect(staffAuthority({ role: "viewer" }, { ...rights, grants: [] }, issue, {})).toBeNull();
  });
});

describe("the PIN", () => {
  it("is 4 digits, not a common one, the member's own", async () => {
    const m = await customer();
    for (const pin of ["123", "12345", "abcd", "1234", "0000", "1111"]) {
      expect(await refused(invoke("me.pin.set", { pin }, as(m))), pin).toBe("invalid_input");
    }
    await invoke("me.pin.set", { pin: "4826" }, as(m));
    const row = await env.DB.prepare("SELECT * FROM core_person_pin WHERE person_id = ?")
      .bind(m.principal.personId)
      .first<Record<string, unknown>>();
    expect(row?.hash).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain("4826");
    const audit = await env.DB.prepare(
      "SELECT input, result FROM core_audit WHERE operation = 'me.pin.set' AND user_id = ?",
    )
      .bind(m.principal.customerId)
      .all();
    // The refusals are audited too; no row holds a PIN.
    expect(audit.results.length).toBe(7);
    expect(JSON.stringify(audit.results)).not.toMatch(/4826|"0000"|"1111"|"12345"/);
    expect(await invoke("me.pin.clear", {}, as(m))).toEqual({ cleared: true });
    expect(await invoke("me.pin.clear", {}, as(m))).toEqual({ cleared: false });
  });

  it("name and PIN find exactly one Person; every miss answers the same", async () => {
    const given = unique("Zoë");
    const family = unique("Ångström");
    const m = await customer(given, family);
    await invoke("me.pin.set", { pin: "4826" }, as(m));
    const typed = `  ${given.toUpperCase().replace("Ë", "E")}   ${family.toLowerCase().replace("å", "a")} `;
    expect(await identifyPerson(db.query, keys, at(), { name: typed, pin: "4826" })).toEqual({
      outcome: "found",
      personId: m.principal.personId,
      via: "pin",
      family: false,
    });
    const misses = [
      { name: `${given} ${family}`, pin: "4827" },
      { name: `${given}x ${family}`, pin: "4826" },
      { name: unique("Nobody"), pin: "4826" },
      { name: `${given} ${family}`, pin: "48" },
    ];
    for (const miss of misses) {
      expect(await identifyPerson(db.query, keys, at(), miss)).toEqual({ outcome: "not_found" });
    }
  });

  it("five failed tries in a minute lock name entry on that device for five minutes", async () => {
    const m = await customer();
    await invoke("me.pin.set", { pin: "5937" }, as(m));
    const device = unique("dev");
    const t0 = new Date();
    const name = `${m.given} ${m.family}`;
    for (let n = 0; n < 5; n += 1) {
      const answer = await identifyPerson(db.query, keys, at(device, t0), { name, pin: "1357" });
      expect(answer.outcome).toBe("not_found");
    }
    expect(await identifyPerson(db.query, keys, at(device, t0), { name, pin: "5937" })).toEqual({
      outcome: "locked",
      entry: "name",
    });
    // Codes still work on that device; another device is not locked.
    expect(
      (await identifyPerson(db.query, keys, at(device, t0), { code: "UNKNOWNCARD" })).outcome,
    ).toBe("not_found");
    expect(
      (await identifyPerson(db.query, keys, at(unique("dev"), t0), { name, pin: "5937" })).outcome,
    ).toBe("found");
    const after = new Date(t0.getTime() + 5 * 60_000 + 1000);
    expect(
      (await identifyPerson(db.query, keys, at(device, after), { name, pin: "5937" })).outcome,
    ).toBe("found");
    // Nothing typed is kept.
    const lock = await env.DB.prepare("SELECT * FROM core_identify_lockout WHERE device_id = ?")
      .bind(device)
      .all();
    expect(JSON.stringify(lock.results)).not.toMatch(/1357|5937|UNKNOWNCARD/);
    expect(JSON.stringify(lock.results)).not.toContain(m.family);
  });

  it("ten wrong PINs for one Person in a day disable it until it is set again", async () => {
    const m = await customer();
    await invoke("me.pin.set", { pin: "7319" }, as(m));
    const name = `${m.given} ${m.family}`;
    // From ten devices, so no device lock-out stops the guesses.
    for (let n = 0; n < 10; n += 1) {
      await identifyPerson(db.query, keys, at(), { name, pin: String(2000 + n) });
    }
    expect((await identifyPerson(db.query, keys, at(), { name, pin: "7319" })).outcome).toBe(
      "not_found",
    );
    await invoke("me.pin.set", { pin: "7319" }, as(m));
    expect((await identifyPerson(db.query, keys, at(), { name, pin: "7319" })).outcome).toBe(
      "found",
    );
  });

  it("unknown codes from one device are limited per minute", async () => {
    const device = unique("dev");
    const t0 = new Date();
    for (let n = 0; n < 20; n += 1) {
      await identifyPerson(db.query, keys, at(device, t0), { code: unique("GUESSCODE") });
    }
    expect(
      await identifyPerson(db.query, keys, at(device, t0), { code: unique("GUESSCODE") }),
    ).toEqual({ outcome: "locked", entry: "code" });
  });
});

describe("erase and merge", () => {
  it("erase removes the Person's codes, cards, PIN and the dependants' codes on their app", async () => {
    const m = await customer();
    const child = await person(unique("Kit"), unique("Lake"));
    await invoke(
      "person.link.add",
      { guardianId: m.principal.personId, dependantId: child },
      staff(admin),
    );
    await invoke("me.code", {}, as(m, await deviceSession(m)));
    await invoke("me.pin.set", { pin: "6284" }, as(m));
    await invoke(
      "personCode.issueCard",
      { personId: m.principal.personId, code: unique("ERASECARD"), label: "tag" },
      staff(admin),
    );
    await invoke("person.erase", { id: m.principal.personId }, staff(admin));
    const codes = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_person_code WHERE person_id IN (?, ?) OR guardian_id = ?",
    )
      .bind(m.principal.personId, child, m.principal.personId)
      .first<{ n: number }>();
    expect(codes?.n).toBe(0);
    const pins = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_person_pin WHERE person_id = ?",
    )
      .bind(m.principal.personId)
      .first<{ n: number }>();
    expect(pins?.n).toBe(0);
  });

  it("merge moves cards to the survivor and keeps the survivor's PIN", async () => {
    const survivor = await customer();
    const merged = await customer();
    // The merged one's account must be off for a merge (both active is refused).
    await env.DB.prepare("UPDATE core_customer SET status = 'disabled' WHERE id = ?")
      .bind(merged.principal.customerId)
      .run();
    await invoke("me.pin.set", { pin: "3916" }, as(survivor));
    await env.DB.prepare(
      "INSERT INTO core_person_pin (person_id, hash, salt, iterations, set_at) VALUES (?, 'h', 's', 1, ?)",
    )
      .bind(merged.principal.personId, new Date().toISOString())
      .run();
    const code = unique("MERGECARD");
    await invoke(
      "personCode.issueCard",
      { personId: merged.principal.personId, code, label: "tag" },
      staff(admin),
    );
    await invoke(
      "person.merge",
      { survivorId: survivor.principal.personId, mergedId: merged.principal.personId, fields: {} },
      staff(admin),
    );
    expect(await identifyPerson(db.query, keys, at(), { code })).toMatchObject({
      outcome: "found",
      personId: survivor.principal.personId,
    });
    const pins = await env.DB.prepare(
      "SELECT person_id FROM core_person_pin WHERE person_id IN (?, ?)",
    )
      .bind(survivor.principal.personId, merged.principal.personId)
      .all<{ person_id: string }>();
    expect(pins.results.map((r) => r.person_id)).toEqual([survivor.principal.personId]);
  });
});

describe("the review of PR #382", () => {
  it("tries sent at once on one device get no further than one by one", async () => {
    const m = await customer();
    await invoke("me.pin.set", { pin: "6472" }, as(m));
    const device = unique("dev");
    const now = new Date();
    const name = `${m.given} ${m.family}`;
    const tries = [
      ...Array.from({ length: 14 }, (_, n) => ({ name, pin: String(3000 + n) })),
      { name, pin: "6472" },
    ];
    const answers = await Promise.all(
      tries.map((input) => identifyPerson(db.query, keys, at(device, now), input)),
    );
    // At most five tries were checked; the rest, the right PIN last among them, were locked.
    expect(answers.filter((a) => a.outcome !== "locked").length).toBeLessThanOrEqual(5);
    expect(answers.at(-1)).toEqual({ outcome: "locked", entry: "name" });
  });

  it("wrong PINs sent at once from many devices disable the PIN before the right one is checked", async () => {
    const m = await customer();
    await invoke("me.pin.set", { pin: "8361" }, as(m));
    const name = `${m.given} ${m.family}`;
    const tries = [
      ...Array.from({ length: 30 }, (_, n) => ({ name, pin: String(4000 + n) })),
      { name, pin: "8361" },
    ];
    const answers = await Promise.all(
      tries.map((input) => identifyPerson(db.query, keys, at(), input)),
    );
    expect(answers.at(-1)).toEqual({ outcome: "not_found" });
    expect((await identifyPerson(db.query, keys, at(), { name, pin: "8361" })).outcome).toBe(
      "not_found",
    );
  });

  it("a name and PIN costs the same slow hashes whether or not the name is someone's", async () => {
    const m = await customer();
    await invoke("me.pin.set", { pin: "2947" }, as(m));
    let hashes = 0;
    const counting = {
      ...keys,
      pinInput(pin: string) {
        hashes += 1;
        return keys.pinInput(pin);
      },
    };
    const cost = async (input: { name: string; pin: string }) => {
      hashes = 0;
      await identifyPerson(db.query, counting, at(), input);
      return hashes;
    };
    const known = await cost({ name: `${m.given} ${m.family}`, pin: "1593" });
    expect(known).toBe(5);
    expect(await cost({ name: unique("Nobody"), pin: "1593" })).toBe(known);
    expect(await cost({ name: `${m.given} ${m.family}`, pin: "15" })).toBe(known);
  });

  it("two first me.code calls at once both answer, with the one code kept", async () => {
    const m = await customer();
    const session = await browserSession(m);
    const [a, b] = await Promise.all([
      invoke("me.code", {}, as(m, session)),
      invoke("me.code", {}, as(m, session)),
    ]);
    const idOf = (out: typeof a) => parseAppPayload(out.codes[0]?.payload as string)?.codeId;
    expect(idOf(a)).toBeTruthy();
    expect(idOf(a)).toBe(idOf(b));
    expect(
      (await identifyPerson(db.query, keys, at(), { code: a.codes[0]?.payload as string })).outcome,
    ).toBe("found");
  });

  it("issuing a card is never queued for review, so its code is never kept in a pending action", async () => {
    const holder = await person(unique("Ana"), unique("Lake"));
    const code = unique("FLOORCARD");
    const floor = { human: { write: "review" as const } };
    await invoke(
      "personCode.issueCard",
      { personId: holder, code, label: "tag" },
      staff(admin, { floor }),
    );
    expect((await identifyPerson(db.query, keys, at(), { code })).outcome).toBe("found");
    const pending = await env.DB.prepare("SELECT input FROM core_pending_action").all();
    expect(JSON.stringify(pending.results)).not.toContain(code);
    // A provisional Person id (which would queue it) is refused by the input.
    expect(
      await refused(
        invoke(
          "personCode.issueCard",
          {
            personId: "per_pending_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            code: unique("PENDCARD"),
            label: "t",
          },
          staff(admin),
        ),
      ),
    ).toBe("invalid_input");
  });
});

describe("cost", () => {
  it("one identification runs a bounded handful of statements, each with few bound values", async () => {
    let statements = 0;
    let mostBound = 0;
    const metered = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            statements += 1;
            mostBound = Math.max(mostBound, (query.match(/\?/g) ?? []).length);
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const counted = createCrmDb(metered).query;
    const parent = await customer();
    for (let n = 0; n < 3; n += 1) {
      const child = await person(unique("Kit"), unique("Lake"));
      await invoke(
        "person.link.add",
        { guardianId: parent.principal.personId, dependantId: child },
        staff(admin),
      );
    }
    const { codes } = await invoke("me.code", {}, as(parent, await deviceSession(parent)));
    await invoke("me.pin.set", { pin: "8152" }, as(parent));
    const tries = [
      { code: codes[0]?.payload as string },
      { code: codes[3]?.payload as string },
      { code: unique("NOSUCHCARD") },
      { name: `${parent.given} ${parent.family}`, pin: "8152" },
      { name: `${parent.given} ${parent.family}`, pin: "8153" },
    ];
    for (const input of tries) {
      statements = 0;
      await identifyPerson(counted, keys, at(), input);
      expect(statements, JSON.stringify(input)).toBeLessThanOrEqual(6);
    }
    expect(mostBound).toBeLessThan(20);
  });
});

/** RFC 4648 base32 to bytes, as a native app would read the secret. */
function fromBase32(text: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
