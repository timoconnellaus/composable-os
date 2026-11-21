// access.check (stage 42, ADR 0478): the seam's one question (`holdsAccess`, ADR 0477), asked by
// a pack's tool for the customer it runs as: of these records, which does the caller hold access
// to. A tool is told the host's answer, never works it out: My courses lists what a student holds,
// and a course page says whether to show "buy" or "open". Tool-only, as public.list is.
import { z } from "zod";
import { getObject } from "../fields/index.ts";
import { defineOperation } from "../operation.ts";
import { holdsAccess } from "../visibility/access.ts";
import { unknownObject } from "../visibility/customer.ts";

export const accessCheck = defineOperation({
  name: "access.check",
  description:
    "From a tool: which of these records (of an object that declares who holds access to it, " +
    "such as a course) the caller holds access to now. Staff hold every one; the public none; a " +
    "customer those a live source gives them (an enrolment, a bundle). Read-only.",
  input: z.object({
    object: z.string().min(1).max(81),
    ids: z.array(z.string().min(1).max(64)).min(1).max(100),
  }),
  output: z.object({ held: z.array(z.string()) }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer", "public"],
  toolOnly: true,
  // It reads the sources' records (an enrolment's) beside what the caller reads.
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const object = getObject(input.object);
    if (!object?.access) throw unknownObject(input.object);
    const caller = ctx.onBehalfOf ?? ctx.principal;
    const held = await holdsAccess({ db: ctx.db, principal: caller }, object, input.ids, ctx.now);
    return { held: input.ids.filter((id) => held.has(id)) };
  },
});

export const accessOperations = [accessCheck] as const;
