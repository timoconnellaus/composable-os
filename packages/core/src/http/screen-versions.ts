// The screen version upload route (stage 75 step 3, ADR 0961): the one way a version's file's bytes
// reach the host. Framework-free, as the media route is; cos-app mounts it beside the HTTP surface.
//
//   PUT /api/v1/screens/versions/<scv_id>/files/<sha256>   the file as the body:
//                                                          `screens.versionPut`
//
// Only with a person's staff device token (a `cos` sign-in, ADR 0470), never a cookie, so no
// page on another site can post here; the client-app binding never mounts it. The body is read
// up to a version's largest file and handed to the operation as `ctx.upload`, which hashes it and
// refuses it unless it is the hash in the path. Beginning and sealing a version are ordinary
// operations on the surface (`screens.versionBegin`, `screens.versionSeal`).
import { SCREEN_VERSION_LIMITS } from "@composable-os/sdk";
import { ValidationError } from "../errors.ts";
import type { Invoker } from "../invoke.ts";
import type { AnyInvocationContext } from "../pipeline.ts";
import type { MediaStore } from "../records/media.ts";
import { errorReply } from "./envelope.ts";
import { readCapped, staffTokenContext } from "./media.ts";

export const SCREEN_VERSIONS_ROUTE = "/api/v1/screens/versions";

const FILE_PATH = /^\/api\/v1\/screens\/versions\/(scv_[0-9A-HJKMNP-TV-Z]{26})\/files\/([0-9a-f]{64})$/;

/** Whether `pathname` is the route's. */
export function isScreenVersionsPath(pathname: string): boolean {
  return pathname === SCREEN_VERSIONS_ROUTE || pathname.startsWith(`${SCREEN_VERSIONS_ROUTE}/`);
}

export interface ScreenVersionsRouteOptions {
  invoker: Pick<Invoker, "invokeByName">;
  /** The caller, from the request's verified credentials. */
  context(request: Request): Promise<AnyInvocationContext>;
  /** The client's part of the files binding. */
  media: MediaStore | undefined;
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Serves one request to the route. */
export async function handleScreenVersions(
  request: Request,
  options: ScreenVersionsRouteOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const file = FILE_PATH.exec(url.pathname);
  if (!file?.[1] || !file[2] || request.method !== "PUT") {
    return reply(404, { error: { code: "not_found", message: "Not found" } });
  }
  try {
    const ctx = await staffTokenContext(request, options);
    const max = SCREEN_VERSION_LIMITS.maxFileBytes;
    if (Number(request.headers.get("content-length") ?? "0") > max) {
      throw new ValidationError(`A file is at most ${max} bytes`, {
        reason: "too_large",
        httpStatus: 413,
      });
    }
    const bytes = await readCapped(request, max);
    const result = await options.invoker.invokeByName(
      "screens.versionPut",
      { version: file[1], sha256: file[2] },
      {
        ...ctx,
        ...(options.media ? { media: options.media } : {}),
        upload: { bytes },
      } as AnyInvocationContext,
    );
    return reply(200, { data: result });
  } catch (error) {
    const r = errorReply(error, true);
    return new Response(r.body, {
      status: r.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
}
