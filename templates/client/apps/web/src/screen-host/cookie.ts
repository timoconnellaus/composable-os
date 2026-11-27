// The server build's ScreenHost (stage 75 step 2): the screens as they were before it. Calls go to
// this site's own routes (src/server.ts, src/host.ts), which reach the host over HOST with the
// customer's cookie: the operation route (/api/v1/op/), sign-in (/auth/*) and the agreement PDFs.
// Who is signed in is a server function (src/me.ts), so a loader can ask on the server. Never in
// the browser build: it imports a server function, which that build refuses.
import { agreementPdfPath } from "@composable-os/client";
import { browserApi } from "../agreements.ts";
import type { CustomerClient } from "../client/customer.ts";
import { getMe } from "../me.ts";
import { type ScreenHost, saveResponse } from "./index.ts";

async function post(path: string, body: unknown): Promise<boolean> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.ok;
}

export function cookieScreenHost(): ScreenHost {
  // Made at the first call, in the browser: it names this page's own origin.
  let api: CustomerClient | null = null;
  return {
    build: "server",
    get api() {
      api ??= browserApi();
      return api;
    },
    me: () => getMe(),
    requestCode: (email) => post("/auth/code", { email }),
    signIn: (email, code) => post("/auth/sign-in", { email, code }),
    signOut: async () => {
      await post("/auth/sign-out", {});
    },
    // The cookie is the host's to end; nothing is kept in the page.
    forget: async () => {},
    downloadAgreementPdf: async (id) =>
      saveResponse(await fetch(agreementPdfPath(id)), `agreement-${id}.pdf`),
  };
}
