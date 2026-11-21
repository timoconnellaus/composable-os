// `cos client generate` (stage 23, ADR 0418): writes a product's typed client.
//
//   cos client generate --out <dir> [--product <id>] [--extension <dir>]... [--runtime <module>]
//
// The contract is read from the product's own registry: the platform's operations, the tools of
// the extensions the product names (its packs, from `packs/<id>` in this checkout), and any
// extension directory given with --extension (the org's own). The output, `customer.ts` and
// `staff.ts`, is committed in the client repo.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension } from "@composable-os/sdk";
import { productContract } from "../product.ts";
import { renderClient } from "../render.ts";

export interface ClientIo {
  out(line: string): void;
  err(line: string): void;
}

export const CLIENT_HELP = `cos client generate: write a product's typed client.

  cos client generate --out <dir> [--product <id>] [--extension <dir>]... [--runtime <module>]

  --out <dir>          where customer.ts and staff.ts are written (commit them)
  --product <id>       the product whose registry is read (default: the active product)
  --extension <dir>    an extension of the org's own, besides the product's packs (repeatable)
  --runtime <module>   the runtime import (default @composable-os/client)
`;

/** The checkout's root: the directory with pnpm-workspace.yaml. */
function repoRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Loads an extension's definition from its directory's index.ts, bundled with esbuild. */
export async function loadExtension(dir: string): Promise<Extension> {
  const entry = join(resolve(dir), "index.ts");
  if (!existsSync(entry)) throw new Error(`${dir} has no index.ts`);
  const { build } = await import("esbuild");
  const out = join(mkdtempSync(join(tmpdir(), "cos-client-")), "extension.mjs");
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "error",
  });
  const module = (await import(pathToFileURL(out).href)) as { default?: Extension };
  if (!module.default) throw new Error(`${entry} has no default export (defineExtension)`);
  return module.default;
}

interface Parsed {
  out?: string;
  product?: string;
  extensions: string[];
  runtime?: string;
}

function parse(argv: string[]): Parsed {
  const parsed: Parsed = { extensions: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (flag === "--out") parsed.out = value;
    else if (flag === "--product") parsed.product = value;
    else if (flag === "--extension") parsed.extensions.push(value);
    else if (flag === "--runtime") parsed.runtime = value;
    else throw new Error(`Unknown option ${flag}`);
    i += 1;
  }
  return parsed;
}

export async function runClient(argv: string[], io: ClientIo): Promise<number> {
  if (argv[0] !== "generate" || argv.includes("--help")) {
    io.out(CLIENT_HELP);
    return argv[0] === "generate" || argv.includes("--help") ? 0 : 2;
  }
  let parsed: Parsed;
  try {
    parsed = parse(argv.slice(1));
  } catch (error) {
    io.err((error as Error).message);
    return 2;
  }
  if (!parsed.out) {
    io.err("--out <dir> is required");
    return 2;
  }
  const { products, DEFAULT_PRODUCT } = await import("@composable-os/products");
  const id = parsed.product ?? DEFAULT_PRODUCT;
  const product = products[id];
  if (!product) {
    io.err(`No product named ${id}. Known: ${Object.keys(products).join(", ")}`);
    return 2;
  }
  const root = repoRoot(process.cwd());
  const dirs = [
    ...product.packs.map((pack) => {
      if (!root) throw new Error("Run cos client generate in a checkout of the repository");
      return join(root, "packs", pack);
    }),
    ...parsed.extensions,
  ];
  const extensions = await Promise.all(dirs.map(loadExtension));
  const contract = productContract(extensions);
  const files = renderClient(contract, {
    product: id,
    ...(parsed.runtime ? { runtime: parsed.runtime } : {}),
  });
  mkdirSync(parsed.out, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(parsed.out, name), text);
  const counts = Object.entries(files)
    .map(
      ([name, text]) => `${name} (${(text.match(/^ {2}"[^"]+": \{$/gm) ?? []).length} operations)`,
    )
    .join(", ");
  io.out(`Wrote ${counts} in ${parsed.out} for ${id}, API ${contract.version}.`);
  return 0;
}
