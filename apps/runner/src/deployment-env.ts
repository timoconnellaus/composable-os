// The runner's own environment as the module-level `env` of `cloudflare:workers` (stage 66 step
// 4, ADR 0615): the one module of the runner that imports it (scripts/check-module-env.mjs). It is
// the deployment's, never a client's, and is read only at load (the product's label, the packs
// the deploy named). Everything else reads the env its entry decided.
import { env } from "cloudflare:workers";

export const deploymentEnv: Env = env;
