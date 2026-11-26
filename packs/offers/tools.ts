// The Offers pack's staff tools (stage 34, step 5). They become operations x.offers.<tool>, run in
// the sandbox, and reach the host only through ctx.ops. None of them holds a rule: what an order is
// charged, who qualifies, the limits and the one answer to a buyer are all the host's (ADR 0693).
// A tool writes a discount's terms or moves it, and reports what the host answered.
//
// Who may do what:
//   - anyone on the staff, the assistant included, reads discounts and drafts one (`draftDiscount`):
//     a draft applies to nobody;
//   - making one live, pausing it, ending it and changing its terms are a person's, with
//     `offers:manage` (`personApproves`: the assistant may ask, and its call waits for a person);
//   - single-use codes are made by a person at the screen (`generateCodes`, `humanOnly`): they are
//     shown once, in that answer only, and kept as their hash (ADR 0699). An approved call shows its
//     answer to nobody, so an assistant cannot ask for codes: it drafts the discount and says so.
import {
  CODE_MIN_LENGTH,
  codeHash,
  defineTool,
  type ExtensionContext,
  foldCode,
  OpsCallError,
  randomCodes,
  z,
} from "@composable-os/sdk";

export const DISCOUNT = "offers.discount";
export const CODE = "offers.code";

/** What a discount may cover: the objects the shipped packs sell, one at a time. */
export const SOLD_OBJECTS = [
  { value: "bookings.booking", label: "Drop-in classes" },
  { value: "ticketing.tickettype", label: "Event tickets" },
  { value: "memberships.passtype", label: "Class passes" },
  { value: "courses.course", label: "Courses" },
  { value: "courses.bundle", label: "Course bundles" },
  { value: "shop.variant", label: "Shop goods" },
] as const;

/** Who a discount is for, as the host's `discount.who` knows them (DISCOUNT_WHO in the SDK). */
export const DISCOUNT_WHO_OPTIONS = [
  { value: "anyone", label: "Anyone, guests included" },
  { value: "signed_in", label: "Signed-in customers" },
  { value: "members", label: "Members (a live membership)" },
  { value: "new_customers", label: "New customers" },
  { value: "organisation", label: "People of an organisation" },
  { value: "tag", label: "People with a tag" },
] as const;

export const DISCOUNT_STATES = [
  { value: "draft", label: "Draft" },
  { value: "active", label: "Live" },
  { value: "paused", label: "Paused" },
  { value: "ended", label: "Ended" },
] as const;

/** The most single-use codes one call makes, and how many are written per host call. */
export const BATCH_MAX = 500;
export const WRITE_CHUNK = 50;
/** The most codes one call of voidCodes switches off. */
export const VOID_MAX = 200;

/** A record as record.get and record.list return it. */
export interface HostRecord {
  id: string;
  title: string | null;
  values: Record<string, unknown>;
}

const id = z.string().min(1).max(64);
const text = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);
const num = (value: unknown): number | null =>
  value === null || value === undefined || value === "" ? null : Number(value);
const many = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return value === null || value === undefined || value === "" ? [] : [String(value)];
};

const whoValues = DISCOUNT_WHO_OPTIONS.map((o) => o.value) as [string, ...string[]];
const soldValues = SOLD_OBJECTS.map((o) => o.value) as [string, ...string[]];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a day, YYYY-MM-DD");

/** A discount's terms, as a tool takes them. Every bound is also the field's, kept by the host. */
const terms = {
  note: z.string().max(2000).describe("Why it exists, for staff"),
  kind: z
    .enum(["percent", "amount", "price"])
    .describe("percent: a percentage off; amount: money off the order; price: a set price each"),
  percent: z.number().min(1).max(100).describe("For percent: 1 to 100"),
  amount: z
    .number()
    .min(0)
    .describe(
      "For amount: the money off, in the currency's major unit; for price: what each costs",
    ),
  automatic: z
    .boolean()
    .describe("True: applies by itself with no code (a member's price, a customer rate)"),
  code: z
    .string()
    .max(64)
    .describe(
      `A shared promo code anyone may type, at least ${CODE_MIN_LENGTH} letters or digits ` +
        "(the host keeps it in capitals without spaces and refuses one another discount has)",
    ),
  who: z.enum(whoValues).describe("Who it is for. Anything but anyone needs a signed-in buyer"),
  organisations: z.array(id).max(50).describe("Organisation ids, for who = organisation"),
  tag: z.string().max(80).describe("The tag, for who = tag"),
  appliesTo: z
    .array(z.enum(soldValues))
    .max(SOLD_OBJECTS.length)
    .describe("What it covers (drop-ins, tickets, passes, courses, goods). Empty: everything"),
  from: day.describe("First day it applies (UTC)"),
  until: day.describe("Last day it applies (UTC)"),
  totalUses: z.number().int().min(1).describe("Most orders in total"),
  perPerson: z.number().int().min(1).describe("Most orders per person"),
  minSpend: z.number().min(0).describe("Least the covered lines must cost"),
};

