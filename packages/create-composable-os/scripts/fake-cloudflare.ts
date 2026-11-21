#!/usr/bin/env node
// A local stand-in for the Cloudflare API, for trying `cos deploy` with no account (stage 24's
// skill trials, and anyone checking a client repo end to end): the fake the CLI's tests use,
// served over HTTP until stopped. Nothing leaves the machine.
//
//   node packages/create-composable-os/scripts/fake-cloudflare.ts [--port 8787]
//
// Prints the environment `cos` needs to use it. `--summary` on stop (Ctrl-C) lists the Workers
// and their bindings.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FakeCloudflare } from "@composable-os/release/testing";
import { nodeSqliteEngine } from "@composable-os/release/testing/node";

const TOKEN = "local-fake-cloudflare-token";
const ACCOUNT = "localfakeaccount0000000000000000";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1] ?? 8787) || 8787;

const cf = new FakeCloudflare({
  token: TOKEN,
  accountId: ACCOUNT,
  sql: nodeSqliteEngine,
  subdomain: "local",
});
function summaryJson() {
  const workers = [...cf.scripts.keys()].map((name) => ({
    name,
    host: cf.liveBinding(name, "HOST") ?? null,
    packs: cf.liveBinding(name, "COS_PACKS")?.text ?? null,
    orgExtensions: cf.liveBinding(name, "COS_ORG_EXTENSIONS")?.text ?? null,
  }));
  return { workers, r2: [...cf.r2Objects.keys()] };
}

const server = createServer(async (req, res) => {
  // What is deployed, for a script or an agent to read: GET /summary.
  if (req.url === "/summary") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(summaryJson(), null, 2));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const response = await cf.fetch(
    new Request(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      ...(body && req.method !== "GET" ? { body } : {}),
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(port, "127.0.0.1", () => {
  const { port: bound } = server.address() as AddressInfo;
  console.log(`Fake Cloudflare API on http://127.0.0.1:${bound}/client/v4. For cos:
export COS_CLOUDFLARE_API=http://127.0.0.1:${bound}/client/v4
export CLOUDFLARE_API_TOKEN=${TOKEN}
export CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}`);
});
const summary = () => {
  for (const [name] of cf.scripts) {
    const bindings = (cf.liveBinding(name, "HOST") ? ["HOST → ClientApp"] : []).join(", ");
    console.log(`  ${name}${bindings ? ` (${bindings})` : ""}`);
  }
};
process.on("SIGINT", () => {
  console.log("\nWorkers deployed:");
  summary();
  process.exit(0);
});
