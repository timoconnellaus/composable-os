// The signed PDF's download routes (stage 44 step 4, ADR 0645). What may be downloaded, by whom,
// is the operations' answer through `invoke()` (the visibility seam, audiences, actors, the audit);
// this module only draws what they return with the email gatekeeper's PDF writer, the same module
// the copy's attachment is made with, so the two files are the same bytes for the same values.
// Nothing is stored.
//
//   GET /api/agreements/acceptances/<aga_…>.pdf       staff (behind Access): agreement.acceptance.pdf
//   GET /api/v1/agreements/acceptances/<aga_…>.pdf    the same beside the HTTP surface: a customer
//                                                     (me.agreements.pdf) or staff, by the session
//   GET /api/agreements/versions/<agv_…>.pdf          staff: agreement.version.pdf (a blank form)
//   GET /api/v1/agreements/versions/<agv_…>.pdf
//
// The public gets the answer any unknown acceptance gets: not found.

import {
  type AnyInvocationContext,
  apiOriginCheck,
  coreInvoker,
  errorReply,
  ForbiddenError,
  OperationError,
} from "@composable-os/core";
import { type AgreementPdf, agreementPdf } from "@composable-os/pdf";

const ACCEPTANCE = /^\/api(?:\/v1)?\/agreements\/acceptances\/(aga_[A-Za-z0-9_-]{1,60})\.pdf$/;
const VERSION = /^\/api(?:\/v1)?\/agreements\/versions\/(agv_[A-Za-z0-9_-]{1,60})\.pdf$/;

/** Whether `pathname` is one of the download routes' (either prefix). */
export function isAgreementPdfPath(pathname: string): boolean {
  return /^\/api(?:\/v1)?\/agreements\//.test(pathname);
}

function failure(error: unknown): Response {
  const reply = errorReply(error, true);
  return new Response(reply.body, {
    status: reply.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const notFound = () => failure(new OperationError("not_found", "Not found"));

interface PdfOptions {
  context(request: Request): Promise<AnyInvocationContext>;
  /**
   * The host's public address only (entry.ts): the origins `API_ALLOWED_ORIGINS` lets call the
   * surface, by the surface's own rule (`apiOriginCheck`), so a page on one of them (a client's
   * browser-only screens, stage 75) can download with its bearer token. Left out (the client-app
   * binding), no Origin is looked at, as before.
   */
  allowedOrigins?: readonly string[];
}

/** Serves one request to the download routes. */
export async function handleAgreementPdf(request: Request, options: PdfOptions): Promise<Response> {
  if (!options.allowedOrigins) return serve(request, options);
  const origin = apiOriginCheck(request, options.allowedOrigins, "content-disposition");
  if (!origin.ok) return failure(new ForbiddenError("This origin may not call the API"));
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...origin.cors,
        "access-control-allow-methods": "GET",
        "access-control-allow-headers": "authorization",
        "access-control-max-age": "600",
      },
    });
  }
  const response = await serve(request, options);
  for (const [name, value] of Object.entries(origin.cors)) response.headers.set(name, value);
  return response;
}

async function serve(request: Request, options: PdfOptions): Promise<Response> {
  const { pathname } = new URL(request.url);
  const acceptance = ACCEPTANCE.exec(pathname)?.[1];
  const version = VERSION.exec(pathname)?.[1];
  if (!acceptance && !version) return notFound();
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: { code: "invalid_input", message: "Use GET" } }), {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8", allow: "GET" },
    });
  }
  try {
    const ctx = await options.context(request);
    const staff = ctx.principal === undefined;
    let name: string;
    let input: Record<string, string>;
    if (version) {
      // A blank form is staff's; anyone else is told nothing exists.
      if (!staff) return notFound();
      name = "agreement.version.pdf";
      input = { versionId: version };
    } else if (staff) {
      name = "agreement.acceptance.pdf";
      input = { acceptanceId: acceptance as string };
    } else if (ctx.principal?.kind === "customer") {
      name = "me.agreements.pdf";
      input = { acceptanceId: acceptance as string };
    } else {
      return notFound();
    }
    const result = (await coreInvoker.invokeByName(name, input, ctx)) as {
      filename: string;
      document: AgreementPdf;
    };
    const bytes = agreementPdf(result.document);
    const filename = result.filename.replace(/[^A-Za-z0-9._-]/g, "-");
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-length": String(bytes.byteLength),
        // Personal data: never kept by a cache, and never read as anything but a PDF.
        "cache-control": "no-store, private",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
