// Stage 22 step 6 (ADR 0402, ADR 0414): the `customer` key and tool audiences in the SDK.
// Criterion 8 for tools (the risk floor), criterion 9 (a runtime extension that opens anything
// outside staff fails `check`), and the declaration reaching the field registry and the seam.
import { type ExtensionManifest, validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { checkManifest } from "../src/extensions/install.ts";
import { toolOperation } from "../src/extensions/tools.ts";
import {
  type ActingUser,
  audiencesOf,
  coreRegistry,
  getObject,
  invoke,
  openOperations,
} from "../src/index.ts";
import { call, outside } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

let admin: ActingUser;
const id = extId("pack");
const BOOKING = `${id}.booking`;

const schema = { type: "object", properties: { id: { type: "string" } } };
const tool = (rest: Record<string, unknown> = {}) => ({
  description: "A test tool a customer may or may not be able to call.",
  risk: "write",
  inputSchema: schema,
  outputSchema: {},
  ...rest,
});

function pack(
  tools: Record<string, unknown> = {},
  customer: unknown = undefined,
): ExtensionManifest {
  return manifest(id, {
    objects: {
      booking: {
        label: "Booking",
        plural: "Bookings",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title", required: true },
          status: { type: "text", label: "Status" },
          note: { type: "text", label: "Note" },
          guest: { type: "relation", label: "Guest", to: "person" },
          friends: { type: "relation", label: "Friends", to: "person", many: true },
        },
        ...(customer ? { customer } : {}),
      },
    },
    tools,
  } as never);
}

const DECLARED = { field: "guest", read: ["title", "status", "note"], write: ["note"] };
const messages = (raw: unknown) =>
  validateManifest(raw).issues.map((i) => `${i.path}: ${i.message}`);

beforeAll(async () => {
  admin = await createUser("admin");
});

describe("the contract checks a customer declaration", () => {
  it("accepts a relation to one person with listed fields", () => {
    expect(messages(pack({}, DECLARED))).toEqual([]);
  });

  it("refuses what does not hold together", () => {
    const bad = (customer: unknown) => messages(pack({}, customer)).join("\n");
    expect(bad({ field: "status", read: [], write: [] })).toContain(
      "must be a relation to one person",
    );
    expect(bad({ field: "friends", read: [], write: [] })).toContain(
      "must be a relation to one person",
    );
    expect(bad({ field: "nobody", read: [], write: [] })).toContain("is not a field");
    expect(bad({ ...DECLARED, read: ["title", "nope"] })).toContain('lists "nope"');
    expect(bad({ ...DECLARED, write: ["status", "note"], read: ["note"] })).toContain(
      'customer.write lists "status", which customer.read does not',
    );
    expect(bad({ field: "guest", read: ["guest"], write: ["guest"] })).toContain(
      "may not list the customer field",
    );
  });
});

describe("the risk floor for tools (criterion 8)", () => {
  for (const audience of ["customer", "public"]) {
    for (const risk of ["bulk-write", "destructive"]) {
      it(`a ${risk} tool open to ${audience} fails the check, and does not load`, () => {
        const m = pack({ wipe: tool({ risk, audiences: [audience] }) }, DECLARED);
        expect(messages(m).join("\n")).toContain(
          `A tool open to ${audience} callers must have risk read or write, not ${risk}`,
        );
        expect(() => toolOperation(m, "wipe", m.tools.wipe as never, "shipped")).toThrow(
          /must have risk class read or write/,
        );
      });
    }
  }

  it("read and write tools open to customers pass and load with their audiences", () => {
    const m = pack(
      { cancel: tool({ audiences: ["customer"], customerFields: { [BOOKING]: ["status"] } }) },
      DECLARED,
    );
    expect(messages(m)).toEqual([]);
    const op = toolOperation(m, "cancel", m.tools.cancel as never, "shipped");
    expect(audiencesOf(op)).toEqual(["customer"]);
  });

  it("a tool may widen only real fields of an object with a customer, never id or the customer field", () => {
    const fields = (customerFields: unknown, customer: unknown = DECLARED) =>
      messages(pack({ t: tool({ audiences: ["customer"], customerFields }) }, customer)).join("\n");
    expect(fields({ [BOOKING]: ["guest"] })).toContain('A tool may never set "guest"');
    expect(fields({ [BOOKING]: ["id"] })).toContain('A tool may never set "id"');
    expect(fields({ [BOOKING]: ["nope"] })).toContain('"nope" is not a field');
    expect(fields({ "other.thing": ["x"] })).toContain("is not an object of this extension");
    expect(fields({ [BOOKING]: ["status"] }, null)).toContain("declares no customer");
    expect(
      messages(pack({ t: tool({ customerFields: { [BOOKING]: ["status"] } }) }, DECLARED)).join(
        "\n",
      ),
    ).toContain("only for a tool open to customer");
  });
});

