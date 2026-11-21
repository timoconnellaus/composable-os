// The media route (stage 28, ADR 0444): the one way a picture's bytes go in or out of the host.
// Framework-free, as the HTTP surface is; cos-app mounts it (and its client-app binding mounts
// the read half), passing the caller's context it resolved from the request.
//
//   POST /api/media?name=<name>&alt=<alt>   the file as the body: `media.upload` (staff only)
//   GET  /api/media/<id>?w=<width>          the picture: `media.serve` decides, R2 streams
//
// What may be served, to whom, is `media.serve`'s answer, through `invoke()`. This module reads
// R2 only for an item that answer named, and writes it only through `media.upload`.
import { ValidationError } from "../errors.ts";
import type { Invoker } from "../invoke.ts";
import type { AnyInvocationContext } from "../pipeline.ts";
import { MEDIA_MAX_BYTES, type MediaResizer, type MediaStore } from "../records/media.ts";
import { errorReply } from "./envelope.ts";

export const MEDIA_ROUTE = "/api/media";

/** Whether `pathname` is the media route's. */
export function isMediaPath(pathname: string): boolean {
  return pathname === MEDIA_ROUTE || pathname.startsWith(`${MEDIA_ROUTE}/`);
}

/** How long the public's copy of a picture may be kept: unpublished, it stops within this. */
export const MEDIA_PUBLIC_SECONDS = 300;

export interface MediaRouteOptions {
  invoker: Pick<Invoker, "invokeByName">;
  /** The caller, from the request's verified session (staff, a customer or the public). */
  context(request: Request): Promise<AnyInvocationContext>;
  media: MediaStore | undefined;
  /** Cloudflare Images, when the deployment binds it; without it the original is served. */
  resizer?: MediaResizer | undefined;
  /** False on the client-app binding: a bound Worker never uploads. */
  uploads: boolean;
}

const ID = /^med_[A-Za-z0-9]{1,60}$/;

function reply(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function failure(error: unknown): Response {
  const r = errorReply(error, true);
  return reply(r.status, r.body);
}

/** Serves one request to the media route. */
export async function handleMedia(request: Request, options: MediaRouteOptions): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === MEDIA_ROUTE) {
      if (request.method !== "POST" || !options.uploads) {
        return reply(404, JSON.stringify({ error: { code: "not_found", message: "Not found" } }));
      }
      return await upload(request, url, options);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new ValidationError("Use GET", { httpStatus: 405 });
    }
    return await serve(request, url, options);
  } catch (error) {
    return failure(error);
  }
}

async function upload(request: Request, url: URL, options: MediaRouteOptions): Promise<Response> {
  // A browser may send it only from the host's own pages: the session cookie is the staff's.
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    throw new ValidationError("Upload from the admin", { httpStatus: 403 });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MEDIA_MAX_BYTES) {
    throw new ValidationError(`A picture is at most ${MEDIA_MAX_BYTES} bytes`, {
      reason: "too_large",
      httpStatus: 413,
    });
  }
  const bytes = await readCapped(request, MEDIA_MAX_BYTES);
  const ctx = await options.context(request);
  const input = {
    name: url.searchParams.get("name") ?? "picture",
    ...(url.searchParams.get("alt") ? { alt: url.searchParams.get("alt") } : {}),
  };
  const result = await options.invoker.invokeByName("media.upload", input, {
    ...ctx,
    ...(options.media ? { media: options.media } : {}),
    upload: { bytes },
  } as AnyInvocationContext);
  return reply(200, JSON.stringify({ data: result }));
}

/** The body, refused once it passes `max` bytes, whatever the header said. */
async function readCapped(request: Request, max: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new ValidationError(`A picture is at most ${max} bytes`, {
        reason: "too_large",
        httpStatus: 413,
      });
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

async function serve(request: Request, url: URL, options: MediaRouteOptions): Promise<Response> {
  const id = url.pathname.slice(MEDIA_ROUTE.length + 1);
  const notFound = () =>
    reply(
      404,
      JSON.stringify({
        error: { code: "not_found", message: "Not found", details: { object: "media" } },
      }),
    );
  if (!ID.test(id)) return notFound();
  const w = url.searchParams.get("w");
  const width = w && /^[0-9]{1,5}$/.test(w) ? Number(w) : undefined;
  const ctx = await options.context(request);
  const answer = (await options.invoker.invokeByName(
    "media.serve",
    { id, ...(width ? { width } : {}) },
    ctx,
  )) as { key: string; type: string; width: number | null; public: boolean };
  const object = await options.media?.get(answer.key);
  if (!object) return notFound();
  let body = object.body;
  let type = answer.type;
  if (answer.width && options.resizer) {
    const resized = await options.resizer.resize(body, { width: answer.width, type });
    body = resized.body;
    type = resized.type;
  }
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": type,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      // The public's copy may be kept a little; a staff member's is theirs only.
      "cache-control": answer.public
        ? `public, max-age=${MEDIA_PUBLIC_SECONDS}`
        : "private, no-store",
    },
  });
}
