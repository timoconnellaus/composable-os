// `cos content import <folder>` (ADR 0470): loads an old blog into a host as the person running it.
//
//   cos content import ./export --host https://admin.example.com [--email you@example.com]
//                      [--dry-run] [--publish] [--yes]
//
// Who it runs as: a person, signed in for this run only. With --email the host emails a staff code
// (its own sign-in); without it the system browser opens the host's staff sign-in (Cloudflare
// Access, Google), which hands a one-time code back to a port on 127.0.0.1 this command listens on
// (ADR 0455; the host lists `http://127.0.0.1/cos-sign-in` in NATIVE_REDIRECT_URIS). Either way
// the host answers with a staff device session, held in this process's memory and nowhere else,
// and ended on the host when the run finishes. No token is read from the environment or a file,
// and none is printed.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { startBrowserSignIn, type Tokens, tokenSession } from "@composable-os/client";
import type { Io } from "../io.ts";
import { reportLines, runImport } from "./engine.ts";
import { POST_FIELDS, readFolder } from "./format.ts";
import { sessionHost } from "./host.ts";

/** The loopback address the browser sign-in comes back to (any port), as the host lists it. */
export const LOOPBACK_PATH = "/cos-sign-in";

export interface ImportFlags {
  host?: string;
  email?: string;
  dryRun?: boolean;
  publish?: boolean;
  yes?: boolean;
}

/** The folder's posts and pictures, as text and bytes. */
export function readImportFolder(dir: string): {
  posts: Map<string, string>;
  pictures: Map<string, Uint8Array>;
} {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`${dir} is not a folder`);
  }
  const posts = new Map<string, string>();
  for (const name of readdirSync(root)) {
    if (name.toLowerCase().endsWith(".json"))
      posts.set(name, readFileSync(join(root, name), "utf8"));
  }
  const pictures = new Map<string, Uint8Array>();
  const folder = join(root, "pictures");
  if (existsSync(folder)) {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isFile()) pictures.set(name, new Uint8Array(readFileSync(path)));
    }
  }
  return { posts, pictures };
}

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

/** `cos content import <folder>`. */
export async function contentImport(
  positional: string[],
  flags: ImportFlags,
  io: Io,
): Promise<number> {
  const dir = positional[0];
  if (!dir) {
    io.err(
      `Usage: cos content import <folder> --host <https://host> [--email <you>] [--dry-run] [--publish] [--yes]\n\nA post file's fields: ${Object.entries(
        POST_FIELDS,
      )
        .map(([k, v]) => `${k} (${v})`)
        .join("; ")}. See docs/importing.md.`,
    );
    return 2;
  }
  const host = flags.host?.replace(/\/+$/, "");
  if (!host || !/^https?:\/\//.test(host)) {
    io.err("--host is the host's address, e.g. https://admin.example.com");
    return 2;
  }
  const plan = readFolder(readImportFolder(dir));
  if (plan.problems.length) {
    io.err(`Nothing was written: ${plan.problems.length} problem(s) in ${dir}.`);
    for (const p of plan.problems) io.err(`  ${p.file}: ${p.message}`);
    return 1;
  }
  io.out(
    `${plan.posts.length} post(s), ${plan.categories.length} categor${plan.categories.length === 1 ? "y" : "ies"} and ${plan.pictures.size} picture(s) in ${dir}.`,
  );

  // Signed in for this run only.
  const store = memoryStore();
  const session = tokenSession({ baseUrl: host, store });
  const deviceName = `cos content import on ${hostname()}`.slice(0, 100);
  try {
    if (flags.email) {
      await session.requestCode(flags.email, "staff");
      const code = await io.ask(`The sign-in code sent to ${flags.email}`, { secret: true });
      await session.signInWithCode(flags.email, code.trim(), deviceName, "staff");
    } else {
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
      } finally {
        back.close();
      }
    }
  } catch (error) {
    io.err(`Could not sign in: ${(error as Error).message}`);
    return 1;
  }

  try {
    const report = await runImport(
      plan,
      sessionHost(host, () => session.headers()),
      {
        dryRun: Boolean(flags.dryRun),
        publish: Boolean(flags.publish),
        confirm: async (summary) => {
          if (flags.yes) return true;
          if (!io.interactive) {
            io.err(`${summary}. Pass --yes to confirm it when running from a script.`);
            return false;
          }
          const answer = await io.ask(`${summary}. Go ahead? (yes/no)`, { default: "no" });
          return /^y(es)?$/i.test(answer.trim());
        },
      },
    );
    for (const line of reportLines(report, Boolean(flags.dryRun))) {
      (report.problems.length ? io.err : io.out)(line);
    }
    return report.problems.length ? 1 : 0;
  } finally {
    await session.signOut();
  }
}
