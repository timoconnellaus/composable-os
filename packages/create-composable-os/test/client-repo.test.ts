// Stage 24: `cos` in a company's own repository, against the fake Cloudflare API and a fake GitHub
// serving fixture releases whose client kit is the real one (scripts/release/client-kit.ts).
//
// - 1 (deploy part): `cos create` then `cos deploy` yields a host and a web app bound to it. The
//   sign-in on the web app's hostname is apps/app/test/company-web.test.ts, which runs the
//   template's own host module against the real host.
// - 2: `cos init` in an Astro-on-a-Worker repo with its own D1 and an Expo app adds only its
//   files, shows every change to one that exists, and afterwards both apps' calls compile, typed.
// - 3 (config part): a web app with a database binding of its own is refused.
// - 7: a product with no packs deploys a host told to install none.
// - 8: an org extension is installed by deploy (pinned in BLOBS); a failing one stops the deploy
//   with nothing changed.
// - 10: `cos add` copies a block from the matching release and writes the lock; `cos diff` shows
//   upstream changes without touching a local edit.
// - 11: `cos upgrade` to a release that changes an operation reports the type error and deploys
//   nothing.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { repositoryPackIds } from "@composable-os/product/packs";
import { buildFixtureRelease } from "@composable-os/release/testing";
import ts from "typescript";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectClientKit } from "../../../scripts/release/client-kit.ts";
import { runIn, startWorld, type World } from "./world.ts";

const here = import.meta.dirname;
const root = join(here, "..", "..", "..");
// Scratch repos inside the package, so module resolution finds the workspace packages.
const scratchRoot = join(here, ".scratch");
mkdirSync(scratchRoot, { recursive: true });
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));
const scratch = () => mkdtempSync(join(scratchRoot, "repo-"));

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** The real client kit, as a release builds it (every pack carried), with `change` applied. */
function kit(change: (files: Record<string, string>) => void = () => {}) {
  const files = Object.fromEntries(
    [...collectClientKit(root, repositoryPackIds(root))].map(([p, b]) => [p, decode(b)]),
  );
  // A block, so cos add and cos diff have one to work on in every fixture release.
  files["blocks/greeting/block.json"] = JSON.stringify({
    name: "greeting",
    pack: null,
    skin: "web",
    operations: ["me.get"],
    files: ["greeting.tsx"],
    dependsOn: [],
  });
  files["blocks/greeting/greeting.tsx"] =
    "export function Greeting({ name }: { name: string }) {\n  return <p>Hello, {name}</p>;\n}\n";
  change(files);
  return files;
}

let world: World;
let cwd = "";
const cos = (...argv: string[]) => runIn(world, ...argv, ...(cwd ? ["--dir", cwd] : []));

beforeEach(async () => {
  world = await startWorld();
  cwd = "";
});
afterEach(() => world.server.close());

async function publish(
  version: string,
  change?: (files: Record<string, string>) => void,
  options: { clientGatekeepers?: boolean } = {},
) {
  await world.github.publish(
    await buildFixtureRelease({ version, client: kit(change), ...options }),
  );
}