const discountOut = z.object({
  id: z.string(),
  name: z.string().nullable(),
  state: z.string().nullable(),
  kind: z.string().nullable(),
  percent: z.number().nullable(),
  amount: z.number().nullable(),
  automatic: z.boolean(),
  code: z.string().nullable().describe("The shared promo code, if it has one"),
  who: z.string().nullable(),
  appliesTo: z.array(z.string()),
  from: z.string().nullable(),
  until: z.string().nullable(),
  totalUses: z.number().nullable(),
  perPerson: z.number().nullable(),
  minSpend: z.number().nullable(),
});

function discountShape(row: HostRecord): z.infer<typeof discountOut> {
  const v = row.values;
  return {
    id: row.id,
    name: text(v.name),
    state: text(v.state),
    kind: text(v.kind),
    percent: num(v.percent),
    amount: num(v.amount),
    automatic: v.automatic === true || v.automatic === 1,
    code: text(v.code),
    who: text(v.who),
    appliesTo: many(v.appliesTo),
    from: text(v.from),
    until: text(v.until),
    totalUses: num(v.totalUses),
    perPerson: num(v.perPerson),
    minSpend: num(v.minSpend),
  };
}

const getDiscount = (ctx: ExtensionContext, discountId: string) =>
  ctx.ops.call<HostRecord>("record.get", { object: DISCOUNT, id: discountId });

/** Who started the call, for the record (a staff caller's name). */
const callerName = (ctx: ExtensionContext): string | null =>
  ctx.caller && "name" in ctx.caller && typeof ctx.caller.name === "string"
    ? ctx.caller.name
    : null;

// --- Reading -------------------------------------------------------------------------------------

const listRow = discountOut.extend({
  used: z.number().describe("Orders paid with it"),
  held: z.number().describe("Unpaid orders holding a use of it"),
  given: z.number().describe("Money it took off paid orders, in the currency's minor unit"),
});

export const DISCOUNTS_LIMIT = 100;

export const discounts = defineTool({
  description:
    "The business's discounts (promo codes, members' prices and customer rates): their terms, " +
    "state (draft, active = live, paused, ended), and how often each was used and what it took " +
    "off paid orders (in minor units, cents). Use state to narrow it ('which codes are live?'). " +
    "Never shows single-use codes (they are kept as their hash). Read-only.",
  input: z.object({
    state: z.enum(["draft", "active", "paused", "ended"]).optional(),
    automatic: z.boolean().optional().describe("Only prices that apply by themselves, or not"),
  }),
  output: z.object({ discounts: z.array(listRow), truncated: z.boolean() }),
  risk: "read",
  async handler(input, ctx) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.state) {
      where.push("d.state = ?");
      params.push(input.state);
    }
    if (input.automatic !== undefined) {
      where.push(input.automatic ? "d.automatic = 1" : "coalesce(d.automatic, 0) = 0");
    }
    const result = await ctx.ops.call<{ rows: Record<string, unknown>[] }>("query.sql", {
      sql:
        "SELECT d.id AS id, d.name AS name, d.state AS state, d.kind AS kind, " +
        "d.percent AS percent, d.amount AS amount, d.automatic AS automatic, d.code AS code, " +
        // `from` is a reserved word: its column is `from_`.
        "d.who AS who, d.applies_to AS applies_to, d.from_ AS from_day, d.until AS until, " +
        "d.total_uses AS total_uses, d.per_person AS per_person, d.min_spend AS min_spend, " +
        "(SELECT count(*) FROM rec_discount_use u WHERE u.discount_id = d.id AND u.state = 'used') AS used, " +
        "(SELECT count(*) FROM rec_discount_use u WHERE u.discount_id = d.id AND u.state = 'held') AS held, " +
        "(SELECT coalesce(sum(u.amount), 0) FROM rec_discount_use u WHERE u.discount_id = d.id AND u.state = 'used') AS given " +
        "FROM rec_x_offers_discount d" +
        (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
        ` ORDER BY d.name ASC LIMIT ${DISCOUNTS_LIMIT + 1}`,
      params,
    });
    const rows = result.rows.slice(0, DISCOUNTS_LIMIT);
    return {
      truncated: result.rows.length > DISCOUNTS_LIMIT,
      discounts: rows.map((r) => ({
        ...discountShape({
          id: String(r.id),
          title: text(r.name),
          values: {
            name: r.name,
            state: r.state,
            kind: r.kind,
            percent: r.percent,
            amount: r.amount,
            automatic: r.automatic,
            code: r.code,
            who: r.who,
            appliesTo: r.applies_to,
            from: r.from_day,
            until: r.until,
            totalUses: r.total_uses,
            perPerson: r.per_person,
            minSpend: r.min_spend,
          },
        }),
        used: Number(r.used ?? 0),
        held: Number(r.held ?? 0),
        given: Number(r.given ?? 0),
      })),
    };
  },
});

