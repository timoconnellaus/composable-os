// Looks after (stage 56 step 1, ADR 0831): the staff accounts that look after a Person, who read
// the Person's notes kept to their coaches (level `coaches`, ADR 0830).
//
//   carer.set   staff, a person only (people:link): an account starts looking after a Person
//   carer.end   staff, a person only (people:link): it stops; it reads their notes no more
//   carer.list  staff (records:read): who looks after a Person, ended rows too on request
//
// Who reads whose notes is policy, so setting it is a person's act on the Person's page, as the
// family link is (ADR 0540): `actors: ["human"]`, refused to the assistant, MCP clients,
// automations and extension code. Nobody sets themselves, unless they already read every coaches
// note.
// What a live row allows is decided by the seam alone (visibility/notes.ts), on every read. Each
// call's audit row (input and the row's id) is the record of who set it; nothing goes on the
// Person's timeline or to an automation.
import { sql } from "kysely";
import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { type NoteViewer, noteRights, visibleSource } from "../visibility/index.ts";

const personId = z.string().min(1).max(64).describe("The person (per_…)");
const userId = z.string().min(1).max(64).describe("The staff account (usr_…)");

const carerSchema = z.object({
  id: z.string(),
  personId: z.string(),
  user: z.object({ id: z.string(), name: z.string().nullable() }),
  startedAt: z.string(),
  setBy: z.string(),
  endedAt: z.string().nullable(),
  endedBy: z.string().nullable(),
});
type Carer = z.infer<typeof carerSchema>;

interface CarerRow {
  id: string;
  person_id: string;
  user_id: string;
  user_name: string | null;
  set_by: string;
  started_at: string;
  ended_at: string | null;
  ended_by: string | null;
}

function toCarer(row: CarerRow): Carer {
  return {
    id: row.id,
    personId: row.person_id,
    user: { id: row.user_id, name: row.user_name },
    startedAt: row.started_at,
    setBy: row.set_by,
    endedAt: row.ended_at,
    endedBy: row.ended_by,
  };
}

function carers(ctx: HandlerContext) {
  return ctx.db
    .selectFrom("core_person_carer as c")
    .leftJoin("core_user as u", "u.id", "c.user_id")
    .select([
      "c.id",
      "c.person_id",
      "c.user_id",
      "u.name as user_name",
      "c.set_by",
      "c.started_at",
      "c.ended_at",
      "c.ended_by",
    ]);
}

/** A live Person (out of the Trash), or not found. */
async function requireLivePerson(ctx: HandlerContext, id: string): Promise<void> {
  const row = await ctx.db
    .selectFrom(visibleSource(ctx, "person"))
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("person", id);
}

export const carerSet = defineOperation({
  name: "carer.set",
  description:
    "Say that a staff account looks after a person (their coach): from then on it reads the " +
    "person's notes kept to their coaches, and stops when the row is ended with carer.end. " +
    "Choose it on the person's page; it is never worked out from bookings. Refused when the " +
    "account already looks after them. Only a person on the staff with people:link can do " +
    "this: never the assistant, an MCP client or code. Audited.",
  input: z.object({ personId, userId }),
  output: carerSchema,
  permission: "people:link",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    // A coach does not add themselves (stage 56): people:link is not restricted, and setting
    // oneself would open a client's coaches notes one step away. Someone who already reads every
    // coaches note (an admin, notes:clients) gains nothing by it.
    if (input.userId === ctx.user.id && !noteRights(ctx as NoteViewer)?.clients) {
      throw new ForbiddenError(
        "You cannot say you look after someone yourself: another person sets it",
        {
          field: "userId",
          rule: "carer_self",
        },
      );
    }
    await requireLivePerson(ctx, input.personId);
    const user = await ctx.db
      .selectFrom("rec_user")
      .select(["id", "name"])
      .where("id", "=", input.userId)
      .executeTakeFirst();
    const active = user
      ? await ctx.db
          .selectFrom("core_user")
          .select("id")
          .where("id", "=", input.userId)
          .where("deactivated_at", "is", null)
          .executeTakeFirst()
      : undefined;
    if (!user || !active) {
      throw new ValidationError("Only an active staff account can look after someone", {
        field: "userId",
      });
    }
    const existing = await ctx.db
      .selectFrom("core_person_carer")
      .select("id")
      .where("person_id", "=", input.personId)
      .where("user_id", "=", input.userId)
      .where("ended_at", "is", null)
      .executeTakeFirst();
    if (existing) {
      throw new ConflictError("This account already looks after this person.", {
        rule: "person_carer",
      });
    }
    const id = newId("personCarer");
    ctx.write(
      ctx.db.insertInto("core_person_carer").values({
        id,
        person_id: input.personId,
        user_id: input.userId,
        set_by: ctx.user.id,
        started_at: ctx.now,
      }),
    );
    return toCarer({
      id,
      person_id: input.personId,
      user_id: input.userId,
      user_name: user.name,
      set_by: ctx.user.id,
      started_at: ctx.now,
      ended_at: null,
      ended_by: null,
    });
  },
});

export const carerEnd = defineOperation({
  name: "carer.end",
  description:
    "End a looks-after row (carer.list gives its id): from the next read the account no longer " +
    "reads the person's notes kept to their coaches, except the ones it wrote. The row is kept, " +
    "ended, with who ended it. Only a person on the staff with people:link can do this. Audited.",
  input: z.object({ id: z.string().min(1).max(64).describe("The row (pcr_…)") }),
  output: carerSchema,
  permission: "people:link",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = (await carers(ctx).where("c.id", "=", input.id).executeTakeFirst()) as
      | CarerRow
      | undefined;
    if (!row) throw new NotFoundError("person carer", input.id);
    if (row.ended_at) {
      throw new ConflictError("This has already ended.", { rule: "person_carer_ended" });
    }
    ctx.write(
      ctx.db
        .updateTable("core_person_carer")
        .set({ ended_at: ctx.now, ended_by: ctx.user.id })
        .where("id", "=", input.id)
        .where("ended_at", "is", null),
    );
    return toCarer({ ...row, ended_at: ctx.now, ended_by: ctx.user.id });
  },
});

export const carerList = defineOperation({
  name: "carer.list",
  description:
    "Who looks after a person (their coaches): the staff accounts that read the person's notes " +
    "kept to their coaches, with who set each and when, live ones first, and (with ended) the " +
    "rows that have ended. Read-only.",
  input: z.object({
    personId,
    ended: z.boolean().default(false).describe("Include rows that have ended"),
  }),
  output: z.object({ items: z.array(carerSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    await requireLivePerson(ctx, input.personId);
    let query = carers(ctx).where("c.person_id", "=", input.personId);
    if (!input.ended) query = query.where("c.ended_at", "is", null);
    const rows = (await query
      .orderBy(sql`c.ended_at IS NOT NULL`)
      .orderBy("c.started_at", "desc")
      .limit(200)
      .execute()) as CarerRow[];
    return { items: rows.map(toCarer) };
  },
});

export const carerOperations = [carerSet, carerEnd, carerList] as const;
