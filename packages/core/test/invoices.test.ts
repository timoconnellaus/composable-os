// Stage 35 step 2 (ADRs 0730 and 0732): quotes', invoices' and credit notes' records, their
// numbering, the invoice settings, drafts and the document event log.
//
// Drafts are written by staff with invoices:write (the assistant for them, through the gate);
// a member without it, a customer, the public and an extension's own account are refused. A
// number is given only in the batch that issues (stage 35 step 3 calls `numberStatements`; these
// tests queue it themselves): twenty issues at once take twenty consecutive numbers, and a failed
// batch takes none. Once issued, the database refuses any change to what a document says, raw SQL
// included. The event log only grows. Only a person who is an admin changes the settings, and a
// change of bank details is told to every admin.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type Actor,
  DEFAULT_INVOICE_SETTINGS,
  eventStatement,
  type InvocationContext,
  invoke,
  numberStatements,
} from "../src/index.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";
import {
  createBuyer,
  createTicketType,
  installBoxOffice,
  outside,
  PUBLIC,
  refusal,
  run,
  TICKET_TYPE,
} from "./order-fixtures.ts";

let admin: ActingUser;
let otherAdmin: ActingUser;
let member: ActingUser;
let personId: string;
let orgId: string;
let ticket: string;

/** The value, or the test fails here. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing");
  return value;
}

const GST = { key: "gst", label: "GST", rate: 1000, retired: false };
const ZERO = { key: "free", label: "GST free", rate: 0, retired: false };

beforeAll(async () => {
  admin = await createUser("admin");
  otherAdmin = await createUser("admin");
  member = await createUser("member");
  await installBoxOffice(admin);
  ticket = await createTicketType(admin, { name: "Fixture class pass", price: 12 });
  personId = (
    await invoke(
      "person.create",
      { givenName: unique("Bill"), emails: [{ email: `${unique("bill")}@example.com` }] },
      context(admin),
    )
  ).id as string;
  orgId = (await invoke("organisation.create", { name: unique("Fixture Co") }, context(admin)))
    .id as string;
  // Fixture rates and details: not anyone's real ones.
  await invoke(
    "invoice.settings.update",
    {
      taxRates: [GST, ZERO],
      defaultTaxRate: "gst",
      business: {
        legalName: "Fixture Studio Pty",
        addressLines: ["1 Example Street"],
        taxNumber: "00 000 000 000",
        taxNumberLabel: "Tax number",
      },
    },
    context(admin),
  );
}, 120_000);

async function draftInvoice(extra: Record<string, unknown> = {}, by = admin) {
  return invoke(
    "invoice.create",
    {
      billTo: { personId },
      lines: [
        { item: { object: TICKET_TYPE, id: ticket }, quantity: 2 },
        { description: "Room hire, fixture", quantity: 1.5, unit: "hours", unitPrice: 4000 },
      ],
      ...extra,
    },
    context(by),
  );
}

/** Issues a draft as stage 35 step 3 will: the next number in the issuing batch. */
async function issueRaw(id: string, extra: Record<string, unknown> = {}) {
  const row = (await env.DB.prepare("SELECT version FROM core_invoice WHERE id = ?")
    .bind(id)
    .first()) as { version: number };
  await db.batch(
    numberStatements(db.query, "invoice", id, row.version, {
      state: "issued",
      issued_on: "2026-11-24",
      issued_at: new Date().toISOString(),
      due_on: "2026-12-08",
      bill_to_name: "Fixture Person",
      business: JSON.stringify({ legalName: "Fixture Studio Pty" }),
      ...extra,
    }),
  );
  return (await env.DB.prepare("SELECT * FROM core_invoice WHERE id = ?")
    .bind(id)
    .first()) as Record<string, unknown>;
}

