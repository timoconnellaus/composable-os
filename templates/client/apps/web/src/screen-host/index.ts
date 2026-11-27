// The screens' one way to the host (stage 75 step 2, ADR 0960): everything a screen does that is
// not drawing goes through a ScreenHost, and each build gives the screens its own.
//
//   the server build  (vite build, TanStack Start on the web app's Worker): `cookieScreenHost`
//                     in ./cookie.ts. Calls go to this site's operation route and /auth/* routes,
//                     which pass them to the host over HOST with the customer's cookie.
//   the browser build (pnpm build:browser, static files only): `tokenScreenHost` in ./tokens.ts.
//                     Calls go to the host's /api/v1 with the typed client and a device session's
//                     bearer token; no cookie is sent or read.
//
// The screens (src/routes/) are the same for both: they take the ScreenHost from the router's
// context (`useScreenHost()`, or `context.screenHost` in a loader) and never name a build. A
// desktop wrapper that holds the tokens itself gives the screens its own ScreenHost.
import { useRouteContext } from "@tanstack/react-router";
import type { CustomerClient, Output } from "../client/customer.ts";

/** Who is signed in, as a page needs it before it loads anything else. */
export type SignedInCustomer = Pick<Output<"me.get">, "displayName" | "primaryEmail">;

export interface ScreenHost {
  /** Which build this is: "server" (cookie, binding) or "browser" (tokens, /api/v1). */
  readonly build: "server" | "browser";
  /** The customer's typed client. Only in the browser: read it in an effect or a handler. */
  readonly api: CustomerClient;
  /** The signed-in customer, or null for the public. Safe in a loader in either build. */
  me(): Promise<SignedInCustomer | null>;
  /** Asks the host to email a sign-in code. False when it would not send one. */
  requestCode(email: string): Promise<boolean>;
  /** Signs in with the emailed code. False for a wrong, used or expired code, or a refusal. */
  signIn(email: string, code: string): Promise<boolean>;
  /** Ends this browser's session on the host and forgets it here. */
  signOut(): Promise<void>;
  /** Forgets this browser's session without asking the host (after the account is deleted). */
  forget(): Promise<void>;
  /** Saves a signed agreement's PDF (stage 44): the host's file, for whoever may have it. */
  downloadAgreementPdf(acceptanceId: string): Promise<void>;
}

/** What the router carries to every route: the same shape in both builds. */
export interface RouterContext {
  screenHost: ScreenHost;
}

/** The ScreenHost of the router this screen is in. */
export function useScreenHost(): ScreenHost {
  return useRouteContext({ from: "__root__", select: (context) => context.screenHost });
}

/** The response a download route answered, saved under its own name (Content-Disposition). */
export async function saveResponse(
  response: Response,
  fallbackName: string,
  page?: Document,
): Promise<void> {
  if (!response.ok) throw new Error(`The host answered ${response.status}`);
  const doc = page ?? document;
  const disposition = response.headers.get("content-disposition") ?? "";
  const name = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await response.blob());
  try {
    const link = doc.createElement("a");
    link.href = url;
    link.download = name;
    doc.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Long enough for the browser to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
