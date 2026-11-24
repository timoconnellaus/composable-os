// The owner's Today entry (stage 60 step 6, ADR 0872): the logic the owner's native block and the
// web Today share. It words the host's answer, sends one action's decision with the second step's
// words only once pressed, explains the host's refusals, forgets what is on screen only, and offers
// only the hooks a client can back. Fixture values only; the host's answers are core's tests.
import { describe, expect, it } from "vitest";
import {
  ApiError,
  approveInput,
  createOwnerHooks,
  forgetToday,
  NetworkError,
  needsComputer,
  OWNER_HOOKS_CALL,
  ownerFailure,
  rejectInput,
  type TodayItem,
  todayCompareWords,
  todayDayWords,
  todayValueWords,
  type WaitingAction,
  waitingActions,
} from "../src/index.ts";

const item = (extra: Partial<TodayItem> = {}): TodayItem => ({
  key: "fixture.count",
  label: "Came today",
  format: "count",
  value: 1234,
  currency: null,
  detail: null,
  compare: null,
  state: "ok",
  target: { kind: "rows" },
  ...extra,
});

const action = (extra: Partial<WaitingAction> = {}): WaitingAction => ({
  id: "pac_1",
  changeSetId: "chs_1",
  operation: "record.update",
  risk: "write",
  reason: "Fixture",
  status: "pending",
  preview: [],
  outbound: null,
  secondStep: null,
  ...extra,
});

describe("words", () => {
  it("words a count, a percent and money as the host gave them", () => {
    expect(todayValueWords(item(), "en-AU")).toBe("1,234");
    expect(todayValueWords(item({ format: "percent", value: 85 }), "en-AU")).toBe("85%");
    expect(
      todayValueWords(item({ format: "money", value: 123450, currency: "AUD" }), "en-AU"),
    ).toBe("$1,234.50");
    // A currency with no minor unit is not divided by 100.
    expect(
      todayValueWords(item({ format: "money", value: 500, currency: "JPY" }), "en-AU"),
    ).toMatch(/^JPY\s500$/);
  });

  it("words the comparison, or none", () => {
    expect(todayCompareWords(item())).toBeNull();
    expect(
      todayCompareWords(item({ value: 7, compare: { against: "yesterday", value: 5 } }), "en-AU"),
    ).toBe("5 yesterday");
    expect(
      todayCompareWords(
        item({
          format: "money",
          currency: "AUD",
          value: 1,
          compare: { against: "lastWeek", value: 9000 },
        }),
        "en-AU",
      ),
    ).toBe("$90.00 last week");
  });

  it("names the business's local day as the host gave it, whatever the device's zone", () => {
    expect(todayDayWords({ day: "2026-11-24", zone: "Pacific/Kiritimati" }, "en-AU")).toBe(
      "Tuesday 24 November",
    );
  });
});

describe("approving one action", () => {
  it("lists a setup change for a computer", () => {
    expect(needsComputer(action({ risk: "extension" }))).toBe(true);
    expect(needsComputer(action({ risk: "schema" }))).toBe(true);
    expect(needsComputer(action({ risk: "destructive" }))).toBe(false);
  });

  it("sends the second step's words only once pressed", () => {
    const step = { label: "Refund", confirmLabel: "Yes, refund", phrase: "refund it" };
    expect(approveInput(action({ secondStep: step }))).toEqual({ actionIds: ["pac_1"] });
    expect(approveInput(action({ secondStep: step }), true)).toEqual({
      actionIds: ["pac_1"],
      confirm: "Yes, refund",
    });
    expect(approveInput(action(), true)).toEqual({ actionIds: ["pac_1"] });
    expect(rejectInput(action(), "  not now ")).toEqual({ actionIds: ["pac_1"], note: "not now" });
    expect(rejectInput(action(), " ")).toEqual({ actionIds: ["pac_1"] });
  });

  it("keeps only what still waits", () => {
    const detail = { actions: [action(), action({ id: "pac_2", status: "applied" })] };
    expect(waitingActions(detail).map((a) => a.id)).toEqual(["pac_1"]);
  });

  it("explains the host's refusals", () => {
    const step = { label: "Refund", confirmLabel: "Yes, refund", phrase: "refund it" };
    expect(
      ownerFailure(new ApiError("second_step_required", "Second step", 409, step)),
    ).toMatchObject({ kind: "secondStep", step });
    expect(
      ownerFailure(
        new ApiError("forbidden", "Review it on a computer", 403, { reason: "review_on_computer" }),
      ),
    ).toEqual({ kind: "reviewOnComputer", message: "Review on a computer" });
    expect(ownerFailure(new ApiError("forbidden", "Needs orders:refund", 403))).toEqual({
      kind: "notAllowed",
      message: "Needs orders:refund",
    });
    expect(ownerFailure(new ApiError("forbidden", "Ended", 401)).kind).toBe("signIn");
    expect(ownerFailure(new NetworkError("down")).kind).toBe("offline");
  });
});

describe("on screen only", () => {
  it("drops money, rows and an approval's detail from the cache", () => {
    const removed: unknown[] = [];
    forgetToday({ removeQueries: ({ queryKey }) => removed.push(queryKey) });
    expect(removed).toEqual([["today.get"], ["today.rows"], ["approval.get"]]);
  });

  it("reads Today, its rows and a change set with gcTime 0", () => {
    const seen: { queryKey: readonly unknown[]; gcTime?: number }[] = [];
    const react = {
      useQuery: ((options: { queryKey: readonly unknown[]; gcTime?: number }) => {
        seen.push(options);
        return { data: undefined, isPending: true, error: null };
      }) as never,
      useMutation: (() => ({})) as never,
    };
    const client = {
      operations: Object.fromEntries(
        Object.values(OWNER_HOOKS_CALL)
          .flat()
          .map((name) => [name, {}]),
      ),
      query: (name: string, input: unknown) => ({
        queryKey: [name, input],
        queryFn: async () => 0,
      }),
      mutation: (name: string) => ({ mutationKey: [name], mutationFn: async () => 0 }),
    };
    const hooks = createOwnerHooks(react, client);
    hooks.useToday();
    hooks.useTodayRows("fixture.count");
    hooks.useChangeSet("chs_1");
    hooks.useWaiting();
    expect(seen.map((o) => [o.queryKey[0], o.gcTime])).toEqual([
      ["today.get", 0],
      ["today.rows", 0],
      ["approval.get", 0],
      ["approval.list", undefined],
    ]);
  });
});

describe("createOwnerHooks", () => {
  const react = {
    useQuery: (() => ({ data: undefined, isPending: true, error: null })) as never,
    useMutation: (() => ({})) as never,
  };
  const holding = (names: string[]) => ({
    operations: Object.fromEntries(names.map((name) => [name, {}])),
    query: () => ({}),
    mutation: () => ({}),
  });

  it("offers every hook to a client holding all the operations", () => {
    const all = Object.values(OWNER_HOOKS_CALL).flat();
    expect(Object.keys(createOwnerHooks(react, holding(all))).sort()).toEqual(
      Object.keys(OWNER_HOOKS_CALL).sort(),
    );
  });

  it("offers only the approvals and the inbox to a release without Today's own operations", () => {
    const built = Object.values(OWNER_HOOKS_CALL)
      .flat()
      .filter((name) => !name.startsWith("today."));
    const hooks = Object.keys(createOwnerHooks(react, holding(built)));
    expect(hooks).toContain("useApprove");
    expect(hooks).toContain("useNotices");
    expect(hooks).not.toContain("useToday");
  });
});