/** A created repo with a stand-in build of its web app (vite is not run in these tests). */
async function created(): Promise<string> {
  const dir = join(scratch(), "shop");
  const made = await runIn(world, "create", dir, "--label", "Shop", "--version", "1.0.0");
  expect(made.code, made.output).toBe(0);
  const server = join(dir, "apps", "web", "dist", "server");
  mkdirSync(join(dir, "apps", "web", "dist", "client"), { recursive: true });
  mkdirSync(server, { recursive: true });
  writeFileSync(join(server, "index.js"), "export default { fetch: () => new Response('shop') };");
  writeFileSync(
    join(server, "wrangler.json"),
    JSON.stringify({
      name: "shop-web",
      main: "index.js",
      compatibility_date: "2026-10-01",
      services: [{ binding: "HOST", service: "shop-app", entrypoint: "ClientApp" }],
      assets: { directory: "../client" },
    }),
  );
  writeFileSync(join(dir, "apps", "web", "dist", "client", "favicon.svg"), "<svg/>");
  cwd = dir;
  return dir;
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const mutating = () => world.cf.calls.filter((c) => c.method !== "GET");

describe("cos create", () => {
  it("writes a client repo from the release's template, named for it", async () => {
    await publish("1.0.0");
    const dir = await created();
    expect(read(dir, "product.ts")).toContain('platform: { version: "1.0.0", release: "demo"');
    expect(read(dir, "product.ts")).toContain('id: "shop"');
    const web = JSON.parse(read(dir, "apps/web/package.json"));
    expect(web.name).toBe("shop-web");
    expect(web.dependencies["@composable-os/client"]).toBe("1.0.0");
    const wrangler = read(dir, "apps/web/wrangler.jsonc");
    expect(wrangler).toContain('"name": "shop-web"');
    // Bound to the host as `cos deploy` names it for this product (issue #155).
    expect(wrangler).toContain('"service": "shop-app", "entrypoint": "ClientApp"');
    expect(wrangler).not.toMatch(/d1_databases|r2_buckets|kv_namespaces/);
    expect(read(dir, ".gitignore")).toContain("node_modules");
    expect(existsSync(join(dir, "skills", "start-client-app", "SKILL.md"))).toBe(true);
    // The typed client is generated for this product: no pack is on, so no pack's tools.
    const client = read(dir, "apps/web/src/client/customer.ts");
    expect(client).toContain('"me.get"');
    expect(client).not.toContain("x.deals.");
    expect(read(dir, "AGENTS.md")).toContain("Never open a database");
  });

  it("says the edge rule is a step to do before opening to the public", async () => {
    await publish("1.0.0");
    const made = await runIn(world, "create", join(scratch(), "two"));
    expect(made.output).toContain("rate limiting rule");
  });

  it("adds the Expo app with --with-mobile, on the same typed client (criterion 5's template)", async () => {
    await publish("1.0.0");
    const plain = join(scratch(), "plain");
    expect((await runIn(world, "create", plain)).code).toBe(0);
    expect(existsSync(join(plain, "apps", "mobile"))).toBe(false);
    const dir = join(scratch(), "gym");
    const made = await runIn(world, "create", dir, "--with-mobile", "--label", "Gym");
    expect(made.code, made.output).toBe(0);
    expect(read(dir, "product.ts")).toContain('mobile: { dir: "apps/mobile" }');
    expect(JSON.parse(read(dir, "apps/mobile/package.json")).name).toBe("gym-mobile");
    expect(JSON.parse(read(dir, "apps/mobile/app.json")).expo).toMatchObject({
      name: "Gym",
      slug: "gym",
    });
    expect(read(dir, "apps/mobile/src/client/customer.ts")).toBe(
      read(dir, "apps/web/src/client/customer.ts"),
    );
  });

  it("refuses a folder that is not empty", async () => {
    await publish("1.0.0");
    const dir = scratch();
    writeFileSync(join(dir, "x"), "");
    expect((await runIn(world, "create", dir)).code).toBe(1);
  });
});

describe("cos deploy", () => {
  it("deploys the host from the release and the web app bound to it (criteria 1 and 7)", async () => {
    await publish("1.0.0");
    await created();
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(0);
    // The host is named for the client's product (issue #155), not the release's (demo-*).
    for (const worker of ["shop-app", "shop-runner", "shop-web"]) {
      expect(world.cf.scripts.has(worker), worker).toBe(true);
    }
    expect(world.cf.scripts.has("demo-app")).toBe(false);
    // One binding, to the host's ClientApp entrypoint, and nothing else.
    expect(world.cf.liveBinding("shop-web", "HOST")).toEqual({
      type: "service",
      name: "HOST",
      service: "shop-app",
      entrypoint: "ClientApp",
    });
    // No pack listed: the runner is told to install none (base records only).
    expect(world.cf.liveBinding("shop-runner", "COS_PACKS")?.text).toBe("");
    expect(deployed.output).toContain("Web app: https://shop-web.acme.workers.dev");
  });

  it("names the host for the client's product at its first install, and the label (issue #155)", async () => {
    await publish("1.0.0");
    await created();
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(0);
    // Every Worker and resource takes the client's names; the release (demo-*) is unchanged.
    expect([...world.cf.d1.values()].some((d) => d.name === "shop")).toBe(true);
    expect([...world.cf.d1.values()].some((d) => d.name === "demo")).toBe(false);
    expect([...world.cf.scripts.keys()].filter((n) => n.startsWith("demo-"))).toEqual([]);
    // The product's label, for every surface that shows its name, on the app and the runner.
    expect(world.cf.liveBinding("shop-app", "COS_PRODUCT_LABEL")?.text).toBe("Shop");
    expect(world.cf.liveBinding("shop-runner", "COS_PRODUCT_LABEL")?.text).toBe("Shop");
    // A second deploy finds the host under its own names and keeps them.
    const again = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(again.code, again.output).toBe(0);
    expect([...world.cf.d1.values()].filter((d) => d.name === "shop")).toHaveLength(1);
    expect([...world.cf.scripts.keys()].filter((n) => n.startsWith("demo-"))).toEqual([]);
  });

  it("product.ts's location hint goes to the first install's D1 and R2 only (ADR 0580)", async () => {
    await publish("1.0.0");
    const dir = await created();
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(0);
    // No location in product.ts: no hint, and the installer asks nothing.
    expect(world.cf.creates.map((c) => c.locationHint)).toEqual([undefined, undefined]);
    // Added later: the host exists, so nothing is moved or sent, and the deploy says so.
    writeFileSync(
      join(dir, "product.ts"),
      read(dir, "product.ts").replace(/(packs: \[[^\]]*\],)/, '$1\n  location: "oc",'),
    );
    const again = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(again.code, again.output).toBe(0);
    expect(again.output).toContain("a setting cannot move them");
    expect(world.cf.creates).toHaveLength(2);
  });

  it("a new host from a product.ts with location oc is created with the hint", async () => {
    await publish("1.0.0");
    const dir = await created();
    writeFileSync(
      join(dir, "product.ts"),
      read(dir, "product.ts").replace(/(packs: \[[^\]]*\],)/, '$1\n  location: "oc",'),
    );
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(0);
    expect(world.cf.creates).toEqual([
      { type: "d1", name: "shop", locationHint: "oc" },
      { type: "r2", name: "shop-blobs", locationHint: "oc" },
    ]);
  });

  it("keeps the names of a host deployed before client names, and never renames it (ADR 0193)", async () => {
    await publish("1.0.0");
    await created();
    // A host installed from the release with its own names, as every deploy did before #155.
    const installed = await cos(
      "install",
      "--product",
      "demo",
      "--version",
      "1.0.0",
      "--yes",
      "--packs",
      "",
    );
    expect(installed.code, installed.output).toBe(0);
    expect(world.cf.scripts.has("demo-app")).toBe(true);
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(0);
    expect(world.cf.scripts.has("shop-app")).toBe(false);
    expect([...world.cf.d1.values()].some((d) => d.name === "shop")).toBe(false);
    expect(world.cf.liveBinding("shop-web", "HOST")?.service).toBe("demo-app");
    // The label still reaches it: it is not a name.
    expect(world.cf.liveBinding("demo-app", "COS_PRODUCT_LABEL")?.text).toBe("Shop");
  });

  it("refuses a web app with a database of its own (criterion 3)", async () => {
    await publish("1.0.0");
    const dir = await created();
    const config = join(dir, "apps", "web", "dist", "server", "wrangler.json");
    const built = JSON.parse(readFileSync(config, "utf8"));
    writeFileSync(config, JSON.stringify({ ...built, d1_databases: [{ binding: "DB" }] }));
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code).toBe(1);
    expect(deployed.output).toContain("never opens a database");
    expect(world.cf.scripts.has("shop-web")).toBe(false);
  });

  it("installs the org's own extension, pinned in BLOBS (criterion 8)", async () => {
    await publish("1.0.0");
    const dir = await created();
    cpSync(join(root, "packs", "lifecycle"), join(dir, "extensions", "lifecycle"), {
      recursive: true,
      filter: (src) => !src.includes("node_modules"),
    });
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(0);
    const hash = world.cf.liveBinding("shop-runner", "COS_ORG_EXTENSIONS")?.text ?? "";
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const stored = world.cf.r2Objects.get(`shop-blobs/org-extensions/${hash}.json`);
    const parsed = JSON.parse(decode(stored ?? new Uint8Array()));
    expect(parsed.extensions.map((e: { id: string }) => e.id)).toEqual(["lifecycle"]);
    expect(Object.keys(parsed.extensions[0].files)).toContain("index.ts");
  });

  it("stops before anything changes when an extension fails cos ext check (criterion 8)", async () => {
    await publish("1.0.0");
    const dir = await created();
    mkdirSync(join(dir, "extensions", "broken"), { recursive: true });
    writeFileSync(
      join(dir, "extensions", "broken", "index.ts"),
      'import { defineExtension } from "@composable-os/sdk";\nexport default defineExtension({ id: "Broken!", version: "1", objects: {} } as never);\n',
    );
    world.cf.calls.length = 0;
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code).toBe(1);
    expect(deployed.output).toContain("nothing was deployed");
    expect(world.cf.calls).toEqual([]);
  });

  it("refuses a pack the release does not have, with no call to Cloudflare", async () => {
    await publish("1.0.0", (files) => {
      files["packs.json"] = '["deals"]\n';
    });
    const dir = await created();
    setPacks(dir, ["tickets"]);
    world.cf.calls.length = 0;
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code).toBe(1);
    expect(deployed.output).toContain("Demo 1.0.0 does not carry the pack tickets");
    expect(world.cf.calls).toEqual([]);
  });

  it("deploys a host told to install a pack the release carries (Ticketing)", async () => {
    await publish("1.0.0");
    const dir = await created();
    setPacks(dir, ["ticketing"]);
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(0);
    // The release carries it (its runner bundles every pack: apps/runner/test/shipped-list.test.ts,
    // where COS_PACKS=ticketing installs exactly Ticketing), and the runner is told to install it.
    expect(world.cf.liveBinding("shop-runner", "COS_PACKS")?.text).toBe("ticketing");
    // Content and Programs too, though their packages say optional: the runner installs every
    // pack an explicit COS_PACKS names (apps/runner/test/listed-packs.test.ts, ADR 0420).
    setPacks(dir, ["ticketing", "content", "programs"]);
    const again = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(again.code, again.output).toBe(0);
    expect(world.cf.liveBinding("shop-runner", "COS_PACKS")?.text).toBe(
      "ticketing,content,programs",
    );
  });

  it("installs the packs a listed pack requires with it (Courses: Programs and Content)", async () => {
    await publish("1.0.0");
    const dir = await created();
    setPacks(dir, ["courses"]);
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(0);
    expect(deployed.output).toContain("Installing programs, content too");
    expect(world.cf.liveBinding("shop-runner", "COS_PACKS")?.text).toBe("courses,programs,content");
    // Listed already, nothing is brought or said.
    setPacks(dir, ["content", "programs", "courses"]);
    const again = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(again.code, again.output).toBe(0);
    expect(again.output).not.toContain("too: a pack product.ts lists requires");
    expect(world.cf.liveBinding("shop-runner", "COS_PACKS")?.text).toBe("content,programs,courses");
  });

  it("trusts only packs.json: a tool in the contract does not make a pack carried", async () => {
    // A release built before every pack was carried: its runner had the CRM's three packs, while
    // its contract (the union over the repository) already named Ticketing's tools.
    await publish("1.0.0", (files) => {
      files["packs.json"] = '["deals","leads","lifecycle"]\n';
      expect(files["contract/customer.json"]).toContain('"x.ticketing.');
    });
    const dir = await created();
    setPacks(dir, ["ticketing"]);
    world.cf.calls.length = 0;
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(1);
    expect(deployed.output).toContain("does not carry the pack ticketing");
    expect(world.cf.calls).toEqual([]);
  });
});

/** product.ts with these packs on. */
function setPacks(dir: string, packs: string[]) {
  writeFileSync(
    join(dir, "product.ts"),
    read(dir, "product.ts").replace(/packs: \[[^\]]*\],/, `packs: ${JSON.stringify(packs)},`),
  );
}

/** product.ts with these environments. */
function setEnvironments(dir: string, environments: Record<string, unknown>) {
  writeFileSync(
    join(dir, "product.ts"),
    read(dir, "product.ts").replace(
      /(packs: \[[^\]]*\],)/,
      `$1\n  environments: ${JSON.stringify(environments)},`,
    ),
  );
}

const secretOf = (worker: string, name: string) => world.cf.scripts.get(worker)?.secrets.get(name);

