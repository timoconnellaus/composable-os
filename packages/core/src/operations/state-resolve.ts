// state.resolve (stage 31a step 3, ADR 0505): the dry run of a requested move (ADR 0503). A pack's
// tool asks, before a member confirms, which state their "cancel" would enter now (cancelled in
// time, or late), and is told the host's answer, the same `resolveStateRequest` the record
// operations run in the write, by the host's clock. Nothing is written. A customer asks only of
// their own record; another's is not found. Tool-only, as my.update is.
import { z } from "zod";
import { NotFoundError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { defineOperation } from "../operation.ts";
import { callerMover } from "../records/lifecycle.ts";
import { resolveStateRequest } from "../records/states.ts";
import { unknownObject } from "../visibility/customer.ts";
import { type AnyRow, orgReader, ownedSource } from "../visibility/index.ts";
import { loadRecord } from "./record.ts";

export const stateResolve = defineOperation({
  name: "state.resolve",
  description:
    "From a tool: which state a requested move (such as `cancel`) would move a record to now, " +
    "decided by the host's clock and the object's windows exactly as the write would decide it " +
    "(a cancel more than the late-cancel time before a class is `cancelled`, later " +
    "`late_cancelled`). Writes nothing. Refused with the rule's details when no state may be " +
    "entered now. A customer asks only of their own records. Read-only.",
  input: z.object({
    object: z.string().min(1).max(81),
    id: z.string().min(1).max(64),
    request: z.string().min(1).max(40).describe("The request's name, e.g. cancel"),
  }),
  output: z.object({
    state: z.string().describe("The state the request would enter now"),
    label: z.string(),
    from: z.string().nullable().describe("The state the record is in"),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer"],
  toolOnly: true,
  // It reads the record whole and what its windows name (a class's start), as the write does.
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const object = getObject(input.object);
    const field = object?.states?.field;
    if (!object || !field || !object.states?.requests?.[input.request]) {
      throw unknownObject(input.object);
    }
    const caller = ctx.onBehalfOf ?? ctx.principal;
    if (caller.kind !== "staff") {
      // Only the caller's own record; another's (or none) is a record that is not there.
      // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view.
      const own = (await (ctx.db as any)
        .selectFrom(ownedSource({ principal: caller }, object))
        .select("id")
        .where("id", "=", input.id)
        .executeTakeFirst()) as AnyRow | undefined;
      if (!own) throw new NotFoundError(object.name, input.id);
    }
    // The host's own reads from here, as the write's are (the whole record, the class its window
    // names and that class's type): org-wide, with the caller still the mover. A prototype, not a
    // spread, so the context's guarded getters (`actor` on a customer's call) are not touched.
    const host = Object.create(ctx, {
      principal: { value: orgReader(ctx.db).principal },
      onBehalfOf: { value: caller },
    }) as typeof ctx;
    const record = await loadRecord(host, object, input.id);
    if (!record) throw new NotFoundError(object.name, input.id);
    const resolved = await resolveStateRequest(
      host,
      object,
      record.values,
      { [field]: input.request },
      callerMover(host),
    );
    const state = String(resolved[field]);
    const choices = object.fields.find((f) => f.name === field)?.options?.choices ?? [];
    const from = record.values[field];
    return {
      state,
      label: choices.find((c) => c.value === state)?.label ?? state,
      from: typeof from === "string" ? from : null,
    };
  },
});

export const stateResolveOperations = [stateResolve] as const;
