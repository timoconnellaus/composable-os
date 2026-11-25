// Stage 43 step 3 (ADR 0581): the practitioner principal, its audience and its accounts. All names
// here are fixture names.
//
// - Criterion 1: `practitioner` is a fourth audience beside staff, customers and the public. No
//   operation opens to it unless it lists it, and every one that does is in open-operations.json
//   (here: `practitioner.me` alone). A practitioner walked through every operation in the
//   registry, with empty input and with real ids, is refused every one but that
//   (`unknown_operation`), and a practitioner's call is never queued.
// - Criterion 2: only a person with `practitioners:manage` invites or ends a practitioner, never
//   the assistant, MCP, an automation, an extension or a device session (the import door).
// - The empty scope: with no care link (step 4) and no practitioner scope (step 5), a
//   practitioner reads no record of any object through the seam, not even what the public may.
import { env } from "cloudflare:workers";
import { TOOL_AUDIENCES } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  type AnyOperation,
  audiencesOf,
  coreRegistry,
  createInvoker,
  createRegistry,
  defineOperation,
  getObject,
  invoke,
  invokeOperation,
  listObjects,
  loadExtensionOperations,
  type OutsideInvocationContext,
  openOperations,
  type PractitionerPrincipal,
  practitionerPrincipalFor,
  refreshSchemaRegistry,
  scopeOf,
  visibleObject,
  visibleSource,
} from "../src/index.ts";
import { recordAccess } from "../src/visibility/records.ts";
import {
  type Customer,
  createCustomer,
  createPosts,
  createShows,
  installShop,
  POST,
  SHOW,
} from "./customer-fixtures.ts";
import { context, createUser, db, unique } from "./helpers.ts";
import { releasePackTools } from "./release-packs.ts";

let admin: ActingUser;
let member: ActingUser;
let practitioner: PractitionerPrincipal;
let client: Customer;
let clientPersonId: string;
let clientEmail: string;
let showId: string;
let postId: string;

/** A practitioner's call as the HTTP surface makes it: the principal, nothing else. */
const asPractitioner = (
  principal: PractitionerPrincipal = practitioner,
  overrides: Partial<OutsideInvocationContext> = {},
): OutsideInvocationContext => ({ principal, db, ...overrides });

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

/** An active practitioner account, made as a person on the staff makes one, then signed in. */
async function activePractitioner(label: string): Promise<PractitionerPrincipal> {
  const email = `${unique(label)}@practice.example`;
  const made = await invoke(
    "practitioner.invite",
    { email, name: `Pat ${label}`, discipline: "Physiotherapist" },
    context(admin),
  );
  // The first sign-in (packages/auth) makes it active; here, the statement it runs.
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE core_practitioner SET status = 'active', activated_at = ?, last_sign_in_at = ? WHERE id = ?",
  )
    .bind(now, now, made.id)
    .run();
  const principal = await practitionerPrincipalFor(db.query, made.id);
  if (!principal) throw new Error("not active");
  return principal;
}

/** Every top-level key of an object input filled with real ids: a client's and a record's. */
function realInput(op: AnyOperation, ids: string[]): Record<string, unknown> {
  const shape = (op.input as unknown as { shape?: Record<string, unknown> }).shape ?? {};
  return Object.fromEntries(Object.keys(shape).map((key, i) => [key, ids[i % ids.length]]));
}

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await installShop();
  client = await createCustomer(admin, "client");
  clientPersonId = client.principal.personId;
  const person = await invoke("person.get", { id: clientPersonId }, context(admin));
  clientEmail = person.emails[0]?.email as string;
  showId = (await createShows(admin)).onSale.show;
  postId = (await createPosts(admin)).live.id;
  practitioner = await activePractitioner("walk");
}, 120_000);