const AI_ACTORS: { actor: Actor; origin: InvocationContext["origin"] }[] = [
  { actor: "assistant", origin: { surface: "assistant", sessionId: "ath_invoices" } },
  {
    actor: "mcp",
    origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: "cap_invoices" },
  },
  { actor: "automation", origin: { surface: "automation", automationId: "x.y" } },
  { actor: "extension", origin: { surface: "extension", extensionId: "bookings" } },
];

describe("drafts", () => {
  it("a person with invoices:write drafts an invoice with a record's line and a typed one, with no number", async () => {
    const invoice = await draftInvoice();
    expect(invoice).toMatchObject({
      state: "draft",
      number: null,
      kind: "standard",
      currency: "AUD",
      taxMode: "inclusive",
      paymentTermsDays: 14,
      billTo: { personId, organisationId: null, printed: null },
    });
    const [pass, hire] = invoice.lines;
    // The host's price, from the record (12.00, with tax as every record's price is).
    expect(pass).toMatchObject({
      source: "record",
      item: { object: TICKET_TYPE, id: ticket },
      description: "Fixture class pass",
      quantity: 2,
      unitPrice: 1200,
      taxRate: { key: "gst", rate: 1000 },
      total: 2400,
      tax: 218,
      net: 2182,
    });
    expect(hire).toMatchObject({
      source: "custom",
      quantity: 1.5,
      unit: "hours",
      unitPrice: 4000,
      total: 6000,
      tax: 545,
      net: 5455,
    });
    expect(invoice).toMatchObject({ total: 8400, taxTotal: 763, netTotal: 7637 });
    expect(invoice.taxByRate).toEqual([
      { key: "gst", label: "GST", rate: 1000, net: 7637, tax: 763, total: 8400 },
    ]);
    const read = await invoke("invoice.get", { id: invoice.id }, context(member));
    expect(read).toEqual(invoice);
    const row = await env.DB.prepare("SELECT number, number_seq FROM core_invoice WHERE id = ?")
      .bind(invoice.id)
      .first();
    expect(row).toEqual({ number: null, number_seq: null });
  });

  it("a host-priced line takes no price from the caller", async () => {
    const refused = await refusal(
      invoke(
        "invoice.create",
        { lines: [{ item: { object: TICKET_TYPE, id: ticket }, unitPrice: 1 }] },
        context(admin),
      ),
    );
    expect(refused.details.rule).toBe("priced_by_host");
    const invoice = await draftInvoice();
    const pass = must(invoice.lines[0]);
    const changed = await refusal(
      invoke("invoice.updateLine", { lineId: pass.id, change: { unitPrice: 1 } }, context(admin)),
    );
    expect(changed.details.rule).toBe("priced_by_host");
  });

  it("lines are added, changed, moved and removed, and the totals follow", async () => {
    const invoice = await draftInvoice();
    const added = await invoke(
      "invoice.addLine",
      {
        id: invoice.id,
        version: invoice.version,
        line: {
          description: "Materials",
          quantity: 3,
          unitPrice: 1000,
          taxRate: "free",
          discount: { kind: "percent", value: 1000, reason: "Fixture discount" },
        },
      },
      context(admin),
    );
    const materials = must(added.lines[2]);
    expect(materials).toMatchObject({
      position: 2,
      net: 2700,
      tax: 0,
      total: 2700,
      discount: { kind: "percent", value: 1000, amount: 300 },
      taxRate: { key: "free", rate: 0 },
    });
    expect(added.total).toBe(8400 + 2700);
    expect(added.taxByRate.map((r: { key: string }) => r.key)).toEqual(["gst", "free"]);
    const moved = await invoke(
      "invoice.updateLine",
      { lineId: materials.id, change: { position: 0, quantity: 1 } },
      context(admin),
    );
    expect(moved.lines.map((l: { description: string }) => l.description)).toEqual([
      "Materials",
      "Fixture class pass",
      "Room hire, fixture",
    ]);
    expect(moved.lines[0]).toMatchObject({ position: 0, net: 900, total: 900 });
    const removed = await invoke(
      "invoice.removeLine",
      { lineId: must(moved.lines[1]).id },
      context(admin),
    );
    expect(removed.lines.map((l: { position: number }) => l.position)).toEqual([0, 1]);
    expect(removed.total).toBe(900 + 6000);
    // A stale version is refused.
    const stale = await refusal(
      invoke("invoice.update", { id: invoice.id, version: 0, title: "x" }, context(admin)),
    );
    expect(stale.details.rule).toBe("document_changed");
  });

  it("amounts typed without tax add the tax on top; a record's price is worked back to its net", async () => {
    const invoice = await draftInvoice({ taxMode: "exclusive" });
    const [pass, hire] = invoice.lines;
    // 12.00 with tax is 10.91 without (1200 × 10000 / 11000, half up), and 10% on top of 21.82.
    expect(pass).toMatchObject({ unitPrice: 1091, net: 2182, tax: 218, total: 2400 });
    expect(hire).toMatchObject({ unitPrice: 4000, net: 6000, tax: 600, total: 6600 });
    // Switching back prices every line again.
    const back = await invoke(
      "invoice.update",
      { id: invoice.id, taxMode: "inclusive" },
      context(admin),
    );
    expect(back.lines[0]).toMatchObject({ unitPrice: 1200, total: 2400 });
    expect(back.lines[1]).toMatchObject({ unitPrice: 4000, total: 6000, tax: 545 });
  });

  it("a quote is drafted the same way, with its validity and deposit", async () => {
    const quote = await invoke(
      "quote.create",
      {
        billTo: { personId, organisationId: orgId },
        siteAddress: "Fixture site",
        validUntil: "2026-12-24",
        deposit: { kind: "percent", value: 2500 },
        lines: [{ description: "Fixture work", quantity: 10, unit: "hours", unitPrice: 9000 }],
      },
      context(admin),
    );
    expect(quote).toMatchObject({
      state: "draft",
      number: null,
      validUntil: "2026-12-24",
      deposit: { kind: "percent", value: 2500 },
      billTo: { personId, organisationId: orgId },
      total: 90000,
    });
    const list = await invoke(
      "quote.list",
      { filter: { field: "organisationId", op: "eq", value: orgId } },
      context(admin),
    );
    expect(list.items.map((q: { id: string }) => q.id)).toContain(quote.id);
    await invoke("quote.delete", { id: quote.id }, context(admin));
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM core_quote_line WHERE quote_id = ?")
        .bind(quote.id)
        .first(),
    ).toEqual({ n: 0 });
  });

  it("a member without invoices:write, a customer, the public and an extension cannot draft one", async () => {
    expect((await refusal(draftInvoice({}, member))).code).toBe("forbidden");
    const buyer = await createBuyer(admin, "invoicebuyer");
    for (const principal of [buyer.principal, PUBLIC]) {
      const refused = await refusal(
        run("invoice.create", { billTo: { personId } }, outside(principal)),
      );
      expect(["forbidden", "unknown_operation", "not_found"]).toContain(refused.code);
    }
    // An extension's code calls as its own account, a member: no invoices:write.
    const extensionAccount = await createUser("member");
    const viaExtension = await refusal(
      invoke(
        "invoice.create",
        {},
        context(extensionAccount, {
          actor: "extension",
          origin: { surface: "extension", extensionId: "bookings" },
        }),
      ),
    );
    expect(viaExtension.code).toBe("forbidden");
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_invoice WHERE created_by IN (?, ?)",
    )
      .bind(member.id, extensionAccount.id)
      .first();
    expect(count).toEqual({ n: 0 });
  });

  it("the assistant drafts for a person who holds invoices:write, through the gate", async () => {
    await setPreset("autonomous");
    try {
      const drafted = await invoke(
        "invoice.create",
        { billTo: { personId }, lines: [{ description: "Drafted", unitPrice: 500 }] },
        context(admin, {
          actor: "assistant",
          origin: { surface: "assistant", sessionId: "ath_invoices" },
        }),
      );
      expect(drafted).toMatchObject({ state: "draft", total: 500 });
    } finally {
      await setPreset("balanced");
    }
  });
});

