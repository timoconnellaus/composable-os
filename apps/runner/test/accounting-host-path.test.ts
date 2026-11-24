// Stage 61 step 3: the host path to the books (ADR 0881). The host calls the accounting
// connection as itself (`callAsHost`, purpose `accounting`): its reads and entries apply at once
// unless the floor denies them, and a void always waits for a person who is an admin. Nothing
// else reaches the connection: `integration.call`, the integration host's `call` (Code Mode's and
// an extension's `codemode:<gatekeeper>` go through it) and a session opened for code are
// refused for every caller (`accounting_host_only`).
import { env } from "cloudflare:workers";
import {
  ACCOUNTING_HOST_ONLY,
  type ActingUser,
  ALWAYS_REVIEWED_KINDS,
  CATALOGUE,
  invokeByName,
  keepsBooks,
} from "@composable-os/core";
import { GATEKEEPER_MODULES } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { hostFor, integrationRuntime } from "../src/integrations/runtime.ts";
import { createAdmin, db, unique } from "./helpers.ts";

const integrations = integrationRuntime(env);
const books = env.TEST_ACCOUNTING_BOOKS as unknown as {
  reset(books: string): Promise<void>;
  writesOf(books: string, reference: string): Promise<number>;
  state(books: string): Promise<{
    records: { ref: string; reference: string | null; kind: string; voided: boolean }[];
  }>;
};

let admin: ActingUser;
let member: ActingUser;
let connectionId: string;
let resource: string;
let name: string;

type Actor = "human" | "mcp" | "assistant" | "extension";

function op<T>(name: string, input: unknown, user = admin, actor: Actor = "human") {
  return invokeByName(name, input, {
    actor,
    user,
    origin: actor === "extension" ? { surface: "extension", extensionId: "x" } : { surface: "ui" },
    db,
    integrations,
  }) as Promise<T>;
}

const callAsHost = (input: Parameters<NonNullable<typeof integrations.callAsHost>>[0]) => {
  if (!integrations.callAsHost) throw new Error("This runtime has no callAsHost");
  return integrations.callAsHost(input);
};

function asHost(method: string, args: unknown[] = []) {
  return callAsHost({ connectionId, resource, method, args, purpose: "accounting" });
}

const caller = (user: ActingUser, actor: Actor = "human") => ({
  actor,
  userId: user.id,
  userName: user.name,
  role: user.role,
  origin: { surface: "ui" as const },
});

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

function summary(reference: string) {
  return {
    reference,
    currency: "AUD",
    date: "2026-11-20",
    text: "Card sales for 20 November",
    lines: [
      { account: "acc-clearing", taxRate: null, net: 1100, tax: 0, text: "Card sales" },
      { account: "acc-passes", taxRate: "tax-gst", net: -1000, tax: -100, text: "Passes" },
    ],
  };
}

beforeAll(async () => {
  admin = await createAdmin();
  member = await createAdmin();
  await env.DB.prepare("UPDATE core_user SET role = 'member' WHERE id = ?").bind(member.id).run();
  member = { ...member, role: "member" };
  name = unique("host-path")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 40);
  await books.reset(name);
  await op("integration.setVendor", { vendor: "accounting-fake", enabled: true });
  const created = await op<{ connection: { id: string } }>("connection.create", {
    vendor: "accounting-fake",
    scope: "org",
  });
  connectionId = created.connection.id;
  const bound = await op<{ resource: { key: string } }>("connection.bindResource", {
    id: connectionId,
    url: `accounting-fake://books/${name}`,
  });
  resource = bound.resource.key;
});