describe("a pack role's client in the mobile app (ADR 0451)", () => {
  it("cos client generate writes only the role's operations; cos deploy names the app's redirect", async () => {
    await publish("1.0.0");
    const dir = await created();
    setPacks(dir, ["ticketing"]);
    writeFileSync(
      join(dir, "product.ts"),
      read(dir, "product.ts").replace(
        /(\n\s*web: \{[^\n]*\},)/,
        '$1\n  mobile: { dir: "apps/mobile", roles: ["ticketing.door"] },',
      ),
    );
    const generated = await cos("client", "generate");
    expect(generated.code, generated.output).toBe(0);
    const door = read(dir, "apps/mobile/src/client/roles/ticketing.door.ts");
    expect(door).toContain("createTicketingDoorClient");
    expect(door).toContain('"x.ticketing.checkIn"');
    expect(door).not.toContain('"person.list"');
    expect(door).not.toContain('"x.ticketing.salesSummary"');
    // The customer client is still the customer's only.
    expect(read(dir, "apps/mobile/src/client/customer.ts")).not.toContain("x.ticketing.checkIn");
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(0);
    expect(world.cf.liveBinding("shop-app", "NATIVE_REDIRECT_URIS")?.text).toBe(
      "http://127.0.0.1/cos-sign-in,shop://staff-sign-in",
    );
  });

  it("lists the command-line door on a host with no mobile app too (ADR 0457)", async () => {
    await publish("1.0.0");
    await created();
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(0);
    expect(world.cf.liveBinding("shop-app", "NATIVE_REDIRECT_URIS")?.text).toBe(
      "http://127.0.0.1/cos-sign-in",
    );
  });

  it("sets each environment's app redirect from its scheme", async () => {
    await publish("1.0.0");
    const dir = await created();
    writeFileSync(
      join(dir, "product.ts"),
      read(dir, "product.ts").replace(
        /(\n\s*web: \{[^\n]*\},)/,
        '$1\n  mobile: { dir: "apps/mobile" },',
      ),
    );
    setEnvironments(dir, { staging: { mobile: { scheme: "shop-staging" } }, live: {} });
    expect((await cos("deploy", "--env", "staging", "--skip-build", "--no-typecheck")).code).toBe(
      0,
    );
    expect((await cos("deploy", "--env", "live", "--skip-build", "--no-typecheck")).code).toBe(0);
    expect(world.cf.liveBinding("shop-staging-app", "NATIVE_REDIRECT_URIS")?.text).toBe(
      "http://127.0.0.1/cos-sign-in,shop-staging://staff-sign-in",
    );
    expect(world.cf.liveBinding("shop-app", "NATIVE_REDIRECT_URIS")?.text).toBe(
      "http://127.0.0.1/cos-sign-in,shop://staff-sign-in",
    );
  });

  it("a role with grants gets the granted tools too, and nothing the grant does not open (stage 45 step 7)", async () => {
    await publish("1.0.0");
    const dir = await created();
    setPacks(dir, ["programs", "bookings", "rostering"]);
    writeFileSync(
      join(dir, "product.ts"),
      read(dir, "product.ts").replace(
        /(\n\s*web: \{[^\n]*\},)/,
        '$1\n  mobile: { dir: "apps/mobile", roles: ["rostering.team", { role: "bookings.coach", grants: ["rostering:roster"] }] },',
      ),
    );
    const generated = await cos("client", "generate");
    expect(generated.code, generated.output).toBe(0);
    const coach = read(dir, "apps/mobile/src/client/roles/bookings.coach.ts");
    expect(coach).toContain("createBookingsCoachClient");
    expect(coach).toContain("With the grants rostering:roster");
    expect(coach).toContain('"x.bookings.roster"');
    expect(coach).toContain('"x.rostering.week"');
    expect(coach).toContain('"x.rostering.take"');
    expect(coach).not.toContain('"x.rostering.assign"');
    expect(coach).not.toContain('"x.rostering.periodTotals"');
    const team = read(dir, "apps/mobile/src/client/roles/rostering.team.ts");
    expect(team).toContain('"x.rostering.me"');
    expect(team).not.toContain('"x.bookings.roster"');
    // A grant the release does not have is refused by name.
    writeFileSync(
      join(dir, "product.ts"),
      read(dir, "product.ts").replace("rostering:roster", "rostering:nothing"),
    );
    const refused = await cos("client", "generate");
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("no grantable permission rostering:nothing");
  });

  it("mobile.owner writes the owner's client: only its listed operations (stage 60, ADR 0872)", async () => {
    await publish("1.0.0");
    const dir = await created();
    setPacks(dir, ["bookings", "memberships", "rostering"]);
    writeFileSync(
      join(dir, "product.ts"),
      read(dir, "product.ts").replace(
        /(\n\s*web: \{[^\n]*\},)/,
        '$1\n  mobile: { dir: "apps/mobile", owner: true },',
      ),
    );
    const generated = await cos("client", "generate");
    expect(generated.code, generated.output).toBe(0);
    expect(generated.output).toContain("roles/owner.ts");
    const owner = read(dir, "apps/mobile/src/client/roles/owner.ts");
    expect(owner).toContain("createOwnerClient");
    for (const name of ["approval.approve", "approval.list", "notification.list", "user.me"]) {
      expect(owner).toContain(`"${name}"`);
    }
    // No other staff operation, and no pack's: the host's Today names the packs' numbers.
    for (const name of ["record.list", "person.list", "approval.decide", "x.bookings.roster"]) {
      expect(owner).not.toContain(`"${name}"`);
    }
    // The customer client is unchanged by it.
    expect(read(dir, "apps/mobile/src/client/customer.ts")).not.toContain('"approval.list"');
  });

  it("refuses a role of a pack the product does not list", async () => {
    await publish("1.0.0");
    const dir = await created();
    writeFileSync(
      join(dir, "product.ts"),
      read(dir, "product.ts").replace(
        /(\n\s*web: \{[^\n]*\},)/,
        '$1\n  mobile: { dir: "apps/mobile", roles: ["ticketing.door"] },',
      ),
    );
    const generated = await cos("client", "generate");
    expect(generated.code).toBe(1);
    expect(generated.output).toContain("a role of ticketing, which packs does not list");
  });
});

describe("environments (ADR 0450)", () => {
  it("staging and live deploy side by side, each its own host, and one never touches the other", async () => {
    await publish("1.0.0");
    const dir = await created();
    setEnvironments(dir, { staging: {}, live: {} });
    world.cf.calls.length = 0;
    const refused = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("say which with --env (live, staging)");
    const unknown = await cos("deploy", "--env", "prod", "--skip-build", "--no-typecheck");
    expect(unknown.output).toContain("no environment prod. Its environments: live, staging");
    expect(world.cf.calls).toEqual([]);

    const staging = await cos("deploy", "--env", "staging", "--skip-build", "--no-typecheck");
    expect(staging.code, staging.output).toBe(0);
    const live = await cos("deploy", "--env", "live", "--skip-build", "--no-typecheck");
    expect(live.code, live.output).toBe(0);
    // Distinct Workers: live keeps the names a product without environments has.
    for (const worker of [
      "shop-staging-app",
      "shop-staging-runner",
      "shop-web-staging",
      "shop-app",
      "shop-runner",
      "shop-web",
    ]) {
      expect(world.cf.scripts.has(worker), worker).toBe(true);
    }
    // Distinct databases, each with its own deployment state, and distinct buckets.
    expect([...world.cf.d1.values()].map((d) => d.name).sort()).toEqual(["shop", "shop-staging"]);
    // Each web app is bound to its own environment's host, and named to it for customer sign-in.
    expect(world.cf.liveBinding("shop-web-staging", "HOST")?.service).toBe("shop-staging-app");
    expect(world.cf.liveBinding("shop-web", "HOST")?.service).toBe("shop-app");
    expect(world.cf.liveBinding("shop-staging-app", "CUSTOMER_AUTH_URL")?.text).toBe(
      "https://shop-web-staging.acme.workers.dev",
    );
    expect(world.cf.liveBinding("shop-app", "CUSTOMER_AUTH_URL")?.text).toBe(
      "https://shop-web.acme.workers.dev",
    );
    // Its own secrets.
    for (const name of ["BETTER_AUTH_SECRET", "CUSTOMER_AUTH_SECRET"]) {
      expect(secretOf("shop-staging-app", name), name).toBeTruthy();
      expect(secretOf("shop-staging-app", name), name).not.toBe(secretOf("shop-app", name));
    }
    // Redeploying staging changes nothing of live's.
    const liveSecrets = new Map(world.cf.scripts.get("shop-app")?.secrets);
    const liveDb = [...world.cf.d1.entries()].find(([, d]) => d.name === "shop")?.[0] as string;
    world.cf.calls.length = 0;
    const again = await cos("deploy", "--env", "staging", "--skip-build", "--no-typecheck");
    expect(again.code, again.output).toBe(0);
    expect(mutating().length).toBeGreaterThan(0);
    const touched = mutating().filter(
      (c) =>
        /\/(shop-app|shop-runner|shop-web|shop-gatekeeper-[^/]+)(\/|$)/.test(c.path) ||
        c.path.includes(liveDb),
    );
    expect(touched).toEqual([]);
    expect(new Map(world.cf.scripts.get("shop-app")?.secrets)).toEqual(liveSecrets);
  });

  it("with none declared, deploys as before, and --env is refused", async () => {
    await publish("1.0.0");
    await created();
    const refused = await cos("deploy", "--env", "staging", "--skip-build", "--no-typecheck");
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("declares no environments");
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(0);
    expect(world.cf.scripts.has("shop-app")).toBe(true);
  });
});