const batchRow = z.object({
  batch: z.string().nullable(),
  made: z.number(),
  working: z.number().describe("Codes not voided"),
  used: z.number().describe("Codes used on at least one paid order"),
  usesPerCode: z.number().nullable(),
  madeBy: z.string().nullable(),
  madeAt: z.string().nullable(),
});

export const codeBatches = defineTool({
  description:
    "The batches of single-use codes made for one discount: how many were made, how many still " +
    "work and how many were used, who made them and when. Never the codes themselves, which " +
    "were shown once to the person who made them. Read-only.",
  input: z.object({ discountId: id }),
  output: z.object({ batches: z.array(batchRow) }),
  risk: "read",
  async handler(input, ctx) {
    const result = await ctx.ops.call<{ rows: Record<string, unknown>[] }>("query.sql", {
      sql:
        "SELECT c.batch AS batch, count(*) AS made, " +
        "sum(CASE WHEN c.active = 1 THEN 1 ELSE 0 END) AS working, " +
        "sum(CASE WHEN EXISTS (SELECT 1 FROM rec_discount_use u WHERE u.code_id = c.id " +
        "AND u.state = 'used') THEN 1 ELSE 0 END) AS used, " +
        "max(c.uses) AS uses, max(c.made_by) AS made_by, min(c.created_at) AS made_at " +
        "FROM rec_x_offers_code c WHERE c.discount = ? GROUP BY c.batch " +
        "ORDER BY made_at DESC LIMIT 100",
      params: [input.discountId],
    });
    return {
      batches: result.rows.map((r) => ({
        batch: text(r.batch),
        made: Number(r.made ?? 0),
        working: Number(r.working ?? 0),
        used: Number(r.used ?? 0),
        usesPerCode: num(r.uses),
        madeBy: text(r.made_by),
        madeAt: text(r.made_at),
      })),
    };
  },
});

// --- Drafting and changing -----------------------------------------------------------------------

const opened = z.object({ object: z.string(), id: z.string() });

export const draftDiscount = defineTool({
  description:
    "Draft a discount: a promo code for a campaign (code = a word such as JANUARY26), a member's " +
    "price (automatic = true, who = members, kind = price or percent, appliesTo = what it " +
    "covers), a customer rate (automatic, who = organisation with organisations) or a discount " +
    "for single-use codes (no code; a person then makes a batch). It is made as a draft and " +
    "applies to nobody until a person makes it live with activateDiscount. The host refuses a " +
    "code shorter than 6 characters or one another discount has. Returns the draft.",
  input: z.object({
    name: z.string().trim().min(1).max(120),
    kind: terms.kind,
    percent: terms.percent.optional(),
    amount: terms.amount.optional(),
    automatic: terms.automatic.optional(),
    code: terms.code.optional(),
    who: terms.who.optional(),
    organisations: terms.organisations.optional(),
    tag: terms.tag.optional(),
    appliesTo: terms.appliesTo.optional(),
    from: terms.from.optional(),
    until: terms.until.optional(),
    totalUses: terms.totalUses.optional(),
    perPerson: terms.perPerson.optional(),
    minSpend: terms.minSpend.optional(),
    note: terms.note.optional(),
  }),
  output: discountOut.extend({ open: opened }),
  risk: "write",
  permission: "offers:manage",
  async handler(input, ctx) {
    // Made in the initial state, draft: the host refuses any other for anyone but itself.
    const { id: discountId } = await ctx.ops.call<{ id: string }>("record.create", {
      object: DISCOUNT,
      values: input,
    });
    const row = await getDiscount(ctx, discountId);
    return { ...discountShape(row), open: { object: DISCOUNT, id: discountId } };
  },
});

