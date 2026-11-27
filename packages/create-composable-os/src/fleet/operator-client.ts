// `cos`'s side of the operator's Worker (stage 66 step 7, ADR 0618; packages/db `operator.ts`).
//
// Each command opens a session: a fresh random token, set as the Worker's `COS_OPERATOR_TOKEN`
// secret with the account's token, waited for until the Worker accepts it, used for the command's
// calls, and replaced by another random value (which nobody keeps) when the command ends. A crash
// leaves a token only that run held, in its memory: no standing credential is left anywhere.
import type { CloudflareClient } from "@composable-os/release";

export const OPERATOR_TOKEN_VAR = "COS_OPERATOR_TOKEN";

/** What the commands call: the operator's Worker, or a test's stand-in. */
export interface Operator {
  op<T = Record<string, unknown>>(action: string, body?: Record<string, unknown>): Promise<T>;
  putFile(client: string, key: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  getExport(path: string): Promise<Uint8Array>;
  /**
   * Takes the operator's session for this command before it changes anything (session.ts), so a
   * command refused because another holds it has written nothing. Absent on a test's stand-in.
   */
  claim?(): Promise<void>;
}

export class OperatorError extends Error {}

function token(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** The operator Worker's answer to a request without its current token (packages/db operator.ts). */
export const NOT_THE_OPERATOR = "not the operator";

/** What cos says when a call is tried again for that answer: the cause, named, with no token. */
export const STALE_NOTE =
  "the operator's Worker answered from a copy without this command's token (its new version is still reaching every copy); trying again";

export interface HttpOperatorOptions {
  /**
   * How long a call answered "not the operator" is tried again (default 60 s). Setting the
   * session's token deploys a new version of the Worker, and Cloudflare may answer from a copy
   * still on the previous version for a while after one answer from the new: the staging check's
   * first real run had `place` accepted and the next call, `migrate`, refused. The Worker refuses
   * such a call before it reads anything else, so trying it again changes nothing twice.
   */
  staleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Told each time a call is tried again, with the call's name (never a token). */
  onStale?: (what: string, attempt: number) => void;
  /**
   * Whether this command still holds the operator's session (the registry's row, session.ts),
   * read before each try again: "not the operator" may also mean another command took the session
   * over (`--take-over`) and set its own token, and then trying again for a minute is wrong.
   */
  stillHolds?: () => Promise<boolean>;
}

/** An operator over HTTP at `origin` with `bearer`. */
export function httpOperator(
  origin: string,
  bearer: string,
  doFetch: typeof fetch = fetch,
  options: HttpOperatorOptions = {},
): Operator {
  const headers = { authorization: `Bearer ${bearer}` };
  const staleMs = options.staleMs ?? 60_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const errorOf = async (response: Response): Promise<string> => {
    try {
      return ((await response.clone().json()) as { error?: string }).error ?? `${response.status}`;
    } catch {
      return `${response.status}`;
    }
  };
  /** Sends a request, again while a stale copy of the Worker answers "not the operator". */
  const send = async (what: string, request: () => Promise<Response>): Promise<Response> => {
    const deadline = Date.now() + staleMs;
    for (let attempt = 1; ; attempt += 1) {
      const response = await request();
      if (response.status !== 401 || (await errorOf(response)) !== NOT_THE_OPERATOR) {
        return response;
      }
      if (Date.now() >= deadline) return response;
      if (options.stillHolds && !(await options.stillHolds())) {
        throw new OperatorError(
          `${what}: another operator's command took the operator's Worker over; this one stops, nothing more sent`,
        );
      }
      options.onStale?.(what, attempt);
      await sleep(Math.min(2_000, 250 * attempt));
    }
  };
  const fail = async (response: Response, what: string): Promise<never> => {
    throw new OperatorError(`${what}: ${await errorOf(response)}`);
  };
  return {
    async op<T>(action: string, body: Record<string, unknown> = {}) {
      const response = await send(action, () =>
        doFetch(`${origin}/op`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ action, ...body }),
        }),
      );
      if (!response.ok) return fail(response, action);
      return (await response.json()) as T;
    },
    async putFile(client, key, bytes, contentType) {
      const path = key.split("/").map(encodeURIComponent).join("%2F");
      const response = await send(`file ${key}`, () =>
        doFetch(`${origin}/files/${client}/${path}`, {
          method: "PUT",
          headers: { ...headers, ...(contentType ? { "content-type": contentType } : {}) },
          body: bytes as BodyInit,
        }),
      );
      if (!response.ok) await fail(response, `file ${key}`);
    },
    async getExport(path) {
      const response = await send(`export file ${path}`, () =>
        doFetch(`${origin}/exports/${path.split("/").map(encodeURIComponent).join("/")}`, {
          headers,
        }),
      );
      if (!response.ok) return fail(response, `export file ${path}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/**
 * Opens a session on the operator's Worker `script` at `origin`: sets a fresh token as its
 * secret, waits until it answers to it, and returns the operator with `close`, which replaces the
 * token with one nobody holds.
 */
export async function openOperator(input: {
  api: CloudflareClient;
  accountId: string;
  script: string;
  origin: string;
  fetch?: typeof fetch;
  redact: (value: string) => void;
  waitMs?: number;
  /** Each call tried again while the new token reaches every copy of the Worker (see above). */
  stale?: HttpOperatorOptions;
}): Promise<Operator & { close(): Promise<void> }> {
  const bearer = token();
  input.redact(bearer);
  await input.api.putSecret(input.accountId, input.script, OPERATOR_TOKEN_VAR, bearer);
  const operator = httpOperator(input.origin, bearer, input.fetch ?? fetch, {
    ...input.stale,
    // The first answer is waited for below: no retry inside it.
    staleMs: 0,
  });
  const deadline = Date.now() + (input.waitMs ?? 60_000);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await operator.op("health");
      break;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new OperatorError(
          `the operator's Worker ${input.script} did not take the session's token (${(error as Error).message})`,
        );
      }
      await new Promise((r) => setTimeout(r, Math.min(2_000, 200 * attempt)));
    }
  }
  return {
    ...httpOperator(input.origin, bearer, input.fetch ?? fetch, input.stale),
    async close() {
      const forgotten = token();
      input.redact(forgotten);
      await input.api.putSecret(input.accountId, input.script, OPERATOR_TOKEN_VAR, forgotten);
    },
  };
}
