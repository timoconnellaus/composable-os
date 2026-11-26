// The Worker that holds clients' databases (stage 66 step 2, ADR 0614). It exports the `ClientDb`
// class from packages/db and answers nothing itself: the host's Workers reach each client's object
// through a Durable Object binding to this script. Kept apart so that a release of the host, which
// redeploys the app and the runner, does not restart every client's database; this Worker is
// deployed only when `ClientDb` itself changes.
export { ClientDb } from "@composable-os/db/client-db";

export default {
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
