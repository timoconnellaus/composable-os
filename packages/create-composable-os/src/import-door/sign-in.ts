// Who an import runs as (ADR 0470, shared by every `cos ... import`, ADR 0495): a person, signed in for this run only. With --email the host emails a staff code (its own
// sign-in); without it the system browser opens the host's staff sign-in (Cloudflare Access,
// Google), which hands a one-time code back to a port on 127.0.0.1 this command listens on (ADR
// 0455; the host lists `http://127.0.0.1/cos-sign-in` in NATIVE_REDIRECT_URIS). Either way the
// host answers with a staff device session, held in this process's memory and nowhere else, and
// ended on the host when the run finishes. No token is read from the environment or a file, and
// none is printed.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { startBrowserSignIn, type Tokens, tokenSession } from "@composable-os/client";
import type { Io } from "../io.ts";
import { type ImportHost, sessionHost } from "./host.ts";

/** The loopback address the browser sign-in comes back to (any port), as the host lists it. */
export const LOOPBACK_PATH = "/cos-sign-in";

export type RunSession = ReturnType<typeof tokenSession>;

function memoryStore() {
  let saved: Tokens | null = null;
  return {
    load: async () => saved,
    save: async (tokens: Tokens | null) => {
      saved = tokens;
    },
  };
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Opens `url` in the system browser, where the platform has a way; else says to. */
function openBrowser(url: string, io: Io) {
  io.out(`Sign in in your browser: ${url}`);
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(command, [url], () => {});
}

/** Waits for the browser to come back to 127.0.0.1 with the one-time code; its full address. */
async function loopback(): Promise<{
  redirectUri: string;
  callback: Promise<string>;
  close(): void;
}> {
  let settle!: (url: string) => void;
  const callback = new Promise<string>((resolve_) => {
    settle = resolve_;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== LOOPBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end("Signed in. You can close this tab and go back to the terminal.");
    settle(`http://127.0.0.1${req.url}`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://127.0.0.1:${port}${LOOPBACK_PATH}`,
    callback,
    close: () => server.close(),
  };
}

/**
 * Signs a person in to `host` for this run, by an emailed code (`email`) or the browser. Throws
 * when it cannot; the caller says so. `label` names the device (`cos courses import`).
 */
export async function signInForRun(
  host: string,
  email: string | undefined,
  io: Io,
  label: string,
): Promise<RunSession> {
  const session = tokenSession({ baseUrl: host, store: memoryStore() });
  const deviceName = `${label} on ${hostname()}`.slice(0, 100);
  if (email) {
    await session.requestCode(email, "staff");
    // The host answers the same whoever the address is, so it cannot say why no code came:
    // these are what to check, on the host, by someone signed in (ADR 0457).
    io.out(
      `If ${email} may sign in by code, a code is on its way. If none arrives in a minute or two, check on the host: ` +
        "the address is one an admin invited, or one you confirmed (your account menu, Confirm your email), " +
        "and Settings → Users shows sign-in codes going out (Send sign-in codes without review). " +
        "Or run without --email to sign in with the browser.",
    );
    const code = await io.ask(`The sign-in code sent to ${email}`, { secret: true });
    await session.signInWithCode(email, code.trim(), deviceName, "staff");
    return session;
  }
  const back = await loopback();
  try {
    const random = () => hex(crypto.getRandomValues(new Uint8Array(16)));
    const started = await startBrowserSignIn({
      hostUrl: host,
      redirectUri: back.redirectUri,
      randomKey: random,
      sha256: async (text) =>
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    });
    openBrowser(started.url, io);
    const callbackUrl = await back.callback;
    await session.finishBrowserSignIn({
      callbackUrl,
      state: started.state,
      verifier: started.verifier,
      redirectUri: back.redirectUri,
      deviceName,
    });
    return session;
  } finally {
    back.close();
  }
}

/** `--host` without a trailing slash, or null (said to the person) when it is not an address. */
export function hostOf(flag: string | undefined, io: Io): string | null {
  const host = flag?.replace(/\/+$/, "");
  if (!host || !/^https?:\/\//.test(host)) {
    io.err("--host is the host's address, e.g. https://admin.example.com");
    return null;
  }
  return host;
}

/**
 * Signs in for this run (signInForRun), does `work` on the host as that person and signs out
 * again. Returns `work`'s exit code, or 1 when the sign-in fails.
 */
export async function withRunSession(
  host: string,
  email: string | undefined,
  io: Io,
  label: string,
  work: (on: ImportHost) => Promise<number>,
): Promise<number> {
  let session: RunSession;
  try {
    session = await signInForRun(host, email, io, label);
  } catch (error) {
    io.err(`Could not sign in: ${(error as Error).message}`);
    return 1;
  }
  try {
    return await work(sessionHost(host, () => session.headers()));
  } finally {
    await session.signOut();
  }
}

/** Asks the person to confirm `summary` (or takes --yes); false stops the run. */
export function confirmer(io: Io, yes: boolean | undefined) {
  return async (summary: string): Promise<boolean> => {
    if (yes) return true;
    if (!io.interactive) {
      io.err(`${summary}. Pass --yes to confirm it when running from a script.`);
      return false;
    }
    const answer = await io.ask(`${summary}. Go ahead? (yes/no)`, { default: "no" });
    return /^y(es)?$/i.test(answer.trim());
  };
}