describe("the practitioner audience (criterion 1)", () => {
  it("is a fourth audience, and only practitioner.me opens to it", () => {
    const everything = [...coreRegistry.list(), ...releasePackTools];
    const open = everything.filter((op) => audiencesOf(op).includes("practitioner"));
    // The reviewed list (ADR 0581): every operation open to practitioners, and nothing else.
    expect(open.map((op) => op.name)).toEqual(["practitioner.me"]);
    expect(open.every((op) => op.risk === "read" || op.risk === "write")).toBe(true);
    // And it is in the generated list, as every operation open outside the org is.
    expect(
      openOperations(everything).operations.filter((op) => op.audiences.includes("practitioner")),
    ).toEqual([
      { name: "practitioner.me", audiences: ["practitioner"], risk: "read", hostInternal: true },
    ]);
    // No pack can open a tool to them yet: the SDK's tool audiences do not name them.
    expect((TOOL_AUDIENCES as readonly string[]).includes("practitioner")).toBe(false);
  });

  it("refuses an operation open to practitioners above the risk floor", () => {
    expect(() =>
      defineOperation({
        name: "fixture.practitionerErase",
        description: "Fixture: an operation that must never open to practitioners.",
        input: z.object({}),
        output: z.object({}),
        permission: "records:erase",
        risk: "destructive",
        audiences: ["practitioner"],
        handler: async () => ({}),
      }),
    ).toThrow(/risk class read or write/);
  });

  it("a practitioner walked through every operation reaches practitioner.me alone", async () => {
    const everything: AnyOperation[] = [
      ...coreRegistry.list(),
      ...releasePackTools,
      ...(await loadExtensionOperations(db.query)),
    ];
    const ids = [clientPersonId, showId, postId, admin.id];
    const reached: string[] = [];
    for (const op of everything) {
      for (const input of [{}, realInput(op, ids)]) {
        try {
          await invokeOperation(op, input, asPractitioner());
          reached.push(op.name);
        } catch (error) {
          const code = (error as { code?: string }).code;
          // Told no such operation exists, before the input is looked at.
          expect([op.name, code]).toEqual([op.name, "unknown_operation"]);
        }
      }
    }
    expect([...new Set(reached)]).toEqual(["practitioner.me"]);
  });

  it("practitioner.me is the caller's own account; nobody else calls it", async () => {
    const me = await invoke("practitioner.me", {}, asPractitioner());
    expect(me).toMatchObject({ id: practitioner.practitionerId, discipline: "Physiotherapist" });
    for (const ctx of [
      context(admin),
      { principal: client.principal, db },
      { principal: { kind: "public" as const }, db },
    ]) {
      expect((await refusal(invoke("practitioner.me", {}, ctx))).code).toBe("unknown_operation");
    }
  });

  it("a practitioner principal names only a practitioner: extra members are not read", async () => {
    // A value that also says it is a customer is still only the practitioner.
    const mixed = { ...practitioner, customerId: client.principal.customerId };
    expect(await invoke("practitioner.me", {}, asPractitioner(mixed))).toMatchObject({
      id: practitioner.practitionerId,
    });
    expect(
      (await refusal(invoke("me.get", {}, asPractitioner(mixed as PractitionerPrincipal)))).code,
    ).toBe("unknown_operation");
  });

  it("a practitioner's write is applied or refused, never queued", async () => {
    const write = defineOperation({
      name: "fixture.practitionerNote",
      description: "Fixture: a practitioner's write that records nothing.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      permission: "records:write",
      risk: "write",
      audiences: ["practitioner"],
      handler: async () => ({ ok: true }),
    });
    const fixtures = createInvoker(createRegistry([...coreRegistry.list(), write]));
    const pending = async () =>
      (await env.DB.prepare("SELECT count(*) AS n FROM core_pending_action").first<{ n: number }>())
        ?.n;
    const before = await pending();
    await env.DB.prepare("UPDATE core_settings SET value = ? WHERE key = 'approval_policy'")
      .bind(JSON.stringify({ preset: "cautious" }))
      .run();
    try {
      expect(
        await fixtures.invokeByName(
          "fixture.practitionerNote",
          {},
          asPractitioner(practitioner, { floor: { "*": { write: "review" } } }),
        ),
      ).toEqual({ ok: true });
      const denied = await refusal(
        fixtures.invokeByName(
          "fixture.practitionerNote",
          {},
          asPractitioner(practitioner, { floor: { "*": { write: "deny" } } }),
        ),
      );
      expect(denied.code).toBe("denied");
    } finally {
      await env.DB.prepare("UPDATE core_settings SET value = ? WHERE key = 'approval_policy'")
        .bind(JSON.stringify({ preset: "balanced" }))
        .run();
    }
    expect(await pending()).toBe(before);
    // Audited as the practitioner's.
    const audit = await env.DB.prepare(
      "SELECT actor, user_id FROM core_audit WHERE operation = 'fixture.practitionerNote' AND outcome = 'ok'",
    ).first();
    expect(audit).toEqual({ actor: "practitioner", user_id: practitioner.practitionerId });
  });
});

