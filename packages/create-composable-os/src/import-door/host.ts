// The host as an import reaches it (ADR 0470, shared by every `cos ... import`, ADR 0495): its
// HTTP surface and its staff-token routes, with the bearer token of the person's device session on
// every call. No Node here: the CLI and the tests against a real host use it alike.

/** How an import reaches the host: the person's session. */
export interface ImportHost {
  /** Calls an operation; a refusal throws with the host's `code`, `message` and `details`. */
  call<T>(name: string, input: unknown): Promise<T>;
  /** Uploads one picture or file over the token upload route (`POST /api/v1/media`). */
  upload(bytes: Uint8Array, name: string): Promise<{ id: string; existing: boolean }>;
  /** A video's WebVTT caption track over the token route (`POST /api/v1/media/<id>/captions`). */
  uploadCaption?(id: string, language: string, label: string, vtt: Uint8Array): Promise<void>;
  /**
   * Sends to an address outside the host (a one-time Stream upload address), with no session:
   * the address is the only credential it needs.
   */
  send?(url: string, init: RequestInit): Promise<Response>;
}

/** The body as JSON; an error page that is not JSON (a gateway's) reads as `{}`. */
async function readBody(response: Response): Promise<unknown> {
  return response.json().catch((error: unknown) => {
    if (response.ok) throw error;
    return {};
  });
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  return body.error?.message ?? `HTTP ${response.status}`;
}

/** The host through a person's device session: every call carries its bearer token. */
export function sessionHost(
  base: string,
  headers: () => Promise<Record<string, string>>,
  fetcher: typeof fetch = fetch,
  outside: typeof fetch = fetcher,
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
      const body = (await readBody(response)) as {
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
      const body = (await readBody(response)) as {
        data?: { id: string; existing: boolean };
        error?: { message: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(`${name}: ${body.error?.message ?? `HTTP ${response.status}`}`);
      }
      return body.data;
    },
    async uploadCaption(id, language, label, vtt) {
      const query = new URLSearchParams({ language, label });
      const response = await fetcher(
        `${base}/api/v1/media/${encodeURIComponent(id)}/captions?${query}`,
        {
          method: "POST",
          headers: { "content-type": "text/vtt", ...(await headers()) },
          body: new Uint8Array(vtt),
        },
      );
      if (!response.ok) throw new Error(`captions (${language}): ${await readError(response)}`);
    },
    send: (url, init) => outside(url, init),
  };
}
