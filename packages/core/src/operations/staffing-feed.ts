// A staff member's private calendar feed (stage 45 step 5, ADR 0628): whether they have one, a new
// address (made, or rotated), and revoking it. Tool-only, as every staffing operation (ADR 0621):
// called from a shipped pack's tool run, acting for the staff account the pipeline verified as the
// tool's caller (`ctx.extension.tool.calledBy`, ADR 0625), never for anything in the input.
//
// The address is a bearer secret (a calendar app polls it with no sign-in), so:
// - only the person makes or rotates their own, at the screen (`humanOnly`, and the verified
//   caller a person): never an assistant, an MCP client, an automation or someone else, so the
//   address is never in a conversation, a tool's run or anyone else's hands;
// - it is answered once, by the call that makes it, and stored only as its hash; nothing of it
//   reaches the audit log (the summary says only that it was rotated), a notice, a tool run's
//   record (which keeps operation names) or an error;
// - the person revokes their own; an admin may revoke anyone's (never make one for them): a
//   person's own act too.
import { z } from "zod";
import { ForbiddenError, NotFoundError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { feedPath, feedTokenHash, newFeedToken, revokeFeed } from "../staffing/feed.ts";
import { toolCaller } from "../staffing/rosterers.ts";
import { assertShippedToolRun } from "./staffing.ts";

/**
 * A feed call: a shipped pack's tool a person calls themselves (never an AI acting for one), for
 * their own account. Answers that account.
 */
async function feedCaller(ctx: HandlerContext, name: string): Promise<string> {
  await assertShippedToolRun(ctx, name);
  const tool = ctx.extension?.tool;
  if (tool?.humanOnly !== true || tool.calledBy?.actor !== "human") {
    throw new ForbiddenError(
      "A calendar feed's address is a person's own: only they make, change or revoke it, never an assistant.",
      { rule: "human_only" },
    );
  }
  return toolCaller(ctx) as string;
}

const feedShape = z.object({
  active: z.boolean().describe("Whether a feed address exists (it is never shown again)"),
  createdAt: z.string().nullable().describe("When the current address was made"),
});

export const staffingFeedStatus = defineOperation({
  name: "staffing.feed.status",
  description:
    "Tool-only (a shipped pack's tool): whether you have a private calendar feed of your shifts, " +
    "and when its address was made. Never the address itself: it is shown once, when made. " +
    "Read-only.",
  input: z.object({}),
  output: feedShape,
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    await assertShippedToolRun(ctx, "staffing.feed.status");
    const row = await ctx.db
      .selectFrom("core_staff_feed")
      .select(["created_at"])
      .where("account_id", "=", toolCaller(ctx) as string)
      .executeTakeFirst();
    return { active: row !== undefined, createdAt: row?.created_at ?? null };
  },
});

export const staffingFeedRotate = defineOperation({
  name: "staffing.feed.rotate",
  description:
    "Tool-only (a shipped pack's tool): a new private address for your calendar feed (your own " +
    "shifts, for a calendar app to subscribe to), replacing any old one, which stops working at " +
    "once. The address is shown this once and never again: anyone who has it sees your shifts, " +
    "so do not share it. A person's own act.",
  input: z.object({}),
  output: z.object({
    path: z
      .string()
      .describe(
        "The feed's address on this host (put the host's origin before it; webcal:// opens it in a calendar app). Shown once.",
      ),
    createdAt: z.string(),
  }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  // The address is a secret: the audit log says it was rotated, never what it is.
  auditSummary: () => ({ feed: "rotated" }),
  redactResult: ["path"],
  async handler(_input, ctx) {
    const account = await feedCaller(ctx, "staffing.feed.rotate");
    const tool = ctx.extension?.tool;
    const token = newFeedToken();
    const hash = await feedTokenHash(token);
    ctx.write(
      ctx.db
        .insertInto("core_staff_feed")
        .values({
          account_id: account,
          token_hash: hash,
          // The tool that made it: the feed answers only while the account may still call it.
          tool: `x.${ctx.extension?.id}.${tool?.name}`,
          created_at: ctx.now,
        })
        .onConflict((oc) =>
          oc.column("account_id").doUpdateSet({
            token_hash: hash,
            tool: `x.${ctx.extension?.id}.${tool?.name}`,
            created_at: ctx.now,
          }),
        ),
    );
    return { path: feedPath(token), createdAt: ctx.now };
  },
});

export const staffingFeedRevoke = defineOperation({
  name: "staffing.feed.revoke",
  description:
    "Tool-only (a shipped pack's tool): revoke a private calendar feed's address, which then " +
    "answers as if it never existed (a calendar app subscribed to it keeps the shifts it last " +
    "fetched, and gets no more). Your own; an admin may revoke anyone's (`account`). A person's " +
    "own act.",
  input: z.object({
    account: z.string().min(1).max(64).optional().describe("Someone else's (an admin only)"),
  }),
  output: z.object({ account: z.string(), revoked: z.boolean() }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const caller = await feedCaller(ctx, "staffing.feed.revoke");
    const account = input.account ?? caller;
    if (account !== caller) {
      const admin = await ctx.db
        .selectFrom("core_user")
        .select(["role", "kind", "deactivated_at"])
        .where("id", "=", caller)
        .executeTakeFirst();
      if (admin?.role !== "admin" || admin.kind !== "human" || admin.deactivated_at) {
        // Whether someone else has a feed is not anyone's to learn.
        throw new NotFoundError("feed", account);
      }
    }
    const row = await ctx.db
      .selectFrom("core_staff_feed")
      .select(["account_id"])
      .where("account_id", "=", account)
      .executeTakeFirst();
    if (row) ctx.write(revokeFeed(ctx.db, account));
    return { account, revoked: row !== undefined };
  },
});

export const staffingFeedOperations = [
  staffingFeedStatus,
  staffingFeedRotate,
  staffingFeedRevoke,
] as const;
