// A call and its client's shipped extensions (issue #558). A new isolate checks them once per
// client through cos-runner's installShipped, and installs them there when they are not. A call
// waits for that at most a small bound: a first install (seconds per pack) carries on under the
// request that started it, a call to a pack not installed yet answers a retryable error meanwhile,
// and an install whose request was ended under it cannot leave the next calls waiting on it.
//
// cos-runner here is a stand-in object for RUNNER, as in the rest of these tests (the real one,
// with its one-read check, is tested in apps/runner/test/shipped-stamp.test.ts): what is tested is
// how cos-app waits on it, which needs an install that never settles or settles when told to.
import { env } from "cloudflare:workers";
import type { Principal } from "@composable-os/auth";
import type { ShippedInstallResult } from "@composable-os/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type ApiEnv, handleApi } from "../src/server/http/api.ts";
import {
  ensureShippedExtensions,
  forgetShippedInstall,
  runOperation,
  SHIPPED_WAIT_MS,
  shippedInstallPending,
} from "../src/server/operations.ts";
import { ensureAdmin } from "./helpers.ts";

const admin: Principal = {
  userId: "usr_01JC0000000000000000SHIP01",
  email: "shipped-install-admin@example.com",
  name: "Shipped Install Admin",
  roles: [],
};

/** A runner whose installShipped settles when the test says (or never), counting its calls. */
function runnerStandIn() {
  const calls: { resolve: (r: ShippedInstallResult[]) => void; reject: (e: Error) => void }[] = [];
  const RUNNER = {
    installShipped: () =>
      new Promise<ShippedInstallResult[]>((resolve, reject) => calls.push({ resolve, reject })),
  } as unknown as Fetcher;
  return { env: { ...env, RUNNER } as ApiEnv, calls };
}

const timed = async (work: Promise<unknown>) => {
  const started = Date.now();
  await work;
  return Date.now() - started;
};

beforeAll(async () => {
  await ensureAdmin(admin);
});

afterEach(() => {
  forgetShippedInstall(env);
});

describe("a call and its client's shipped install", () => {
  it("installs a single-client deployment's packs on first use, once per isolate", async () => {
    const { env: e, calls } = runnerStandIn();
    const first = ensureShippedExtensions(e);
    calls[0]?.resolve([{ id: "deals", outcome: "installed" }]);
    await first;
    expect(shippedInstallPending(e)).toBe(false);
    await ensureShippedExtensions(e);
    expect(calls).toHaveLength(1);
  });

  it("does not hang a call on an install that never settles, nor the calls after it", async () => {
    // What a cancelled request could leave: an install that never answers.
    const { env: e, calls } = runnerStandIn();
    expect(await timed(ensureShippedExtensions(e, { waitMs: 50 }))).toBeLessThan(1_000);
    expect(await timed(ensureShippedExtensions(e, { waitMs: 50 }))).toBeLessThan(1_000);
    expect(shippedInstallPending(e)).toBe(true);
    // The default bound is small.
    expect(SHIPPED_WAIT_MS).toBeLessThanOrEqual(2_000);
    // One gone stale is started again by the next call, not waited on for ever.
    await ensureShippedExtensions(e, { waitMs: 10, staleMs: 0 });
    expect(calls).toHaveLength(2);
  });

  it("tries a failed install again on the next call", async () => {
    const { env: e, calls } = runnerStandIn();
    const first = ensureShippedExtensions(e);
    calls[0]?.reject(new Error("runner unreachable"));
    await first;
    const second = ensureShippedExtensions(e);
    expect(calls).toHaveLength(2);
    calls[1]?.resolve([]);
    await second;
    expect(shippedInstallPending(e)).toBe(false);
  });

  it("answers a call to a pack not installed yet with a retryable error, then refuses it", async () => {
    const { env: e, calls } = runnerStandIn();
    await ensureShippedExtensions(e, { waitMs: 0 });
    const call = { name: "x.ticketing.issueTicket", input: {} };
    const during = await runOperation(e, admin, call);
    expect(during).toMatchObject({
      ok: false,
      error: { code: "timeout", details: { installing: true, retryAfterSeconds: 5 } },
    });
    // A core operation is not held up.
    expect((await runOperation(e, admin, { name: "person.list", input: {} })).ok).toBe(true);
    // Once the install has finished, a pack that is not installed is refused, as always.
    calls[0]?.resolve([]);
    await ensureShippedExtensions(e);
    expect(await runOperation(e, admin, call)).toMatchObject({
      ok: false,
      error: { code: "unknown_operation" },
    });
  });

  it("answers 503 over HTTP while installing, and 404 once installed", async () => {
    const { env: e, calls } = runnerStandIn();
    await ensureShippedExtensions(e, { waitMs: 0 });
    const call = () =>
      handleApi(
        new Request("https://crm.test/api/v1/op/x.ticketing.listEvents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        e,
      );
    const during = await call();
    expect(during?.status).toBe(503);
    expect(await during?.json()).toMatchObject({
      error: { code: "timeout", details: { installing: true } },
    });
    calls[0]?.resolve([]);
    await ensureShippedExtensions(e);
    expect((await call())?.status).toBe(404);
  });
});
