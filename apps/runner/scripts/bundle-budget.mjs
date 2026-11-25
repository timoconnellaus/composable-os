// Bundle budget for cos-runner (ADR 0043): the main module must stay small and must not carry the
// TypeScript compiler, which lives in the checker's Dynamic Worker (a Text module, never parsed by
// cos-runner itself). Builds with scripts/build.mjs, the build that ships, into a temporary
// directory.
//
// Before ADR 0043 the main module was 10,348 KiB (the compiler, its declarations and the SDK
// bundle all inside it).
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { buildRunner } from "./build.mjs";

// The history below is of wrangler's unminified main module, which is no longer what is measured.
// 4,096 KiB at ADR 0043. Raised to 5,120 KiB (2026-11-05): stage 5's automation engine (Workflows,
// queue consumer, rails) took it to 4,221 KiB, and stage 7a's AI SDK adds ~1.1 MB. The compiler
// check below is what the budget is really for, and it is unchanged. Raised to 5,632 KiB
// (2026-11-05): stage 6b (run-as, integration-event triggers, the outbox retry and notification
// delivery) on top of 7a and 8 took it to 5,124 KiB. Raised to 6,144 KiB (2026-11-06): stage 15's
// assignment rules, stage 16's duplicates and stage 17's A2UI catalogue, which each fit alone,
// took it to 5,741 KiB together. No React or compiler came with them. Raised to 6,656 KiB
// (2026-11-21): stages 22, 23, 25 and 26 (customers, the HTTP surface, orders and payments,
// capacity) took it to 6,146 KiB. No React or compiler came with them either. Measured
// 2026-11-21 when a release began to carry every pack (ADR 0420 as amended): 6,246 KiB with four
// packs (the shipped sources grew from 69 KiB to 120 KiB); not raised. Raised to 7,168 KiB
// (2026-11-22): stage 42's Courses pack (its shipped source, carried as text) with the video
// host and the access scope, on top of tax at checkout and publish requests, took it to 6,811 KiB.
// No React or compiler came with them. Raised to 7,680 KiB (2026-11-22) by stage 32b's Memberships
// pack, at 7,184 KiB, and lowered back to 7,168 KiB the same day: stage 31a measured the cause.
// What dominated the main module (esbuild's metafile, with eight packs at 7,192 KiB): packages/core
// 2,461 KiB, @cloudflare/computer 835, zod 832, kysely 578, sucrase 493, the AI SDK about 700, and
// the packs' sources as a JS literal (generated/shipped.ts) 359 KiB, growing by each pack's whole
// source. Packs were not duplicated (no blocks, clients or SDK copies in it). The packs' sources
// moved to a Text module (shipped.txt), as the SDK bundle's are: 6,874 KiB with all nine packs.
// Raised to 7,680 KiB (2026-11-23): 7,151 KiB on main after stage 44 step 1 (agreement documents);
// stage 45 step 1 (field exceptions in recurring) takes it to 7,170, routine mail adds about 37 and
// stage 44 step 2 more. All of it is packages/core and operation descriptions; no React or compiler
// came with them, and the compiler check below is unchanged. Raised once here, on main, so the
// branches in flight stop each failing on the others' growth.
//
// Measures what ships (2026-11-23, ADR 0043 as amended): the main module as scripts/build.mjs
// emits it, minified for whitespace only (no renaming, no syntax rewriting). On main at 57be31f8
// wrangler's unminified module was 7,578 KiB and the shipped one is 5,531 KiB. The budget is
// 7,168 KiB of the shipped module, about 1.6 MB of room. The experiment behind it: a scratch entry
// that re-exports src/index.ts and imports `typescript` took the shipped main module from 5,531
// to 13,002 KiB (+7,471 KiB; unminified, 7,578 to 18,409). That accident overshoots this budget by
// about 5.8 MB at today's size, and by 7.5 MB less whatever room is left at any later size, so it
// still fails clearly; the markers below catch it at any size.
// Raised to 7,680 KiB (2026-11-26, stage 52 step 4, PR #474): `origin/main` alone measured
// 7,161 KiB at 10f86c53, 7 KiB under the old budget, so the next change of any size would have
// failed it. This PR adds its own finance code (the payout read and the Payouts report, about
// 40 KiB shipped after its review: 7,201 KiB), no new dependency; no React or compiler came with
// it, and the compiler check below is unchanged. packages/core has doubled since 2026-11-22
// (2,461 to 4,956 KiB unminified on main, operations/ 2,237 of it): issue #475 tracks the growth,
// to measure (esbuild's metafile) before the next raise.
const MAIN_BUDGET_KIB = 7_680;
// Everything the runner uploads (the main module and its Text modules, not the source map), against
// the platform's limit on a Worker's size. Checked 2026-11-23 at
// https://developers.cloudflare.com/workers/platform/limits/: 64 MiB uncompressed on both plans,
// and no compressed limit (the gzip figure is for reference only). This budget is half of that.
// The startup limit (1 s to parse and run the global scope) is reported only by a real upload
// (startup_time_ms), so it is not checked here.
const UPLOAD_BUDGET_KIB = 32 * 1024;
const MAP_GZIP_BUDGET_KIB = 7.5 * 1024;

