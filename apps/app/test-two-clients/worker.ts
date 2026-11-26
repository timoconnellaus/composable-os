// The two-client suite's Worker (vitest.two-client.config.ts): the app's real Durable Object
// classes and its real ClientApp entrypoint, which the web app fixtures bind to with the client
// in their binding's props. TanStack Start needs its build, so `fetch` is not served here: the
// suite calls the app's entries (src/server/entry.ts) itself.
export { AssistantAgent } from "../src/server/assistant/agent.ts";
export { AgentJob } from "../src/server/assistant/job.ts";
export { ClientApp } from "../src/server/http/bound.ts";

export default {
  fetch: () => new Response("two-client test worker"),
} satisfies ExportedHandler<Env>;
