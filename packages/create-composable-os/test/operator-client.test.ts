// cos's side of the operator's Worker against a Worker whose new secret has not reached every copy
// of it yet: the fault of the staging check's first real run, where `cos client add bravo` had
// `place` accepted and then `migrate` refused with "not the operator".
import { describe, expect, it } from "vitest";
import { NOT_THE_OPERATOR, openOperator } from "../src/fleet/operator-client.ts";

/**
 * The operator's Worker as Cloudflare serves it after `putSecret`: each new token is a new
 * version, and for a while some requests still reach a copy on an earlier one. `copies` says, for
 * each request in turn, how many versions behind its copy is (0: the newest); then the newest.
 */
function propagatingWorker(copies: number[]) {
  const versions: string[] = [];
  const seen: { action: string; behind: number }[] = [];
  const api = {
    async putSecret(_account: string, _script: string, _name: string, value: string) {
      versions.push(value);
    },
  };
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const behind = copies.shift() ?? 0;
    const token = versions[Math.max(0, versions.length - 1 - behind)];
    const action = init?.body
      ? (JSON.parse(String(init.body)) as { action: string }).action
      : String(url);
    seen.push({ action, behind });
    const sent = new Headers(init?.headers).get("authorization");
    if (sent !== `Bearer ${token}`) {
      return Response.json({ error: NOT_THE_OPERATOR }, { status: 401 });
    }
    if (action === "fails") return Response.json({ error: "no client x" }, { status: 404 });
    // A 401 that is not the token's: anything but "not the operator".
    if (action === "unauthorised") {
      return Response.json({ error: "session expired" }, { status: 401 });
    }
    return Response.json({ ok: true, action });
  };
  return { api, fetch: fetch as typeof globalThis.fetch, seen, versions };
}

const open = (
  worker: ReturnType<typeof propagatingWorker>,
  staleMs = 5_000,
  stillHolds?: () => Promise<boolean>,
) => {
  const stale: string[] = [];
  return {
    stale,
    operator: openOperator({
      api: worker.api as never,
      accountId: "acc",
      script: "demo-operator-staging",
      origin: "https://operator.example",
      fetch: worker.fetch,
      redact: () => {},
      stale: {
        staleMs,
        sleep: async () => {},
        onStale: (what) => stale.push(what),
        ...(stillHolds ? { stillHolds } : {}),
      },
    }),
  };
};

describe("an operator session while its token reaches every copy of the Worker", () => {
  it("tries a call again that a copy on the previous version refused, and it goes through", async () => {
    // The previous command's closing token is the version before this one's.
    const worker = propagatingWorker([0, 0, 1]);
    await worker.api.putSecret("acc", "s", "COS_OPERATOR_TOKEN", "the previous command's close");
    const { operator, stale } = open(worker);
    const session = await operator;
    expect(await session.op("place", { client: "bravo" })).toMatchObject({ action: "place" });
    // The run's fault: `migrate` reached a copy still on the previous version.
    expect(await session.op("migrate", { client: "bravo" })).toMatchObject({ action: "migrate" });
    expect(worker.seen.map((s) => `${s.action}:${s.behind}`)).toEqual([
      "health:0",
      "place:0",
      "migrate:1",
      "migrate:0",
    ]);
    expect(stale).toEqual(["migrate"]);
  });

  it("still fails, naming it, when the token is never taken", async () => {
    // The first answer is accepted; then every copy refuses, past the time allowed.
    const live = propagatingWorker([0, ...Array(1000).fill(1)]);
    await live.api.putSecret("acc", "s", "COS_OPERATOR_TOKEN", "older");
    const session = await open(live, 0).operator;
    await expect(session.op("migrate", { client: "bravo" })).rejects.toThrow(
      `migrate: ${NOT_THE_OPERATOR}`,
    );
  });

  it("never tries again an answer that is not the token's", async () => {
    const worker = propagatingWorker([]);
    const { operator, stale } = open(worker);
    const session = await operator;
    await expect(session.op("fails")).rejects.toThrow("fails: no client x");
    expect(worker.seen.filter((s) => s.action === "fails")).toHaveLength(1);
    expect(stale).toEqual([]);
  });

  it("tries again only the 'not the operator' answer: any other 401 is final", async () => {
    const worker = propagatingWorker([]);
    const { operator, stale } = open(worker);
    const session = await operator;
    await expect(session.op("unauthorised")).rejects.toThrow("unauthorised: session expired");
    expect(worker.seen.filter((s) => s.action === "unauthorised")).toHaveLength(1);
    expect(stale).toEqual([]);
  });

  it("stops trying again once another command has taken the session over (review of #546)", async () => {
    // Every copy refuses after the first answer, as when a --take-over set its own token.
    const worker = propagatingWorker([0, ...Array(1000).fill(1)]);
    await worker.api.putSecret("acc", "s", "COS_OPERATOR_TOKEN", "the other command's token");
    let holds = true;
    const { operator, stale } = open(worker, 60_000, async () => holds);
    const session = await operator;
    holds = false;
    await expect(session.op("migrate", { client: "bravo" })).rejects.toThrow(
      "migrate: another operator's command took the operator's Worker over",
    );
    expect(worker.seen.filter((s) => s.action === "migrate")).toHaveLength(1);
    expect(stale).toEqual([]);
  });
});