describe("numbering", () => {
  it("twenty issues at once take twenty different consecutive numbers", async () => {
    const drafts = [];
    for (let n = 0; n < 20; n += 1) drafts.push((await draftInvoice()).id as string);
    const before = (await env.DB.prepare(
      "SELECT next_number FROM core_document_counter WHERE series = 'invoice'",
    ).first()) as { next_number: number };
    const issued = await Promise.all(drafts.map((id) => issueRaw(id)));
    const seqs = issued.map((r) => Number(r.number_seq)).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(20);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => before.next_number + i));
    for (const row of issued) {
      expect(row.number).toBe(`INV-${String(row.number_seq).padStart(4, "0")}`);
      expect(row.state).toBe("issued");
    }
    const after = (await env.DB.prepare(
      "SELECT next_number FROM core_document_counter WHERE series = 'invoice'",
    ).first()) as { next_number: number };
    expect(after.next_number).toBe(before.next_number + 20);
  });

  it("a failed issue uses no number", async () => {
    const id = (await draftInvoice()).id as string;
    const before = await env.DB.prepare(
      "SELECT next_number, version FROM core_document_counter WHERE series = 'invoice'",
    ).first();
    const row = (await env.DB.prepare("SELECT version FROM core_invoice WHERE id = ?")
      .bind(id)
      .first()) as { version: number };
    // The batch fails after the number was given (a stale read of the document here).
    await expect(
      db.batch(numberStatements(db.query, "invoice", id, row.version + 5, { state: "issued" })),
    ).rejects.toThrow(/core_document_stale/);
    expect(
      await env.DB.prepare(
        "SELECT next_number, version FROM core_document_counter WHERE series = 'invoice'",
      ).first(),
    ).toEqual(before);
    expect(
      await env.DB.prepare("SELECT state, number FROM core_invoice WHERE id = ?").bind(id).first(),
    ).toEqual({ state: "draft", number: null });
    // A number other than the series' own is refused, and an issued invoice keeps the one it has.
    await expect(
      env.DB.prepare(
        "UPDATE core_invoice SET number = 'INV-9999', number_seq = 9999, state = 'issued', version = version + 1 WHERE id = ?",
      )
        .bind(id)
        .run(),
    ).rejects.toThrow(/core_document_number/);
    await expect(
      env.DB.prepare("UPDATE core_invoice SET state = 'issued', version = version + 1 WHERE id = ?")
        .bind(id)
        .run(),
    ).rejects.toThrow(/core_document_number/);
  });

  it("the next number is only raised, by a person who is an admin, against the version read", async () => {
    const get = () => invoke("invoice.settings.get", {}, context(admin));
    const series = must(
      (await get()).series.find((s: { series: string }) => s.series === "invoice"),
    );
    const raised = await invoke(
      "invoice.settings.update",
      {
        series: [
          {
            series: "invoice",
            version: series.version,
            nextNumber: series.nextNumber + 100,
            prefix: "INV-",
          },
        ],
      },
      context(admin),
    );
    const now = must(raised.series.find((s: { series: string }) => s.series === "invoice"));
    expect(now).toMatchObject({ nextNumber: series.nextNumber + 100, version: series.version + 1 });
    const down = await refusal(
      invoke(
        "invoice.settings.update",
        { series: [{ series: "invoice", version: now.version, nextNumber: now.nextNumber - 1 }] },
        context(admin),
      ),
    );
    expect(down.details.rule).toBe("number_down");
    const stale = await refusal(
      invoke(
        "invoice.settings.update",
        { series: [{ series: "invoice", version: series.version, nextNumber: 999999 }] },
        context(admin),
      ),
    );
    expect(stale.details.rule).toBe("document_numbering");
    expect(
      (
        await refusal(
          invoke(
            "invoice.settings.update",
            { series: [{ series: "invoice", version: now.version, nextNumber: 999999 }] },
            context(member),
          ),
        )
      ).code,
    ).toBe("forbidden");
    for (const extra of AI_ACTORS) {
      const refused = await refusal(
        invoke(
          "invoice.settings.update",
          { series: [{ series: "invoice", version: now.version, nextNumber: 999999 }] },
          context(admin, extra),
        ),
      );
      expect(refused.code, extra.actor).toBe("forbidden");
    }
    // The database holds the same rule for any writer.
    await expect(
      env.DB.prepare(
        "UPDATE core_document_counter SET next_number = 1, version = version + 1 WHERE series = 'invoice'",
      ).run(),
    ).rejects.toThrow(/core_document_counter_back/);
    // A write that does not name the version it read (it moves by exactly one) is refused.
    await expect(
      env.DB.prepare(
        "UPDATE core_document_counter SET next_number = next_number + 1 WHERE series = 'invoice'",
      ).run(),
    ).rejects.toThrow(/core_document_counter_back/);
    await expect(
      env.DB.prepare("DELETE FROM core_document_counter WHERE series = 'invoice'").run(),
    ).rejects.toThrow(/core_document_counter_back/);
    await expect(
      env.DB.prepare(
        "INSERT OR REPLACE INTO core_document_counter (series, prefix, next_number) VALUES ('invoice', 'X', 1)",
      ).run(),
    ).rejects.toThrow(/core_document_counter_back/);
    // The next issue takes the raised number.
    const issued = await issueRaw((await draftInvoice()).id as string);
    expect(issued.number_seq).toBe(now.nextNumber);
  });
});

