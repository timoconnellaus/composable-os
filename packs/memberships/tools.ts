// The Memberships tools. They become operations x.memberships.<tool>, run in the sandbox, and reach
// the host only through ctx.ops. None holds a rule: a plan's price, the trial, a pass's price, its
// uses and expiry, the intro offer's one per person, and what a membership or a pass may be spent
// on are the host's (`sellable`, `recurring.grants`, `allowance`). What is left is the host's
// count (`allowance.get`). A tool asks, and reports what the host answered.
import { defineTool, type ExtensionContext, OpsCallError, z } from "@composable-os/sdk";

export const PLAN = "memberships.plan";
export const MEMBERSHIP = "memberships.membership";
export const PASSTYPE = "memberships.passtype";
export const PASS = "memberships.pass";

interface RecordShape {
  id: string;
  title?: string | null;
  values: Record<string, unknown>;
}
interface ListShape {
  items: RecordShape[];
  nextCursor?: string | null;
  currency?: string | null;
}

const id = z.string().min(1).max(64);
const text = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);
const num = (value: unknown): number | null =>
  typeof value === "number" ? value : value == null || value === "" ? null : Number(value);
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : value == null || value === "" ? [] : [String(value)];

const currency = z
  .string()
  .nullable()
  .describe("The currency prices are in (ISO 4217), the deployment's one; null until it is set");

/** What a plan, a pass type, a membership or a pass allows, as its record says. */
const limitsOut = z.object({
  classTypes: z.array(z.string()).describe("Class type ids; empty: every class type"),
  weekdays: z.array(z.string()).describe("1 Monday to 7 Sunday; empty: every day"),
  fromMinute: z.number().nullable().describe("Classes starting at or after, minutes after midnight"),
  untilMinute: z.number().nullable().describe("Classes starting before, minutes after midnight"),
});
const limitsOf = (v: Record<string, unknown>) => ({
  classTypes: list(v.classTypes),
  weekdays: list(v.weekdays),
  fromMinute: num(v.fromMinute),
  untilMinute: num(v.untilMinute),
});

// --- What is on sale -----------------------------------------------------------------------------

export const plans = defineTool({
  description:
    "The membership plans on sale: each plan's title, a line on what it gives, description, " +
    "price per month (in the major unit of `currency`), classes per week or month (null: " +
    "unlimited), the class types, days and times it allows, and the days of its free trial. " +
    "Whether a person gets the trial is the host's, when they subscribe (subscription.start): " +
    "one per person, signed in. Read-only.",
  input: z.object({}),
  output: z.object({
    plans: z.array(
      limitsOut.extend({
        id: z.string(),
        title: z.string().nullable(),
        summary: z.string().nullable(),
        description: z.string().nullable(),
        price: z.number().nullable().describe("Per month, in the major unit of `currency`"),
        uses: z.number().nullable().describe("Classes per period; null: unlimited"),
        per: z.enum(["week", "month"]).nullable(),
        trialDays: z.number().nullable(),
      }),
    ),
    currency,
  }),
  risk: "read",
  audiences: ["customer", "public"],
  async handler(_input, ctx) {
    const page = await ctx.ops.call<ListShape>("public.list", {
      object: PLAN,
      sort: { field: "price", direction: "asc" },
      limit: 50,
    });
    return {
      plans: page.items.map((p) => ({
        id: p.id,
        title: text(p.values.title),
        summary: text(p.values.summary),
        description: text(p.values.description),
        price: num(p.values.price),
        uses: num(p.values.uses),
        per: p.values.per === "month" ? ("month" as const) : p.values.per ? ("week" as const) : null,
        trialDays: num(p.values.trialDays),
        ...limitsOf(p.values),
      })),
      currency: page.currency ?? null,
    };
  },
});

export const passTypes = defineTool({
  description:
    "The passes on sale, bought once: class packs, drop-ins and intro offers. Each one's title, " +
    "a line on what it gives, description, price (in the major unit of `currency`), its classes, " +
    "how many days it is valid for from the day it is bought (null: it does not expire), the " +
    "class types, days and times it allows, and whether it is an intro offer (one per person, " +
    "bought signed in; the host refuses a second). Read-only.",
  input: z.object({}),
  output: z.object({
    passTypes: z.array(
      limitsOut.extend({
        id: z.string(),
        title: z.string().nullable(),
        summary: z.string().nullable(),
        description: z.string().nullable(),
        price: z.number().nullable(),
        uses: z.number().nullable(),
        validDays: z.number().nullable(),
        onePerPerson: z.boolean(),
      }),
    ),
    currency,
  }),
  risk: "read",
  audiences: ["customer", "public"],
  async handler(_input, ctx) {
    const page = await ctx.ops.call<ListShape>("public.list", {
      object: PASSTYPE,
      sort: { field: "price", direction: "asc" },
      limit: 50,
    });
    return {
      passTypes: page.items.map((p) => ({
        id: p.id,
        title: text(p.values.title),
        summary: text(p.values.summary),
        description: text(p.values.description),
        price: num(p.values.price),
        uses: num(p.values.uses),
        validDays: num(p.values.validDays),
        onePerPerson: p.values.onePerPerson === true,
        ...limitsOf(p.values),
      })),
      currency: page.currency ?? null,
    };
  },
});

