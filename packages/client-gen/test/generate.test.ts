// Stage 23, acceptance criteria 5 to 7 (ADR 0418): the generator.
//
// - 5, types: a fixture client app compiles against its generated client, and fails `tsc` once
//   an operation's input changes and the client is generated again.
// - 6, per product: a product with an extension tool types it; one without does not.
// - 7, the bundle split: the built customer entry point names no staff operation.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContract, defineOperation } from "@composable-os/core";
import deals from "@composable-os/extension-deals";
import leads from "@composable-os/extension-leads";
import lifecycle from "@composable-os/extension-lifecycle";
import { build } from "esbuild";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { operationsFor, productContract, renderClient } from "../src/index.ts";
import { runClient } from "../src/node/cli.ts";
import greeter from "./fixtures/greeter/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, "..", "..", "client", "src", "index.ts");
// Scratch directories inside the package, so module resolution finds the workspace packages.
const scratchRoot = join(here, "..", ".scratch");
mkdirSync(scratchRoot, { recursive: true });
const scratch = () => mkdtempSync(join(scratchRoot, "t-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

/** Type-checks `files` (name → text) as one program, with the runtime resolved from source. */
function typecheck(dir: string, files: Record<string, string>): string[] {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const program = ts.createProgram(
    Object.keys(files).map((name) => join(dir, name)),
    {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      lib: ["lib.es2023.d.ts"],
      types: [],
      paths: {
        "@composable-os/client": [runtime],
        "@composable-os/extension-deals/headless": [
          join(here, "..", "..", "..", "extensions", "deals", "headless.ts"),
        ],
      },
    },
  );
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file
      ? `${d.file.fileName.split("/").pop()}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}`
      : "";
    return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
  });
}

const greetOp = (input: z.ZodObject) =>
  defineOperation({
    name: "fixture.greet",
    description: "Fixture: greets the caller by name. Used by the type-break test. Writes nothing.",
    input,
    output: z.object({ greeting: z.string() }),
    permission: "records:read",
    risk: "read",
    audiences: ["customer"],
    handler: async () => ({ greeting: "hi" }),
  });

const saveOp = defineOperation({
  name: "fixture.save",
  description: "Fixture: saves a note for the caller. Used by the type-break test. A write.",
  input: z.object({ text: z.string() }),
  output: z.object({ id: z.string() }),
  permission: "records:read",
  risk: "write",
  audiences: ["customer"],
  handler: async () => ({ id: "x" }),
});

/** A client app written against the generated customer entry point. */
const APP = `import { createCustomerClient } from "./customer.ts";

const api = createCustomerClient({ baseUrl: "https://host.example" });

export async function hello(): Promise<string> {
  const out = await api.call("fixture.greet", { name: "Ada" });
  return out.greeting;
}

export const greeting = api.query("fixture.greet", { name: "Ada" });
export const save = api.mutation("fixture.save");
export const saved = save.mutationFn({ text: "hello" });
`;

