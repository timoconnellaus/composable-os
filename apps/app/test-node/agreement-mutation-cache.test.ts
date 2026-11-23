// Stage 44 step 5, the review of PR #291: what a person types, draws and answers when they agree
// (in me.agreements.accept, or a visitor's buying call) is not kept in the app's query cache once
// the call is over, whether it succeeded or failed. The blocks make these calls through
// `forgetAfter` (@composable-os/client), which resets the mutation; this runs it against TanStack
// Query's own MutationObserver, the thing `useMutation` is, with the options the hooks give.
import { forgetAfter } from "@composable-os/client";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

const given = {
  classId: "rec_fixture",
  email: "visitor@fixture.test",
  agreements: [
    {
      versionId: "agv_fixture",
      typedName: "Fixture Visitor",
      signature: {
        width: 1000,
        height: 400,
        strokes: [
          [
            [10, 10],
            [300, 200],
          ],
        ],
      },
      answers: [{ key: "q1", yes: true, note: "Fixture note" }],
    },
  ],
};

/** An observer as a block holds one (subscribed, as while the screen is mounted). */
function mounted(mutationFn: (input: typeof given) => Promise<unknown>) {
  const client = new QueryClient();
  const observer = new MutationObserver(client, {
    mutationKey: ["x.bookings.buy"],
    mutationFn,
    gcTime: 0,
  });
  const unsubscribe = observer.subscribe(() => {});
  const mutation = {
    mutateAsync: (input: typeof given) => observer.mutate(input),
    reset: () => observer.reset(),
  };
  const held = () =>
    JSON.stringify([
      observer.getCurrentResult().variables ?? null,
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.state.variables),
    ]);
  return { mutation, held, unsubscribe };
}

describe("a call that carries what a person gave keeps none of it in the cache", () => {
  it("after it succeeds, while the screen that made it is still on show", async () => {
    const { mutation, held, unsubscribe } = mounted(async () => ({ ok: true }));
    expect(await forgetAfter(mutation, given)).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(held()).not.toContain("Fixture");
    unsubscribe();
  });

  it("after it fails", async () => {
    const refused = Object.assign(new Error("refused"), { code: "invalid_input" });
    const { mutation, held, unsubscribe } = mounted(async () => {
      throw refused;
    });
    await expect(forgetAfter(mutation, given)).rejects.toBe(refused);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(held()).not.toContain("Fixture");
    unsubscribe();
  });

  it("without it, the variables stay while the screen is on show (why it is there)", async () => {
    const { mutation, held, unsubscribe } = mounted(async () => ({ ok: true }));
    await mutation.mutateAsync(given);
    expect(held()).toContain("Fixture Visitor");
    unsubscribe();
  });
});