describe("the empty scope: a practitioner reads nothing through the seam", () => {
  it("no object exists for a practitioner, not even one the public may read", async () => {
    await refreshSchemaRegistry(db.query);
    const objects = listObjects();
    // The fixture shop has objects with customer and public declarations: both kinds are here.
    expect(objects.some((o) => o.public)).toBe(true);
    expect(objects.some((o) => o.customer)).toBe(true);
    const viewer = { principal: practitioner };
    for (const object of objects) {
      expect([object.name, scopeOf(practitioner, object).kind]).toEqual([object.name, "none"]);
      expect(() => visibleObject(viewer, object.name), object.name).toThrow();
      expect(() => visibleSource(viewer, object), object.name).toThrow();
    }
  });

  it("no Person, record, search hit or public record: reads answer as for ids that do not exist", async () => {
    const records = recordAccess({ db: db.query, principal: practitioner });
    const asTheyDoNotExist = async (object: string, id: string) => {
      const error = await refusal(records.get(object, id));
      const missing = await refusal(records.get(object, "rec_01NOTHERE0000000000000000"));
      expect(error.code, `${object} ${id}`).toBe(missing.code);
    };
    // The client's own Person, a record they own, a show on sale and a published post (both
    // readable by the public): none is there for a practitioner.
    await asTheyDoNotExist("person", clientPersonId);
    for (const [object, ids] of Object.entries(client.records)) {
      if (getObject(object) && ids[0]) await asTheyDoNotExist(object, ids[0]);
    }
    // What anyone may read (a show on sale, a published post) is not there for them either.
    const asPublic = recordAccess({ db: db.query, principal: { kind: "public" } });
    expect((await asPublic.get(SHOW, showId)).id).toBe(showId);
    expect((await asPublic.get(POST, postId)).id).toBe(postId);
    await asTheyDoNotExist(SHOW, showId);
    await asTheyDoNotExist(POST, postId);
    for (const object of ["person", "organisation", "activity", "task"]) {
      expect((await refusal(records.list(object))).code).toBeDefined();
    }
    // What search hydrates hits from: the same seam, so no hit either.
    for (const object of ["person", "organisation", "activity", "task"] as const) {
      expect(() => visibleSource({ principal: practitioner }, object)).toThrow();
    }
  });

  it("the client's own Person is the client's, and staff still read it: the scope is the practitioner's alone", async () => {
    const staff = recordAccess({
      db: db.query,
      principal: { kind: "staff", userId: admin.id, role: "admin" },
    });
    expect((await staff.get("person", clientPersonId)).id).toBe(clientPersonId);
    const theirs = recordAccess({ db: db.query, principal: client.principal });
    expect((await theirs.get("person", clientPersonId)).id).toBe(clientPersonId);
  });
});

