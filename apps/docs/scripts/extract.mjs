// What the code says, as plain data: every pack's manifest, the core operations registry, the
// products, the CLI's help and the behaviours an object may declare. The packs and the registry
// are TypeScript that Node cannot run as it is (and the registry imports `cloudflare:*`), so this
// bundles one small entry with esbuild, stubs the `cloudflare:*` modules (nothing here runs a
// Worker: definitions are only read) and runs it. No network. The markdown sources are read by
// sources.mjs without any of this, so the documents lane needs no install.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { packIds } from "./sources.mjs";

const CLOUDFLARE_STUB = `
export class DurableObject {} export class WorkerEntrypoint {} export class WorkflowEntrypoint {}
export class RpcTarget {} export class WorkflowStep {} export const env = {}; export default {};
`;

/** The entry esbuild bundles: imports every source and turns definitions into plain data. */
function entrySource(root, packs) {
  const abs = (p) => JSON.stringify(join(root, p));
  return `
import { toJSONSchema } from "zod";
import { coreRegistry } from ${abs("packages/core/src/index.ts")};
import { products } from ${abs("products/index.ts")};
import { HELP } from ${abs("packages/create-composable-os/src/main.ts")};
import { GATEKEEPER_MODULES } from ${abs("packages/sdk/src/contract.ts")};
${packs.map((id, i) => `import pack${i} from ${abs(`packs/${id}/index.ts`)};`).join("\n")}
const packs = { ${packs.map((id, i) => `${JSON.stringify(id)}: pack${i}`).join(", ")} };

const isSchema = (v) => v !== null && typeof v === "object" && "_zod" in v;
function schema(v, io) {
  try {
    return toJSONSchema(v, { io, unrepresentable: "any", cycles: "ref", reused: "inline" });
  } catch (error) {
    return { unrepresentable: String(error?.message ?? error) };
  }
}
// Definitions to data: schemas become JSON Schema (the input as a caller writes it, the output as
// the host answers), functions are dropped, everything else is kept as it is.
function plain(v, key, seen = new Set()) {
  if (isSchema(v)) return schema(v, key === "output" ? "output" : "input");
  if (typeof v === "function" || typeof v === "symbol" || v === undefined) return undefined;
  if (v === null || typeof v !== "object") return v;
  if (seen.has(v)) return undefined;
  seen.add(v);
  if (Array.isArray(v)) {
    const out = v.map((x) => plain(x, undefined, seen)).filter((x) => x !== undefined);
    seen.delete(v);
    return out;
  }
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const p = plain(x, k, seen);
    if (p !== undefined) out[k] = p;
  }
  seen.delete(v);
  return out;
}

const OP_KEYS = [
  "name", "description", "permission", "risk", "audiences", "actors", "toolOnly", "hostInternal",
  "deskOnly", "packPermissions", "packGrantable", "packRestricted", "packAnyStaff", "staffInput",
  "alwaysReview", "bookkeeping", "hostStep",
];
export function facts() {
  const operations = coreRegistry.list().map((op) => {
    const out = {};
    for (const k of OP_KEYS) if (op[k] !== undefined && typeof op[k] !== "function") out[k] = plain(op[k], k);
    // What decides review or reach but is code, not data: said as a fact.
    if (typeof op.reviewWhen === "function") out.reviewWhen = true;
    if (op.mcp?.expose === false) out.mcpHidden = true;
    out.input = schema(op.input, "input");
    out.output = schema(op.output, "output");
    return out;
  });
  return {
    operations,
    packs: Object.fromEntries(Object.entries(packs).map(([id, m]) => [id, plain(m)])),
    products: Object.values(products).map((p) => plain(p)),
    help: HELP,
    gatekeeperModules: [...GATEKEEPER_MODULES],
  };
}
`;
}

/** The behaviours and declarations an object may carry: ObjectSpec's `*Spec` keys, with their doc. */
function behaviours(root) {
  const require = createRequire(join(root, "apps", "docs", "package.json"));
  const ts = require("typescript");
  const file = join(root, "packages", "sdk", "src", "contract.ts");
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const out = [];
  ts.forEachChild(source, (node) => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== "ObjectSpec") return;
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      const type = member.type.getText(source);
      const spec = type.match(/^(?:readonly\s+)?(\w+Spec)(\[\])?$/);
      if (!spec) continue;
      const doc = ts
        .getJSDocCommentsAndTags(member)
        .map((d) => (typeof d.comment === "string" ? d.comment : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      out.push({ key: member.name.getText(source), type, doc });
    }
  });
  return out;
}

/** Runs the bundle and returns the code's facts. */
export async function extractCodeFacts(root) {
  const require = createRequire(join(root, "apps", "docs", "package.json"));
  const { build } = require("esbuild");
  const packs = packIds(root);
  const result = await build({
    stdin: { contents: entrySource(root, packs), resolveDir: join(root, "packages", "core") },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    logLevel: "error",
    // Packages the CLI loads lazily and the bundle never calls.
    external: ["typescript", "esbuild", "sucrase"],
    plugins: [
      {
        name: "cloudflare-stub",
        setup(b) {
          b.onResolve({ filter: /^cloudflare:/ }, (a) => ({ path: a.path, namespace: "cf" }));
          b.onLoad({ filter: /.*/, namespace: "cf" }, () => ({
            contents: CLOUDFLARE_STUB,
            loader: "js",
          }));
        },
      },
    ],
  });
  const dir = join(root, "apps", "docs", "node_modules", ".cache");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `extract-${process.pid}.mjs`);
  writeFileSync(out, result.outputFiles[0].text);
  let mod;
  try {
    mod = await import(pathToFileURL(out).href);
  } finally {
    // The bundle is several megabytes; it is read once.
    rmSync(out, { force: true });
  }
  // Plain data only: a round trip drops anything JSON cannot carry.
  const facts = JSON.parse(JSON.stringify(mod.facts()));
  facts.behaviours = behaviours(root);
  return facts;
}