describe("a runtime extension cannot open anything outside staff (criterion 9)", () => {
  const now = new Date().toISOString();

  it("fails check with a message for a tool audience and for an object's customer", async () => {
    const m = pack(
      {
        cancel: tool({ audiences: ["staff", "customer"] }),
        wave: tool({ audiences: ["public"], risk: "read" }),
      },
      DECLARED,
    );
    const runtime = await checkManifest(db.query, id, m, now, { source: "runtime" });
    const outsideIssues = runtime.issues.filter((i) => i.code === "outside_audience");
    expect(outsideIssues.map((i) => i.path).sort()).toEqual([
      "objects.booking.customer",
      "tools.cancel.audiences",
      "tools.wave.audiences",
    ]);
    expect(outsideIssues[0]?.message).toMatch(/A runtime extension cannot/);
    expect(runtime.plan).toBeNull();
  });

  it("the same manifest passes as a shipped extension, and a plain one passes as runtime", async () => {
    const m = pack({ cancel: tool({ audiences: ["staff", "customer"] }) }, DECLARED);
    expect((await checkManifest(db.query, id, m, now, { source: "shipped" })).issues).toEqual([]);
    expect(
      (await checkManifest(db.query, id, pack({ plain: tool() }), now, { source: "runtime" }))
        .issues,
    ).toEqual([]);
  });

  it("a runtime extension's tool loads as staff only whatever its manifest says", () => {
    const m = pack({ cancel: tool({ audiences: ["customer"] }) }, DECLARED);
    expect(audiencesOf(toolOperation(m, "cancel", m.tools.cancel as never, "runtime"))).toEqual([
      "staff",
    ]);
    expect(audiencesOf(toolOperation(m, "cancel", m.tools.cancel as never))).toEqual(["staff"]);
  });
});

describe("the declaration reaches the registry and the seam", () => {
  it("an object reconciled with a customer key is read by its customer through the seam", async () => {
    await reconcile(pack({}, DECLARED));
    expect(getObject(BOOKING)?.customer).toEqual(DECLARED);
    const guest = await invoke("person.create", { givenName: "Gina" }, context(admin));
    const other = await invoke("person.create", { givenName: "Otto" }, context(admin));
    for (const [person, title] of [
      [guest.id, "Gina's booking"],
      [other.id, "Otto's booking"],
    ] as const) {
      await invoke(
        "record.create",
        { object: BOOKING, values: { title, status: "held", guest: person } },
        context(admin),
      );
    }
    const page = await call(
      "fixture.myList",
      { object: BOOKING },
      outside({ kind: "customer", customerId: "cus_gina", personId: guest.id }),
    );
    expect(page).toMatchObject({
      ok: true,
      value: { items: [{ values: { title: "Gina's booking", status: "held", note: null } }] },
    });
    expect((page as { value: { items: unknown[] } }).value.items).toHaveLength(1);
  });
});

describe("the generic writes are for tools only", () => {
  it("my.create, my.update and my.delete are listed as toolOnly and refuse a direct call", async () => {
    const listed = openOperations(coreRegistry.list()).operations.filter((op) => op.toolOnly);
    // And the public reads a pack's tools make (stage 27, ADR 0438).
    expect(listed.map((op) => op.name)).toEqual([
      // Stage 42 (ADR 0478): which records the caller holds access to, for a pack's tool.
      "access.check",
      "my.create",
      // Stage 41 (ADR 0414, amended): a customer's own record to the Trash, where its object says.
      "my.delete",
      "my.update",
      // Stage 31a step 8 (ADR 0560): a drop-in booking made with its order, from a pack's tool.
      "order.startHeld",
      "public.get",
      "public.list",
      // Stage 31a (ADR 0504): the dry run of a requested move (a member's cancel).
      "state.resolve",
    ]);
    for (const name of ["my.create", "my.update", "my.delete"]) {
      const direct = await call(
        name,
        { object: BOOKING, id: "rec_x", values: { note: "hi" } },
        outside({ kind: "customer", customerId: "cus_gina", personId: "per_x" }),
      );
      expect(direct).toMatchObject({ ok: false, error: { code: "unknown_operation" } });
    }
  });
});
