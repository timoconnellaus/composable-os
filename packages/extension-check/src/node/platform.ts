// Where the platform's source is, for a check run outside a deployment: the SDK the extension is
// written against and the core migrations its dry-run reconcile needs. Today that is a checkout
// of the Composable OS repository, found by walking up from the extension's directory. A client
// repo (stage 24) will resolve the same two things from the installed platform version.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
    if (up === dir) return null;
    dir = up;
  }
}
