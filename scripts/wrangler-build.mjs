#!/usr/bin/env node
// A Worker's release build: `wrangler deploy --dry-run --outdir dist`, bundled for the product
// the build is for. With COS_PRODUCT set (packages/product/src/node.ts), the active product
// module is replaced by that product's definition; without it, this is plain wrangler.
//
// Usage (from a Worker's directory): node ../../scripts/wrangler-build.mjs [wrangler args]
import { execFileSync } from "node:child_process";
import { productAlias } from "../packages/product/src/node.ts";

const alias = Object.entries(productAlias()).flatMap(([from, to]) => ["--alias", `${from}:${to}`]);
execFileSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "deploy",
    "--dry-run",
    "--outdir",
    "dist",
    ...alias,
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