const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

export const changeDiscount = defineTool({
  description:
    "Change a discount's terms: what is off, what it covers, who it is for, its dates, limits " +
    "or its shared promo code (null clears one). Not its state: use activateDiscount, " +
    "pauseDiscount or endDiscount. A change to a live discount changes what buyers are charged " +
    "from the next order, so a person makes it: the assistant's call waits for a person. Orders " +
    "already started keep the deal they were priced with. Returns the discount.",
  input: z.object({
    discountId: id,
    name: z.string().trim().min(1).max(120).optional(),
    kind: terms.kind.optional(),
    percent: nullable(terms.percent),
    amount: nullable(terms.amount),
    automatic: terms.automatic.optional(),
    code: nullable(terms.code),
    who: terms.who.optional(),
    organisations: nullable(terms.organisations),
    tag: nullable(terms.tag),
    appliesTo: nullable(terms.appliesTo),
    from: nullable(terms.from),
    until: nullable(terms.until),
    totalUses: nullable(terms.totalUses),
    perPerson: nullable(terms.perPerson),
    minSpend: nullable(terms.minSpend),
    note: nullable(terms.note),
  }),
  output: discountOut,
  risk: "write",
  permission: "offers:manage",
  personApproves: true,
  async handler(input, ctx) {
    const { discountId, ...values } = input;
    if (Object.keys(values).length === 0) {
      throw new OpsCallError("invalid_input", "Say what to change", { field: "discountId" });
    }
    await ctx.ops.call("record.update", { object: DISCOUNT, id: discountId, values });
    return discountShape(await getDiscount(ctx, discountId));
  },
});

// --- Making live, pausing, ending ----------------------------------------------------------------

/** Moves a discount from its current state (ADR 0437: of two moves at once, one goes through). */
async function move(ctx: ExtensionContext, discountId: string, to: string) {
  const row = await getDiscount(ctx, discountId);
  const from = text(row.values.state);
  if (from === to) return discountShape(row);
  // The host refuses a move the object does not declare (from ended, say), in its own words.
  await ctx.ops.call("record.update", {
    object: DISCOUNT,
    id: discountId,
    values: { state: to },
    ...(from ? { from } : {}),
  });
  return discountShape(await getDiscount(ctx, discountId));
}

const moveInput = z.object({ discountId: id });

export const activateDiscount = defineTool({
  description:
    "Make a draft or paused discount live: from now on the host applies it to every order it " +
    "covers (by its code, or by itself for a member's price). A person's decision with " +
    "offers:manage: the assistant may ask, and its call waits for a person to approve. Check " +
    "the terms first with discounts. Returns the discount.",
  input: moveInput,
  output: discountOut,
  risk: "write",
  permission: "offers:manage",
  personApproves: true,
  recordAction: {
    object: DISCOUNT,
    label: "Make live",
    idInput: "discountId",
    confirm: "Make this discount live? The host applies it to orders from now on.",
    hideWhen: { field: "state", values: ["active", "ended"] },
  },
  handler: (input, ctx) => move(ctx, input.discountId, "active"),
});

export const pauseDiscount = defineTool({
  description:
    "Pause a live discount: it applies to no new order until it is made live again. Orders " +
    "already started keep their deal. A person's decision with offers:manage (the assistant's " +
    "call waits for a person). Returns the discount.",
  input: moveInput,
  output: discountOut,
  risk: "write",
  permission: "offers:manage",
  personApproves: true,
  recordAction: {
    object: DISCOUNT,
    label: "Pause",
    idInput: "discountId",
    confirm: "Pause this discount? New orders will not get it until it is live again.",
    hideWhen: { field: "state", values: ["draft", "paused", "ended"] },
  },
  handler: (input, ctx) => move(ctx, input.discountId, "paused"),
});

