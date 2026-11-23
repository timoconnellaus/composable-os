// The e2e suite's web server: `vite dev`, its output passed through unchanged, watched for the dev
// server breaking under the tests. When workerd dies, Miniflare restarts it ("The Workers runtime
// crashed unexpectedly…") and the Vite plugin restarts the dev server; a request in flight gets
// Vite's HTML error page ("fetch failed") or a reset socket, so a test fails that says nothing
// about the product. Each such crash is appended to CRASH_LOG with its time, and on Linux (CI) with
// the memory left and any kernel OOM kill, so the cause can be read from the job's log; the
// reporter (dev-server-reporter.ts) names the failures that coincide with one.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const CRASH_LOG = join(here, ".dev-server", "crashes.jsonl");
const CRASH = /The Workers runtime crashed unexpectedly|\[vite\] Internal server error: fetch failed/;

/** What the machine says about memory just after a crash (Linux only; never fails the server). */
function evidence() {
  if (process.platform !== "linux") return {};
  const run = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", timeout: 5_000 }).trim();
    } catch {
      return null;
    }
  };
  const kernel = run("sudo", ["-n", "dmesg", "-T"]);
  return {
    memory: run("free", ["-m"]),
    oom: kernel
      ?.split("\n")
      .filter((line) => /out of memory|oom-kill|killed process/i.test(line))
      .slice(-5),
  };
}

function main() {
  mkdirSync(dirname(CRASH_LOG), { recursive: true });
  writeFileSync(CRASH_LOG, "");
  const vite = spawn("pnpm", ["exec", "vite", "dev"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  let last = 0;
  for (const [stream, out] of [
    [vite.stdout, process.stdout],
    [vite.stderr, process.stderr],
  ]) {
    createInterface({ input: stream }).on("line", (line) => {
      out.write(`${line}\n`);
      if (!CRASH.test(line)) return;
      const at = Date.now();
      // One crash prints both lines; record it once.
      if (at - last < 5_000) return;
      last = at;
      const found = evidence();
      appendFileSync(CRASH_LOG, `${JSON.stringify({ at, line, ...found })}\n`);
      process.stderr.write(
        `\n[e2e] THE DEV SERVER BROKE at ${new Date(at).toISOString()}: workerd crashed and is ` +
          "restarting. A test failing now failed because of the dev server, not the product.\n" +
          (found.memory ? `[e2e] memory:\n${found.memory}\n` : "") +
          (found.oom?.length ? `[e2e] kernel OOM:\n${found.oom.join("\n")}\n` : "") +
          "\n",
      );
    });
  }
  const stop = (signal) => vite.kill(signal);
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  vite.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