describe("gatekeeper settings per environment (ADR 0452)", () => {
  const settings = {
    staging: {
      live: false,
      hostname: "admin.staging.shop.example",
      gatekeepers: {
        "email-send": {
          ALLOWED_SENDER_DOMAINS: "staging.shop.example",
          sendEmail: { allowedSenderAddresses: ["tickets@staging.shop.example"] },
        },
        payments: { PAYMENTS_FAKE_PROVIDER: true },
      },
    },
    live: {
      gatekeepers: {
        "email-send": { ALLOWED_SENDER_DOMAINS: "shop.example", INTERNAL_DOMAINS: "shop.example" },
        payments: { STRIPE_ACCOUNT: "acct_123" },
      },
    },
  };

  it("installs each environment's gatekeepers with its settings, and says which secrets a person sets", async () => {
    await publish("1.0.0", undefined, { clientGatekeepers: true });
    const dir = await created();
    setEnvironments(dir, settings);
    const staging = await cos("deploy", "--env", "staging", "--skip-build", "--no-typecheck");
    expect(staging.code, staging.output).toBe(0);
    expect(
      world.cf.liveBinding("shop-staging-gatekeeper-email-send", "ALLOWED_SENDER_DOMAINS")?.text,
    ).toBe("staging.shop.example");
    expect(world.cf.liveBinding("shop-staging-gatekeeper-email-send", "EMAIL")).toMatchObject({
      type: "send_email",
      allowed_sender_addresses: ["tickets@staging.shop.example"],
    });
    expect(
      world.cf.liveBinding("shop-staging-gatekeeper-payments", "PAYMENTS_FAKE_PROVIDER")?.text,
    ).toBe("true");
    // Derived, never typed: the webhook address on this environment's own host.
    expect(world.cf.liveBinding("shop-staging-gatekeeper-payments", "BASE_URL")?.text).toBe(
      "https://admin.staging.shop.example/gatekeeper/payments",
    );
    expect(staging.output).toContain(
      "npx wrangler secret put STRIPE_SECRET_KEY --name shop-staging-gatekeeper-payments",
    );

    const live = await cos("deploy", "--env", "live", "--skip-build", "--no-typecheck");
    expect(live.code, live.output).toBe(0);
    expect(world.cf.liveBinding("shop-gatekeeper-payments", "STRIPE_ACCOUNT")?.text).toBe(
      "acct_123",
    );
    expect(world.cf.liveBinding("shop-gatekeeper-payments", "PAYMENTS_FAKE_PROVIDER")?.text).toBe(
      "false",
    );
    expect(world.cf.liveBinding("shop-gatekeeper-email-send", "INTERNAL_DOMAINS")?.text).toBe(
      "shop.example",
    );
  });

  it("gives staging's fake payment provider a generated signing secret once, never printed, and live none (issue #217)", async () => {
    await publish("1.0.0", undefined, { clientGatekeepers: true });
    const dir = await created();
    setEnvironments(dir, settings);
    const first = await cos("deploy", "--env", "staging", "--skip-build", "--no-typecheck");
    expect(first.code, first.output).toBe(0);
    const worker = "shop-staging-gatekeeper-payments";
    const secret = secretOf(worker, "FAKE_WEBHOOK_SECRET") as string;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(first.output).not.toContain(secret);
    // Named as set, never asked of a person.
    expect(first.output).toContain("FAKE_WEBHOOK_SECRET");
    expect(first.output).not.toContain("wrangler secret put FAKE_WEBHOOK_SECRET");
    // A secret is never also a plain var.
    expect(world.cf.liveBinding(worker, "FAKE_WEBHOOK_SECRET")?.type).not.toBe("plain_text");

    // A person's own secret and the other settings survive a redeploy, which keeps the secret.
    world.cf.scripts.get(worker)?.secrets.set("STRIPE_SECRET_KEY", "sk_test_by_hand");
    const again = await cos("deploy", "--env", "staging", "--skip-build", "--no-typecheck");
    expect(again.code, again.output).toBe(0);
    expect(secretOf(worker, "FAKE_WEBHOOK_SECRET")).toBe(secret);
    expect(secretOf(worker, "STRIPE_SECRET_KEY")).toBe("sk_test_by_hand");
    expect(again.output).not.toContain(secret);
    expect(again.output).not.toMatch(/setting secrets on [^\n]*payments[^\n]*FAKE_WEBHOOK_SECRET/);
    expect(world.cf.liveBinding(worker, "PAYMENTS_FAKE_PROVIDER")?.text).toBe("true");
    expect(
      world.cf.liveBinding("shop-staging-gatekeeper-email-send", "ALLOWED_SENDER_DOMAINS")?.text,
    ).toBe("staging.shop.example");

    // Live does not turn the fake on, so it gets no fake secret.
    const live = await cos("deploy", "--env", "live", "--skip-build", "--no-typecheck");
    expect(live.code, live.output).toBe(0);
    expect(secretOf("shop-gatekeeper-payments", "FAKE_WEBHOOK_SECRET")).toBeUndefined();
    expect(live.output).not.toContain(secret);
  });

  it("refuses, before any call, a secret in product.ts, a setting the gatekeeper does not take, and the fake provider on live", async () => {
    await publish("1.0.0", undefined, { clientGatekeepers: true });
    const dir = await created();
    const original = read(dir, "product.ts");
    const attempt = async (environments: Record<string, unknown>) => {
      writeFileSync(join(dir, "product.ts"), original);
      setEnvironments(dir, environments);
      world.cf.calls.length = 0;
      const out = await cos("deploy", "--env", "live", "--skip-build", "--no-typecheck");
      expect(out.code).toBe(1);
      expect(world.cf.calls).toEqual([]);
      return out.output;
    };
    expect(
      await attempt({ live: { gatekeepers: { payments: { STRIPE_SECRET_KEY: "x" } } } }),
    ).toContain("STRIPE_SECRET_KEY is a secret of payments: it never goes in product.ts");
    expect(
      await attempt({ live: { gatekeepers: { payments: { FAKE_WEBHOOK_SECRET: "x" } } } }),
    ).toContain("FAKE_WEBHOOK_SECRET is a secret of payments: it never goes in product.ts");
    expect(await attempt({ live: { gatekeepers: { payments: { COLOUR: "red" } } } })).toContain(
      "payments takes no setting COLOUR. It takes: PAYMENTS_FAKE_PROVIDER, STRIPE_ACCOUNT",
    );
    expect(
      await attempt({ live: { gatekeepers: { payments: { PAYMENTS_FAKE_PROVIDER: true } } } }),
    ).toContain("is live and turns on the fake payment provider");
    expect(await attempt({ live: { gatekeepers: { sms: {} } } })).toContain(
      "names the gatekeeper sms, which this release does not have",
    );
  });
});

describe("customer sign-in on the web app's hostname (ADR 0421, ADR 0450)", () => {
  it("sets CUSTOMER_AUTH_URL to the web app's origin and makes its secret once", async () => {
    await publish("1.0.0");
    await created();
    const first = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(first.code, first.output).toBe(0);
    expect(world.cf.liveBinding("shop-app", "CUSTOMER_AUTH_URL")?.text).toBe(
      "https://shop-web.acme.workers.dev",
    );
    const secret = secretOf("shop-app", "CUSTOMER_AUTH_SECRET") as string;
    const staff = secretOf("shop-app", "BETTER_AUTH_SECRET") as string;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secret).not.toBe(staff);
    expect(first.output).not.toContain(secret);
    // A redeploy changes neither secret (the staff one was made anew on every client deploy
    // before: it was looked for under the release's Worker name).
    const again = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(again.code, again.output).toBe(0);
    expect(secretOf("shop-app", "CUSTOMER_AUTH_SECRET")).toBe(secret);
    expect(secretOf("shop-app", "BETTER_AUTH_SECRET")).toBe(staff);
    expect(world.cf.liveBinding("shop-app", "CUSTOMER_AUTH_URL")?.text).toBe(
      "https://shop-web.acme.workers.dev",
    );
    // Rotating is asked for by name, and changes only the customer secret.
    const rotated = await cos(
      "deploy",
      "--skip-build",
      "--no-typecheck",
      "--rotate-customer-auth-secret",
    );
    expect(rotated.code, rotated.output).toBe(0);
    expect(secretOf("shop-app", "CUSTOMER_AUTH_SECRET")).not.toBe(secret);
    expect(secretOf("shop-app", "BETTER_AUTH_SECRET")).toBe(staff);
  });

  it("a product with no web app gets neither", async () => {
    await publish("1.0.0");
    const dir = await created();
    writeFileSync(
      join(dir, "product.ts"),
      read(dir, "product.ts").replace(/\n\s*web: \{[^\n]*\},/, ""),
    );
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(0);
    expect(world.cf.liveBinding("shop-app", "CUSTOMER_AUTH_URL")).toBeUndefined();
    expect(secretOf("shop-app", "CUSTOMER_AUTH_SECRET")).toBeUndefined();
  });
});

