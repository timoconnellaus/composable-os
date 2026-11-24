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
import type { ApiContract, PackRolesFile } from "@composable-os/core/http-contract";
import deals from "@composable-os/pack-deals";
import leads from "@composable-os/pack-leads";
import lifecycle from "@composable-os/pack-lifecycle";
import { build } from "esbuild";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  operationsFor,
  productContract,
  renderClient,
  renderOwnerClient,
  renderRoleClient,
} from "../src/index.ts";
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
      jsx: ts.JsxEmit.ReactJSX,
      skipLibCheck: true,
      lib: ["lib.es2023.d.ts"],
      types: [],
      paths: {
        "@composable-os/client": [runtime],
        "@composable-os/pack-deals/client": [
          join(here, "..", "..", "..", "packs", "deals", "client", "index.ts"),
        ],
        "@composable-os/pack-ticketing/client": [
          join(here, "..", "..", "..", "packs", "ticketing", "client", "index.ts"),
        ],
        "@composable-os/pack-rostering/client": [
          join(here, "..", "..", "..", "packs", "rostering", "client", "index.ts"),
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
import { createDealsHooks } from "@composable-os/pack-deals/client";
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

describe("a pack role's client (ADR 0451)", () => {
  const api = join(here, "..", "..", "core", "api", "v1");
  const staff = JSON.parse(readFileSync(join(api, "staff.json"), "utf8")) as ApiContract;
  const roles = JSON.parse(readFileSync(join(api, "roles.json"), "utf8")) as PackRolesFile;
  const door = roles.roles.find((r) => r.name === "ticketing.door") as PackRolesFile["roles"][0];

  it("an app with the door role's client names no other staff operation", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "door.ts"), renderRoleClient(staff, door, { product: "gym" }));
    writeFileSync(
      join(dir, "app.ts"),
      'import { createTicketingDoorClient } from "./door.ts";\nexport const door = (fetch: never) => createTicketingDoorClient({ baseUrl: "https://admin.gym.example", fetch });\n',
    );
    const outfile = join(dir, "app.bundle.js");
    await build({
      entryPoints: [join(dir, "app.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "neutral",
      minify: true,
      alias: { "@composable-os/client": runtime },
      logLevel: "error",
    });
    const built = readFileSync(outfile, "utf8");
    const others = staff.operations
      .map((op) => op.name)
      .filter((n) => !door.operations.includes(n));
    expect(others.length).toBeGreaterThan(200);
    expect(others.filter((n) => built.includes(`"${n}"`) || built.includes(`'${n}'`))).toEqual([]);
    for (const name of door.operations) expect(built).toContain(name);
  });

  it("types the role's calls, and its reads take only the role's objects", () => {
    const dir = scratch();
    const errors = typecheck(dir, {
      "door.ts": renderRoleClient(staff, door, { product: "gym" }),
      "scan.ts": [
        'import { createTicketingDoorClient } from "./door.ts";',
        'const door = createTicketingDoorClient({ baseUrl: "https://admin.gym.example" });',
        'export const ok = () => door.call("x.ticketing.checkIn", { code: "TCK-1" });',
        'export const tickets = () => door.call("record.list", { object: "ticketing.ticket" });',
        'export const people = () => door.call("record.list", { object: "person" });',
        'export const other = () => door.call("person.list", {});',
      ].join("\n"),
    });
    expect(errors.some((e) => e.startsWith("scan.ts:5"))).toBe(true);
    expect(errors.some((e) => e.startsWith("scan.ts:6"))).toBe(true);
    expect(errors.filter((e) => /scan\.ts:[34]/.test(e))).toEqual([]);
  });

  it("wires the native door scanner block's hooks with no cast; a hook outside the role does not compile (ADR 0453)", () => {
    const dir = scratch();
    const repo = join(here, "..", "..", "..");
    const host = join(repo, "templates", "client", "apps", "mobile", "src", "host.ts");
    const block = join(
      repo,
      "packs",
      "ticketing",
      "blocks",
      "ticketing-native-scanner",
      "door-scanner-screen.tsx",
    );
    const errors = typecheck(dir, {
      "door.ts": renderRoleClient(staff, door, { product: "gym" }),
      "wire.ts": [
        'import { createTicketingHooks, type UseMutation, type UseQuery, type UseState } from "@composable-os/pack-ticketing/client";',
        `import type { DoorScannerScreen } from ${JSON.stringify(block)};`,
        `import { staffSession } from ${JSON.stringify(host)};`,
        'import { createTicketingDoorClient } from "./door.ts";',
        "declare const react: { useQuery: UseQuery; useMutation: UseMutation; useState: UseState };",
        "declare const staff: ReturnType<typeof staffSession>;",
        "const ticketing = createTicketingHooks(react, staff.client(createTicketingDoorClient));",
        "type ScannerProps = Parameters<typeof DoorScannerScreen>[0];",
        'export const props: ScannerProps["ticketing"] = ticketing;',
        "export const checkIn = ticketing.useCheckIn();",
        "// @ts-expect-error: the door role cannot back the events on sale.",
        "export const events = ticketing.useEventsOnSale();",
        "// @ts-expect-error: nor starting an order.",
        "export const start = ticketing.useStartOrder();",
      ].join("\n"),
    });
    // No error in the wiring: no cast, and each @ts-expect-error is used (an unused one is an error).
    expect(errors.filter((e) => e.startsWith("wire.ts"))).toEqual([]);
  });
});

describe("a pack role's client with grants (stage 45 step 7, ADR 0600)", () => {
  const api = join(here, "..", "..", "core", "api", "v1");
  const staff = JSON.parse(readFileSync(join(api, "staff.json"), "utf8")) as ApiContract;
  const roles = JSON.parse(readFileSync(join(api, "roles.json"), "utf8")) as PackRolesFile;
  const coach = roles.roles.find((r) => r.name === "bookings.coach") as PackRolesFile["roles"][0];
  const roster = roles.grants?.find((g) => g.permission === "rostering:roster");
  const withGrant = {
    ...coach,
    operations: [...new Set([...coach.operations, ...(roster?.operations ?? [])])].sort(),
  };

  it("the release lists each grantable permission with the tools a grant of it opens", () => {
    expect(roster?.operations).toEqual(
      expect.arrayContaining(["x.rostering.week", "x.rostering.take", "x.rostering.me"]),
    );
    expect(roster?.operations).not.toContain("x.rostering.assign");
    expect(roles.grants?.find((g) => g.permission === "rostering:pay")).toMatchObject({
      restricted: true,
    });
  });

  it("a coach's client with rostering:roster wires the native rostering blocks with no cast; the rosterers' hooks do not compile", () => {
    const dir = scratch();
    const repo = join(here, "..", "..", "..");
    const host = join(repo, "templates", "client", "apps", "mobile", "src", "host.ts");
    const blocks = join(repo, "packs", "rostering", "blocks");
    const errors = typecheck(dir, {
      "coach.ts": renderRoleClient(staff, withGrant, {
        product: "gym",
        grants: ["rostering:roster"],
      }),
      "plain.ts": renderRoleClient(staff, coach, { product: "gym" }).replaceAll(
        "createBookingsCoachClient",
        "createPlainCoachClient",
      ),
      "wire.ts": [
        'import { createRosteringHooks, type UseMutation, type UseQuery } from "@composable-os/pack-rostering/client";',
        `import type { MyShiftsScreen } from ${JSON.stringify(join(blocks, "rostering-native-my-shifts", "my-shifts-screen.tsx"))};`,
        `import type { OffersScreen } from ${JSON.stringify(join(blocks, "rostering-native-offers", "offers-screen.tsx"))};`,
        `import type { RosterScreen } from ${JSON.stringify(join(blocks, "rostering-native-roster", "roster-screen.tsx"))};`,
        `import type { MyAvailabilityScreen } from ${JSON.stringify(join(blocks, "rostering-native-my-availability", "my-availability-screen.tsx"))};`,
        `import type { MyCalendarScreen } from ${JSON.stringify(join(blocks, "rostering-native-my-calendar", "my-calendar-screen.tsx"))};`,
        `import { staffSession } from ${JSON.stringify(host)};`,
        'import { createBookingsCoachClient } from "./coach.ts";',
        'import { createPlainCoachClient } from "./plain.ts";',
        "declare const react: { useQuery: UseQuery; useMutation: UseMutation };",
        "declare const staff: ReturnType<typeof staffSession>;",
        "const rostering = createRosteringHooks(react, staff.client(createBookingsCoachClient));",
        'export const mine: Parameters<typeof MyShiftsScreen>[0]["rostering"] = rostering;',
        'export const offers: Parameters<typeof OffersScreen>[0]["rostering"] = rostering;',
        'export const week: Parameters<typeof RosterScreen>[0]["rostering"] = rostering;',
        'export const away: Parameters<typeof MyAvailabilityScreen>[0]["rostering"] = rostering;',
        'export const calendar: Parameters<typeof MyCalendarScreen>[0]["rostering"] = rostering;',
        "// @ts-expect-error: the grant opens the team's tools, never the rosterers'.",
        "export const assign = rostering.useAssign();",
        "// @ts-expect-error: nor pay.",
        "export const pay = rostering.usePeriodTotals(null);",
        "const plain = createRosteringHooks(react, staff.client(createPlainCoachClient));",
        "// @ts-expect-error: without the grant, a coach's client holds no roster.",
        "export const none = plain.useWeek({ from: '2026-06-01', to: '2026-06-07' });",
      ].join("\n"),
    });
    expect(errors.filter((e) => e.startsWith("wire.ts"))).toEqual([]);
    // The header says why it holds more than the role.
    expect(
      renderRoleClient(staff, withGrant, { product: "gym", grants: ["rostering:roster"] }),
    ).toContain("With the grants rostering:roster");
  });
});

describe("the owner's client (stage 60, ADR 0872)", () => {
  const api = join(here, "..", "..", "core", "api", "v1");
  const staff = JSON.parse(readFileSync(join(api, "staff.json"), "utf8")) as ApiContract;
  const roles = JSON.parse(readFileSync(join(api, "roles.json"), "utf8")) as PackRolesFile;
  const owner = roles.owner as NonNullable<PackRolesFile["owner"]>;

  it("an app with the owner's client names no other staff operation", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "owner.ts"), renderOwnerClient(staff, owner, { product: "gym" }));
    writeFileSync(
      join(dir, "app.ts"),
      'import { createOwnerClient } from "./owner.ts";\nexport const owner = (fetch: never) => createOwnerClient({ baseUrl: "https://admin.gym.example", fetch });\n',
    );
    const outfile = join(dir, "app.bundle.js");
    await build({
      entryPoints: [join(dir, "app.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "neutral",
      minify: true,
      alias: { "@composable-os/client": runtime },
      logLevel: "error",
    });
    const built = readFileSync(outfile, "utf8");
    const others = staff.operations
      .map((op) => op.name)
      .filter((n) => !owner.operations.includes(n));
    expect(others.filter((n) => built.includes(`"${n}"`) || built.includes(`'${n}'`))).toEqual([]);
    for (const name of owner.operations) expect(built).toContain(name);
  });

  it("types its calls; record.list and any other staff operation are type errors", () => {
    const dir = scratch();
    const errors = typecheck(dir, {
      "owner.ts": renderOwnerClient(staff, owner, { product: "gym" }),
      "use.ts": [
        'import { createOwnerClient } from "./owner.ts";',
        'const owner = createOwnerClient({ baseUrl: "https://admin.gym.example" });',
        'export const waiting = () => owner.call("approval.list", { status: "awaiting_review" });',
        'export const records = () => owner.call("record.list", { object: "person" });',
        'export const other = () => owner.call("person.list", {});',
      ].join("\n"),
    });
    expect(errors.some((e) => e.startsWith("use.ts:4"))).toBe(true);
    expect(errors.some((e) => e.startsWith("use.ts:5"))).toBe(true);
    expect(errors.filter((e) => /use\.ts:3/.test(e))).toEqual([]);
  });

  it("drives the owner's hooks through the staff session with no cast (ADR 0453)", () => {
    const dir = scratch();
    const host = join(here, "..", "..", "..", "templates", "client", "apps", "mobile", "src");
    const errors = typecheck(dir, {
      "owner.ts": renderOwnerClient(staff, owner, { product: "gym" }),
      "wire.ts": [
        'import { createOwnerHooks, type OwnerHooks, type OwnerUseMutation, type OwnerUseQuery } from "@composable-os/client";',
        `import { staffSession } from ${JSON.stringify(join(host, "host.ts"))};`,
        'import { createOwnerClient } from "./owner.ts";',
        "declare const react: { useQuery: OwnerUseQuery; useMutation: OwnerUseMutation };",
        "declare const staff: ReturnType<typeof staffSession>;",
        "const today = createOwnerHooks(react, staff.client(createOwnerClient));",
        'type Approvals = Pick<OwnerHooks, "useWaiting" | "useChangeSet" | "useApprove" | "useReject">;',
        'type Inbox = Pick<OwnerHooks, "useNotices" | "useUnreadCount" | "useMarkRead" | "useMe">;',
        "export const approvals: Approvals = today;",
        "export const inbox: Inbox = today;",
      ].join("\n"),
    });
    expect(errors.filter((e) => e.startsWith("wire.ts"))).toEqual([]);
  });

  it("refuses an operation the staff contract does not have", () => {
    expect(() =>
      renderOwnerClient(staff, { operations: ["today.nothing"] }, { product: "gym" }),
    ).toThrow(/today\.nothing/);
  });
});
