// Tells a failure the dev server caused from one the product (or the test) did. dev-server.mjs
// records each time workerd crashes under `vite dev`; a test that fails while that happens is named
// here as the dev server's, in the run's output and its summary, so nobody debugs the product for
// it. Every other failure is left as it is: the product or the test is wrong.
import { existsSync, readFileSync } from "node:fs";
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { CRASH_LOG } from "./dev-server.mjs";

/** How long after a crash the restarted dev server may still answer with errors. */
const RESTART_MS = 30_000;

function crashes(): { at: number }[] {
  if (!existsSync(CRASH_LOG)) return [];
  return readFileSync(CRASH_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { at: number });
}

export default class DevServerReporter implements Reporter {
  #broken: string[] = [];
  #failed = 0;

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === "passed" || result.status === "skipped") return;
    this.#failed++;
    const start = result.startTime.getTime();
    const end = start + result.duration;
    const crash = crashes().find((c) => c.at <= end && c.at + RESTART_MS >= start);
    if (!crash) return;
    const name = `${test.titlePath().filter(Boolean).join(" › ")}${result.retry ? ` (retry #${result.retry})` : ""}`;
    this.#broken.push(name);
    console.error(
      `\n[e2e] DEV SERVER, NOT PRODUCT: "${name}" failed while the dev server's Workers runtime ` +
        `crashed (${new Date(crash.at).toISOString()}); see "THE DEV SERVER BROKE" in the output.\n`,
    );
  }

  onEnd(_result: FullResult) {
    if (!this.#broken.length) return;
    console.error(
      `\n[e2e] ${this.#broken.length} of ${this.#failed} failure(s) happened while the dev server ` +
        `crashed, not because of the product:\n${this.#broken.map((n) => `  - ${n}`).join("\n")}\n` +
        (this.#failed > this.#broken.length
          ? `[e2e] The other ${this.#failed - this.#broken.length} failure(s) are the product's or the test's.\n`
          : ""),
    );
  }

  printsToStdio() {
    return false;
  }
}