export const buy = defineTool({
  description:
    "Start an order for one pass (a class pack, a drop-in or an intro offer). A signed-in " +
    "customer buys as themselves; a guest gives their email address, and may not buy an intro " +
    "offer (the host refuses it: one per person, signed in). The host prices it from the pass " +
    "type, refuses one not on sale, and refuses a second intro offer for the same person. " +
    "Nothing is paid here: the buyer then calls order.checkout with the order's id (and a " +
    "guest's token) to pay on the provider's page; the pass is granted when the provider " +
    "confirms the payment. Amounts in the minor unit.",
  input: z.object({
    passTypeId: id,
    email: z.string().trim().max(320).optional().describe("A guest's email address"),
  }),
  output: z.object({
    id: z.string(),
    state: z.string(),
    currency: z.string(),
    total: z.number(),
    token: z.string().nullable().describe("A guest's key to this order, shown once"),
  }),
  risk: "write",
  audiences: ["customer", "public"],
  async handler(input, ctx) {
    const order = await ctx.ops.call<{
      id: string;
      state: string;
      currency: string;
      total: number;
      token?: string | null;
    }>("order.start", {
      lines: [{ object: PASSTYPE, id: input.passTypeId, quantity: 1 }],
      pay: "full",
      ...(input.email === undefined ? {} : { email: input.email }),
    });
    return {
      id: order.id,
      state: order.state,
      currency: order.currency,
      total: order.total,
      token: order.token ?? null,
    };
  },
});

// --- What a member holds -------------------------------------------------------------------------

const periodOut = z.object({
  key: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  used: z.number(),
  left: z.number().nullable().describe("Null: unlimited"),
});

const holding = limitsOut.extend({
  id: z.string(),
  kind: z.enum(["membership", "pass"]),
  title: z.string().nullable(),
  status: z.string().describe("The record's own state, as the host keeps it"),
  uses: z.number().nullable().describe("Per period for a membership, in all for a pass; null: unlimited"),
  per: z.enum(["total", "week", "month"]),
  from: z.string().nullable(),
  until: z.string().nullable().describe("When it stops or expires"),
  live: z.boolean().describe("It can pay for a class now (the host's answer)"),
  period: periodOut.nullable().describe("This week, this month or in all, as the host counts it"),
});
type Holding = z.infer<typeof holding>;

interface AllowanceView {
  live?: boolean;
  period: { key: string; startsAt: string; endsAt: string; used: number; left: number | null };
}

async function holdingsOf(
  ctx: ExtensionContext,
  read: "my.list" | "record.list",
  personId: string | null,
): Promise<Holding[]> {
  const filter = personId ? { filter: { field: "person", op: "eq", value: personId } } : {};
  const [memberships, passes] = await Promise.all([
    ctx.ops.call<ListShape>(read, {
      object: MEMBERSHIP,
      ...filter,
      sort: { field: "from", direction: "desc" },
      limit: 20,
    }),
    ctx.ops.call<ListShape>(read, {
      object: PASS,
      ...filter,
      sort: { field: "from", direction: "desc" },
      limit: 50,
    }),
  ]);
  const out: Holding[] = [];
  for (const [kind, object, items] of [
    ["membership", MEMBERSHIP, memberships.items],
    ["pass", PASS, passes.items],
  ] as const) {
    for (const r of items) {
      const v = r.values;
      // The host's count: uses spent and left now (allowance.get), never worked out here.
      let view: AllowanceView | null = null;
      try {
        view = await ctx.ops.call<AllowanceView>("allowance.get", { object, id: r.id });
      } catch {
        view = null;
      }
      out.push({
        id: r.id,
        kind,
        title: text(v.title),
        status: String(v.status ?? ""),
        uses: num(v.uses),
        per: kind === "pass" ? "total" : v.per === "month" ? "month" : "week",
        from: text(v.from),
        until: text(v.until),
        live: view?.live ?? (view ? view.period.left !== 0 : false),
        period: view?.period ?? null,
        ...limitsOf(v),
      });
    }
  }
  return out;
}

