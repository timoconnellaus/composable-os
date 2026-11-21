// The media route (stage 28, ADR 0444): the one way a picture's bytes go in or out of the host.
// Framework-free, as the HTTP surface is; cos-app mounts it (and its client-app binding mounts
// the read half), passing the caller's context it resolved from the request.
//
//   POST /api/media?name=<name>&alt=<alt>   the file as the body: `media.upload` (staff only)
//   GET  /api/media/<id>?w=<width>          the picture: `media.serve` decides, R2 streams
//   GET  /api/v1/media/<id>?w=<width>       the same, beside the HTTP surface: the address a phone
//                                           (or anyone outside) asks the host's own hostname for,
//                                           bypassed by Cloudflare Access with the rest of /api/v1
//                                           (issue #181). The admin's pictures stay on /api/media.
//   POST /api/v1/media?name=&alt=           an upload by a staff device token only, for a script a
//                                           person signed in to (`cos content import`, ADR 0470):
//                                           beside the surface, so it works behind Access, and
//                                           never with a cookie, so no browser page can reach it.
//   POST /api/media/<id>/captions?language=&label=
//                                           a video's WebVTT caption track: `media.captionUpload`
//                                           (staff only; stage 42, ADR 0475)
//   POST /api/v1/media/<id>/captions?language=&label=
//                                           the same with a staff device token only, for an import
//                                           a person signed in to (cos courses import, ADR 0485)
//   *    /api/v1/media/fake-stream/*        the fake Stream's upload and playback addresses, only
//                                           where the fake is configured (development and tests)
//
// A picture and a file (a PDF) go up here; a video never does: the browser sends it straight to
// the address Stream gave `media.videoUpload`.
//
// What may be served, to whom, is `media.serve`'s answer, through `invoke()`. This module reads
// R2 only for an item that answer named, and writes it only through `media.upload`.

import { MEDIA_CAPTION_MAX_BYTES, MEDIA_FILE_MAX_BYTES } from "@composable-os/sdk";
import { ForbiddenError, ValidationError } from "../errors.ts";
import type { Invoker } from "../invoke.ts";
import type { AnyInvocationContext } from "../pipeline.ts";
import type { MediaResizer, MediaStore } from "../records/media.ts";
import { videoHost } from "../records/stream.ts";
import { errorReply } from "./envelope.ts";

export const MEDIA_ROUTE = "/api/media";
/** The read half beside the HTTP surface, for callers outside the org on the host's hostname. */
export const PUBLIC_MEDIA_ROUTE = "/api/v1/media";

/** Whether `pathname` is the media route's (either prefix). */
export function isMediaPath(pathname: string): boolean {
  return (
    pathname === MEDIA_ROUTE ||
    pathname.startsWith(`${MEDIA_ROUTE}/`) ||
    pathname === PUBLIC_MEDIA_ROUTE ||
    pathname.startsWith(`${PUBLIC_MEDIA_ROUTE}/`)
  );
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
  /**
   * `POST /api/v1/media` with a staff device token (ADR 0470). Off unless set: the client-app
   * binding never takes one.
   */
  tokenUploads?: boolean;
}

const ID = /^med_[A-Za-z0-9]{1,60}$/;
const CAPTIONS = /^\/api\/media\/(med_[A-Za-z0-9]{1,60})\/captions$/;
/** The same with a staff device token (stage 42's import, ADR 0485), beside the HTTP surface. */
const TOKEN_CAPTIONS = /^\/api\/v1\/media\/(med_[A-Za-z0-9]{1,60})\/captions$/;
const FAKE_STREAM_PREFIX = `${PUBLIC_MEDIA_ROUTE}/fake-stream/`;

/** The fake Stream's control, when this isolate's video host is the fake. */
function fakeStream(): { handle(request: Request): Promise<Response> } | undefined {
  const host = videoHost() as
    | { fake?: { handle(request: Request): Promise<Response> } }
    | undefined;
  return host?.fake;
}

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
    if (url.pathname.startsWith(FAKE_STREAM_PREFIX)) {
      const fake = fakeStream();
      if (!fake)
        return reply(404, JSON.stringify({ error: { code: "not_found", message: "Not found" } }));
      return await fake.handle(request);
    }
    const tokenCaption = TOKEN_CAPTIONS.exec(url.pathname);
    if (tokenCaption?.[1]) {
      if (request.method !== "POST" || !options.tokenUploads) {
        return reply(404, JSON.stringify({ error: { code: "not_found", message: "Not found" } }));
      }
      const ctx = await staffTokenContext(request, options);
      return await captionUpload(request, url, tokenCaption[1], options, ctx);
    }
    const caption = CAPTIONS.exec(url.pathname);
    if (caption?.[1]) {
      if (request.method !== "POST" || !options.uploads) {
        return reply(404, JSON.stringify({ error: { code: "not_found", message: "Not found" } }));
      }
      return await captionUpload(request, url, caption[1], options);
    }
    if (url.pathname === MEDIA_ROUTE) {
      if (request.method !== "POST" || !options.uploads) {
        return reply(404, JSON.stringify({ error: { code: "not_found", message: "Not found" } }));
      }
      return await upload(request, url, options);
    }
    if (url.pathname === PUBLIC_MEDIA_ROUTE) {
      if (request.method !== "POST" || !options.tokenUploads) {
        return reply(404, JSON.stringify({ error: { code: "not_found", message: "Not found" } }));
      }
      return await tokenUpload(request, url, options);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new ValidationError("Use GET", { httpStatus: 405 });
    }
    return await serve(request, url, options);
  } catch (error) {
    return failure(error);
  }
}

