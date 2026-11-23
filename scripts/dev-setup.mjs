#!/usr/bin/env node
// Prepares local development: creates each Worker's .dev.vars from its .dev.vars.example when
// missing (generating BETTER_AUTH_SECRET and opening sign-up so the e2e test user can be created),
// then applies core migrations to the local D1 database.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const app of ["apps/app", "apps/runner"]) {
  const example = join(root, app, ".dev.vars.example");
  const target = join(root, app, ".dev.vars");
  if (existsSync(target) || !existsSync(example)) continue;
  copyFileSync(example, target);
  let vars = readFileSync(target, "utf8")
    .replace(/^BETTER_AUTH_SECRET=$/m, `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}`)
    // Customer sign-in locally (its own secret, never the staff one), for the buyer's journey.
    .replace(/^CUSTOMER_AUTH_SECRET=$/m, `CUSTOMER_AUTH_SECRET=${randomBytes(32).toString("hex")}`);
  if (app === "apps/app") vars += "\n# Local only: anyone can sign up.\nAUTH_ALLOW_SIGNUP=true\n";
  writeFileSync(target, vars);
  console.log(`created ${app}/.dev.vars`);
}

// Stage 41: customer sign-in locally (a member signing in to log a session, in the programs e2e
// spec). Its own secret, never the staff one; added once to a .dev.vars that lacks it.
{
  const target = join(root, "apps/app/.dev.vars");
  if (existsSync(target)) {
    const vars = readFileSync(target, "utf8");
    if (!/^CUSTOMER_AUTH_SECRET=./m.test(vars)) {
      writeFileSync(
        target,
        `${vars.replace(/^CUSTOMER_AUTH_SECRET=.*$/m, "").trimEnd()}\n# Local only: customer sign-in.\nCUSTOMER_AUTH_SECRET=${randomBytes(32).toString("hex")}\n`,
      );
      console.log("added CUSTOMER_AUTH_SECRET to apps/app/.dev.vars");
    }
  }
}

// In a git worktree, copy provider keys (AI_KEY_*) from the main checkout's apps/app/.dev.vars
// when this worktree's file lacks them, so keys set once (for example voice: AssemblyAI,
// ElevenLabs) work in every worktree. Values are never printed.
const mainCheckout = (() => {
  try {
    const common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: root,
        encoding: "utf8",
      },
    ).trim();
    const main = dirname(common);
    return main === root ? null : main;
  } catch {
    return null;
  }
})();
const appVarsTarget = join(root, "apps/app/.dev.vars");
const mainAppVars = mainCheckout ? join(mainCheckout, "apps/app/.dev.vars") : null;
if (mainAppVars && existsSync(mainAppVars) && existsSync(appVarsTarget)) {
  const current = readFileSync(appVarsTarget, "utf8");
  const missing = readFileSync(mainAppVars, "utf8")
    .split("\n")
    .filter((line) => /^AI_KEY_[A-Z0-9_]+=.+/.test(line))
    .filter((line) => !new RegExp(`^${line.split("=")[0]}=`, "m").test(current));
  if (missing.length > 0) {
    writeFileSync(
      appVarsTarget,
      `${current.trimEnd()}\n\n# Copied from the main checkout by scripts/dev-setup.mjs.\n${missing.join("\n")}\n`,
    );
    console.log(`copied ${missing.map((l) => l.split("=")[0]).join(", ")} from the main checkout`);
  }
}

// Stage 6a: an existing runner .dev.vars from before stage 6 still gets the fake provider, which
// local development and the e2e suite connect to.
const runnerVars = join(root, "apps/runner/.dev.vars");
if (
  existsSync(runnerVars) &&
  !/^INTEGRATIONS_FAKE_PROVIDER=/m.test(readFileSync(runnerVars, "utf8"))
) {
  writeFileSync(
    runnerVars,
    `${readFileSync(runnerVars, "utf8").trimEnd()}\n# Stage 6a: the fake OAuth provider (local only).\nINTEGRATIONS_FAKE_PROVIDER=true\n`,
  );
  console.log("added INTEGRATIONS_FAKE_PROVIDER to apps/runner/.dev.vars");
}

