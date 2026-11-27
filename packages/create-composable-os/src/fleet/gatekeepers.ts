// The gatekeepers a host of many clients runs (stage 66; ADR 0618, "A fleet's gatekeepers"). The
// list is fixed by the platform, not chosen by a flag: a gatekeeper goes on a fleet only once it
// is made per client (ADR 0616, "Gatekeepers"), so turning one on is a code change, reviewed, never
// an operator's option. Today that is email sending alone: each client sends from its own verified
// sender domains (ADR 0616, "Email sending per client"). The others stay off a fleet, in no
// client's environment (payments, text, inbound webhooks and email receiving hold one account for
// the whole deployment; the OAuth ones need the operator's apps and the checks ADR 0616 lists).
//
// The deploy engine does the rest as it does for a single-client deployment: the gatekeeper's
// Worker is uploaded because the state names it, the runner binds it as `GATEKEEPER_<NAME>`, and
// on a fleet `SENDER_DOMAINS_PER_CLIENT=true` is set on it (packages/release `fleet.ts`).
import type { ReleaseManifest } from "@composable-os/release";

/** The gatekeepers every fleet runs, by short name. */
export const FLEET_GATEKEEPERS: readonly string[] = Object.freeze(["email-send"]);

/**
 * The deployment state's `gatekeepers` for a fleet on `manifest`: the release's Worker names of
 * FLEET_GATEKEEPERS, sorted. Throws when the release lacks one, so a fleet is never installed or
 * upgraded silently without email sending (its clients' sign-in codes would never go out).
 */
export function fleetGatekeepers(manifest: Pick<ReleaseManifest, "workers">): string[] {
  const names = FLEET_GATEKEEPERS.map((short) => {
    const worker = manifest.workers.find((w) => w.role === "gatekeeper" && w.shortName === short);
    if (!worker) {
      throw new Error(
        `The release has no ${short} gatekeeper, which every host of many clients runs (ADR 0618).`,
      );
    }
    return worker.name;
  });
  return [...new Set(names)].sort();
}
