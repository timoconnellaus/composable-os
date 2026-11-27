// The fake Cloudflare API and the fake GitHub, served over real HTTP, and the CLI run against them.
// Shared by the installer's tests (cli.test.ts) and the client repo's (client-repo.test.ts).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  FIXTURE_PRODUCT_DEFINITION as DEMO,
  FakeCloudflare,
  FakeGitHub,
} from "@composable-os/release/testing";
import { nodeSqliteEngine } from "@composable-os/release/testing/node";
import { Redactor } from "../src/io.ts";
import { type Env, runCli } from "../src/main.ts";

export const TOKEN = "cf-token-0123456789-secret";
export const ACCOUNT = "acc00000000000000000000000000cli";

export interface World {
  cf: FakeCloudflare;
  github: FakeGitHub;
  server: Server;
  env: Env;
  /** Every request to the fake GitHub: its path and the Authorization header it carried. */
  githubCalls: { path: string; authorization: string | null }[];
  /** Answers a GitHub request in place of the fake (a rate limit), when it returns a response. */
  githubHook?: ((path: string) => Response | undefined) | undefined;
}

export async function startWorld(): Promise<World> {
  const cf = new FakeCloudflare({
    token: TOKEN,
    accountId: ACCOUNT,
    sql: nodeSqliteEngine,
    subdomain: "acme",
    zones: [
      { id: "zone00000000000000000000000shop", name: "shop.example" },
      // A host of many clients' own zone (stage 66 step 8).
      { id: "zone0000000000000000000000fleet", name: "fleet.example" },
    ],
  });
  let github!: FakeGitHub;
  let world!: World;
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const url = `${origin}${req.url}`;
    let response: Response;
    if (req.url?.startsWith("/client/v4/")) {
      response = await cf.fetch(
        new Request(url, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          ...(body && req.method !== "GET" ? { body } : {}),
        }),
      );
    } else if (req.url === "/api/health") {
      const version = cf.liveBinding("demo-app", "COS_RELEASE_VERSION")?.text;
      response = Response.json({ status: "ok", version, migrations: { upToDate: true } });
    } else {
      const authorization = req.headers.authorization ?? null;
      world.githubCalls.push({ path: req.url ?? "", authorization });
      response = world.githubHook?.(req.url ?? "") ?? (await github.fetch(url));
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  github = new FakeGitHub("example/demo", origin);
  world = {
    githubCalls: [],
    cf,
    github,
    server,
    env: {
      COS_CLOUDFLARE_API: `${origin}/client/v4`,
      COS_GITHUB_API: origin,
      COS_HEALTH_ORIGIN: origin,
      CLOUDFLARE_API_TOKEN: TOKEN,
    },
  };
  return world;
}

export async function runIn(world: World, ...argv: string[]) {
  const lines: string[] = [];
  const redactor = new Redactor();
  const code = await runCli(argv, {
    io: {
      interactive: false,
      out: (l) => lines.push(redactor.clean(l)),
      err: (l) => lines.push(redactor.clean(l)),
      ask: async () => {
        throw new Error("no prompts in tests");
      },
    },
    redactor,
    products: { all: { [DEMO.id]: DEMO }, default: DEMO.id },
    env: world.env,
    ghVerifier: null,
    smokeDelayMs: 0,
  });
  return { code, output: lines.join("\n") };
}
