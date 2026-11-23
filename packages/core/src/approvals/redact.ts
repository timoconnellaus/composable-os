// What a pending action shows its reader (stage 45 step 6, the review of PR #287, ADR 0627). An
// operation's or extension tool's `redact` fields (a leave note, why a shift was not worked, how
// someone is counted for pay) are kept out of the audit log; the approval queue keeps the action's
// input whole, since a person must see what they approve. So the queue's reads show those fields
// only to someone who could approve the action themselves:
// - a restricted pack tool's call: someone who holds the tool (their role or a grant of it);
// - a write of who works a shift, where a pack declares who rosters: someone who rosters;
// - anything else: someone who may approve at all (`records:write`, a person).
// Anyone else (a viewer, a member reading another's rosterer request, an AI actor reading its own
// queue) sees `[redacted]` in their place, in the input, the preview and the simulated output.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { resolveExtensionOperation } from "../extensions/tools.ts";
import type { AnyOperation, HandlerContext } from "../operation.ts";
import { loadStaffRights, staffAuthority } from "../pack-roles.ts";
import { redactInput } from "../pipeline.ts";
import { holdsPermission } from "../principals.ts";
import { movesStartedShiftCall, touchesRoster } from "../staffing/approvals.ts";
import { isRosterer, rosteringDeclared } from "../staffing/rosterers.ts";

async function operationOf(
  db: Kysely<CoreDatabase>,
  name: string,
): Promise<AnyOperation | undefined> {
  if (name.startsWith("x.")) return resolveExtensionOperation(db, name);
  const { coreRegistry } = await import("../invoke.ts");
  return coreRegistry.get(name);
}

/** Whether the reader of the queue could approve `operation` with `input` themselves. */
async function couldApprove(
  ctx: HandlerContext,
  op: AnyOperation,
  input: unknown,
): Promise<boolean> {
  if (ctx.actor !== "human") return false;
  if (op.packRestricted) {
    const rights = await loadStaffRights(ctx.db, ctx.user.id);
    if (staffAuthority(ctx.user, rights, op, input) === null) return false;
  } else if (!holdsPermission(ctx.user, ctx.permissionGrants, "records:write")) {
    return false;
  }
  const roster =
    touchesRoster(op.name, input) || (await movesStartedShiftCall(ctx.db, op.name, input, ctx.now));
  if (roster && (await rosteringDeclared(ctx.db))) {
    return isRosterer(ctx.db, ctx.user.id);
  }
  return true;
}

interface Redactable {
  operation: string;
  input: unknown;
  preview: unknown;
  simulatedOutput: unknown;
}

/** The actions with each operation's `redact` fields hidden from a reader who could not approve. */
export async function redactForReader<A extends Redactable>(
  ctx: HandlerContext,
  actions: readonly A[],
): Promise<A[]> {
  const out: A[] = [];
  for (const action of actions) {
    const op = await operationOf(ctx.db, action.operation).catch(() => undefined);
    const keys = op?.redact ?? [];
    if (!op || !keys.length || (await couldApprove(ctx, op, action.input))) {
      out.push(action);
      continue;
    }
    out.push({
      ...action,
      input: redactInput(action.input, keys),
      preview: redactInput(action.preview, keys) as A["preview"],
      simulatedOutput: redactInput(action.simulatedOutput, keys),
    });
  }
  return out;
}
