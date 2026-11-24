// The minute cron's agreements step (stage 44, ADR 0640): scheduled versions whose time has come
// take effect. It runs as the platform's own system step (SYSTEM_USER, origin `system`), so it is
// gated, audited and in one batch, as scheduled publishes of records are (content/schedule.ts).
// A minute with nothing due is one indexed read outside the pipeline (two in an hour's first
// minute): no operation, no audit row.
import type { CrmDb } from "@composable-os/db";
import type { GateFloor } from "../gate.ts";
import { invoke } from "../invoke.ts";
import { agreementWorkDue } from "../operations/agreement.ts";
import { SYSTEM_USER } from "../users.ts";

export async function runAgreementsDue(
  db: CrmDb,
  { floor, clock }: { floor?: GateFloor; clock?: () => Date } = {},
): Promise<{ documents: number }> {
  const at = clock?.() ?? new Date();
  // Unconfirmed acceptances wait three days: looking for them in an hour's first minute is enough.
  const stale = at.getUTCMinutes() === 0;
  if (!(await agreementWorkDue(db.query, at.toISOString(), { stale }))) return { documents: 0 };
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
