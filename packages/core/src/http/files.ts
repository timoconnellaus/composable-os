// The record file route (stage 56 step 3, ADR 0834): the one way a note's photo or PDF goes in
// or out of the host. Framework-free, as the media route is; cos-app mounts it, passing the
// caller's context it resolved from the request. Staff only in this step: the client-app binding
// does not mount it, and every operation behind it is closed to customers and the public.
//
//   POST /api/files?name=<name>[&note=<act_…>]   the file as the body: `file.checkUpload` first,
//                                                with the size the request says, before the body
//                                                is read; then `file.upload` with the bytes
//   GET  /api/files/<fil_…>                      the file: `file.serve` decides, R2 streams
//   GET  /api/v1/files/<fil_…>                   the same, beside the HTTP surface: the address a
//                                                staff phone asks the host's own hostname for
//
// A file is served only after `file.serve` said so for this caller, on this request: never by a
// URL that works without a session, and never from a cache (`private, no-store`). Whatever the
// reason a file is not served (no such file, a note the caller may not read, a note in the Trash,
// no session, a customer, the public, a cookie from another site), the answer is one and the same
// not-found, so the route tells no one whether a file exists. A file is sent so that it can never
// run as a page on the admin's origin: its type from its bytes, `nosniff`, a sandboxing content
// security policy, pictures inline and PDFs only as downloads, under a name ending in their type.

import { RECORD_FILE_MAX_BYTES } from "@composable-os/sdk";
import { OperationError, ValidationError } from "../errors.ts";
import type { Invoker } from "../invoke.ts";
import type { AnyInvocationContext } from "../pipeline.ts";
import { contentDisposition } from "../records/files.ts";
import type { MediaStore } from "../records/media.ts";
import { errorReply } from "./envelope.ts";
import { readCapped } from "./media.ts";

export const FILES_ROUTE = "/api/files";
/** The read half beside the HTTP surface, for a staff phone on the host's own hostname. */
export const API_FILES_ROUTE = "/api/v1/files";

/** Whether `pathname` is the file route's (either prefix). */
export function isFilesPath(pathname: string): boolean {
  return (
    pathname === FILES_ROUTE ||
    pathname.startsWith(`${FILES_ROUTE}/`) ||
    pathname === API_FILES_ROUTE ||
    pathname.startsWith(`${API_FILES_ROUTE}/`)
  );
}

export interface FilesRouteOptions {
  invoker: Pick<Invoker, "invokeByName">;
  /** The caller, from the request's verified session. */
  context(request: Request): Promise<AnyInvocationContext>;
  /** The deployment's R2 bucket (files are kept under `files/`). */
  store: MediaStore | undefined;
}

const ID = /^fil_[A-Za-z0-9]{1,60}$/;
const NOTE = /^act_[A-Za-z0-9]{1,60}$/;

/** The headers every answer here carries: nothing is kept, nothing is sniffed. */
const BASE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...BASE_HEADERS },
  });
}

/** The one answer for a file that is not served, whatever the reason. */
export function fileNotServed(): Response {
  return json(404, { error: { code: "not_found", message: "Not found" } });
}

/** Serves one request to the file route. */
export async function handleFiles(request: Request, options: FilesRouteOptions): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === FILES_ROUTE) {
    if (request.method !== "POST") return fileNotServed();
    try {
      return await upload(request, url, options);
    } catch (error) {
      const r = errorReply(error, true);
      return new Response(r.body, {
        status: r.status,
        headers: { "content-type": "application/json; charset=utf-8", ...BASE_HEADERS },
      });
    }
  }
  const prefix = url.pathname.startsWith(`${API_FILES_ROUTE}/`) ? API_FILES_ROUTE : FILES_ROUTE;
  const id = url.pathname.slice(prefix.length + 1);
  if ((request.method !== "GET" && request.method !== "HEAD") || !ID.test(id)) {
    return fileNotServed();
  }
  try {
    return await serve(request, id, options);
  } catch (error) {
    // Refused, unknown, signed out, a customer, from another site: the same answer. Only a fault
    // of the host's own (no answer at all) is not a not-found, and it names nothing.
    if (error instanceof OperationError && error.code !== "internal") return fileNotServed();
    return json(500, { error: { code: "internal", message: "Something went wrong" } });
  }
}

async function upload(request: Request, url: URL, options: FilesRouteOptions): Promise<Response> {
  // A browser may send it only from the host's own pages: the session cookie is the staff's.
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    throw new ValidationError("Upload from the admin", { httpStatus: 403 });
  }
  const note = url.searchParams.get("note");
  if (note !== null && !NOTE.test(note)) {
    throw new ValidationError("note is a note's id (act_…)", { field: "note" });
  }
  // Before the body is read: the size the request says, the note, the limits.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared < 0 || declared > RECORD_FILE_MAX_BYTES) {
    throw new ValidationError(`A file is at most ${RECORD_FILE_MAX_BYTES} bytes`, {
      reason: "too_large",
      httpStatus: 413,
    });
  }
  const ctx = await options.context(request);
  await options.invoker.invokeByName(
    "file.checkUpload",
    { ...(note ? { note } : {}), bytes: declared },
    ctx,
  );
  // Then the bytes, never more than the largest a file may be, whatever the header said; the
  // operation holds each type to its own limit and checks everything again.
  const bytes = await readCapped(request, RECORD_FILE_MAX_BYTES);
  const result = await options.invoker.invokeByName(
    "file.upload",
    { name: url.searchParams.get("name") ?? "file", ...(note ? { note } : {}) },
    {
      ...ctx,
      ...(options.store ? { media: options.store } : {}),
      upload: { bytes },
    } as AnyInvocationContext,
  );
  return json(200, { data: result });
}

async function serve(request: Request, id: string, options: FilesRouteOptions): Promise<Response> {
  const ctx = await options.context(request);
  const answer = (await options.invoker.invokeByName("file.serve", { id }, ctx)) as {
    key: string;
    type: string;
    bytes: number;
    filename: string;
  };
  const object = await options.store?.get(answer.key);
  if (!object) return fileNotServed();
  const pdf = answer.type === "application/pdf";
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "content-type": answer.type,
      "content-length": String(object.size),
      // A PDF is saved, never shown in the page; a picture is shown, never run.
      "content-disposition": contentDisposition(pdf ? "attachment" : "inline", answer.filename),
      "content-security-policy": "default-src 'none'; sandbox",
      // No other site may embed it, with the staff member's cookie or without.
      "cross-origin-resource-policy": "same-origin",
    },
  });
}
