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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { confirmer, LOOPBACK_PATH, signInForRun } from "../import-door/sign-in.ts";
import type { Io } from "../io.ts";
import { reportLines, runImport } from "./engine.ts";
import { POST_FIELDS, readFolder } from "./format.ts";
import { sessionHost } from "./host.ts";

export { LOOPBACK_PATH };

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

  // Signed in for this run only (import-door/sign-in.ts).
  let session: Awaited<ReturnType<typeof signInForRun>>;
  try {
    session = await signInForRun(host, flags.email, io, "cos content import");
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
        confirm: confirmer(io, flags.yes),
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
