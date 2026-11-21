// Where the platform's source is, for a check run outside a deployment: the SDK the extension is
// written against and the core migrations its dry-run reconcile needs. In a checkout of the
// Composable OS repository, found by walking up from the extension's directory; in a client repo
// (stage 24), the copies the installed `cos` carries (`dist/platform/`, its own version's).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
      return { root, sdkSrc, migrations };
    }
  }
  return null;
}
