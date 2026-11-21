// The host as the content import reaches it (ADR 0470): its HTTP surface and its staff-token
// upload route, with the bearer token of the person's device session on every call. No Node here:
// the CLI and the tests against a real host use it alike.
import type { ImportHost } from "./engine.ts";

/** The host through a person's device session: every call carries its bearer token. */
export function sessionHost(
  base: string,
  headers: () => Promise<Record<string, string>>,
  fetcher: typeof fetch = fetch,
): ImportHost {
  return {
    async call<T>(name: string, input: unknown): Promise<T> {
      const response = await fetcher(`${base}/api/v1/op/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          ...(await headers()),
        },
        body: JSON.stringify(input),
      });
      const body = (await response.json()) as {
        data?: T;
        error?: { code: string; message: string; details?: unknown };
      };
      if (!response.ok || body.error) {
        throw Object.assign(new Error(body.error?.message ?? `${name}: HTTP ${response.status}`), {
          code: body.error?.code,
          details: body.error?.details,
        });
      }
      return body.data as T;
    },
    async upload(bytes, name) {
      const response = await fetcher(`${base}/api/v1/media?${new URLSearchParams({ name })}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...(await headers()) },
        body: new Uint8Array(bytes),
      });
      const body = (await response.json()) as {
        data?: { id: string; existing: boolean };
        error?: { message: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(`pictures/${name}: ${body.error?.message ?? `HTTP ${response.status}`}`);
      }
      return body.data;
    },
  };
}