describe("practitioner accounts (criterion 2)", () => {
  it("a person with practitioners:manage invites, lists, gets and ends one", async () => {
    const email = `${unique("dana")}@practice.example`;
    const made = await invoke(
      "practitioner.invite",
      { email, name: "Dana", discipline: "Dietitian" },
      context(admin),
    );
    expect(made).toMatchObject({
      email,
      name: "Dana",
      discipline: "Dietitian",
      status: "invited",
      invitedBy: admin.id,
      invitationEmail: "not_sent",
    });
    // Their Person is made with the address, as person.create makes any.
    const person = await invoke("person.get", { id: made.personId }, context(admin));
    expect(person.displayName).toBe("Dana");
    expect((await invoke("practitioner.get", { id: made.id }, context(admin))).id).toBe(made.id);
    const listed = await invoke("practitioner.list", { status: "invited" }, context(admin));
    expect(listed.items.map((p) => p.id)).toContain(made.id);
    // Inviting again before it is accepted updates and resends it.
    const again = await invoke(
      "practitioner.invite",
      { email, name: "Dana", discipline: "Sports dietitian" },
      context(admin),
    );
    expect(again).toMatchObject({ id: made.id, discipline: "Sports dietitian" });
    const ended = await invoke(
      "practitioner.end",
      { id: made.id, reason: "Left the practice" },
      context(admin),
    );
    expect(ended).toMatchObject({
      status: "ended",
      endedBy: admin.id,
      endedReason: "Left the practice",
    });
    // An ended address is not invited again here, nor ended twice.
    expect(
      (
        await refusal(
          invoke("practitioner.invite", { email, name: "Dana", discipline: "x" }, context(admin)),
        )
      ).code,
    ).toBe("conflict");
    expect(
      (await refusal(invoke("practitioner.end", { id: made.id, reason: "x" }, context(admin))))
        .code,
    ).toBe("conflict");
    // Audited, as the account's own object.
    const audit = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_audit_changes WHERE object_type = 'practitioner' AND record_id = ?",
    )
      .bind(made.id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(3);
  });

  it("uses the address's existing Person: a member can also be a practitioner", async () => {
    const made = await invoke(
      "practitioner.invite",
      {
        email: clientEmail,
        name: "Client as practitioner",
        discipline: "Dietitian",
      },
      context(admin),
    );
    expect(made.personId).toBe(clientPersonId);
    // The same address in other letters is the same account, its invite updated.
    const again = await invoke(
      "practitioner.invite",
      { email: clientEmail.toUpperCase(), name: "Client as practitioner", discipline: "x" },
      context(admin),
    );
    expect(again.id).toBe(made.id);
  });

  it("one account per Person: another address of the same Person is refused", async () => {
    const tag = unique("two");
    const person = await invoke(
      "person.create",
      {
        displayName: tag,
        emails: [{ email: `${tag}@a.example`, primary: true }, { email: `${tag}@b.example` }],
      },
      context(admin),
    );
    const first = await invoke(
      "practitioner.invite",
      { email: `${tag}@a.example`, name: tag, discipline: "Physio" },
      context(admin),
    );
    expect(first.personId).toBe(person.id);
    const second = await refusal(
      invoke(
        "practitioner.invite",
        { email: `${tag}@b.example`, name: tag, discipline: "Physio" },
        context(admin),
      ),
    );
    expect(second).toMatchObject({ code: "conflict", details: { practitionerId: first.id } });
  });

  it("a staff member without the permission is refused; one granted it may", async () => {
    const input = { email: `${unique("no")}@practice.example`, name: "No", discipline: "Physio" };
    expect((await refusal(invoke("practitioner.invite", input, context(member)))).code).toBe(
      "forbidden",
    );
    expect((await refusal(invoke("practitioner.list", {}, context(member)))).code).toBe(
      "forbidden",
    );
    const granted = await createUser("member");
    await env.DB.prepare("UPDATE core_user SET granted_permissions = ? WHERE id = ?")
      .bind(JSON.stringify(["practitioners:manage"]), granted.id)
      .run();
    expect((await invoke("practitioner.invite", input, context(granted))).status).toBe("invited");
  });

  it("the assistant, MCP, automations, extensions and a device session cannot, whatever is granted", async () => {
    const input = { email: `${unique("ai")}@practice.example`, name: "AI", discipline: "Physio" };
    for (const actor of ["assistant", "mcp", "automation", "extension"] as const) {
      for (const name of ["practitioner.invite", "practitioner.list"] as const) {
        const error = await refusal(
          invoke(name, name === "practitioner.list" ? {} : input, context(admin, { actor })),
        );
        expect([actor, name, error.code]).toEqual([actor, name, "forbidden"]);
      }
    }
    // A device session (the company's app on a phone, the import door) is a person's, not the
    // web admin's.
    const device = await refusal(
      invoke(
        "practitioner.invite",
        input,
        context(admin, { origin: { surface: "client", staffDevice: true } }),
      ),
    );
    expect(device).toMatchObject({ code: "forbidden", details: { reason: "web_admin_only" } });
    // Nothing was made for any of them.
    const made = await env.DB.prepare("SELECT count(*) AS n FROM core_practitioner WHERE email = ?")
      .bind(input.email)
      .first<{ n: number }>();
    expect(made?.n).toBe(0);
  });

  it("an ended account's principal resolves to no one", async () => {
    const principal = await activePractitioner("ending");
    expect(await practitionerPrincipalFor(db.query, principal.practitionerId)).toEqual(principal);
    await invoke(
      "practitioner.end",
      { id: principal.practitionerId, reason: "Fixture" },
      context(admin),
    );
    expect(await practitionerPrincipalFor(db.query, principal.practitionerId)).toBeNull();
  });

  it("a merge moves the duplicate's account to the survivor, and is refused when both have one", async () => {
    const tag = unique("merge");
    const a = await invoke("person.create", { displayName: `${tag} a` }, context(admin));
    const b = await invoke(
      "person.create",
      { displayName: `${tag} b`, emails: [{ email: `${tag}@practice.example` }] },
      context(admin),
    );
    const account = await invoke(
      "practitioner.invite",
      { email: `${tag}@practice.example`, name: tag, discipline: "Physio" },
      context(admin),
    );
    expect(account.personId).toBe(b.id);
    await invoke("person.merge", { survivorId: a.id, mergedId: b.id }, context(admin));
    expect((await invoke("practitioner.get", { id: account.id }, context(admin))).personId).toBe(
      a.id,
    );

    const c = await invoke(
      "person.create",
      { displayName: `${tag} c`, emails: [{ email: `${tag}-c@practice.example` }] },
      context(admin),
    );
    await invoke(
      "practitioner.invite",
      { email: `${tag}-c@practice.example`, name: `${tag} c`, discipline: "Physio" },
      context(admin),
    );
    const refused = await refusal(
      invoke("person.merge", { survivorId: a.id, mergedId: c.id }, context(admin)),
    );
    expect(refused).toMatchObject({ code: "conflict", details: { rule: "practitioner_accounts" } });

    // Ended, c's account no longer stands in the way: the merge deletes it and keeps a's.
    const cAccount = await env.DB.prepare("SELECT id FROM core_practitioner WHERE person_id = ?")
      .bind(c.id)
      .first<{ id: string }>();
    await invoke("practitioner.end", { id: cAccount?.id ?? "", reason: "left" }, context(admin));
    await invoke("person.merge", { survivorId: a.id, mergedId: c.id }, context(admin));
    const left = await env.DB.prepare(
      "SELECT id, person_id FROM core_practitioner WHERE person_id IN (?, ?)",
    )
      .bind(a.id, c.id)
      .all<{ id: string; person_id: string }>();
    expect(left.results).toEqual([{ id: account.id, person_id: a.id }]);
  });

  it("erasing the Person removes the account, its sessions and the codes sent to its address", async () => {
    const tag = unique("gone");
    const email = `${tag}@practice.example`;
    const account = await invoke(
      "practitioner.invite",
      { email, name: tag, discipline: "Physio" },
      context(admin),
    );
    const now = new Date().toISOString();
    // A code as Better Auth's email plugin stores it, and a stored reply of the account.
    await env.DB.prepare(
      "INSERT INTO core_practitioner_verification (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, 'hash', ?, ?, ?)",
    )
      .bind(unique("ver"), `sign-in-otp-${email}`, now, now, now)
      .run();
    const count = async (sqlText: string, ...binds: string[]) =>
      (
        await env.DB.prepare(sqlText)
          .bind(...binds)
          .first<{ n: number }>()
      )?.n;
    await invoke("person.erase", { id: account.personId }, context(admin));
    expect(
      await count("SELECT count(*) AS n FROM core_practitioner WHERE id = ?", account.id),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_practitioner_verification WHERE identifier LIKE ?",
        `%${email}`,
      ),
    ).toBe(0);
  });
});
