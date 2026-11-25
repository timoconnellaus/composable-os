// A test double of the payments gatekeeper's payout reads (stage 52 step 4, ADR 0793) for the
// host's finance tests: `listPayouts` and `payoutLines` answered from payouts a test makes, a page
// at a time, newest first as the provider lists them, counting every call. A test can make the
// key lack the permission (`unavailable`, a 403), or only for the lines (Payouts: read without
// Balance: read), the key be refused (`revoked`, a 401), the provider fail (`error`), the cursor
// stop moving (`stuck`), and a page carry lines the gatekeeper could not read (`unreadable`). The
// real gatekeeper and its fake provider are driven end to end in
// apps/runner/test/finance-payouts.test.ts.
import { env } from "cloudflare:workers";
import type { IntegrationRuntime } from "../src/index.ts";
import { unique } from "./helpers.ts";

export interface DoubleLine {
  ref: string;
  kind: "payment" | "refund" | "dispute" | "adjustment" | "fee" | "payout_reversal";
  amount: number;
  fee: number;
  currency: string;
  paymentRef: string | null;
  refundRef: string | null;
  reversalOf?: string | null;
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
  /** Lines the gatekeeper could not read, reported on its first page. */
  unreadable?: number;
}

export interface PayoutsDouble {
  runtime: IntegrationRuntime;
  payouts: DoublePayout[];
  /** Provider calls answered (pages of payouts or lines), by method. */
  calls: { listPayouts: number; payoutLines: number };
  mode: {
    reads: "ok" | "unavailable" | "error" | "revoked";
    /** Payouts: read but not Balance: read: the lines are refused. */
    linesUnavailable: boolean;
    /** A cursor that does not move: every later page names the cursor it was asked with. */
    stuck: boolean;
    pageSize: number;
  };
  /** Creates the org's payments connection (fake), owned by `ownerId`; its id. */
  connect(ownerId: string): Promise<string>;
  /** A payout of `lines` arriving `arrivalDate`; its amount is the lines' net plus `skew`. */
  pay(
    arrivalDate: string,
    lines: (Omit<DoubleLine, "ref" | "currency" | "occurredAt" | "reversalOf"> & {
      reversalOf?: string | null;
      currency?: string;
    })[],
    extra?: Partial<Pick<DoublePayout, "status" | "itemised" | "currency" | "unreadable">> & {
      skew?: number;
    },
  ): DoublePayout;
}

let lineN = 0;

export function payoutsDouble(currency: string): PayoutsDouble {
  const payouts: DoublePayout[] = [];
  const calls = { listPayouts: 0, payoutLines: 0 };
  const mode: PayoutsDouble["mode"] = {
    reads: "ok",
    linesUnavailable: false,
    stuck: false,
    pageSize: 100,
  };
  const no = () => Promise.reject(new Error("not used in this test"));
  const refusal = { unavailable: true, reason: "this key may not read payouts" };
  const fails = () => {
    if (mode.reads === "error") throw new Error("the provider answered 503");
    if (mode.reads === "revoked") {
      throw new Error("Stripe refused the key (HTTP 401): the connection needs attention.");
    }
  };
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
      const at = <T extends { ref: string }>(list: T[]) => {
        if (!arg.after) return 0;
        const i = list.findIndex((x) => x.ref === arg.after);
        if (i === -1) throw new Error("unknown cursor");
        return i + 1;
      };
      if (input.method === "listPayouts") {
        calls.listPayouts += 1;
        fails();
        if (mode.reads === "unavailable") return { value: refusal, pending: [], applied: [] };
        const all = payouts
          .filter((p) => p.arrivalDate >= String(arg.since))
          .sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate) || b.ref.localeCompare(a.ref));
        const from = at(all);
        const page = all.slice(from, from + mode.pageSize);
        const next = from + mode.pageSize < all.length ? (page.at(-1)?.ref ?? null) : null;
        return {
          value: {
            payouts: page.map(({ lines: _lines, unreadable: _u, ...p }) => ({
              provider: "fake",
              ...p,
            })),
            next: mode.stuck && arg.after ? arg.after : next,
          },
          pending: [],
          applied: [],
        };
      }
      if (input.method === "payoutLines") {
        calls.payoutLines += 1;
        fails();
        if (mode.reads === "unavailable" || mode.linesUnavailable) {
          return { value: refusal, pending: [], applied: [] };
        }
        const payout = payouts.find((p) => p.ref === arg.payoutRef);
        if (!payout) throw new Error("no such payout");
        const from = at(payout.lines);
        const page = payout.lines.slice(from, from + mode.pageSize);
        const next =
          from + mode.pageSize < payout.lines.length ? (page.at(-1)?.ref ?? null) : null;
        return {
          value: {
            lines: page,
            next: mode.stuck && arg.after ? arg.after : next,
            ...(from === 0 && payout.unreadable ? { unreadable: payout.unreadable } : {}),
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
          reversalOf: l.reversalOf ?? null,
          ref: `ftx_${String(lineN).padStart(6, "0")}`,
          currency: l.currency ?? extra.currency ?? currency,
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
        ...(extra.unreadable ? { unreadable: extra.unreadable } : {}),
      };
      payouts.push(payout);
      return payout;
    },
  };
}
