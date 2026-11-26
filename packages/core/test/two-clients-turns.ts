// Setup file of the core suite run with two clients taking turns in one isolate (stage 66 step 5,
// criterion 5, ADR 0617): `COS_TEST_DB=two-clients pnpm --filter @composable-os/core
// test:two-clients`. Core is given a client scope store as a many-client host gives it; every
// test runs unchanged as the suite's own client (`env.DB`, the code outside any scope), and
// before and after every test a second client (test/other-client.ts) takes its turn in its own
// scope, filling what core keeps at module level with its own. A cache not kept per client would
// show a test the other client's schema, plan or answers, or show the other client what a test
// wrote; either fails.

import { env } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach } from "vitest";
import { type ClientScope, provideClientScope } from "../src/index.ts";
import { otherClient, otherClientsTurn, ownClientSeesNoneOfTheOthers } from "./other-client.ts";

provideClientScope(new AsyncLocalStorage<ClientScope>(), {
  unscoped: { database: env.DB, client: "test-client" },
});
await otherClient();

beforeEach(async () => {
  await otherClientsTurn();
  ownClientSeesNoneOfTheOthers();
});

afterEach(async () => {
  ownClientSeesNoneOfTheOthers();
  await otherClientsTurn();
});