const out = await mkdtemp(join(tmpdir(), "cos-runner-bundle-"));
try {
  const { main } = await buildRunner(out, [], { quiet: true });
  const kib = (await stat(main)).size / 1024;
  const code = await readFile(main, "utf8");
  const files = await readdir(out);
  let upload = 0;
  let uploadGzip = 0;
  for (const file of files) {
    if (file.endsWith(".map") || file === "README.md") continue;
    const bytes = await readFile(join(out, file));
    upload += bytes.length;
    uploadGzip += gzipSync(bytes).length;
  }
  const uploadKib = upload / 1024;
  const failures = [];
  if (kib > MAIN_BUDGET_KIB) {
    failures.push(
      `main module is ${kib.toFixed(0)} KiB as shipped, over the ${MAIN_BUDGET_KIB} KiB budget`,
    );
  }
  if (uploadKib > UPLOAD_BUDGET_KIB) {
    failures.push(
      `the upload is ${uploadKib.toFixed(0)} KiB, over the ${UPLOAD_BUDGET_KIB} KiB budget (the platform's limit is 64 MiB)`,
    );
  }
  // Markers of the compiler's own code (not of the checker's id or comments). Whitespace
  // minification renames nothing, so they survive in the shipped module.
  for (const marker of ["createProgram", "getSemanticDiagnostics", "createSourceFile("]) {
    if (code.includes(marker))
      failures.push(`main module contains the TypeScript compiler (${marker})`);
  }
  // React's element symbols: the host renders no React (blocks and client apps are client code).
  for (const marker of ["react.transitional.element", '"react.element"']) {
    if (code.includes(marker)) failures.push(`main module contains React (${marker})`);
  }
  if (!files.some((f) => f.endsWith("checker.txt"))) failures.push("no checker.txt Text module");
  if (!files.some((f) => f.endsWith("sdk-bundle.txt")))
    failures.push("no sdk-bundle.txt Text module");
  // The source map scripts/deploy.mjs uploads: the platform takes up to 15 MiB gzipped and 60 MiB
  // uncompressed (https://developers.cloudflare.com/workers/observability/source-maps/, checked
  // 2026-11-23). Half of the gzipped limit.
  if (!files.includes("index.js.map")) failures.push("no source map (index.js.map)");
  else {
    const map = await readFile(join(out, "index.js.map"));
    const mapGzipKib = gzipSync(map).length / 1024;
    if (mapGzipKib > MAP_GZIP_BUDGET_KIB || map.length / 1024 > 30 * 1024)
      failures.push(
        `the source map is ${(map.length / 1024).toFixed(0)} KiB (gzip ${mapGzipKib.toFixed(0)} KiB), over the ${MAP_GZIP_BUDGET_KIB} KiB gzipped or 30 MiB budget`,
      );
  }
  if (failures.length) {
    console.error(`bundle budget failed:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log(
    `bundle budget ok: main module ${kib.toFixed(0)} KiB as shipped (budget ${MAIN_BUDGET_KIB} KiB), upload ${uploadKib.toFixed(0)} KiB (budget ${UPLOAD_BUDGET_KIB} KiB; gzip ${(uploadGzip / 1024).toFixed(0)} KiB, for reference), compiler only in the checker worker's Text module`,
  );
} finally {
  await rm(out, { recursive: true, force: true });
}