/**
 * An upload by a person's staff device session (ADR 0470): the bearer token a native sign-in
 * gave them, and nothing else. A cookie (a browser's) is not taken here, so a page on another
 * site cannot post to it with the staff member's Access or session cookie. The context the host
 * builds from a staff device token is a human's (actor `human`); anything else is refused before
 * the body is read, and `media.upload` itself refuses any actor but a human.
 */
async function tokenUpload(
  request: Request,
  url: URL,
  options: MediaRouteOptions,
): Promise<Response> {
  return upload(request, url, options, await staffTokenContext(request, options));
}

/**
 * A person's staff device session, and nothing else (ADR 0470): a bearer token a native sign-in
 * gave them. A cookie is not taken, so no page on another site can post here; the context the host
 * builds from such a token is a human's, and anything else is refused before the body is read.
 */
async function staffTokenContext(
  request: Request,
  options: MediaRouteOptions,
): Promise<AnyInvocationContext> {
  if (!/^Bearer\s+cos_at_\S+$/i.test(request.headers.get("authorization") ?? "")) {
    throw new ForbiddenError("Upload with a staff device token: sign in with cos first", {
      reason: "token_required",
      httpStatus: 401,
    });
  }
  const ctx = await options.context(request);
  if (!("actor" in ctx) || ctx.actor !== "human") {
    throw new ForbiddenError("Only a person signed in as staff uploads here", {
      reason: "staff_only",
      httpStatus: 403,
    });
  }
  return ctx;
}

async function upload(
  request: Request,
  url: URL,
  options: MediaRouteOptions,
  given?: AnyInvocationContext,
): Promise<Response> {
  // A browser may send it only from the host's own pages: the session cookie is the staff's.
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    throw new ValidationError("Upload from the admin", { httpStatus: 403 });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  // The largest a file may be; media.upload holds each kind to its own limit.
  if (declared > MEDIA_FILE_MAX_BYTES) {
    throw new ValidationError(`A file is at most ${MEDIA_FILE_MAX_BYTES} bytes`, {
      reason: "too_large",
      httpStatus: 413,
    });
  }
  const bytes = await readCapped(request, MEDIA_FILE_MAX_BYTES);
  const ctx = given ?? (await options.context(request));
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

/** A video's caption track, from the admin (stage 42, ADR 0475). */
async function captionUpload(
  request: Request,
  url: URL,
  id: string,
  options: MediaRouteOptions,
  given?: AnyInvocationContext,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    throw new ValidationError("Upload from the admin", { httpStatus: 403 });
  }
  if (Number(request.headers.get("content-length") ?? "0") > MEDIA_CAPTION_MAX_BYTES) {
    throw new ValidationError(`A caption file is at most ${MEDIA_CAPTION_MAX_BYTES} bytes`, {
      reason: "too_large",
      httpStatus: 413,
    });
  }
  const bytes = await readCapped(request, MEDIA_CAPTION_MAX_BYTES);
  const ctx = given ?? (await options.context(request));
  const label = url.searchParams.get("label");
  const result = await options.invoker.invokeByName(
    "media.captionUpload",
    { id, language: url.searchParams.get("language") ?? "", ...(label ? { label } : {}) },
    { ...ctx, upload: { bytes } } as AnyInvocationContext,
  );
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
      throw new ValidationError(`A file here is at most ${max} bytes`, {
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
  const prefix = url.pathname.startsWith(`${PUBLIC_MEDIA_ROUTE}/`)
    ? PUBLIC_MEDIA_ROUTE
    : MEDIA_ROUTE;
  const id = url.pathname.slice(prefix.length + 1);
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
      // A download is saved, never shown in the page (stage 42).
      ...(type === "application/pdf" ? { "content-disposition": "attachment" } : {}),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      // The public's copy may be kept a little; a staff member's is theirs only.
      "cache-control": answer.public
        ? `public, max-age=${MEDIA_PUBLIC_SECONDS}`
        : "private, no-store",
    },
  });
}