describe("an issued document is never changed", () => {
  it("is refused by every operation and by any direct update or delete", async () => {
    const invoice = await draftInvoice();
    const firstLine = must(invoice.lines[0]);
    const issued = await issueRaw(invoice.id);
    for (const [name, input] of [
      ["invoice.update", { id: invoice.id, title: "changed" }],
      ["invoice.addLine", { id: invoice.id, line: { description: "x", unitPrice: 1 } }],
      ["invoice.updateLine", { lineId: firstLine.id, change: { quantity: 9 } }],
      ["invoice.removeLine", { lineId: firstLine.id }],
      ["invoice.delete", { id: invoice.id }],
    ] as const) {
      const refused = await refusal(invoke(name, input as never, context(admin)));
      expect(refused.details.rule, name).toBe("document_immutable");
    }
    for (const statement of [
      "UPDATE core_invoice SET total = 1, net_total = 1, tax_total = 0, version = version + 1 WHERE id = ?",
      "UPDATE core_invoice SET bill_to_name = 'Someone else', version = version + 1 WHERE id = ?",
      "UPDATE core_invoice SET issued_on = '2020-01-01', version = version + 1 WHERE id = ?",
      "UPDATE core_invoice SET business = '{}', version = version + 1 WHERE id = ?",
      "UPDATE core_invoice SET tax_by_rate = '[]', version = version + 1 WHERE id = ?",
      "UPDATE core_invoice SET person_id = (SELECT id FROM core_person WHERE id != core_invoice.person_id LIMIT 1), version = version + 1 WHERE id = ?",
      "UPDATE core_invoice SET state = 'draft', version = version + 1 WHERE id = ?",
      "UPDATE core_invoice SET number = 'INV-1', version = version + 1 WHERE id = ?",
      "DELETE FROM core_invoice WHERE id = ?",
      "UPDATE core_invoice_line SET line_total = 1, line_net = 1, line_tax = 0 WHERE invoice_id = ?",
      "UPDATE core_invoice_line SET tax_rate = 0, tax_key = NULL, tax_label = NULL WHERE invoice_id = ?",
      "DELETE FROM core_invoice_line WHERE invoice_id = ?",
      `INSERT INTO core_invoice_line (id, invoice_id, position, description, quantity_milli,
         unit_price, line_net, line_tax, line_total, source, created_at)
       VALUES ('inl_x', ?, 9, 'x', 1000, 1, 1, 0, 1, 'custom', 'now')`,
    ]) {
      await expect(env.DB.prepare(statement).bind(invoice.id).run(), statement).rejects.toThrow(
        /core_document_immutable/,
      );
    }
    // A REPLACE is an insert: it cannot get round the delete trigger.
    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO core_invoice (id, currency, tax_mode, payment_terms_days,
           created_at, created_by, updated_at, updated_by) VALUES (?, 'AUD', 'inclusive', 14, 'now', 'u', 'now', 'u')`,
      )
        .bind(invoice.id)
        .run(),
    ).rejects.toThrow(/core_document_immutable/);
    // Without its version moving, nothing changes at all (a write from an old read).
    await expect(
      env.DB.prepare("UPDATE core_invoice SET reminders_paused = 1 WHERE id = ?")
        .bind(invoice.id)
        .run(),
    ).rejects.toThrow(/core_document_stale/);
    // What host code may still move: its state, the reminders, part payments, the due date.
    await env.DB.prepare(
      "UPDATE core_invoice SET state = 'sent', reminders_paused = 1, allow_part_payments = 1, due_on = '2026-12-31', version = version + 1 WHERE id = ?",
    )
      .bind(invoice.id)
      .run();
    const read = await invoke("invoice.get", { id: invoice.id }, context(admin));
    expect(read).toMatchObject({
      state: "sent",
      number: issued.number,
      total: invoice.total,
      lines: invoice.lines,
      billTo: { printed: { name: "Fixture Person" } },
    });
  });

  it("an erase of the person billed detaches them and keeps the bill-to as printed", async () => {
    const billed = (
      await invoke(
        "person.create",
        { givenName: unique("Erased"), emails: [{ email: `${unique("erased")}@example.com` }] },
        context(admin),
      )
    ).id as string;
    const issued = (await draftInvoice({ billTo: { personId: billed } })).id as string;
    const draft = (await draftInvoice({ billTo: { personId: billed } })).id as string;
    await issueRaw(issued);
    await invoke("person.erase", { id: billed }, context(admin));
    expect(
      await env.DB.prepare(
        "SELECT person_id, bill_to_name, state FROM core_invoice WHERE id IN (?, ?) ORDER BY state",
      )
        .bind(draft, issued)
        .all()
        .then((r) => r.results),
    ).toEqual([
      { person_id: null, bill_to_name: null, state: "draft" },
      { person_id: null, bill_to_name: "Fixture Person", state: "issued" },
    ]);
  });
});

describe("the document event log", () => {
  it("only grows: no update, no delete, no row below the newest", async () => {
    const invoice = await draftInvoice();
    const at = new Date().toISOString();
    await db.batch([
      eventStatement(db.query, {
        documentKind: "invoice",
        documentId: invoice.id,
        event: "issued",
        amount: invoice.total,
        currency: "AUD",
        at,
        byUser: admin.id,
      }),
      eventStatement(db.query, {
        documentKind: "invoice",
        documentId: invoice.id,
        event: "payment_applied",
        paymentId: "pay_fixture",
        method: "recorded",
        amount: 100,
        currency: "AUD",
        at,
      }),
    ]);
    const all = await invoke("invoice.events", {}, context(admin));
    const mine = all.items.filter((e: { documentId: string }) => e.documentId === invoice.id);
    expect(mine.map((e: { event: string }) => e.event)).toEqual(["issued", "payment_applied"]);
    expect(mine[0]).toMatchObject({
      invoiceId: invoice.id,
      byUser: admin.id,
      amount: invoice.total,
    });
    const first = must(mine[0]);
    const second = must(mine[1]);
    // By cursor: after the first, the second is next.
    const page = await invoke("invoice.events", { after: first.seq, limit: 1 }, context(admin));
    expect(page.items[0]?.seq).toBe(second.seq);
    for (const statement of [
      "UPDATE core_invoice_event SET amount = 1 WHERE seq = ?",
      "DELETE FROM core_invoice_event WHERE seq = ?",
      `INSERT OR REPLACE INTO core_invoice_event (seq, document_kind, document_id, event, at)
       VALUES (?, 'invoice', 'inv_x', 'voided', 'now')`,
    ]) {
      await expect(env.DB.prepare(statement).bind(first.seq).run(), statement).rejects.toThrow(
        /core_invoice_event_immutable/,
      );
    }
    // A row with an explicit seq below the newest is refused (a reader past it would miss it).
    await expect(
      env.DB.prepare(
        "INSERT INTO core_invoice_event (seq, document_kind, document_id, event, at) VALUES (?, 'invoice', 'inv_x', 'voided', 'now')",
      )
        .bind(0)
        .run(),
    ).rejects.toThrow(/core_invoice_event_immutable/);
    // The log is invoices:payments': a member without it is refused.
    expect((await refusal(invoke("invoice.events", {}, context(member)))).code).toBe("forbidden");
  });

  it("invoices:payments is restricted: granted by another admin, never to oneself", async () => {
    const bookkeeper = await createUser("member");
    const self = await refusal(
      invoke(
        "user.setPermissions",
        { id: admin.id, permissions: ["invoices:payments"] },
        context(admin),
      ),
    );
    expect(self.details.rule).toBe("self_grant");
    await invoke(
      "user.setPermissions",
      { id: bookkeeper.id, permissions: ["invoices:payments"] },
      context(admin),
    );
    const read = await invoke("invoice.events", { limit: 1 }, context(bookkeeper));
    expect(read.items.length).toBeLessThanOrEqual(1);
    const grantable = await invoke("user.grantablePermissions", {}, context(admin));
    expect(
      grantable.items.find((g: { permission: string }) => g.permission === "invoices:payments"),
    ).toMatchObject({ restricted: true, from: "core" });
  });
});

describe("the invoice settings", () => {
  it("a change of bank details by an admin tells every admin, and the audit never holds them in full", async () => {
    const account = "12345678";
    await invoke(
      "invoice.settings.update",
      { bank: [{ label: "Account", value: account }] },
      context(otherAdmin),
    );
    for (const user of [admin, otherAdmin]) {
      const notice = await env.DB.prepare(
        "SELECT title, body FROM core_notifications WHERE user_id = ? AND title LIKE '%bank details%' ORDER BY created_at DESC",
      )
        .bind(user.id)
        .first<{ title: string; body: string }>();
      expect(notice?.title).toMatch(/bank details/);
      expect(notice?.body).not.toContain(account);
    }
    const { results } = await env.DB.prepare(
      "SELECT a.input, a.result, c.diff FROM core_audit a LEFT JOIN core_audit_changes c ON c.audit_id = a.id WHERE a.operation = 'invoice.settings.update' AND a.user_id = ?",
    )
      .bind(otherAdmin.id)
      .all();
    expect(results.length).toBeGreaterThan(0);
    expect(JSON.stringify(results)).not.toContain(account);
    const read = await invoke("invoice.settings.get", {}, context(member));
    expect(read.bank).toEqual([{ label: "Account", value: account }]);
  });

  it("an AI actor or a member is refused, and nothing changes", async () => {
    const before = await invoke("invoice.settings.get", {}, context(admin));
    expect(
      (await refusal(invoke("invoice.settings.update", { bank: [] }, context(member)))).code,
    ).toBe("forbidden");
    await setPreset("autonomous");
    try {
      for (const extra of AI_ACTORS) {
        const refused = await refusal(
          invoke(
            "invoice.settings.update",
            { bank: [], paymentTermsDays: 1 },
            context(admin, extra),
          ),
        );
        expect(refused.code, extra.actor).toBe("forbidden");
      }
    } finally {
      await setPreset("balanced");
    }
    expect(await invoke("invoice.settings.get", {}, context(admin))).toEqual(before);
  });

  it("a tax rate never changes; one on a document stays; one on an issued document keeps its label", async () => {
    const changed = await refusal(
      invoke(
        "invoice.settings.update",
        { taxRates: [{ ...GST, rate: 1500 }, ZERO] },
        context(admin),
      ),
    );
    expect(changed.details.rule).toBe("tax_rate_fixed");
    const removed = await refusal(
      invoke("invoice.settings.update", { taxRates: [ZERO], defaultTaxRate: null }, context(admin)),
    );
    expect(removed.details.rule).toBe("tax_rate_in_use");
    const relabelled = await refusal(
      invoke(
        "invoice.settings.update",
        { taxRates: [{ ...GST, label: "Tax" }, ZERO] },
        context(admin),
      ),
    );
    expect(relabelled.details.rule).toBe("tax_rate_fixed");
    // Retired: kept on documents, refused on a new line, and no longer the default.
    const retiredDefault = await refusal(
      invoke(
        "invoice.settings.update",
        { taxRates: [{ ...GST, retired: true }, ZERO] },
        context(admin),
      ),
    );
    expect(retiredDefault.details.rule).toBe("unknown_tax_rate");
    const gst2 = { key: "gst_new", label: "GST", rate: 1000, retired: false };
    await invoke(
      "invoice.settings.update",
      { taxRates: [{ ...GST, retired: true }, ZERO, gst2], defaultTaxRate: "gst_new" },
      context(admin),
    );
    const onRetired = await refusal(
      invoke(
        "invoice.create",
        { lines: [{ description: "x", unitPrice: 100, taxRate: "gst" }] },
        context(admin),
      ),
    );
    expect(onRetired.details.rule).toBe("retired_tax_rate");
    const fresh = await invoke(
      "invoice.create",
      { lines: [{ description: "x", unitPrice: 1100 }] },
      context(admin),
    );
    expect(fresh.lines[0]).toMatchObject({ taxRate: { key: "gst_new" }, tax: 100 });
    // Put the fixture's default back for the tests after.
    await invoke(
      "invoice.settings.update",
      { taxRates: [{ ...GST, retired: false }, ZERO, gst2], defaultTaxRate: "gst" },
      context(admin),
    );
  });

  it("starts from the decided defaults", () => {
    expect(DEFAULT_INVOICE_SETTINGS).toMatchObject({
      paymentTermsDays: 14,
      quoteValidDays: 30,
      depositDueDays: 0,
      reminders: { on: true, days: [0, 7, 14] },
      retentionYears: 7,
      taxRates: [],
      bank: [],
    });
  });
});

describe("what dashboards and query.sql read", () => {
  it("rec_invoice carries numbers, states, amounts and ids, never an address, notes or bank details", async () => {
    const invoice = await draftInvoice({ notes: "Fixture note text", siteAddress: "Fixture site" });
    await issueRaw(invoice.id, { bill_to_address: "Fixture address line" });
    const row = (await env.DB.prepare("SELECT * FROM rec_invoice WHERE id = ?")
      .bind(invoice.id)
      .first()) as Record<string, unknown>;
    expect(row).toMatchObject({ id: invoice.id, total: invoice.total, person_id: personId });
    const text = JSON.stringify(row);
    for (const hidden of [
      "Fixture note text",
      "Fixture site",
      "Fixture address line",
      "Fixture Studio",
    ]) {
      expect(text).not.toContain(hidden);
    }
    const sql = await invoke(
      "query.sql",
      { sql: `SELECT number, total FROM rec_invoice WHERE id = '${invoice.id}'` },
      context(member),
    );
    expect(sql.rows).toEqual([{ number: row.number, total: invoice.total }]);
  });
});