// The vendored gatekeeper Workers import configurator frames that are generated, not committed.
execFileSync("node", [join(root, "scripts/gatekeeper-configurator-frames.mjs")], {
  stdio: "inherit",
});

// Local dev has no Workers AI binding: answer the build model role ("Describe a widget") with
// the deterministic stand-in (stage 4a), in new and existing .dev.vars alike.
const appVars = join(root, "apps/app/.dev.vars");
if (existsSync(appVars) && !/^AI_FAKE_MODEL=/m.test(readFileSync(appVars, "utf8"))) {
  writeFileSync(
    appVars,
    `${readFileSync(appVars, "utf8").trimEnd()}\n\n# Local only: stand-ins for every model role and in-memory vectors (no AI or Vectorize locally).\nAI_FAKE_MODEL=true\n`,
  );
}

// Local dev has no Cloudflare Stream: videos go to the fake Stream (stage 42, ADR 0475), in new
// and existing .dev.vars alike. Never in a deployment.
if (existsSync(appVars) && !/^STREAM_FAKE=/m.test(readFileSync(appVars, "utf8"))) {
  writeFileSync(
    appVars,
    `${readFileSync(appVars, "utf8").trimEnd()}\n\n# Local only: videos go to the fake Stream (no Cloudflare Stream locally).\nSTREAM_FAKE=true\n`,
  );
}

// Stand-in speech for local dev and e2e, unless this checkout has a real key to try (ADR 0349).
if (
  existsSync(appVars) &&
  !/^(AI_FAKE_VOICE|AI_KEY_ASSEMBLYAI)=/m.test(readFileSync(appVars, "utf8"))
) {
  writeFileSync(
    appVars,
    `${readFileSync(appVars, "utf8").trimEnd()}\n\n# Local only: stand-in speech with no key and no network.\nAI_FAKE_VOICE=true\n`,
  );
}

// cos-runner bundles the SDK and the shipped extensions as source at build time (ADR 0025); vite
// dev loads it as an auxiliary Worker, so the bundle must exist first.
execFileSync("node", [join(root, "apps/runner/scripts/bundle.mjs")], { stdio: "inherit" });

// The app and the runner share one local D1 database (same database_name, same persist dir).
execFileSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local"], {
  cwd: join(root, "apps/app"),
  stdio: "inherit",
  env: { ...process.env, CI: "true" },
});