export const endDiscount = defineTool({
  description:
    "End a discount for good: it applies to no new order and cannot be made live again (draft " +
    "a new one instead). Orders already started keep their deal; its codes stop working. A " +
    "person's decision with offers:manage (the assistant's call waits for a person). Returns the " +
    "discount.",
  input: moveInput,
  output: discountOut,
  risk: "destructive",
  permission: "offers:manage",
  personApproves: true,
  recordAction: {
    object: DISCOUNT,
    label: "End",
    idInput: "discountId",
    confirm: "End this discount for good? It cannot be made live again.",
    hideWhen: { field: "state", values: ["ended"] },
  },
  handler: (input, ctx) => move(ctx, input.discountId, "ended"),
});

// --- Single-use codes ----------------------------------------------------------------------------

/** A batch's default name: when it was made. */
const batchName = (at: Date) => `Batch ${at.toISOString().slice(0, 16).replace("T", " ")}`;

/** The codes among `codes` whose records exist (a write that failed after it committed). */
async function written(ctx: ExtensionContext, discountId: string, codes: readonly string[]) {
  const hashes = await Promise.all(codes.map((c) => codeHash(c)));
  const page = await ctx.ops.call<{ items: HostRecord[] }>("record.list", {
    object: CODE,
    filter: {
      and: [
        { field: "discount", op: "eq", value: discountId },
        { field: "word", op: "in", value: hashes },
      ],
    },
    limit: WRITE_CHUNK,
    fields: ["word"],
  });
  const found = new Set(page.items.map((r) => String(r.values.word)));
  return codes.filter((_, i) => found.has(hashes[i] as string));
}

export const generateCodes = defineTool({
  description:
    `Make a batch of up to ${BATCH_MAX} random single-use codes for a discount, each good for ` +
    "usesPerCode orders (1 by default), and show them once, in this answer, to export or send. " +
    "The host keeps only each code's hash, so they cannot be shown again: keep the list. A " +
    "person only, with offers:manage, at the discount's page; the assistant cannot make codes. " +
    "Not for an ended discount. The discount still applies only once it is live. If the batch " +
    "stops part way, the answer says so and holds every code that was made.",
  input: z.object({
    discountId: id,
    count: z.coerce.number().int().min(1).max(BATCH_MAX).default(50),
    usesPerCode: z.coerce.number().int().min(1).max(1000).default(1),
    batch: z.string().trim().min(1).max(60).optional().describe("A name for the batch"),
  }),
  output: z.object({
    discountId: z.string(),
    batch: z.string(),
    made: z.number(),
    complete: z.boolean().describe("False: the batch stopped part way; see problem"),
    problem: z.string().nullable(),
    codes: z.array(z.string()).describe("The codes, shown once: the host keeps only their hash"),
  }),
  risk: "bulk-write",
  permission: "offers:manage",
  humanOnly: true,
  // Shown once: never in the audit log, an approval's stored result or a replayed reply (ADR 0628).
  redactResult: ["codes"],
  recordAction: {
    object: DISCOUNT,
    label: "Make single-use codes",
    idInput: "discountId",
    ask: {
      input: "count",
      label: "How many",
      options: [
        { value: "10", label: "10 codes" },
        { value: "50", label: "50 codes" },
        { value: "100", label: "100 codes" },
        { value: "500", label: "500 codes" },
      ],
    },
    hideWhen: { field: "state", values: ["ended"] },
  },
  async handler(input, ctx) {
    // The discount is read first: an unknown id is refused before any code is made, and an ended
    // one too (its codes would never work, and nobody would know why).
    const discount = await getDiscount(ctx, input.discountId);
    if (discount.values.state === "ended") {
      throw new OpsCallError(
        "invalid_input",
        "This discount has ended: its codes would never work. Draft a new discount for them.",
        { field: "discountId", reason: "ended" },
      );
    }
    const batch = input.batch ?? batchName(new Date());
    const madeBy = callerName(ctx);
    const codes = randomCodes(input.count);
    const made: string[] = [];
    let problem: string | null = null;
    // In chunks (record.createMany, all or none each), so a batch of hundreds stays within what
    // one host call writes. A chunk refused because a code was taken (80 random bits: it does not
    // happen, but a unique index says so) is made again once with new codes.
    for (let start = 0; start < codes.length && problem === null; start += WRITE_CHUNK) {
      let chunk = codes.slice(start, start + WRITE_CHUNK);
      for (let attempt = 0; ; attempt++) {
        const records = await Promise.all(
          chunk.map(async (code, i) => ({
            label: `${batch} #${String(start + i + 1).padStart(4, "0")}`,
            discount: input.discountId,
            batch,
            word: await codeHash(code),
            uses: input.usesPerCode,
            active: true,
            ...(madeBy ? { madeBy } : {}),
          })),
        );
        try {
          await ctx.ops.call("record.createMany", { object: CODE, records });
          made.push(...chunk);
          break;
        } catch (error) {
          const taken =
            error instanceof OpsCallError &&
            error.code === "conflict" &&
            attempt === 0 &&
            JSON.stringify(error.details ?? {}).includes("code_taken");
          if (taken) {
            chunk = randomCodes(chunk.length);
            continue;
          }
          // A write can fail after the database kept it (a call that timed out on the way back):
          // the codes it made are given to the person with the rest, never left unheld.
          const kept = await written(ctx, input.discountId, chunk).catch(() => []);
          made.push(...kept);
          const why = error instanceof Error ? error.message : "the host refused it";
          problem = `Stopped after ${made.length} codes: ${why}`;
          break;
        }
      }
    }
    if (!made.length && problem) {
      throw new OpsCallError("conflict", problem, { discountId: input.discountId });
    }
    return {
      discountId: input.discountId,
      batch,
      made: made.length,
      complete: problem === null,
      problem,
      codes: made,
    };
  },
});

