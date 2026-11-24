// The minute cron's agreements step (stage 44, ADR 0640): scheduled versions whose time has come
// take effect. It runs as the platform's own system step (SYSTEM_USER, origin `system`), so it is
// gated, audited and in one batch, as scheduled publishes of records are (content/schedule.ts).
// A minute with nothing due is two indexed reads outside the pipeline: no operation, no audit row.
import type { CrmDb } from "@composable-os/db";
import type { GateFloor } from "../gate.ts";
import { invoke } from "../invoke.ts";
import { agreementWorkDue } from "../operations/agreement.ts";
import { SYSTEM_USER } from "../users.ts";

export async function runAgreementsDue(
  db: CrmDb,
  { floor, clock }: { floor?: GateFloor; clock?: () => Date } = {},
): Promise<{ documents: number }> {
  if (!(await agreementWorkDue(db.query, (clock?.() ?? new Date()).toISOString()))) {
    return { documents: 0 };
  }
  const result = (await invoke(
    "agreement.takeEffect",
    {},
    {
      actor: "automation",
      user: SYSTEM_USER,
      origin: { surface: "system", automationId: "system.agreements" },
      db,
      ...(floor ? { floor } : {}),
      ...(clock ? { clock } : {}),
    },
  )) as { documents: string[] };
  return { documents: result.documents.length };
}
