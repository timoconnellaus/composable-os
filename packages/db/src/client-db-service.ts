// The query path of every client's database, and nothing else (stage 66 step 2, ADR 0614, the
// review of #511, S6). `ClientDb` also has the operator's methods (restore, restart, size limits,
// migrations, bookmarks, holds, place), and anything holding its Durable Object namespace can call
// them. So the host's Workers (the app, the runner) never bind the namespace: they bind
// `cos-client-db`'s entrypoint `ClientDbQueries` as a service, which serves only `query`, `stage`,
// `commit`, `take` and `outcome`, for a client id it checks, and `clientDatabaseService()` stands
// where a D1 binding stands over it. The raw namespace is bound only where the operator's commands
// run (step 7) and in tests.
//
// Who may call it (#515, S1): any Worker of the account can bind a service by name, so the
// entrypoint checks two things the host alone can make, under the props key (`COS_PROPS_KEY`,
// and `COS_PROPS_KEY_PREVIOUS` during a rotation, both in cos-client-db's own secrets too):
// - the binding's props, which the deploy engine sets and no code can change: `{ caller, proof }`
//   of one of the host's Workers (`clientDbCallerProps`);
// - each call's target: `{ client, proof }`, the proof of that client, which the directory makes
//   when it builds the client's environment (`clientDatabaseService(…, { proof })`). Code holding
//   the binding without the key (code below an entry, which never sees the host's `env`) opens no
//   client's database but the one its environment's `DB` already is.
//
// Binding names (for step 4):
//   app, runner:  "services": [{ "binding": "CLIENT_DB_QUERIES", "service": "cos-client-db",
//                                "entrypoint": "ClientDbQueries",
//                                "props": { "caller": "cos-app", "proof": … } }]
//                 DB = clientDatabaseService(env.CLIENT_DB_QUERIES, client, { locationHint, proof })
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
import { CLIENT_DB_CALLERS, isPropsProof, PROOF } from "./client-proofs.ts";
import { validateClientId } from "./registry.ts";

/** Which client's database a call is for, and where to create it if it does not exist yet. */
export interface ClientDbTarget {
  client: string;
  locationHint?: DurableObjectLocationHint;
  /** The host's proof of the client (`PROOF.clientDb`), required by `ClientDbQueries`. */
  proof?: string;
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
  const { proof } = target as { proof?: unknown };
  return {
    client: id,
    ...(locationHint === undefined
      ? {}
      : { locationHint: locationHint as DurableObjectLocationHint }),
    ...(typeof proof === "string" ? { proof } : {}),
  };
}

/** What `ClientDbQueries` reads of its own `env`: the namespace and the props keys. */
export interface ClientDbQueriesEnv {
  CLIENT_DB: DurableObjectNamespace<ClientDb>;
  COS_PROPS_KEY?: string;
  COS_PROPS_KEY_PREVIOUS?: string;
}

/** Whether `props` are a host Worker's binding props under a key `env` accepts. */
export function isClientDbCaller(env: object, props: unknown): boolean {
  if (!props || typeof props !== "object") return false;
  const { caller, proof } = props as { caller?: unknown; proof?: unknown };
  return (
    (CLIENT_DB_CALLERS as readonly unknown[]).includes(caller) &&
    isPropsProof(env, proof, PROOF.clientDbCaller, caller as string)
  );
}

/**
 * `cos-client-db`'s entrypoint for the host's Workers: the query path of a named client's
 * database. Its `env` holds the namespace; nothing it serves reaches the operator's methods.
 */
export class ClientDbQueries
  extends WorkerEntrypoint<ClientDbQueriesEnv, { caller?: string; proof?: string }>
  implements ClientDbQueryService
{
  #stub(target: ClientDbTarget) {
    if (!isClientDbCaller(this.env, this.ctx.props)) {
      throw new RangeError("Not a client's database: this caller is not one of the host's Workers");
    }
    const { client, locationHint, proof } = checkTarget(target);
    if (!isPropsProof(this.env, proof, PROOF.clientDb, client)) {
      throw new RangeError("Not a client's database: the call carries no proof of its client");
    }
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