// Stage 27: something to sell locally. The box office fixture extension
// (packages/core/test/fixtures/boxoffice) is the org's own extension here, delivered the way
// `cos deploy` delivers one (ADR 0422): its files in BLOBS under their sha256, pinned by the
// runner's COS_ORG_EXTENSIONS. It is optional, so nothing installs it until an admin does
// (extension.install { id: "boxoffice", shipped: true }); the orders e2e spec does. A runtime
// extension cannot declare `sellable` (ADR 0435).
{
  const fixture = join(root, "packages/core/test/fixtures/boxoffice/index.ts");
  // And the Ticketing pack (stage 27), which the CRM does not list: local dev delivers it as an
  // org extension too, optional, so the ticketing e2e spec installs it the way a product that
  // lists the pack would have it. Its extension files only (not client/, blocks/ or tests).
  const ticketing = Object.fromEntries(
    ["index.ts", "tools.ts", "automations.ts", "dashboards.ts", "routine-mail.ts"].map((file) => [
      file,
      readFileSync(join(root, "packs/ticketing", file), "utf8"),
    ]),
  );
  const programs = Object.fromEntries(
    ["index.ts", "tools.ts", "layout.ts", "dashboards.ts", "authoring.ts"].map((file) => [
      file,
      readFileSync(join(root, "packs/programs", file), "utf8"),
    ]),
  );
  // And Courses (stage 42), which requires Programs, the same way, for its e2e specs.
  const courses = Object.fromEntries(
    ["index.ts", "tools.ts", "outline.ts", "automations.ts", "dashboards.ts"].map((file) => [
      file,
      readFileSync(join(root, "packs/courses", file), "utf8"),
    ]),
  );
  // And Bookings (stage 31a), which requires Programs, the same way, for its e2e spec. Until the
  // Memberships pack is connected (step 4), local dev's Bookings also lets the e2e spec's fixture
  // holder (`bkfixture.pass`) pay; the shipped pack names only the Memberships pack's holders.
  const bookings = Object.fromEntries(
    ["index.ts", "tools.ts", "automations.ts", "dashboards.ts", "routine-mail.ts"].map((file) => [
      file,
      readFileSync(join(root, "packs/bookings", file), "utf8").replace(
        'paidBy: ["memberships.membership", "memberships.pass"]',
        'paidBy: ["memberships.membership", "memberships.pass", "bkfixture.pass"]',
      ),
    ]),
  );
  // And Memberships (stage 32b), which requires Programs, the same way, for its e2e spec.
  const memberships = Object.fromEntries(
    ["index.ts", "tools.ts", "dashboards.ts"].map((file) => [
      file,
      readFileSync(join(root, "packs/memberships", file), "utf8"),
    ]),
  );
  // And Content (stage 28), the same way, for its e2e spec.
  const content = Object.fromEntries(
    ["index.ts", "tools.ts"].map((file) => [
      file,
      readFileSync(join(root, "packs/content", file), "utf8"),
    ]),
  );
  // Two ways to have a pack locally, which do not mix (a pack and an org extension may not share
  // an id, shipped-list.ts):
  // - The default, the CRM's local dev: the runner's COS_PACKS is "*" (the CRM's packs), and
  //   Ticketing, Programs and Content come as optional org extensions, which an admin (or an e2e
  //   spec) installs with extension.install { id, shipped: true }.
  // - Client-shaped (COS_DEV_PACKS=ticketing,content pnpm dev): the runner's COS_PACKS is that
  //   list, as `cos deploy` sets it for a product that lists those packs, so they install at boot
  //   from the release's bundle (ADR 0420, amended 2026-11-22); they are then not delivered as
  //   org extensions. Packs not listed (the CRM's too) are not installed.
  const devPacks = (process.env.COS_DEV_PACKS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const packsFile = join(root, "apps/app/.wrangler/cos-packs");
  mkdirSync(dirname(packsFile), { recursive: true });
  writeFileSync(packsFile, devPacks.join(","));
  if (devPacks.length) console.log(`local runner: COS_PACKS=${devPacks.join(",")} (COS_DEV_PACKS)`);
  const asOrgExtension = (id) => !devPacks.includes(id);
  const text = JSON.stringify({
    extensions: [
      {
        id: "boxoffice",
        version: "1.0.0",
        optional: true,
        files: { "index.ts": readFileSync(fixture, "utf8") },
      },
      { id: "ticketing", version: "0.1.0", optional: true, files: ticketing },
      // And Programs (stage 41), the same way, for its e2e specs.
      { id: "programs", version: "0.1.0", optional: true, files: programs },
      { id: "content", version: "0.2.0", optional: true, files: content },
      { id: "courses", version: "0.1.0", optional: true, files: courses },
      { id: "bookings", version: "0.1.0", optional: true, files: bookings },
      { id: "memberships", version: "0.1.0", optional: true, files: memberships },
    ].filter((extension) => asOrgExtension(extension.id)),
  });
  const hash = createHash("sha256").update(text).digest("hex");
  const blob = join(root, "apps/app/.wrangler/org-extensions.json");
  mkdirSync(dirname(blob), { recursive: true });
  writeFileSync(blob, text);
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "r2",
      "object",
      "put",
      `cos-blobs/org-extensions/${hash}.json`,
      "--file",
      blob,
      "--local",
    ],
    { cwd: join(root, "apps/app"), stdio: "inherit", env: { ...process.env, CI: "true" } },
  );
  // apps/app/vite.config.ts pins it on the local runner (not .dev.vars, which `wrangler types`
  // reads).
  writeFileSync(join(root, "apps/app/.wrangler/org-extensions.sha256"), hash);
}
