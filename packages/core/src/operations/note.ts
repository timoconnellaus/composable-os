// note.open (stage 56, ADR 0830): the text of a note the caller may read, above all a sensitive
// one, which timelines list as a locked row. A person only; every opening is an audit row naming
// the note and no text (`auditReads`, ADR 0643), and no AI actor lists those rows.
import { z } from "zod";
import { NotFoundError } from "../errors.ts";
import { defineOperation } from "../operation.ts";
import { activitySchema, loadActivity } from "./activity.ts";

export const noteOpen = defineOperation({
  name: "note.open",
  description:
    "Open a note to read its text: a sensitive note is listed on timelines without it. Only a " +
    "person who may read the note (its author, admins, and people the business named one by " +
    "one) can open it; anyone else gets not found. Every opening is recorded in the audit log, " +
    "without the text. Read-only.",
  input: z.object({ id: z.string().startsWith("act_").max(64).describe("The note (act_…)") }),
  output: activitySchema,
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  auditReads: true,
  auditSummary: (_output, input) => ({ notes: [input.id] }),
  mcp: { expose: false },
  async handler(input, ctx) {
    const note = await loadActivity(ctx, input.id, { unlock: true });
    if (note?.type !== "note" || (note.private && note.authorUserId !== ctx.user.id)) {
      throw new NotFoundError("activity", input.id);
    }
    return note;
  },
});

export const noteOperations = [noteOpen] as const;
