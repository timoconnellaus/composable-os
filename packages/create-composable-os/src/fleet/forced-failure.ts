// A failure forced on purpose, for the staging check only (.github/workflows/fleet-staging-check.yml):
// it proves on real Cloudflare that a failed update is undone. `COS_FLEET_FORCE_FAILURE` is one of
//
//   migration:<client>   that client's migrate call of `cos fleet upgrade` also carries one more
//                        migration, which fails inside its database (the others are restored and
//                        nothing is uploaded, as for any failed migration)
//   smoke                the smoke check of `cos fleet upgrade` fails after the upload (the previous
//                        Workers are uploaded again and every client restored)
//
// cos refuses the variable, with nothing done, anywhere but a staging fleet of the check's throwaway
// product, inside that workflow's run on GitHub Actions: it is never a switch a live host, a real
// product or an operator's terminal can turn on.
import type { Migration } from "@composable-os/db";
import type { ProductDefinition } from "@composable-os/product";
import { CliError, type Env, throwawayProblem } from "../main.ts";
import type { Operator } from "./operator-client.ts";

export const FORCE_FAILURE_VAR = "COS_FLEET_FORCE_FAILURE";
export const STAGING_CHECK_WORKFLOW = ".github/workflows/fleet-staging-check.yml";

/** The migration a forced failure adds: it inserts into a table no release has, so it fails. */
export const FORCED_MIGRATION: Migration = {
  name: "9999_staging_check_forced_failure.sql",
  queries: ["INSERT INTO staging_check_forced_failure_no_such_table VALUES (1)"],
};

export type ForcedFailure = { kind: "migration"; client: string } | { kind: "smoke" } | null;

/**
 * The failure the environment forces, or null when it forces none. Throws, before anything is
 * done, when it is set anywhere but the staging check (see the top of this file).
 */
export function forcedFailure(
  env: Env,
  where: { environment: string; product: ProductDefinition },
): ForcedFailure {
  const value = env[FORCE_FAILURE_VAR]?.trim();
  if (!value) return null;
  const refuse = (why: string): never => {
    throw new CliError(
      `${FORCE_FAILURE_VAR} is the staging check's test switch and is refused here: ${why}. Nothing was changed.`,
    );
  };
  if (where.environment !== "staging") refuse("this is not a staging fleet");
  // Its id and every name: the fleet is found by the product's database name, so an id alone
  // could aim the switch at a real product's staging fleet (review of #541, F3).
  const problem = throwawayProblem(where.product);
  if (problem) refuse(`the product is not the check's throwaway one (${problem})`);
  if (
    env.GITHUB_ACTIONS !== "true" ||
    !env.GITHUB_WORKFLOW_REF?.includes(`/${STAGING_CHECK_WORKFLOW}@`)
  ) {
    refuse(`it is not a run of ${STAGING_CHECK_WORKFLOW}`);
  }
  if (value === "smoke") return { kind: "smoke" };
  const match = /^migration:([a-z0-9][a-z0-9-]*)$/.exec(value);
  if (!match) return refuse("its value is migration:<client> or smoke");
  return { kind: "migration", client: match[1] as string };
}

/** `operator` with the forced migration added to `client`'s migrate calls. */
export function withForcedMigration(operator: Operator, client: string): Operator {
  return {
    op: (action, body = {}) =>
      operator.op(
        action,
        action === "migrate" && body.client === client
          ? { ...body, migrations: [...(body.migrations as Migration[]), FORCED_MIGRATION] }
          : body,
      ),
    putFile: (...args) => operator.putFile(...args),
    getExport: (path) => operator.getExport(path),
    ...(operator.claim ? { claim: () => (operator.claim as () => Promise<void>)() } : {}),
  };
}
