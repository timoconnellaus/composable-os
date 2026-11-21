// Stage 22 step 4 (ADR 0402): the sign-up setting and invites. Changing the setting is a human
// admin's alone (criterion 11); who may be sent a sign-in code follows it, invites, existing
// accounts and the erased-address list. Sign-in itself is tested in packages/auth.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTORS,
  type ActingUser,
  customerCodeTarget,
  customerMayGetCode,
  ForbiddenError,
  inviteCustomer,
  invoke,
  loadCustomerSignup,
  newId,
  ValidationError,
} from "../src/index.ts";
import { auditChanges, context, createUser, db, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;

const address = (label: string) => `${unique(label)}@customers.example`;

async function erase(email: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  const hash = `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  await env.DB.prepare(
    "INSERT INTO core_erased_address (hash, object_type, erased_at, erased_by) VALUES (?, 'person', ?, NULL)",
  )
    .bind(hash, new Date().toISOString())
    .run();
}

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM core_settings WHERE key = 'customer_signup'").run();
});

describe("the connection customer mail goes out from (stage 23)", () => {
  it("is unset by default, refuses a connection that cannot send, and is a human admin's", async () => {
    expect(await customerCodeTarget(db.query)).toEqual({
      problem:
        "no email connection is chosen for customer mail (an admin sets it in the customer settings)",
    });
    await expect(
      invoke("customer.settings.update", { emailConnectionId: "con_nope" }, context(admin)),
    ).rejects.toMatchObject({ code: "invalid_input", details: { field: "emailConnectionId" } });
    await expect(
      invoke(
        "customer.settings.update",
        { emailConnectionId: null },
        context(admin, { actor: "assistant" }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("the sign-up setting", () => {
  it("is invite only by default, and when the stored value is unreadable", async () => {
    expect(await invoke("customer.settings.get", {}, context(member))).toEqual({
      signup: "invite_only",
      eraseDueDays: 30,
      emailConnectionId: null,
    });
    await env.DB.prepare(
      "INSERT INTO core_settings (key, value, updated_at) VALUES ('customer_signup', '\"wide-open\"', ?)",
    )
      .bind(new Date().toISOString())
      .run();
    expect(await loadCustomerSignup(db.query)).toBe("invite_only");
  });

  it("a human admin changes it, and the change is audited", async () => {
    expect(await invoke("customer.settings.update", { signup: "open" }, context(admin))).toEqual({
      signup: "open",
      eraseDueDays: 30,
      emailConnectionId: null,
      previous: { signup: "invite_only", eraseDueDays: 30, emailConnectionId: null },
    });
    expect(await loadCustomerSignup(db.query)).toBe("open");
    const changes = await auditChanges("customer_signup");
    expect(changes.at(-1)).toMatchObject({
      operation: "customer.settings.update",
      object_type: "settings",
    });
    expect(changes.at(-1)?.diff).toMatchObject({
      signup: { before: "invite_only", after: "open" },
    });
  });

  it("is refused for every actor that is not a human, admin or not", async () => {
    for (const actor of ACTORS.filter((a) => a !== "human")) {
      await expect(
        invoke("customer.settings.update", { signup: "open" }, context(admin, { actor })),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(
      invoke("customer.settings.update", { signup: "open" }, context(member)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await loadCustomerSignup(db.query)).toBe("invite_only");
  });

  it("is not open to customers or the public", async () => {
    const outside = { principal: { kind: "public" as const }, db };
    await expect(
      invoke("customer.settings.update", { signup: "open" }, outside),
    ).rejects.toMatchObject({ code: "unknown_operation" });
  });
});

describe("who may be sent a sign-in code", () => {
  it("invite only: an invited address, not another", async () => {
    const invited = address("invited");
    expect(await inviteCustomer(db, ` ${invited.toUpperCase()} `, admin.id)).toEqual({
      email: invited,
    });
    expect(await customerMayGetCode(db.query, invited)).toBe(true);
    expect(await customerMayGetCode(db.query, address("stranger"))).toBe(false);
    expect(await customerMayGetCode(db.query, "not an address")).toBe(false);
  });

  it("open: any address", async () => {
    await invoke("customer.settings.update", { signup: "open" }, context(admin));
    expect(await customerMayGetCode(db.query, address("anyone"))).toBe(true);
  });

  it("an address with an account, while the account is active", async () => {
    const email = address("account");
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_customer (id, email, email_verified, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
    )
      .bind(newId("customer"), email, now, now)
      .run();
    expect(await customerMayGetCode(db.query, email)).toBe(true);
    await env.DB.prepare("UPDATE core_customer SET status = 'disabled' WHERE email = ?")
      .bind(email)
      .run();
    expect(await customerMayGetCode(db.query, email)).toBe(false);
  });

  it("never an erased person's address, even invited or open, and it cannot be invited", async () => {
    const email = address("erased");
    await inviteCustomer(db, email, admin.id);
    await invoke("customer.settings.update", { signup: "open" }, context(admin));
    await erase(email);
    expect(await customerMayGetCode(db.query, email)).toBe(false);
    await expect(inviteCustomer(db, email, admin.id)).rejects.toBeInstanceOf(ValidationError);
  });
});
