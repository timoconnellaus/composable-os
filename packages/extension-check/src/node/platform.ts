// Where the platform's source is, for a check run outside a deployment: the SDK the extension is
// written against and the core migrations its dry-run reconcile needs. In a checkout of the
// Composable OS repository, found by walking up from the extension's directory; in a client repo
// (stage 24), the copies the installed `cos` carries (`dist/platform/`, its own version's).
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface Platform {
  root: string;
  /** packages/sdk/src: `index.ts` is the SDK's entry. */
  sdkSrc: string;
  /** packages/db/migrations: the core schema, as numbered .sql files. */
  migrations: string;
}

export function findPlatform(from: string): Platform | null {
  let dir = resolve(from);
  for (;;) {
    const sdkSrc = join(dir, "packages", "sdk", "src");
    const migrations = join(dir, "packages", "db", "migrations");
    if (existsSync(join(sdkSrc, "index.ts")) && existsSync(migrations)) {
      return { root: dir, sdkSrc, migrations };
    }
    const up = dirname(dir);
    if (up === dir) return bundledPlatform();
    dir = up;
  }
}

/** The SDK source and migrations bundled with the installed CLI (packages/create-composable-os). */
function bundledPlatform(): Platform | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const root of [join(here, "platform"), join(here, "..", "platform")]) {
    const sdkSrc = join(root, "sdk");
    const migrations = join(root, "migrations");
    if (existsSync(join(sdkSrc, "index.ts")) && existsSync(migrations)) {
      // Installed, the CLI is under node_modules, where TypeScript treats sources as a library's
      // and emits no declarations for them: the type check works on a copy outside it.
      if (!root.split(sep).includes("node_modules")) return { root, sdkSrc, migrations };
      const copy = join(
        tmpdir(),
        `cos-platform-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`,
      );
      if (!existsSync(join(copy, "sdk", "index.ts"))) {
        mkdirSync(join(copy, "node_modules"), { recursive: true });
        cpSync(root, copy, { recursive: true });
        // The SDK's one dependency, as the CLI has it, so the copy bundles and type-checks.
        const zod = dirname(createRequire(import.meta.url).resolve("zod/package.json"));
        symlinkSync(zod, join(copy, "node_modules", "zod"), "dir");
      }
      return { root: copy, sdkSrc: join(copy, "sdk"), migrations: join(copy, "migrations") };
    }
  }
  return null;
}
