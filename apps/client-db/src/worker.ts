// The Worker that holds clients' databases (stage 66 step 2, ADR 0614). It exports the `ClientDb`
// class from packages/db and answers no request itself. Kept apart so that a release of the host,
// which redeploys the app and the runner, does not restart every client's database; this Worker is
// deployed only when `ClientDb` itself changes.
//
// Two ways in:
// - `ClientDbQueries`, a WorkerEntrypoint serving only the query path (query, stage, commit, take,
//   outcome) for a client id it checks: what the host's app and runner bind, as the service
//   `CLIENT_DB_QUERIES` (`clientDatabaseService`). They never hold the namespace.
// - The `ClientDb` namespace itself, with the operator's methods (restore, restart, size limits,
//   migrations, bookmarks, holds, place): bound only where the operator's commands run (step 7),
//   as `CLIENT_DB` with `script_name` this Worker.
export { ClientDb } from "@composable-os/db/client-db";
export { ClientDbQueries } from "@composable-os/db/client-db-service";

export default {
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
