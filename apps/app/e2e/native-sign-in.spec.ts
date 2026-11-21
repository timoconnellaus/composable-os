// The native staff sign-in in a real browser (ADR 0457, as amended): a command-line tool or an
// app opens /native/staff-sign-in in the system browser; the signed-in person presses Continue on
// the confirm page; the browser is sent to the tool's loopback listener (or the app's scheme) with
// a one-time code, which the tool exchanges, with its verifier, for a device session.
//
// The POST is the browser's own: its Origin and Sec-Fetch-Site are whatever Chromium sends for
// the page's referrer policy. Beta.6 answered it 403 (Origin: null under `no-referrer`).
import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { startBrowserSignIn } from "../../../packages/client/src/index.ts";

const sha256 = async (text: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const randomKey = () =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** A loopback listener on a port of its own, as `cos content import` opens one. */
async function loopback() {
  let received: (url: string) => void = () => {};
  const callback = new Promise<string>((resolve) => {
    received = resolve;
  });
  const server = createServer((request, response) => {
    received(`http://127.0.0.1:${port}${request.url}`);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("Signed in. You can close this window.");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    redirectUri: `http://127.0.0.1:${port}/cos-sign-in`,
    callback,
    close: () => server.close(),
  };
}

test("the browser's Continue hands a loopback tool a code that signs it in", async ({
  page,
  baseURL,
}) => {
  const back = await loopback();
  try {
    const start = await startBrowserSignIn({
      hostUrl: baseURL as string,
      redirectUri: back.redirectUri,
      randomKey,
      sha256,
    });
    await page.goto(start.url);
    await expect(page.getByRole("heading", { name: /^Sign in to / })).toBeVisible();
    await expect(page.getByText("a command-line tool on this computer")).toBeVisible();
    // The form POST as Chromium makes it; the host must accept it and redirect to the listener.
    const posted = page.waitForRequest(
      (r) => r.method() === "POST" && r.url().endsWith("/native/staff-sign-in"),
    );
    await page.getByRole("button", { name: "Continue" }).click();
    const request = await posted;
    // What the browser really sent, recorded for whoever reads a failure here.
    test.info().annotations.push({
      type: "sent",
      description: JSON.stringify({
        origin: (await request.allHeaders()).origin ?? null,
        "sec-fetch-site": (await request.allHeaders())["sec-fetch-site"] ?? null,
      }),
    });
    const callbackUrl = await back.callback;
    const answered = new URL(callbackUrl);
    expect(answered.searchParams.get("state")).toBe(start.state);
    const code = answered.searchParams.get("code") ?? "";
    expect(code).toMatch(/^cos_hc_/);
    await expect(page.getByText("Signed in. You can close this window.")).toBeVisible();

    // The tool exchanges it, with its verifier, and calls as the person.
    const exchanged = await page.request.post("/api/v1/auth/staff/exchange", {
      data: {
        code,
        codeVerifier: start.verifier,
        redirectUri: back.redirectUri,
        deviceName: "e2e loopback",
      },
      headers: { cookie: "" },
    });
    expect(exchanged.status(), await exchanged.text()).toBe(200);
    const tokens = (await exchanged.json()).data as { accessToken: string; refreshToken: string };
    const call = await page.request.post("/api/v1/op/user.emailStatus", {
      data: {},
      headers: { authorization: `Bearer ${tokens.accessToken}`, cookie: "" },
    });
    expect(call.status(), await call.text()).toBe(200);
    await page.request.post("/api/v1/auth/sign-out", {
      data: { refreshToken: tokens.refreshToken },
      headers: { cookie: "" },
    });
  } finally {
    back.close();
  }
});

test("the browser's Continue sends an app's custom scheme its code", async ({ page, baseURL }) => {
  const redirectUri = "cosdev://staff-sign-in";
  const start = await startBrowserSignIn({
    hostUrl: baseURL as string,
    redirectUri,
    randomKey,
    sha256,
  });
  await page.goto(start.url);
  await expect(page.getByText("the app that opens cosdev:// links")).toBeVisible();
  // Chromium cannot open the scheme; the 303 it is sent to is what the app would receive.
  const answer = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/native/staff-sign-in"),
  );
  await page.getByRole("button", { name: "Continue" }).click();
  const response = await answer;
  expect(response.status()).toBe(303);
  const location = new URL(response.headers().location ?? "");
  expect(`${location.protocol}//${location.host}${location.pathname}`).toBe(redirectUri);
  expect(location.searchParams.get("state")).toBe(start.state);
  const exchanged = await page.request.post("/api/v1/auth/staff/exchange", {
    data: {
      code: location.searchParams.get("code"),
      codeVerifier: start.verifier,
      redirectUri,
      deviceName: "e2e app",
    },
    headers: { cookie: "" },
  });
  expect(exchanged.status(), await exchanged.text()).toBe(200);
});