/** Switches off the working codes of a discount matching `filters`: at most VOID_MAX a call. */
async function voidMatching(ctx: ExtensionContext, discountId: string, filters: unknown[]) {
  const where = {
    and: [
      { field: "discount", op: "eq", value: discountId },
      { field: "active", op: "eq", value: true },
      ...filters,
    ],
  };
  let voided = 0;
  while (voided < VOID_MAX) {
    const page = await ctx.ops.call<{ items: HostRecord[] }>("record.list", {
      object: CODE,
      filter: where,
      limit: Math.min(200, VOID_MAX - voided),
      fields: ["active"],
    });
    if (!page.items.length) break;
    for (const code of page.items) {
      await ctx.ops.call("record.update", {
        object: CODE,
        id: code.id,
        values: { active: false },
      });
      voided++;
    }
  }
  const left = await ctx.ops.call<{ count: number }>("record.count", {
    object: CODE,
    filter: where,
  });
  return { voided, remaining: Number(left.count ?? 0) };
}

const voidOut = z.object({ voided: z.number(), remaining: z.number() });

export const voidBatch = defineTool({
  description:
    `Stop a whole batch of single-use codes working, by its name; at most ${VOID_MAX} a call ` +
    "(call again while remaining is more than 0). Orders already started keep their deal. A " +
    "person's decision with offers:manage (the assistant's call waits for a person). Returns how " +
    "many were voided.",
  input: z.object({ discountId: id, batch: z.string().trim().min(1).max(60) }),
  output: voidOut,
  risk: "bulk-write",
  permission: "offers:manage",
  personApproves: true,
  handler: (input, ctx) =>
    voidMatching(ctx, input.discountId, [{ field: "batch", op: "eq", value: input.batch }]),
});

export const voidCodes = defineTool({
  description:
    "Stop single-use codes working, typed as they were given out (a code that leaked). A person " +
    "only, with offers:manage, at the screen: the codes are never kept, in the audit log or in a " +
    "request waiting for approval, so the assistant cannot ask for this (it may ask to void the " +
    "whole batch with voidBatch). Returns how many were voided.",
  input: z.object({
    discountId: id,
    codes: z.array(z.string().max(64)).min(1).max(50).describe("Codes as typed"),
  }),
  output: voidOut,
  risk: "bulk-write",
  permission: "offers:manage",
  humanOnly: true,
  // The codes a person types are never kept in the audit log.
  redact: ["codes"],
  async handler(input, ctx) {
    const hashes = await Promise.all(input.codes.map((c) => codeHash(foldCode(c))));
    return voidMatching(ctx, input.discountId, [{ field: "word", op: "in", value: hashes }]);
  },
});
