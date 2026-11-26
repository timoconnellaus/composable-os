// The query path of every client's database, and nothing else (stage 66 step 2, ADR 0614, the
// review of #511, S6). `ClientDb` also has the operator's methods (restore, restart, size limits,
// migrations, bookmarks, holds, place), and anything holding its Durable Object namespace can call
// them. So the host's Workers (the app, the runner) never bind the namespace: they bind
// `cos-client-db`'s entrypoint `ClientDbQueries` as a service, which serves only `query`, `stage`,
// `commit`, `take` and `outcome`, for a client id it checks, and `clientDatabaseService()` stands
// where a D1 binding stands over it. The raw namespace is bound only where the operator's commands
// run (step 7) and in tests.
//
// Binding names (for step 4):
//   app, runner:  "services": [{ "binding": "CLIENT_DB_QUERIES", "service": "cos-client-db",
//                                "entrypoint": "ClientDbQueries" }]
//                 DB = clientDatabaseService(env.CLIENT_DB_QUERIES, client, { locationHint })
//   operator:     "durable_objects": { "bindings": [{ "name": "CLIENT_DB", "class_name": "ClientDb",
//                                "script_name": "cos-client-db" }] }
//                 clientDatabase(env.CLIENT_DB, client) and the operator methods on its stub
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ClientDb,
  ClientDbAnswer,
  ClientDbAnswerPart,
  ClientDbOutcome,
  ClientDbQuery,
  ClientDbStaged,
} from "./client-db.ts";
import { validateClientId } from "./registry.ts";

/** Which client's database a call is for, and where to create it if it does not exist yet. */
export interface ClientDbTarget {
  client: string;
  locationHint?: DurableObjectLocationHint;
}

/** What `ClientDbQueries` serves: the query path only, each call for one named client. */
export interface ClientDbQueryService {
  query(target: ClientDbTarget, queries: ClientDbQuery[], id?: string): Promise<ClientDbAnswer>;
  stage(
    target: ClientDbTarget,
    batch: string,
    index: number,
    queries: ClientDbQuery[],
  ): Promise<ClientDbStaged>;
  commit(
    target: ClientDbTarget,
    batch: string,
    partsBefore: number,
    queries: ClientDbQuery[],
  ): Promise<ClientDbAnswer>;
  take(target: ClientDbTarget, id: string, part: number): Promise<ClientDbAnswerPart>;
  outcome(target: ClientDbTarget, id: string): Promise<ClientDbOutcome>;
}

/** Cloudflare's location hints (Durable Objects, data location, 2026-11). */
export const LOCATION_HINTS: readonly DurableObjectLocationHint[] = [
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "apac-ne",
  "apac-se",
  "oc",
  "afr",
  "me",
] as DurableObjectLocationHint[];

/** `target` checked: a client id the registry's rule allows, and a known hint or none. */
export function checkTarget(target: unknown): ClientDbTarget {
  if (!target || typeof target !== "object")
    throw new RangeError("Not a client's database: no target");
  const { client, locationHint } = target as { client?: unknown; locationHint?: unknown };
  const id = validateClientId(client);
  if (
    locationHint !== undefined &&
    !LOCATION_HINTS.includes(locationHint as DurableObjectLocationHint)
  ) {
    throw new RangeError("Not a client's database: an unknown location hint");
  }
  return locationHint === undefined
    ? { client: id }
    : { client: id, locationHint: locationHint as DurableObjectLocationHint };
}

/**
 * `cos-client-db`'s entrypoint for the host's Workers: the query path of a named client's
 * database. Its `env` holds the namespace; nothing it serves reaches the operator's methods.
 */
export class ClientDbQueries
  extends WorkerEntrypoint<{ CLIENT_DB: DurableObjectNamespace<ClientDb> }>
  implements ClientDbQueryService
{
  #stub(target: ClientDbTarget) {
    const { client, locationHint } = checkTarget(target);
    const namespace = this.env.CLIENT_DB;
    return namespace.get(namespace.idFromName(client), locationHint ? { locationHint } : undefined);
  }

  async query(target: ClientDbTarget, queries: ClientDbQuery[], id?: string) {
    return (await this.#stub(target).query(queries, id)) as ClientDbAnswer;
  }

  async stage(target: ClientDbTarget, batch: string, index: number, queries: ClientDbQuery[]) {
    return (await this.#stub(target).stage(batch, index, queries)) as ClientDbStaged;
  }

  async commit(
    target: ClientDbTarget,
    batch: string,
    partsBefore: number,
    queries: ClientDbQuery[],
  ) {
    return (await this.#stub(target).commit(batch, partsBefore, queries)) as ClientDbAnswer;
  }

  async take(target: ClientDbTarget, id: string, part: number) {
    return (await this.#stub(target).take(id, part)) as ClientDbAnswerPart;
  }

  async outcome(target: ClientDbTarget, id: string) {
    return (await this.#stub(target).outcome(id)) as ClientDbOutcome;
  }
}
