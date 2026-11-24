// Free times (stage 49 step 4, ADRs 0762 and 0763): the start times at which a booked shift (an
// appointment, `staffed.open`) of one kind can be made now, and who is free at each. Tool-only:
// a shipped pack's tool calls it, for the staff member, the customer or the visitor who called
// the tool (Bookings' freeTimes opens it to them). A customer or visitor is answered as their
// own create would be judged: inside the create rules' window, nothing when only staff book it.
// Read-only; it says when someone is free, never why a time is not.
import type { Kysely } from "kysely";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { FREE_MAX_DAYS, FREE_MAX_PROVIDERS, freeTimes } from "../staffing/free.ts";
import { kindObjectOf } from "../staffing/kinds.ts";
import { isLiveDependant } from "../visibility/guardians.ts";
import { visibleSource } from "../visibility/index.ts";
import { assertShippedToolRun } from "./staffing.ts";

// biome-ignore lint/suspicious/noExplicitAny: x_* tables are not in CoreDatabase; names come from the registry.
type AnyDb = Kysely<any>;

const DAY = 86_400;

const timeSchema = z.object({
  startsAt: z.string(),
  endsAt: z.string(),
  /** Who is free then: the shift's person values (coach profiles), in order. */
  providers: z.array(z.string()),
  /** The first of the kind's rooms free then, or null when it needs none. */
  room: z.string().nullable(),
});

/** Whether the call is from outside the organisation (a customer or the public, ADR 0414). */
const outsideCaller = (ctx: HandlerContext) => ctx.principal.kind !== "staff";

export const staffingFree = defineOperation({
  name: "staffing.free",
  description:
    "Tool-only (a shipped pack's tool): the free start times of one kind of booked work (a " +
    "service's appointments, an object declaring staffed.open) between from and to (ISO " +
    "instants; default the next 7 days, at most 31), soonest first, each with who is free then " +
    "(the shift's person values, a coach profile) and the first free room. Free means within " +
    "open hours, not away, no other shift (buffers included), a room free, no closure, not over " +
    "the client's own; for a customer or a visitor also inside the booking window. providers " +
    "limits it to some (at most 20); client is whose own bookings to leave out (a customer: " +
    "themselves, the default, or a child of theirs). Never says why a time is not free. Read-only.",
  input: z.object({
    object: z.string().min(1).max(81),
    kind: z.string().min(1).max(64).describe("The kind record (a service)"),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    providers: z.array(z.string().min(1).max(64)).min(1).max(FREE_MAX_PROVIDERS).optional(),
    client: z.string().min(1).max(64).optional().describe("A Person id"),
  }),
  output: z.object({ times: z.array(timeSchema) }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer", "public"],
  toolOnly: true,
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const outside = outsideCaller(ctx);
    if (!outside) await assertShippedToolRun(ctx, "staffing.free");
    const object = getObject(input.object);
    if (!object?.staffed?.open) throw new NotFoundError("object", input.object);
    const kindName = kindObjectOf(object);
    const kindObject = kindName ? getObject(kindName) : undefined;
    // The kind as the caller may read it: the public sees only what is public (a service while
    // it is offered), staff every record not in the Trash.
    const kind = kindObject
      ? await (ctx.db as AnyDb)
          .selectFrom(visibleSource(ctx, kindObject))
          .select("id")
          .where("id", "=", input.kind)
          .executeTakeFirst()
      : undefined;
    if (!kindName || !kind) throw new NotFoundError(kindName ?? input.object, input.kind);
    const nowSeconds = Math.floor(Date.parse(ctx.now) / 1000);
    const from = input.from ? Math.floor(Date.parse(input.from) / 1000) : nowSeconds;
    const to = input.to ? Math.floor(Date.parse(input.to) / 1000) : from + 7 * DAY;
    if (!(to > from)) throw new ValidationError("to must be after from", { field: "to" });
    if (to - from > FREE_MAX_DAYS * DAY) {
      throw new ValidationError(`Free times cover at most ${FREE_MAX_DAYS} days a call`, {
        field: "to",
        rule: "free_range",
      });
    }
    // Whose own bookings are left out: a customer's are theirs, or a live dependant's; the
    // public names nobody (it reads no one's bookings).
    let client: string | null = input.client ?? null;
    const principal = ctx.principal;
    if (principal.kind === "customer") {
      client ??= principal.personId;
      if (
        client !== principal.personId &&
        !(await isLiveDependant(ctx.db, principal.personId, client))
      ) {
        throw new NotFoundError("person", client);
      }
    } else if (outside && client !== null) {
      throw new NotFoundError("person", client);
    }
    const times = await freeTimes(ctx, {
      object,
      kind: input.kind,
      from,
      to,
      providers: input.providers,
      client,
      customerRules: outside,
    });
    // Who is free is named by the shift's person value: a coach profile. Where the person is a
    // staff account itself (a user field), a customer or visitor is told the times only, never
    // an account id (the review of PR #430).
    const named = !outside || object.staffed.who.account !== undefined;
    const iso = (s: number) => new Date(s * 1000).toISOString();
    return {
      times: times.map((t) => ({
        startsAt: iso(t.starts),
        endsAt: iso(t.ends),
        providers: named ? t.providers.map((p) => p.who) : [],
        room: t.rooms[0] ?? null,
      })),
    };
  },
});

export const staffingFreeOperations = [staffingFree] as const;