describe("types (criterion 5)", () => {
  it("a client app compiles, and fails tsc once the operation's input changes", () => {
    const dir = scratch();
    const before = renderClient(buildContract([greetOp(z.object({ name: z.string() })), saveOp]), {
      product: "fixture",
    });
    expect(
      typecheck(dir, { "customer.ts": before["customer.ts"] as string, "app.ts": APP }),
    ).toEqual([]);

    // The operation now takes `fullName`: generate again, and the app no longer compiles.
    const after = renderClient(
      buildContract([greetOp(z.object({ fullName: z.string() })), saveOp]),
      { product: "fixture" },
    );
    const errors = typecheck(dir, { "customer.ts": after["customer.ts"] as string, "app.ts": APP });
    console.log(`tsc after the input changed:\n${errors.join("\n")}`);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toMatch(/app\.ts:6 .*name.*fullName|app\.ts:6 .*fullName/s);
  });

  it("a query cannot be used as a mutation, nor the reverse", () => {
    const dir = scratch();
    const files = renderClient(buildContract([greetOp(z.object({ name: z.string() })), saveOp]), {
      product: "fixture",
    });
    const wrong = `import { createCustomerClient } from "./customer.ts";
const api = createCustomerClient({ baseUrl: "https://host.example" });
export const a = api.mutation("fixture.greet");
export const b = api.query("fixture.save", { text: "x" });
`;
    const errors = typecheck(dir, {
      "customer.ts": files["customer.ts"] as string,
      "app.ts": wrong,
    });
    expect(errors.filter((e) => e.startsWith("app.ts"))).toHaveLength(2);
  });

  it("the CRM product's whole client compiles", () => {
    const dir = scratch();
    const files = renderClient(productContract([deals, leads, lifecycle]), { product: "crm" });
    const app = `import { createCustomerClient } from "./customer.ts";
import { createStaffClient } from "./staff.ts";
import { createDealsHooks } from "@composable-os/extension-deals/headless";
const customer = createCustomerClient({ baseUrl: "https://h" });
const staff = createStaffClient({ baseUrl: "https://h" });
export const me = customer.query("me.get", {});
export const update = customer.mutation("me.update");
export const people = staff.query("person.list", {});
export const stages = staff.call("x.deals.stageMetrics", { pipelineId: "x" });
// The Deals pack's headless entry takes the generated staff client as it is (criterion: pack hooks).
export const dealsHooks = createDealsHooks(
  <T>(o: { queryKey: readonly unknown[]; queryFn: () => Promise<T> }) => ({ data: undefined as T | undefined, isPending: true, error: o.queryKey }),
  staff,
);
`;
    expect(typecheck(dir, { ...files, "app.ts": app })).toEqual([]);
  });
});

describe("per product (criterion 6)", () => {
  it("a product with the extension types its tool; one without does not", () => {
    const withIt = renderClient(productContract([greeter]), { product: "with" });
    const without = renderClient(productContract([]), { product: "without" });
    expect(withIt["customer.ts"]).toContain('"x.greeter.greet": {');
    expect(withIt["customer.ts"]).toContain("input: { name: string }");
    expect(without["customer.ts"]).not.toContain("x.greeter");
    expect(without["staff.ts"]).not.toContain("x.greeter");
  });

  it("cos client generate reads the product's registry and the org's own extension", async () => {
    const out = scratch();
    const lines: string[] = [];
    const code = await runClient(
      [
        "generate",
        "--out",
        out,
        "--product",
        "crm",
        "--extension",
        join(here, "fixtures", "greeter"),
      ],
      { out: (l) => lines.push(l), err: (l) => lines.push(l) },
    );
    expect(code, lines.join("\n")).toBe(0);
    const customer = readFileSync(join(out, "customer.ts"), "utf8");
    const staff = readFileSync(join(out, "staff.ts"), "utf8");
    expect(customer).toContain('"x.greeter.greet"');
    // The product's packs: Deals' tools are staff tools.
    expect(staff).toContain('"x.deals.stageMetrics"');
    expect(customer).not.toContain("x.deals.");
  });
});

describe("the bundle split (criterion 7)", () => {
  it("the built customer entry point contains no staff operation name", async () => {
    const contract = productContract([deals, greeter]);
    const files = renderClient(contract, { product: "crm" });
    const dir = scratch();
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const outfile = join(dir, "customer.bundle.js");
    await build({
      entryPoints: [join(dir, "customer.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "neutral",
      minify: true,
      alias: { "@composable-os/client": runtime },
      logLevel: "error",
    });
    const built = readFileSync(outfile, "utf8");
    const customerNames = new Set(operationsFor(contract, "customer").map((op) => op.name));
    const staffOnly = contract.operations.map((op) => op.name).filter((n) => !customerNames.has(n));
    expect(staffOnly.length).toBeGreaterThan(200);
    expect(
      staffOnly.filter((name) => built.includes(`"${name}"`) || built.includes(`'${name}'`)),
    ).toEqual([]);
    // Not vacuous: the customer operations are in it.
    for (const name of customerNames) expect(built).toContain(name);
  });
});
