// The room calendar's operations (stage 57 step 1, ADR 0844): `rooms.week` and `rooms.check`,
// tool-only reads over core_thing_time (occupancy/index.ts). Called from a shipped pack's tool run
// (Venue hire's room calendar and availability, Bookings'), for the staff account the pipeline
// verified as the tool's caller, never from a person, MCP or an assistant directly. They write
// nothing and decide nothing: a free answer is a guide, and the database still refuses a clash.
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { MAX_CLAIMS, roomClaims } from "../occupancy/index.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { loadStaffRights } from "../pack-roles.ts";
import { loadGeneralSettings } from "../settings.ts";
import { toolCaller } from "../staffing/rosterers.ts";
import { addLocalDays, parseLocalDate, wallClockToInstant } from "../time/local.ts";
import { assertShippedToolRun } from "./staffing.ts";

/** The longest range one call reads. */
export const ROOMS_MAX_DAYS = 62;

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD");
const instant = z
  .string()
  .min(1)
  .max(40)
  .refine((v) => Number.isFinite(Date.parse(v)), "a date and time, ISO 8601");
const recordId = z.string().min(1).max(64);

const roomClaimSchema = z.object({
  thing: z.object({ object: z.string(), id: z.string(), name: z.string().nullable() }),
  object: z.string().nullable().describe("The occupying object (null to a fixed role)"),
  label: z
    .string()
    .nullable()
    .describe("Its kind: Class, Appointment, Hire (null to a fixed role)"),
  id: z.string().nullable().describe("The record, for a click-through (null to a fixed role)"),
  title: z
    .string()
    .nullable()
    .describe("What the calendar shows: the object's declared title, else its label. Never a name"),
  startsAt: z.string().nullable().describe("The record's own start (null to a fixed role)"),
  endsAt: z.string().nullable().describe("The record's own end (null to a fixed role)"),
  takenFrom: z.string().describe("When it takes the room from, set-up or a buffer included"),
  takenTo: z.string().describe("When it takes the room until, pack-down or a buffer included"),
  provisional: z
    .boolean()
    .nullable()
    .describe("Held, not yet firm (a hire before its deposit); it refuses a clash all the same"),
});

/** Whether the tool's caller reads only "taken": an account holding a pack's fixed role. */
async function takenOnly(ctx: HandlerContext): Promise<boolean> {
  const account = toolCaller(ctx);
  if (!account) return true;
  return (await loadStaffRights(ctx.db, account)).packRole !== null;
}

export const roomsWeek = defineOperation({
  name: "rooms.week",
  description:
    "Tool-only (a shipped pack's tool): the room calendar, every claim on a room (one booking at " +
    "a time) from `from` to `to` (local dates in the organisation's zone, both included; at most " +
    `${ROOMS_MAX_DAYS} days), whatever holds it (a class, an appointment, a hire, an event, a ` +
    "block), in order of start: the room, its kind, its title, its own times, the times it takes " +
    "with set-up and pack-down, and whether it is provisional (a hold). `roomIds` keeps those " +
    "rooms. Never a client's or a hirer's name, nor any money. Someone holding a pack's fixed " +
    "role reads only that a room is taken, and when. Read-only.",
  input: z.object({
    from: localDate,
    to: localDate,
    roomIds: z.array(recordId).min(1).max(100).optional().describe("Only these rooms"),
  }),
  output: z.object({
    claims: z.array(roomClaimSchema),
    zone: z.string(),
    truncated: z
      .boolean()
      .describe(`More claims than one answer holds (${MAX_CLAIMS}): ask for fewer days or rooms`),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "rooms.week");
    const from = parseLocalDate(input.from);
    const to = parseLocalDate(input.to);
    if (!from) throw new ValidationError(`${input.from} is not a date`, { field: "from" });
    if (!to) throw new ValidationError(`${input.to} is not a date`, { field: "to" });
    if (input.to < input.from) {
      throw new ValidationError("It must end on or after its first date", { field: "to" });
    }
    const days =
      (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
        86_400_000 +
      1;
    if (days > ROOMS_MAX_DAYS) {
      throw new ValidationError(`At most ${ROOMS_MAX_DAYS} days at a time`, { field: "to" });
    }
    const { timezone } = await loadGeneralSettings(ctx.db);
    const start = wallClockToInstant({ ...from, hour: 0, minute: 0 }, timezone) / 1000;
    const end = wallClockToInstant({ ...addLocalDays(to, 1), hour: 0, minute: 0 }, timezone) / 1000;
    const { claims, truncated } = await roomClaims(
      ctx,
      { from: start, to: end, things: input.roomIds },
      { full: !(await takenOnly(ctx)) },
    );
    return { claims, zone: timezone, truncated };
  },
});

export const roomsCheck = defineOperation({
  name: "rooms.check",
  description:
    "Tool-only (a shipped pack's tool): whether a room is free from `starts` to `ends` (ISO " +
    "instants, half-open: a claim ending at `starts` does not count), and what takes it then, as " +
    "rooms.week shows it. Add set-up and pack-down to the times yourself. A guide only: the " +
    "database still refuses a clash when the record is written. Someone holding a pack's fixed " +
    "role reads only that the room is taken, and when. Read-only.",
  input: z.object({ roomId: recordId, starts: instant, ends: instant }),
  output: z.object({
    free: z.boolean(),
    claims: z.array(roomClaimSchema),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "rooms.check");
    const from = Math.floor(Date.parse(input.starts) / 1000);
    const to = Math.ceil(Date.parse(input.ends) / 1000);
    if (!(to > from)) {
      throw new ValidationError("It must end after it starts", { field: "ends" });
    }
    if (to - from > ROOMS_MAX_DAYS * 86_400) {
      throw new ValidationError(`At most ${ROOMS_MAX_DAYS} days at a time`, { field: "ends" });
    }
    const { claims } = await roomClaims(
      ctx,
      { from, to, things: [input.roomId] },
      { full: !(await takenOnly(ctx)) },
    );
    return { free: claims.length === 0, claims };
  },
});

export const roomsOperations = [roomsWeek, roomsCheck] as const;
