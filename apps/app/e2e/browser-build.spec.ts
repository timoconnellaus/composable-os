// Stage 75 step 2 (ADR 0960): the client template's screens as a browser-only build, served as
// static files by a plain file server on an address of their own, against the dev host. A
// customer signs in with an emailed code (tokens, no cookie), sees their account (where they are
// signed in is listed), changes their name (a write through /api/v1), reloads on a hash route and
// is still signed in, then signs out.
//
// The build is made here (`vite build -c vite.browser.config.ts`, COS_HOST_URL the dev host) and
// served from http://localhost:E2E_STATIC_PORT (5183), which the e2e dev server lets in through
// API_ALLOWED_ORIGINS (vite.config.ts), as a client's web address is let in.
//
// It changes the customer settings (open sign-up, the host's sign-in mail on a fake outbox) and
// puts them back.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { type APIRequestContext, expect, type Page, type Request, test } from "@playwright/test";
import { open, unique } from "./helpers.ts";
import {
  addFakeResource,
  connectFake,
  connectionId,
  fakeAddress,
  openIntegrations,
  sentMail,
} from "./integration-helpers.ts";

const STATIC_PORT = Number(process.env.E2E_STATIC_PORT ?? 5183);
const STATIC = `http://localhost:${STATIC_PORT}`;
const HOST = `http://localhost:${Number(process.env.E2E_PORT ?? 5179)}`;
const TEMPLATE_WEB = resolve(import.meta.dirname, "../../../templates/client/apps/web");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

/** A plain static file server: the files, as they are, and nothing else. */
function serve(root: string): Promise<Server> {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", STATIC).pathname;
    const file = normalize(join(root, path === "/" ? "index.html" : decodeURIComponent(path)));
    if (!file.startsWith(root)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      response
        .writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" })
        .end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((done) => server.listen(STATIC_PORT, "localhost", () => done(server)));
}

async function op<T>(request: APIRequestContext, name: string, input: unknown): Promise<T> {
  const response = await request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as { data?: T };
  expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return body.data as T;
}

let server: Server | null = null;
let before: { signup: string; emailConnectionId: string | null } | null = null;
let outbox = "";

test.beforeAll(() => {
  // The browser-only build, for this host.
  const out = mkdtempSync(join(tmpdir(), "cos-e2e-browser-"));
  execFileSync("pnpm", ["exec", "vite", "build", "-c", "vite.browser.config.ts", "--outDir", out], {
    cwd: TEMPLATE_WEB,
    env: { ...process.env, COS_HOST_URL: HOST },
    stdio: "pipe",
  });
  return serve(out).then((started) => {
    server = started;
  });
});

test.afterAll(() => {
  server?.close();
});

/** Open sign-up and the host's sign-in mail on a fake outbox, as my-account.spec.ts sets them. */
async function setUp(page: Page) {
  before = await op(page.request, "customer.settings.get", {});
  outbox = fakeAddress("browserbuild");
  await openIntegrations(page);
  const connection = await connectFake(page, outbox, "org");
  await addFakeResource(page, connection, "Outbox", outbox);
  await op(page.request, "customer.settings.update", {
    signup: "open",
    emailConnectionId: await connectionId(connection),
  });
  await open(page, "/settings/users");
  const signInMail = page.getByTestId("sign-in-mail");
  if ((await signInMail.getAttribute("data-ready")) !== "true") {
    await signInMail.getByRole("switch").click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Send without review" })
      .click();
  }
  await expect(signInMail).toHaveAttribute("data-ready", "true");
}

async function codeFor(page: Page, email: string): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const mail = (await sentMail(page.request, outbox)).filter((m) => m.to.includes(email));
        code = /\b(\d{6})\b/.exec(mail.at(-1)?.text ?? "")?.[1];
        return code;
      },
      { timeout: 30_000 },
    )
    .toMatch(/^\d{6}$/);
  return code ?? "";
}

test("a customer signs in and changes their details on the browser-only build", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await setUp(page);
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const email = `${unique("static")}@members.test`.toLowerCase();
    await op(page.request, "person.create", { givenName: unique("Static"), emails: [{ email }] });

    const screen = await context.newPage();
    // Every call the screens make to the host: none may carry a cookie.
    const calls: Request[] = [];
    screen.on("request", (request) => {
      if (request.url().startsWith(HOST)) calls.push(request);
    });

    await screen.goto(`${STATIC}/#/sign-in`);
    await screen.getByLabel("Email").fill(email);
    await screen.getByRole("button", { name: "Email me a code" }).click();
    await screen.getByLabel("The code we emailed you").fill(await codeFor(page, email));
    await screen.getByRole("button", { name: "Sign in" }).click();

    // "Before you go on" goes straight on when nothing is due; another spec's document may be.
    const account = screen.getByRole("heading", { name: "My account", exact: true });
    const notNow = screen.getByRole("link", { name: "Not now" });
    await expect(account.or(notNow)).toBeVisible();
    if (await notNow.isVisible()) await notNow.click();
    await expect(account).toBeVisible();
    expect(new URL(screen.url()).hash).toBe("#/account");

    // A list from the host: where they are signed in, this browser's device session first.
    const devices = screen.getByRole("region", { name: "Sign-in and devices" });
    await expect(devices.getByText("This device (Web browser)", { exact: false })).toBeVisible();

    // One write through /api/v1: their name.
    const name = unique("Ada Static");
    const details = screen.getByRole("region", { name: "Your details" });
    await details.getByLabel("Name", { exact: true }).fill(name);
    await details.getByRole("button", { name: "Save" }).click();
    await expect(details.getByRole("status")).toHaveText("Saved.");
    await expect(screen.getByText(name, { exact: true })).toBeVisible();

    // A reload on a hash route asks the static server for index.html only, and is still signed in.
    await screen.reload();
    await expect(account).toBeVisible();
    await expect(screen.getByText(name, { exact: true })).toBeVisible();

    // The calls went to the host's /api/v1, with no cookie, and the host set none.
    expect(calls.length).toBeGreaterThan(3);
    for (const call of calls) {
      expect(call.url()).toMatch(new RegExp(`^${HOST}/api/v1/`));
      expect((await call.allHeaders()).cookie).toBeUndefined();
    }
    expect(await context.cookies()).toEqual([]);

    // Signing out ends the device session and forgets it here.
    await devices.getByRole("button", { name: "Sign out" }).click();
    await expect(screen.getByRole("heading", { name: "Welcome" })).toBeVisible();
    await screen.goto(`${STATIC}/#/account`);
    await expect(screen.getByRole("heading", { name: "Sign in" })).toBeVisible();
  } finally {
    await context.close();
    if (before) {
      await op(page.request, "customer.settings.update", {
        signup: before.signup,
        ...(before.emailConnectionId ? { emailConnectionId: before.emailConnectionId } : {}),
      });
      before = null;
    }
  }
});
