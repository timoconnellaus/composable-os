// A test double of the payments gatekeeper's payout reads (stage 52 step 4, ADR 0793) for the
// host's finance tests: `listPayouts` and `payoutLines` answered from payouts a test makes, a page
// at a time, newest first as the provider lists them, counting every call; a test can make the
// connection refuse the read (`unavailable`) or the provider fail (`error`). The real gatekeeper
// and its fake provider are driven end to end in apps/runner/test/finance-payouts.test.ts.
import { env } from "cloudflare:workers";
import type { IntegrationRuntime } from "../src/index.ts";
import { unique } from "./helpers.ts";

export interface DoubleLine {
  ref: string;
  kind: "payment" | "refund" | "dispute" | "adjustment" | "fee";
  amount: number;
  fee: number;
  currency: string;
  paymentRef: string | null;
  refundRef: string | null;
  occurredAt: string;
}

export interface DoublePayout {
  ref: string;
  amount: number;
  currency: string;
  arrivalDate: string;
  status: "paid" | "pending" | "in_transit" | "failed" | "canceled";
  createdAt: string;
  itemised: boolean;
  lines: DoubleLine[];
}

export interface PayoutsDouble {
  runtime: IntegrationRuntime;
  payouts: DoublePayout[];
  /** Provider calls answered (pages of payouts or lines), by method. */
  calls: { listPayouts: number; payoutLines: number };
  mode: { reads: "ok" | "unavailable" | "error"; pageSize: number };
  /** Creates the org's payments connection (fake), owned by `ownerId`. */
  connect(ownerId: string): Promise<string>;
  /** A payout of `lines` arriving `arrivalDate`; its amount is the lines' net plus `skew`. */
  pay(
    arrivalDate: string,
    lines: Omit<DoubleLine, "ref" | "currency" | "occurredAt">[],
    extra?: Partial<Pick<DoublePayout, "status" | "itemised" | "currency">> & { skew?: number },
  ): DoublePayout;
}

let lineN = 0;

export function payoutsDouble(currency: string): PayoutsDouble {
  const payouts: DoublePayout[] = [];
  const calls = { listPayouts: 0, payoutLines: 0 };
  const mode: PayoutsDouble["mode"] = { reads: "ok", pageSize: 100 };
  const no = () => Promise.reject(new Error("not used in this test"));
  const refusal = { unavailable: true, reason: "this key may not read payouts" };
  const runtime: IntegrationRuntime = {
    availableVendors: async () => ["payments"],
    startConnect: no,
    provision: no,
    redeem: no,
    reconnect: no,
    disconnect: no,
    bindResource: no,
    unbindResource: no,
    configure: no,
    supportedResources: no,
    types: no,
    setSync: no,
    syncNow: no,
    call: no,
    applyOutbound: no,
    rejectOutbound: async () => undefined,
    async callAsHost(input) {
      if (input.purpose !== "orders") throw new Error("payouts are the host's orders call");
      const arg = input.args[0] as Record<string, unknown>;
      if (input.method === "listPayouts") {
        calls.listPayouts += 1;
        if (mode.reads === "error") throw new Error("the provider answered 503");
        if (mode.reads === "unavailable") return { value: refusal, pending: [], applied: [] };
        const all = payouts
          .filter((p) => p.arrivalDate >= String(arg.since))
          .sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate) || b.ref.localeCompare(a.ref));
        const from = arg.after ? all.findIndex((p) => p.ref === arg.after) + 1 : 0;
        const page = all.slice(from, from + mode.pageSize);
        return {
          value: {
            payouts: page.map(({ lines: _lines, ...p }) => ({ provider: "fake", ...p })),
            next: from + mode.pageSize < all.length ? (page.at(-1)?.ref ?? null) : null,
          },
          pending: [],
          applied: [],
        };
      }
      if (input.method === "payoutLines") {
        calls.payoutLines += 1;
        if (mode.reads === "error") throw new Error("the provider answered 503");
        if (mode.reads === "unavailable") return { value: refusal, pending: [], applied: [] };
        const payout = payouts.find((p) => p.ref === arg.payoutRef);
        if (!payout) throw new Error("no such payout");
        const from = arg.after ? payout.lines.findIndex((l) => l.ref === arg.after) + 1 : 0;
        const page = payout.lines.slice(from, from + mode.pageSize);
        return {
          value: {
            lines: page,
            next: from + mode.pageSize < payout.lines.length ? (page.at(-1)?.ref ?? null) : null,
          },
          pending: [],
          applied: [],
        };
      }
      throw new Error(`unexpected ${input.method}`);
    },
  };
  return {
    runtime,
    payouts,
    calls,
    mode,
    async connect(ownerId) {
      const id = `con_${unique("pay").toUpperCase()}`;
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, resources, created_at, updated_at) VALUES (?, 'payments', 'org', ?, 'Payments', 'active', ?, ?, ?)",
      )
        .bind(
          id,
          ownerId,
          JSON.stringify([
            {
              key: "merchant",
              url: "payments://merchant/fake",
              pattern: "payments://merchant/:provider",
              title: "Payments with Fake provider",
              tsType: "PaymentsSession",
              bindingName: "PAYMENTS",
            },
          ]),
          now,
          now,
        )
        .run();
      return id;
    },
    pay(arrivalDate, lines, extra = {}) {
      const made: DoubleLine[] = lines.map((l) => {
        lineN += 1;
        return {
          ...l,
          ref: `ftx_${String(lineN).padStart(6, "0")}`,
          currency: extra.currency ?? currency,
          occurredAt: `${arrivalDate}T00:00:00.000Z`,
        };
      });
      const payout: DoublePayout = {
        ref: `fpo_${unique("p")}`,
        amount: made.reduce((n, l) => n + l.amount - l.fee, 0) + (extra.skew ?? 0),
        currency: extra.currency ?? currency,
        arrivalDate,
        status: extra.status ?? "paid",
        createdAt: `${arrivalDate}T00:00:00.000Z`,
        itemised: extra.itemised ?? true,
        lines: extra.itemised === false ? [] : made,
      };
      payouts.push(payout);
      return payout;
    },
  };
}
