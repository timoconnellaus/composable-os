// The public routes, served by the vendor's fetch under BASE_URL (the CRM proxies
// /gatekeeper/text/* here, bypassing Access: the provider calls them):
//
//   POST {base}/in/<provider>   the provider's webhook: delivery receipts and replies
//
// Only the provider this deployment uses has a route; its signature is checked before anything is
// read. A good delivery is answered 200 once stored (the events DO dedupes a replay); a bad one
// 401 with a fixed reason that quotes nothing from the request.

import { eventsStub } from "./events.js";
import { baseUrl, providerModule } from "./provider.js";

type Env = Cloudflare.Env;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_HEADERS = 100;
const MAX_HEADER_VALUE = 8 * 1024;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

const notFound = () => json(404, { ok: false, error: "not found" });

async function readBounded(request: Request, limit: number): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) return undefined;
  const buffer = new Uint8Array(await request.arrayBuffer());
  return buffer.byteLength > limit ? undefined : buffer;
}

function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of headers) {
    if (++count > MAX_HEADERS) break;
    record[name.toLowerCase()] = value.slice(0, MAX_HEADER_VALUE);
  }
  return record;
}

function relativePath(env: Env, pathname: string): string | undefined {
  const basePath = new URL(baseUrl(env)).pathname.replace(/\/+$/, "");
  if (basePath === "") return pathname;
  if (!pathname.startsWith(`${basePath}/`)) return undefined;
  return pathname.slice(basePath.length);
}

/** Serves every public route. */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const path = relativePath(env, new URL(request.url).pathname);
  if (path === undefined || !path.startsWith("/in/")) return notFound();
  const found = providerModule(env);
  if ("problem" in found || path !== `/in/${found.name}`) return notFound();
  if (request.method !== "POST") {
    return json(405, { ok: false, error: "method not allowed" }, { allow: "POST" });
  }
  const body = await readBounded(request, MAX_BODY_BYTES);
  if (!body) return json(413, { ok: false, error: "too large" });
  const verified = await found.module
    .open(env)
    .verifyWebhook(headerRecord(request.headers), body, Math.floor(Date.now() / 1000));
  if (!verified.ok) return json(401, { ok: false, error: verified.reason });
  const { duplicate } = await eventsStub(env).receive(
    found.name,
    verified.eventId,
    verified.events,
  );
  return json(200, { ok: true, duplicate });
}