/** A web app whose code calls me.get, with a tsconfig that resolves the runtime from source. */
function compilingApp(dir: string) {
  writeFileSync(
    join(dir, "apps", "web", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        lib: ["ES2023"],
        types: [],
        paths: { "@composable-os/client": [join(root, "packages", "client", "src", "index.ts")] },
      },
      include: ["src/account.ts"],
    }),
  );
  writeFileSync(
    join(dir, "apps", "web", "src", "account.ts"),
    'import { createCustomerClient } from "./client/customer.ts";\n' +
      'export const me = (fetch: Parameters<typeof createCustomerClient>[0]["fetch"]) =>\n' +
      '  createCustomerClient({ baseUrl: "https://host", ...(fetch ? { fetch } : {}) }).call("me.get", {});\n',
  );
}

describe("cos upgrade in a client repo (criterion 11)", () => {
  it("reports the type error a changed operation makes, and deploys nothing", async () => {
    await publish("1.0.0");
    // 1.1.0's me.get takes a required input.
    await publish("1.1.0", (files) => {
      const contract = JSON.parse(files["contract/customer.json"] as string);
      const me = contract.operations.find((op: { name: string }) => op.name === "me.get");
      me.input = {
        type: "object",
        properties: { include: { type: "string" } },
        required: ["include"],
      };
      files["contract/customer.json"] = JSON.stringify(contract);
    });
    const dir = await created();
    compilingApp(dir);
    world.cf.calls.length = 0;
    // The upgrade moves the packages; the type check waits for them to be installed.
    const moved = await cos("upgrade", "--version", "1.1.0");
    expect(moved.code, moved.output).toBe(0);
    expect(moved.output).toContain("The type check was skipped");
    installedAt(dir, "1.1.0");
    const upgraded = await cos("upgrade", "--version", "1.1.0");
    expect(upgraded.code).toBe(1);
    expect(upgraded.output).toMatch(/apps\/web\/src\/account\.ts:3: .*include/);
    expect(upgraded.output).toContain("Nothing was deployed.");
    expect(world.cf.calls).toEqual([]);
    expect(read(dir, "product.ts")).toContain('version: "1.1.0"');
  });

  it("moves product.ts, regenerates the client and replaces skills when the apps compile", async () => {
    await publish("1.0.0");
    await publish("1.1.0", (files) => {
      files["skills/start-client-app/SKILL.md"] = "# start-client-app, as of 1.1.0\n";
    });
    const dir = await created();
    compilingApp(dir);
    installedAt(dir, "1.1.0");
    const upgraded = await cos("upgrade");
    expect(upgraded.code, upgraded.output).toBe(0);
    expect(read(dir, "product.ts")).toContain('version: "1.1.0"');
    expect(read(dir, "skills/start-client-app/SKILL.md")).toContain("as of 1.1.0");
    expect(upgraded.output).toContain("the apps type-check against it. Nothing is deployed yet");
  });

  it("moves every @composable-os dependency, keeps what it cannot rewrite, and type-checks only once installed (issue #177)", async () => {
    await publish("1.0.0");
    await publish("1.1.0");
    const dir = await created();
    compilingApp(dir);
    // A range, and a local tarball cos must not rewrite.
    const web = JSON.parse(read(dir, "apps/web/package.json"));
    web.dependencies["@composable-os/client"] = "^1.0.0";
    web.dependencies["@composable-os/pack-ticketing"] = "file:../../tarballs/pack-ticketing.tgz";
    writeFileSync(join(dir, "apps/web/package.json"), `${JSON.stringify(web, null, 2)}\n`);
    installedAt(dir, "1.0.0");

    const upgraded = await cos("upgrade");
    expect(upgraded.code, upgraded.output).toBe(0);
    const after = JSON.parse(read(dir, "apps/web/package.json"));
    expect(after.dependencies["@composable-os/client"]).toBe("^1.1.0");
    expect(after.dependencies["@composable-os/pack-ticketing"]).toBe(
      "file:../../tarballs/pack-ticketing.tgz",
    );
    const rootPkg = JSON.parse(read(dir, "package.json"));
    for (const [name, spec] of Object.entries({
      ...rootPkg.dependencies,
      ...rootPkg.devDependencies,
    }) as [string, string][]) {
      if (name.startsWith("@composable-os/")) expect(spec, name).toBe("1.1.0");
    }
    expect(upgraded.output).toContain(
      "apps/web/package.json: @composable-os/client ^1.0.0 → ^1.1.0",
    );
    expect(upgraded.output).toContain(
      'apps/web/package.json: @composable-os/pack-ticketing "file:../../tarballs/pack-ticketing.tgz"',
    );
    // Installed at 1.0.0 still: the check is skipped and said so, never reported as a pass.
    expect(upgraded.output).toContain("@composable-os/client (1.0.0 installed)");
    expect(upgraded.output).toContain("pnpm install");
    expect(upgraded.output).toContain("not yet type-checked");
    expect(upgraded.output).not.toContain("the apps type-check against it");

    installedAt(dir, "1.1.0");
    const again = await cos("upgrade");
    expect(again.code, again.output).toBe(0);
    expect(again.output).toContain("Already on 1.1.0");
    expect(again.output).toContain("the apps type-check against it");
  });
});

/** Stands in for an install: each @composable-os dependency's package.json, at `version`. */
function installedAt(dir: string, version: string) {
  for (const app of [".", "apps/web", "apps/mobile"]) {
    const file = join(dir, app, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      if (!name.startsWith("@composable-os/")) continue;
      const at = join(dir, app, "node_modules", name);
      mkdirSync(at, { recursive: true });
      writeFileSync(join(at, "package.json"), JSON.stringify({ name, version }));
    }
  }
}

/** Publishes `version` again, replacing the release of that tag: a kit rebuilt at one version. */
async function republish(version: string, change: (files: Record<string, string>) => void) {
  const at = world.github.releases.findIndex((r) => r.tag === `v${version}`);
  if (at >= 0) world.github.releases.splice(at, 1);
  await publish(version, change);
}