describe("the host's accounting call (purpose accounting)", () => {
  it("reads the books and posts an entry at once, as the host, with nothing to approve", async () => {
    const read = await asHost("describeBooks");
    expect(read.value).toMatchObject({ baseCurrency: "AUD", lockDate: null });
    const reference = `cos:summary:${unique("day")}:1`;
    const posted = await asHost("postSummary", [summary(reference)]);
    expect(posted.pending).toEqual([]);
    expect(posted.applied).toMatchObject([{ actionKind: "accounting.post" }]);
    expect(await books.writesOf(name, reference)).toBe(1);
  });

  it("holds a void for an admin whatever the host says, and no AI actor or member approves it", async () => {
    expect(ALWAYS_REVIEWED_KINDS.has("accounting.void")).toBe(true);
    const id = unique("inv");
    const contact = await asHost("upsertContact", [
      { reference: `cos:organisation:${id}`, name: `Customer ${id}` },
    ]);
    expect(contact.applied).toMatchObject([{ actionKind: "accounting.contact" }]);
    const found = await asHost("findContacts", [{ reference: `cos:organisation:${id}` }]);
    const [made] = found.value as { ref: string }[];
    const invoiceReference = `cos:invoice:${id}:1`;
    const invoice = await asHost("postInvoice", [
      {
        reference: invoiceReference,
        currency: "AUD",
        number: `INV-${id}`.slice(0, 40),
        contact: made?.ref,
        issueDate: "2026-11-20",
        dueDate: "2026-12-04",
        lines: [
          {
            text: "Room hire",
            account: "acc-sales",
            taxRate: "tax-gst",
            quantity: 1,
            unitPrice: 2000,
            net: 2000,
            tax: 200,
          },
        ],
      },
    ]);
    expect(invoice.applied).toHaveLength(1);
    const record = await asHost("findByReference", [invoiceReference]);
    const ref = (record.value as { ref: string }).ref;

    const voided = await asHost("voidDocument", [
      { reference: invoiceReference, ref, reason: "Issued to the wrong customer" },
    ]);
    expect(voided.applied).toEqual([]);
    expect(voided.pending).toHaveLength(1);
    const isVoided = async () =>
      (await books.state(name)).records.find((r) => r.reference === invoiceReference)?.voided;
    expect(await isVoided()).toBe(false);

    const actionId = voided.pending[0]?.actionId as string;
    for (const [user, actor] of [
      [admin, "mcp"],
      [admin, "assistant"],
      [member, "human"],
    ] as const) {
      const error = await refusal(op("approval.approve", { actionIds: [actionId] }, user, actor));
      expect(error, `${actor} as ${user.role}`).toMatchObject({ code: "forbidden" });
    }
    expect(await isVoided()).toBe(false);

    await op("approval.approve", { actionIds: [actionId] });
    expect(await isVoided()).toBe(true);
  });

  it("reaches books only, and books only by that purpose", async () => {
    await op("integration.setVendor", { vendor: "webhook", enabled: true });
    const other = await op<{ connection: { id: string } }>("connection.create", {
      vendor: "webhook",
      scope: "org",
    });
    const endpointId = unique("books").toLowerCase().slice(0, 30);
    await op("connection.configure", {
      id: other.connection.id,
      pattern: "webhook://endpoint/:endpointId",
      method: "configure",
      args: [{ endpointId, scheme: "hmac-sha256" }],
    });
    const bound = await op<{ resource: { key: string } }>("connection.bindResource", {
      id: other.connection.id,
      url: `webhook://endpoint/${endpointId}`,
    });
    const error = await refusal(
      callAsHost({
        connectionId: other.connection.id,
        resource: bound.resource.key,
        method: "describe",
        args: [],
        purpose: "accounting",
      }),
    );
    expect(String(error)).toContain("reaches books only");
    for (const purpose of ["orders", "agreements"] as const) {
      const error = await refusal(
        callAsHost({
          connectionId,
          resource,
          method: purpose === "orders" ? "describeBooks" : "send",
          args: [],
          purpose,
        }),
      );
      expect(String(error), purpose).toContain(ACCOUNTING_HOST_ONLY);
    }
  });
});

describe("the host-only rule (accounting_host_only)", () => {
  it("refuses integration.call on the books for every caller, before anything is sent", async () => {
    const reference = `cos:summary:${unique("ai")}:1`;
    for (const actor of ["human", "mcp", "assistant", "extension"] as const) {
      for (const [method, args] of [
        ["describeBooks", []],
        ["postSummary", [summary(reference)]],
      ] as const) {
        const error = await refusal(
          op("integration.call", { connectionId, resource, method, args }, admin, actor),
        );
        // Extension code is refused before it gets that far (it holds no grant to call); every
        // other caller reaches the rule.
        expect(error, `${actor} ${method}`).toMatchObject({
          code: "forbidden",
          ...(actor === "extension" ? {} : { details: { rule: ACCOUNTING_HOST_ONLY } }),
        });
      }
    }
    expect(await books.writesOf(name, reference)).toBe(0);
  });

  it("refuses the integration host's call and a code session, which Code Mode and extensions use", async () => {
    const reference = `cos:summary:${unique("code")}:1`;
    for (const actor of ["human", "extension", "automation"] as const) {
      const error = await refusal(
        integrations.call({
          connectionId,
          resource,
          method: "postSummary",
          args: [summary(reference)],
          caller: { ...caller(admin), actor },
        }),
      );
      expect(String(error), actor).toContain(ACCOUNTING_HOST_ONLY);
    }
    const session = await refusal(
      // The stub's own type of a session is too deep to check here.
      (
        hostFor(env, connectionId) as unknown as { openSession(i: unknown): Promise<unknown> }
      ).openSession({ resource, caller: caller(admin, "extension") }),
    );
    expect(String(session)).toContain(ACCOUNTING_HOST_ONLY);
    expect(await books.writesOf(name, reference)).toBe(0);
    // The types stay readable: they describe the contract and reach nothing.
    const { types } = await op<{ types: string }>("integration.types", { connectionId, resource });
    expect(types).toContain("export interface AccountingSession");
  });

  it("offers no codemode module for a gatekeeper that keeps books", () => {
    const keepers = CATALOGUE.filter((e) => keepsBooks(e.vendor)).map((e) => e.vendor);
    expect(keepers).toContain("accounting-fake");
    for (const vendor of keepers) {
      expect(GATEKEEPER_MODULES as readonly string[]).not.toContain(vendor);
    }
  });
});
