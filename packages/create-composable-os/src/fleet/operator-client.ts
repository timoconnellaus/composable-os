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
}

export class OperatorError extends Error {}

function token(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** An operator over HTTP at `origin` with `bearer`. */
export function httpOperator(
  origin: string,
  bearer: string,
  doFetch: typeof fetch = fetch,
): Operator {
  const headers = { authorization: `Bearer ${bearer}` };
  const fail = async (response: Response, what: string): Promise<never> => {
    let message = `${response.status}`;
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      // Not JSON.
    }
    throw new OperatorError(`${what}: ${message}`);
  };
  return {
    async op<T>(action: string, body: Record<string, unknown> = {}) {
      const response = await doFetch(`${origin}/op`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ action, ...body }),
      });
      if (!response.ok) return fail(response, action);
      return (await response.json()) as T;
    },
    async putFile(client, key, bytes, contentType) {
      const path = key.split("/").map(encodeURIComponent).join("%2F");
      const response = await doFetch(`${origin}/files/${client}/${path}`, {
        method: "PUT",
        headers: { ...headers, ...(contentType ? { "content-type": contentType } : {}) },
        body: bytes as BodyInit,
      });
      if (!response.ok) await fail(response, `file ${key}`);
    },
    async getExport(path) {
      const response = await doFetch(
        `${origin}/exports/${path.split("/").map(encodeURIComponent).join("/")}`,
        { headers },
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
}): Promise<Operator & { close(): Promise<void> }> {
  const bearer = token();
  input.redact(bearer);
  await input.api.putSecret(input.accountId, input.script, OPERATOR_TOKEN_VAR, bearer);
  const operator = httpOperator(input.origin, bearer, input.fetch ?? fetch);
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
    ...operator,
    async close() {
      const forgotten = token();
      input.redact(forgotten);
      await input.api.putSecret(input.accountId, input.script, OPERATOR_TOKEN_VAR, forgotten);
    },
  };
}