describe("cos upgrade keeps the host modules current (ADR 0451, amended)", () => {
  const HOST = "apps/web/src/host.ts";
  const newer = (files: Record<string, string>) => {
    files["template/apps/web/src/host.ts"] =
      `${files["template/apps/web/src/host.ts"]}\n// A change in the newer template.\nexport const NEWER = true;\n`;
  };

  it("replaces a host module the company has not edited, and records it", async () => {
    await publish("1.0.0");
    await publish("1.1.0", newer);
    const dir = await created();
    const state = JSON.parse(read(dir, "composable-os.lock.json"));
    expect(Object.keys(state.hostModules)).toEqual([HOST]);
    const upgraded = await cos("upgrade", "--no-typecheck");
    expect(upgraded.output).toContain(`Host modules: ${HOST} replaced with 1.1.0's.`);
    expect(read(dir, HOST)).toContain("export const NEWER = true;");
    expect(JSON.parse(read(dir, "composable-os.lock.json")).hostModules[HOST].version).toBe(
      "1.1.0",
    );
  });

  it("leaves an edited one, and shows its diff against the new template with what to do", async () => {
    await publish("1.0.0");
    await publish("1.1.0", newer);
    const dir = await created();
    const edited = `${read(dir, HOST)}\n// The company's own change.\n`;
    writeFileSync(join(dir, HOST), edited);
    const upgraded = await cos("upgrade", "--no-typecheck");
    expect(read(dir, HOST)).toBe(edited);
    expect(upgraded.output).toContain(`${HOST}: edited here since cos wrote it. Not changed.`);
    expect(upgraded.output).toContain("+ export const NEWER = true;");
    expect(upgraded.output).toContain("- // The company's own change.");
    expect(upgraded.output).toContain(`Host modules left to merge by hand: ${HOST}`);
  });

  it("treats a module with no recorded hash (adopted before) as edited", async () => {
    await publish("1.0.0");
    await publish("1.1.0", newer);
    const dir = await created();
    rmSync(join(dir, "composable-os.lock.json"));
    const before = read(dir, HOST);
    const upgraded = await cos("upgrade", "--no-typecheck");
    expect(read(dir, HOST)).toBe(before);
    expect(upgraded.output).toContain(`${HOST}: no record of what cos wrote`);
    expect(upgraded.output).toContain("+ export const NEWER = true;");
  });

  it("adds a module the new template brings, in an adopted repo", async () => {
    await publish("1.0.0");
    const dir = join(scratch(), "movement");
    cpSync(join(here, "fixtures", "adopt"), dir, { recursive: true });
    cwd = dir;
    expect((await cos("init", "--web", ".", "--mobile", "mobile", "--yes")).code).toBe(0);
    const state = JSON.parse(read(dir, "composable-os.lock.json"));
    expect(Object.keys(state.hostModules).sort()).toEqual([
      "mobile/src/composable-os/host.ts",
      "mobile/src/composable-os/secure-random.ts",
      "mobile/src/composable-os/secure-store.ts",
      "src/composable-os/host.ts",
    ]);
    rmSync(join(dir, "mobile", "src", "composable-os", "secure-random.ts"));
    await publish("1.1.0");
    const upgraded = await cos("upgrade", "--no-typecheck");
    expect(upgraded.output).toContain("mobile/src/composable-os/secure-random.ts (new)");
    // cos init writes product.ts with quoted keys; the upgrade moves it too (it could not before).
    expect(read(dir, "product.ts")).toContain('"version": "1.1.0"');
    expect(existsSync(join(dir, "mobile", "src", "composable-os", "secure-random.ts"))).toBe(true);
  });

  it("brings the media route to repos made before it, created and adopted (issue #181)", async () => {
    // The release before: the template's host.ts without its media route.
    const before = (files: Record<string, string>) => {
      const host = files["template/apps/web/src/host.ts"] ?? "";
      const at = host.indexOf("/** Where this site's pages ask for a picture");
      expect(at).toBeGreaterThan(0);
      files["template/apps/web/src/host.ts"] = host.slice(0, at);
    };
    await publish("1.0.0", before);
    await publish("1.1.0");
    const dir = await created();
    expect(read(dir, HOST)).not.toContain("export async function mediaRoute");
    const recorded = JSON.parse(read(dir, "composable-os.lock.json")).hostModules[HOST].sha256;
    const upgraded = await cos("upgrade", "--no-typecheck");
    expect(upgraded.output).toContain(`Host modules: ${HOST} replaced with 1.1.0's.`);
    expect(read(dir, HOST)).toContain("export async function mediaRoute");
    const after = JSON.parse(read(dir, "composable-os.lock.json")).hostModules[HOST];
    expect(after.version).toBe("1.1.0");
    expect(after.sha256).not.toBe(recorded);

    // An adopted site (its host module in src/composable-os/) is given it, and its hash recorded,
    // so its next upgrade can replace it the same way.
    const adopted = join(scratch(), "adopted-site");
    cpSync(join(here, "fixtures", "adopt"), adopted, { recursive: true });
    cwd = adopted;
    expect((await cos("init", "--web", ".", "--mobile", "mobile", "--yes")).code).toBe(0);
    const module = "src/composable-os/host.ts";
    expect(read(adopted, module)).toContain("export async function mediaRoute");
    expect(JSON.parse(read(adopted, "composable-os.lock.json")).hostModules[module].sha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("compares by content: a kit rebuilt at the same version still shows what changed", async () => {
    await publish("1.0.0");
    const dir = await created();
    const added = await cos("add", "greeting");
    expect(added.code, added.output).toBe(0);
    await republish("1.0.0", (files) => {
      newer(files);
      files["blocks/greeting/greeting.tsx"] =
        'export function Greeting({ name }: { name: string }) {\n  return <p className="rebuilt">Hello, {name}</p>;\n}\n';
    });
    const upgraded = await cos("upgrade", "--no-typecheck");
    expect(upgraded.output).toContain("Already on 1.0.0. Checking the host modules");
    expect(upgraded.output).toContain(`Host modules: ${HOST} replaced with 1.0.0's.`);
    expect(read(dir, HOST)).toContain("export const NEWER = true;");
    const diff = await cos("diff", "greeting");
    expect(diff.output).toContain('+   return <p className="rebuilt">Hello, {name}</p>;');
    expect(diff.output).toContain("changed since it was copied (the release was rebuilt");
  });
});

describe("blocks (criterion 10)", () => {
  it("cos diff --accept reads releases from --bundle-dir, sends a GitHub token from the environment, and says so on a rate limit", async () => {
    await publish("1.0.0");
    await publish("1.1.0", (files) => {
      files["blocks/greeting/greeting.tsx"] =
        'export function Greeting({ name }: { name: string }) {\n  return <p className="greeting">Hello, {name}!</p>;\n}\n';
    });
    await created();
    expect((await cos("add", "greeting")).code).toBe(0);
    expect((await cos("upgrade")).code).toBe(0);

    // Both releases, as a release build leaves them: their bundles and one SHA256SUMS.
    const bundles = join(scratch(), "bundles");
    mkdirSync(bundles, { recursive: true });
    const sums: string[] = [];
    for (const release of world.github.releases) {
      for (const [name, bytes] of release.assets) {
        if (name === "SHA256SUMS") sums.push(new TextDecoder().decode(bytes).trim());
        else if (name.endsWith(".tar.gz")) writeFileSync(join(bundles, name), bytes);
      }
    }
    writeFileSync(join(bundles, "SHA256SUMS"), `${sums.join("\n")}\n`);

    const token = "ghp_test_token_never_printed_0123456789";
    world.env.GH_TOKEN = token;
    world.githubCalls.length = 0;
    try {
      const accepted = await cos("diff", "greeting", "--accept", "--bundle-dir", bundles);
      expect(accepted.code, accepted.output).toBe(0);
      expect(accepted.output).toContain("Accepted: greeting is recorded as merged up to 1.1.0");
      expect(accepted.output).not.toContain(token);
      // Read from the folder: no release listing or download, only the attestation check, with
      // the token.
      expect(world.githubCalls.filter((c) => /\/releases(\/|$)/.test(c.path))).toEqual([]);
      const api = world.githubCalls.filter((c) => c.path.includes("/attestations/"));
      expect(api.length).toBeGreaterThan(0);
      for (const call of api) expect(call.authorization).toBe(`Bearer ${token}`);
    } finally {
      delete world.env.GH_TOKEN;
    }

    // A release the folder lacks is said, never quietly downloaded.
    rmSync(join(bundles, readdirSync(bundles).find((f) => f.includes("1.0.0")) as string));
    world.githubCalls.length = 0;
    const lacking = await cos("diff", "greeting", "--bundle-dir", bundles, "--version", "1.1.0");
    expect(lacking.code).toBe(0);
    const old = await cos("diff", "greeting", "--bundle-dir", bundles, "--version", "1.0.0");
    expect(old.code).toBe(1);
    expect(old.output).toContain("is not in --bundle-dir");
    expect(world.githubCalls.filter((c) => /\/releases(\/|$)/.test(c.path))).toEqual([]);

    // GitHub's rate limit, without a token: a message to act on.
    world.githubHook = () =>
      new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" },
      });
    try {
      const limited = await cos("diff", "greeting", "--bundle-dir", bundles);
      expect(limited.code).toBe(1);
      expect(limited.output).toContain("rate limit");
      expect(limited.output).toContain("GH_TOKEN or GITHUB_TOKEN");
    } finally {
      world.githubHook = undefined;
    }
  });

  it("cos diff --accept records changes applied by hand, so the next diff starts there (issue #177)", async () => {
    await publish("1.0.0");
    await publish("1.1.0", (files) => {
      files["blocks/greeting/greeting.tsx"] =
        'export function Greeting({ name }: { name: string }) {\n  return <p className="greeting">Hello, {name}!</p>;\n}\n';
    });
    const dir = await created();
    expect((await cos("add", "greeting")).code).toBe(0);
    const file = join(dir, "apps", "web", "src", "blocks", "greeting", "greeting.tsx");
    // The client restyles its copy, then upgrades.
    const edited = readFileSync(file, "utf8").replace("<p>", '<p style={{ color: "teal" }}>');
    writeFileSync(file, edited);
    expect((await cos("upgrade")).code).toBe(0);

    // Accepting against a version the repo is not on is refused, and records nothing.
    const refused = await cos("diff", "greeting", "--version", "1.0.0", "--accept");
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("merged up to the version product.ts is on (1.1.0)");
    expect(JSON.parse(read(dir, "blocks.lock.json")).greeting.version).toBe("1.0.0");

    // The changes are merged by hand, then accepted: shown once more, then recorded.
    writeFileSync(file, edited.replace("Hello, {name}</p>", "Hello, {name}!</p>"));
    const accepted = await cos("diff", "greeting", "--accept");
    expect(accepted.code, accepted.output).toBe(0);
    expect(accepted.output).toContain('+   return <p className="greeting">Hello, {name}!</p>;');
    expect(accepted.output).toContain("Accepted: greeting is recorded as merged up to 1.1.0");
    const lock = JSON.parse(read(dir, "blocks.lock.json")).greeting;
    expect(lock.version).toBe("1.1.0");
    expect(lock.app).toBe("apps/web");
    // The file is the client's: never touched.
    expect(readFileSync(file, "utf8")).toContain('style={{ color: "teal" }}');
    // The next diff shows nothing new upstream, only that the copy is edited here.
    const after = await cos("diff", "greeting");
    expect(after.output).toContain("No upstream change");
    expect(after.output).not.toContain('className="greeting"');
  });

  it("cos add copies from the matching release; cos diff shows upstream changes and keeps edits", async () => {
    await publish("1.0.0");
    await publish("1.1.0", (files) => {
      files["blocks/greeting/greeting.tsx"] =
        'export function Greeting({ name }: { name: string }) {\n  return <p className="greeting">Hello, {name}!</p>;\n}\n';
    });
    const dir = await created();
    const added = await cos("add", "greeting");
    expect(added.code, added.output).toBe(0);
    const file = join(dir, "apps", "web", "src", "blocks", "greeting", "greeting.tsx");
    expect(readFileSync(file, "utf8")).toContain("<p>Hello, {name}</p>");
    const lock = JSON.parse(read(dir, "blocks.lock.json"));
    expect(lock.greeting).toMatchObject({ version: "1.0.0", app: "apps/web" });

    // The client restyles its copy.
    const edited = readFileSync(file, "utf8").replace("<p>", '<p style={{ color: "teal" }}>');
    writeFileSync(file, edited);
    const diff = await cos("diff", "greeting", "--version", "1.1.0");
    expect(diff.code, diff.output).toBe(0);
    expect(diff.output).toContain("greeting.tsx: edited here since it was copied");
    expect(diff.output).toContain('+   return <p className="greeting">Hello, {name}!</p>;');
    expect(diff.output).toContain("-   return <p>Hello, {name}</p>;");
    expect(readFileSync(file, "utf8")).toBe(edited);
    expect((await cos("diff", "greeting")).output).toContain("No upstream change");
  });

  it("prints the release's version of a pack and the install command the app takes (Expo)", async () => {
    await publish("1.0.0");
    const dir = join(scratch(), "gym");
    expect((await runIn(world, "create", dir, "--with-mobile", "--version", "1.0.0")).code).toBe(0);
    cwd = dir;
    setPacks(dir, ["ticketing"]);
    const added = await cos("add", "ticketing-native-scanner");
    expect(added.code, added.output).toBe(0);
    expect(added.output).toContain(
      "cd apps/mobile && npx expo install @composable-os/pack-ticketing@1.0.0",
    );
    expect(added.output).not.toContain("@*");
  });

  it("copies the sign-in block with the base-layer blocks it depends on, and their MIT licence", async () => {
    await publish("1.0.0");
    const dir = await created();
    const added = await cos("add", "web-sign-in");
    expect(added.code, added.output).toBe(0);
    const blocks = join(dir, "apps", "web", "src", "blocks");
    for (const file of [
      "web-sign-in/sign-in-form.tsx",
      "ui-button/button.tsx",
      "ui-input/input.tsx",
      "ui-label/label.tsx",
      "ui-utils/utils.ts",
      "web-sign-in/LICENSE",
    ]) {
      expect(existsSync(join(blocks, file)), file).toBe(true);
    }
    expect(readFileSync(join(blocks, "web-sign-in", "LICENSE"), "utf8")).toContain("MIT License");
    expect(readFileSync(join(blocks, "ui-button", "button.tsx"), "utf8")).toContain(
      'from "../ui-utils/utils.ts"',
    );
    expect(added.output).toMatch(/pnpm add .*radix-ui@/);
    expect(Object.keys(JSON.parse(read(dir, "blocks.lock.json"))).sort()).toEqual([
      "ui-button",
      "ui-input",
      "ui-label",
      "ui-utils",
      "web-sign-in",
    ]);
  });

  it("lists the release's blocks with their skin, pack and dependencies", async () => {
    await publish("1.0.0");
    await created();
    const listed = await cos("add");
    expect(listed.code).toBe(0);
    expect(listed.output).toMatch(/web-sign-in\s+web; base; with ui-button, ui-input, ui-label/);
    expect(listed.output).toMatch(/native-base\s+native; base/);
  });

  it("cos client generate in a client repo writes each app's client again", async () => {
    await publish("1.0.0");
    const dir = await created();
    rmSync(join(dir, "apps", "web", "src", "client", "customer.ts"));
    const generated = await cos("client", "generate");
    expect(generated.code, generated.output).toBe(0);
    expect(read(dir, "apps/web/src/client/customer.ts")).toContain('"me.get"');
  });

  it("copies Content's rich text with the Courses player, which a text lesson needs", async () => {
    await publish("1.0.0");
    const dir = await created();
    // Only Courses listed: it requires Content, so the host installs it and its block may come.
    setPacks(dir, ["courses"]);
    writeFileSync(
      join(dir, "product.ts"),
      read(dir, "product.ts").replace(
        /(\n\s*web: \{[^\n]*\},)/,
        '$1\n  mobile: { dir: "apps/mobile" },',
      ),
    );
    const web = await cos("add", "courses-player");
    expect(web.code, web.output).toBe(0);
    const native = await cos("add", "courses-native-player");
    expect(native.code, native.output).toBe(0);
    expect(existsSync(join(dir, "apps/web/src/blocks/content-rich-text/rich-text.tsx"))).toBe(true);
    expect(
      existsSync(join(dir, "apps/mobile/src/blocks/content-native-rich-text/rich-text-view.tsx")),
    ).toBe(true);
    expect(web.output).toMatch(/@composable-os\/pack-content@1\.0\.0/);
    expect(Object.keys(JSON.parse(read(dir, "blocks.lock.json"))).sort()).toEqual([
      "content-native-rich-text",
      "content-rich-text",
      "courses-native-player",
      "courses-player",
      "native-base",
      "ui-button",
      "ui-utils",
    ]);
  });

  it("refuses a block of a pack the product does not list", async () => {
    await publish("1.0.0", (files) => {
      files["blocks/deal-card/block.json"] = JSON.stringify({
        name: "deal-card",
        pack: "deals",
        skin: "web",
        operations: [],
        files: [],
        dependsOn: [],
      });
    });
    await created();
    const added = await cos("add", "deal-card");
    expect(added.code).toBe(1);
    expect(added.output).toContain("the deals pack, which product.ts does not list");
  });
});

describe("cos init in a repo shaped like the first client's (criterion 2)", () => {
  function fixture(): string {
    const dir = join(scratch(), "movement");
    cpSync(join(here, "fixtures", "adopt"), dir, { recursive: true });
    return dir;
  }
  const snapshot = (dir: string, paths: string[]) =>
    Object.fromEntries(paths.map((p) => [p, read(dir, p)]));
  const existing = [
    "package.json",
    "wrangler.jsonc",
    "AGENTS.md",
    "src/pages/index.astro",
    "src/lib/account.ts",
    "mobile/package.json",
    "mobile/app.json",
    "mobile/src/account.ts",
  ];

  function compiles(dir: string, files: string[]): string[] {
    const program = ts.createProgram(
      files.map((f) => join(dir, f)),
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
        paths: { "@composable-os/client": [join(root, "packages", "client", "src", "index.ts")] },
      },
    );
    return ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  }

  it("adds its files, changes no existing file without showing the diff, then applies with --yes", async () => {
    await publish("1.0.0");
    const dir = fixture();
    const before = snapshot(dir, existing);
    expect(compiles(dir, ["src/lib/account.ts", "mobile/src/account.ts"]).join("\n")).toMatch(
      /composable-os\/customer/,
    );
    cwd = dir;
    const first = await cos("init", "--web", ".", "--mobile", "mobile");
    expect(first.code, first.output).toBe(0);
    // Nothing that existed changed: every change is shown instead.
    expect(snapshot(dir, existing)).toEqual(before);
    for (const path of ["package.json", "AGENTS.md", "mobile/package.json"]) {
      expect(first.output).toContain(`--- ${path}`);
    }
    // The site deploys itself: its top-level config gets no binding to a host that does not
    // exist yet. What to add, and when, is printed instead.
    expect(first.output).not.toContain("--- wrangler.jsonc");
    expect(first.output).toContain("Add it only after cos deploy has made that host");
    expect(first.output).toContain(
      '"services": [{ "binding": "HOST", "service": "movement-app", "entrypoint": "ClientApp" }]',
    );
    expect(first.output).toContain("Not changed.");
    // It keeps the site's own Worker and its own deploy, and says the site has data of its own.
    expect(read(dir, "product.ts")).toContain('"worker": "movement-site"');
    expect(read(dir, "product.ts")).toContain('"deploy": "own"');
    expect(first.output).toContain("data of its own (d1_databases)");
    // Only its own files are new.
    for (const path of [
      "product.ts",
      "skills/start-client-app/SKILL.md",
      "src/composable-os/customer.ts",
      "mobile/src/composable-os/customer.ts",
      "src/composable-os/host.ts",
      "mobile/src/composable-os/host.ts",
      "mobile/src/composable-os/secure-store.ts",
      "pnpm-workspace.yaml",
    ]) {
      expect(existsSync(join(dir, path)), path).toBe(true);
    }
    // Both apps' calls now compile against their typed client.
    expect(compiles(dir, ["src/lib/account.ts", "mobile/src/account.ts"])).toEqual([]);

    // Told to, it applies exactly the diffs it showed; the site keeps its own D1.
    rmSync(join(dir, "product.ts"));
    const second = await cos("init", "--web", ".", "--mobile", "mobile", "--yes");
    expect(second.code, second.output).toBe(0);
    expect(read(dir, "wrangler.jsonc")).toBe(before["wrangler.jsonc"]);
    expect(read(dir, "AGENTS.md").startsWith(before["AGENTS.md"] as string)).toBe(true);
    expect(read(dir, "AGENTS.md")).toContain("Never open a database");
    // The site is the root package: it gains the client, and keeps everything it had.
    expect(JSON.parse(read(dir, "package.json")).dependencies).toEqual({
      ...JSON.parse(before["package.json"] as string).dependencies,
      "@composable-os/client": "1.0.0",
    });
    expect(JSON.parse(read(dir, "package.json")).devDependencies["@composable-os/cli"]).toBe(
      "1.0.0",
    );
    expect(JSON.parse(read(dir, "mobile/package.json")).dependencies["@composable-os/client"]).toBe(
      "1.0.0",
    );
    expect(read(dir, "src/pages/index.astro")).toBe(before["src/pages/index.astro"]);
  });

  it("cos deploy deploys the host and leaves the adopted site to its own deploy", async () => {
    await publish("1.0.0");
    const dir = fixture();
    cwd = dir;
    expect((await cos("init", "--web", ".", "--mobile", "mobile", "--yes")).code).toBe(0);
    const deployed = await cos("deploy", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(0);
    expect(world.cf.scripts.has("movement-app")).toBe(true);
    expect(world.cf.scripts.has("movement-site")).toBe(false);
    expect(deployed.output).toContain('deploys itself (web.deploy "own")');
    expect(deployed.output).toContain("HOST's target is movement-app, entrypoint ClientApp");
  });

  it("shows the tsconfig change an Expo app needs for the host module's .ts imports, and scopes the edge rule", async () => {
    await publish("1.0.0");
    const dir = fixture();
    writeFileSync(
      join(dir, "mobile", "tsconfig.json"),
      `${JSON.stringify({ extends: "expo/tsconfig.base", compilerOptions: { strict: true } }, null, 2)}\n`,
    );
    cwd = dir;
    const init = await cos(
      "init",
      "--web",
      ".",
      "--mobile",
      "mobile",
      "--operation-route",
      "/composable/op/",
    );
    expect(init.code, init.output).toBe(0);
    expect(init.output).toContain("--- mobile/tsconfig.json");
    expect(init.output).toContain('+     "allowImportingTsExtensions": true,');
    expect(init.output).toContain('+     "noEmit": true');
    expect(read(dir, "mobile/tsconfig.json")).not.toContain("allowImportingTsExtensions");
    // The rule names only the routes that reach the host, not the site's own /api/.
    expect(init.output).toContain(
      '(starts_with(http.request.uri.path, "/auth/") or starts_with(http.request.uri.path, "/composable/op/"))',
    );
    expect(init.output).not.toContain('"/api/")');
    expect(existsSync(join(dir, "mobile", "src", "composable-os", "secure-random.ts"))).toBe(true);
  });

  it("--packs turns on packs the release carries and refuses one it does not", async () => {
    await publish("1.0.0");
    const dir = fixture();
    cwd = dir;
    const refused = await cos("init", "--web", ".", "--packs", "ticketing,tickets", "--yes");
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("does not carry the pack tickets");
    expect(existsSync(join(dir, "product.ts"))).toBe(false);
    const done = await cos("init", "--web", ".", "--packs", "ticketing", "--yes");
    expect(done.code, done.output).toBe(0);
    expect(read(dir, "product.ts")).toContain('"packs": [\n    "ticketing"\n  ]');
  });

  it("with environments: the binding goes under the site's matching environment; the rest is printed, and each host deploys on its own", async () => {
    await publish("1.0.0");
    const dir = fixture();
    // The site has a staging environment of its own; its live deploy is the top level.
    writeFileSync(
      join(dir, "wrangler.jsonc"),
      read(dir, "wrangler.jsonc").replace(
        '"d1_databases"',
        '"env": {\n    "staging": {\n      "name": "movement-site-staging",\n      "d1_databases": [{ "binding": "DB", "database_name": "movement-staging" }]\n    }\n  },\n  "d1_databases"',
      ),
    );
    cwd = dir;
    const init = await cos("init", "--web", ".", "--envs", "staging,live", "--yes");
    expect(init.code, init.output).toBe(0);
    const config = read(dir, "wrangler.jsonc");
    // Under env.staging, to the staging host, shown as a diff and applied with --yes.
    expect(init.output).toContain("--- wrangler.jsonc");
    expect(config).toMatch(
      /"staging": \{\n\s+"services": \[\{ "binding": "HOST", "service": "movement-staging-app", "entrypoint": "ClientApp" \}\],\n\s+"name": "movement-site-staging"/,
    );
    // Nothing at the top level: live's binding is printed, to add once the live host exists.
    expect(config.match(/"services"/g)).toHaveLength(1);
    expect(init.output).toContain(
      'live: "services": [{ "binding": "HOST", "service": "movement-app", "entrypoint": "ClientApp" }]',
    );
    expect(read(dir, "product.ts")).toContain('"environments"');

    const staging = await cos("deploy", "--env", "staging", "--no-typecheck");
    expect(staging.code, staging.output).toBe(0);
    expect(world.cf.scripts.has("movement-staging-app")).toBe(true);
    expect(world.cf.scripts.has("movement-app")).toBe(false);
    expect(staging.output).toContain(
      '"env": { "staging": { "services": [{ "binding": "HOST", "service": "movement-staging-app", "entrypoint": "ClientApp" }] } }',
    );
    expect(world.cf.liveBinding("movement-staging-app", "CUSTOMER_AUTH_URL")?.text).toBe(
      "https://movement-site-staging.acme.workers.dev",
    );
    const live = await cos("deploy", "--env", "live", "--no-typecheck");
    expect(live.code, live.output).toBe(0);
    expect(world.cf.scripts.has("movement-app")).toBe(true);
    expect(live.output).toContain(
      '"services": [{ "binding": "HOST", "service": "movement-app", "entrypoint": "ClientApp" }]',
    );
  });

  it("the adopted apps call me.get, typed: the Worker over its binding, the Expo app over HTTPS", async () => {
    await publish("1.0.0");
    const dir = fixture();
    cwd = dir;
    expect((await cos("init", "--web", ".", "--mobile", "mobile", "--yes")).code).toBe(0);
    const { build } = await import("esbuild");
    const run = async (entry: string) => {
      const out = join(dir, `${entry.replace(/\W/g, "_")}.mjs`);
      await build({
        entryPoints: [join(dir, entry)],
        outfile: out,
        bundle: true,
        format: "esm",
        platform: "neutral",
        logLevel: "error",
        alias: { "@composable-os/client": join(root, "packages", "client", "src", "index.ts") },
      });
      return import(out);
    };
    const sent: { url: string; headers: Record<string, string> }[] = [];
    const host = {
      fetch: async (url: string, init?: { headers: Record<string, string> }) => {
        sent.push({ url, headers: init?.headers ?? {} });
        return new Response(JSON.stringify({ data: { displayName: "Ada Lovelace" } }), {
          status: 200,
        });
      },
    };
    const site = await run("src/lib/account.ts");
    expect(await site.displayName(host, "theme=dark; cos-customer.session_token=abc.sig")).toBe(
      "Ada Lovelace",
    );
    expect(sent[0]).toMatchObject({
      url: "https://host/api/v1/op/me.get",
      headers: { cookie: "cos-customer.session_token=abc.sig" },
    });
    const mobile = await run("mobile/src/account.ts");
    expect(
      await mobile.displayName("https://admin.movement.example", "cos_at_token", host.fetch),
    ).toBe("Ada Lovelace");
    expect(sent[1]).toMatchObject({
      url: "https://admin.movement.example/api/v1/op/me.get",
      headers: { authorization: "Bearer cos_at_token" },
    });
  });
});
