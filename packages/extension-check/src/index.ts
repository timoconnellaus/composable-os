// @composable-os/extension-check: the checks on extension source that run before a manifest exists
// (ADR 0025, ADR 0405). cos-runner runs them inside a deployment for `extension.check`; the cos
// command runs the same functions for `cos ext check`. The checks on the manifest itself
// (contract, formulas, automations, the dry-run reconcile) are `checkEvaluated` in
// @composable-os/core.
export * from "./build.ts";
export * from "./typecheck.ts";
