// What `cos ext check` needs from the host to run the check outside a deployment (ADR 0405):
// the check `extension.check` runs, and enough of the reconciler to put the extensions this one
// builds on into a local database first. Exported as @composable-os/core/extension-check so the
// command does not load the whole operations registry.
export type { EvaluateResult, SourceIssue } from "./host.ts";
export { type CheckIssue, type CheckResult, checkEvaluated, checkManifest } from "./install.ts";
export { refreshSchemaRegistry } from "./schema.ts";