export const mine = defineTool({
  description:
    "The signed-in member's own memberships and passes: each one's title, state, what it allows " +
    "(classes per week or month, or in all; class types, days and times), when it started and " +
    "when it stops or expires, and the host's count for now: classes used and left this week, " +
    "this month or in all (left null: unlimited). Read-only.",
  input: z.object({}),
  output: z.object({ holdings: z.array(holding) }),
  risk: "read",
  audiences: ["customer"],
  async handler(_input, ctx) {
    return { holdings: await holdingsOf(ctx, "my.list", null) };
  },
});

export const holdings = defineTool({
  description:
    "For staff: one person's memberships and passes, with their state, what each allows, when " +
    "it stops or expires, and the classes used and left now, as the host counts them. Read-only.",
  input: z.object({ personId: id }),
  output: z.object({ holdings: z.array(holding) }),
  risk: "read",
  async handler(input, ctx) {
    return { holdings: await holdingsOf(ctx, "record.list", input.personId) };
  },
});

// --- Staff, by hand ------------------------------------------------------------------------------

const passOut = z.object({ passId: z.string(), status: z.string(), source: z.string() });

/** Who did it, as the host says (never the input), kept on the record with the reason. */
const signed = (reason: string, ctx: ExtensionContext) =>
  `${reason}${ctx.caller?.kind === "staff" ? ` (${ctx.caller.name})` : ""}`.slice(0, 1000);

export const givePass = defineTool({
  description:
    "Give a person a pass by hand, free, with the reason: a pass type's classes and validity, " +
    "or fewer classes or days if given. Recorded as given by staff, with who gave it. A person on " +
    "the staff only (never the assistant or an automation), with the memberships:passes " +
    "permission. Returns the pass.",
  input: z.object({
    personId: id,
    passTypeId: id,
    reason: z.string().trim().min(3).max(500),
    uses: z.number().int().min(1).max(1000).optional().describe("Default: the pass type's"),
    validDays: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe("Default: the pass type's; from today"),
  }),
  output: passOut,
  risk: "write",
  permission: "memberships:passes",
  humanOnly: true,
  async handler(input, ctx) {
    const type = await ctx.ops.call<RecordShape>("record.get", {
      object: PASSTYPE,
      id: input.passTypeId,
    });
    const v = type.values;
    const days = input.validDays ?? num(v.validDays);
    const now = new Date();
    const created = await ctx.ops.call<RecordShape>("record.create", {
      object: PASS,
      values: {
        title: text(v.title) ?? "Pass",
        person: input.personId,
        passtype: input.passTypeId,
        uses: input.uses ?? num(v.uses),
        ...limitsOf(v),
        from: now.toISOString(),
        ...(days ? { until: new Date(now.getTime() + days * 86_400_000).toISOString() } : {}),
        source: "staff",
        reason: signed(input.reason, ctx),
      },
    });
    return { passId: created.id, status: "active", source: "staff" };
  },
});

export const voidPass = defineTool({
  description:
    "Void a pass by hand, with the reason: it pays for no more classes; classes already booked " +
    "with it stay booked. For a pass bought, refund its order instead (a full refund voids it). " +
    "A person on the staff only, with the memberships:passes permission. Returns the pass.",
  input: z.object({ passId: id, reason: z.string().trim().min(3).max(500) }),
  output: passOut,
  risk: "write",
  permission: "memberships:passes",
  humanOnly: true,
  recordAction: {
    object: PASS,
    label: "Void pass",
    idInput: "passId",
    confirm: "Void this pass? It pays for no more classes.",
    ask: {
      input: "reason",
      label: "Why",
      options: [
        { value: "Given in error", label: "Given in error" },
        { value: "Asked for by the member", label: "Asked for by the member" },
        { value: "Replaced by another pass", label: "Replaced by another pass" },
      ],
    },
    hideWhen: { field: "status", values: ["void"] },
  },
  async handler(input, ctx) {
    const row = await ctx.ops.call<RecordShape>("record.get", { object: PASS, id: input.passId });
    if (row.values.source !== "staff") {
      throw new OpsCallError(
        "invalid_input",
        "A bought pass is voided by refunding its order in full, not here",
        { reason: "bought" },
      );
    }
    // From a current read (ADR 0437): of two voids at once, the host lets one through.
    await ctx.ops.call("record.update", {
      object: PASS,
      id: input.passId,
      values: { status: "void", reason: signed(input.reason, ctx) },
      from: "active",
    });
    return { passId: input.passId, status: "void", source: "staff" };
  },
});
