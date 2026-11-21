// Minimal entry for the Workers test pool. The real entry is TanStack Start's server entry.
// Durable Object classes bound in wrangler.jsonc must be exported here too.
import { ClientApp as HostClientApp } from "../src/server/http/bound.ts";
import { boundTestEnv } from "./bound-env.ts";

export { AssistantAgent } from "../src/server/assistant/agent.ts";
export { AgentJob } from "../src/server/assistant/job.ts";

/**
 * cos-app's ClientApp entrypoint (stage 24), which the company-web fixture Worker binds to: the
 * real class, given the tests' env (customer sign-in on, codes kept for the tests).
 */
export class ClientApp extends HostClientApp {
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, boundTestEnv(env) as unknown as Env);
  }
}

export default {
  fetch: () => new Response("test worker"),
} satisfies ExportedHandler<Env>;
