// A gatekeeper cursor ends on `null`, not on an empty page: Google's and Microsoft's cursors hand
// back `[]` when one `next()` ran out of budget with results still ahead. Sync reads past it, so a
// delete reconciliation never takes a cut-short listing for the whole window (and deletes what the
// provider still holds), and a pass never stops short of the window's mail or events.
import { describe, expect, it } from "vitest";
import { ObservationTracker } from "../src/integrations/queue.ts";
import { gmailAdapter, outlookAdapter, outlookCalendarAdapter } from "../src/integrations/sync.ts";

const from = new Date("2026-08-01T00:00:00Z");
const to = new Date("2026-08-08T00:00:00Z");

function cursorOf<T>(pages: T[][]) {
  let i = 0;
  return { next: async () => pages[i++] ?? null };
}

describe("cursors with an empty page before the end", () => {
  it("reconciliation listings read past it", async () => {
    const gmail = await gmailAdapter.listIds?.(
      {
        searchMessages: async () =>
          cursorOf([[{ info: { id: "a" } }], [], [{ info: { id: "b" } }]]),
      },
      from,
      to,
    );
    expect(gmail).toEqual({ ids: ["a", "b"], complete: true });

    const outlook = await outlookAdapter.listIds?.(
      {
        listMessages: async () =>
          cursorOf([
            [{ id: "a", receivedAt: "2026-08-02T00:00:00Z" }],
            [],
            [{ id: "b", receivedAt: "2026-08-03T00:00:00Z" }],
          ]),
      },
      from,
      to,
    );
    expect(outlook).toEqual({ ids: ["a", "b"], complete: true });

    const calendar = await outlookCalendarAdapter.listIds?.(
      { listEvents: async () => cursorOf([[{ id: "e1" }], [], [{ id: "e2" }]]) },
      from,
      to,
    );
    expect(calendar).toEqual({ ids: ["e1", "e2"], complete: true });
  });

  it("a pass reads past it", async () => {
    const event = (id: string) => ({
      id,
      start: "2026-08-09T09:00:00Z",
      end: "2026-08-09T10:00:00Z",
      subject: `Meeting ${id}`,
    });
    const out = await outlookCalendarAdapter.pull(
      { listEvents: async () => cursorOf([[event("1")], [], [event("2")]]) },
      null,
      {
        since: "2026-08-07T12:00:00.000Z",
        now: "2026-11-05T12:00:00.000Z",
        tracker: new ObservationTracker(),
        limit: 25,
      },
    );
    expect(out.items.map((i) => i.providerId)).toEqual(["1", "2"]);
  });

  it("a cursor that never ends gives an incomplete listing, so nothing is deleted", async () => {
    let calls = 0;
    const endless = {
      next: async () => {
        calls += 1;
        return [];
      },
    };
    const gmail = await gmailAdapter.listIds?.({ searchMessages: async () => endless }, from, to);
    expect(gmail).toEqual({ ids: [], complete: false });
    expect(calls).toBe(20);
  });
});
