// This web app's Worker: the sign-in routes, the browser's operation route, the media route and
// the signed agreements' PDFs (src/host.ts) first, then TanStack Start for pages.
import { env } from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";
import {
  agreementPdfRoute,
  authRoute,
  type HostEnv,
  mediaRoute,
  operationRoute,
  withSessionKept,
} from "./host.ts";

/**
 * The operations code running in the browser (a block, an island) may call through
 * /api/v1/op/<name>. Name each one a page needs; pages rendered on the server call the host
 * directly (customerApi) and need no entry here. The agreements ones are the agreement pages'
 * (routes/before-you-go-on.tsx, routes/agreements.tsx) and the agreement blocks' (cos add
 * web-agree): a visitor reads what they are asked with agreement.guestVersions.
 */
const BROWSER_OPERATIONS = [
  "me.get",
  "me.agreements.due",
  "me.agreements.list",
  "me.agreements.get",
  "me.agreements.accept",
  "agreement.guestVersions",
] as const;

export default {
  async fetch(request: Request): Promise<Response> {
    const host = env as unknown as HostEnv;
    const auth = await authRoute(request, host);
    if (auth) return auth;
    const call = await operationRoute(request, host, { allow: BROWSER_OPERATIONS });
    if (call) return call;
    // The pictures published content shows (a post's cover, a rich text picture): /api/media/<id>.
    const picture = await mediaRoute(request, host);
    if (picture) return picture;
    // A customer's own signed agreement: /api/v1/agreements/acceptances/<id>.pdf.
    const pdf = await agreementPdfRoute(request, host);
    if (pdf) return withSessionKept(request, host, pdf);
    return withSessionKept(request, host, await handler.fetch(request));
  },
};
