// PaymentsEvents: one Durable Object per provider (`idFromName(provider)`). It remembers the event
// ids it has seen (replay dedupe), keeps the recent events, holds the hook's initiator, and
// delivers each new event to the bound hook through the kit's hook-delivery queue, retried from its
// alarm.

import { DurableObject } from "cloudflare:workers";
import type {
  HookTargetMetadata,
  ObservationDescription,
} from "@composable-os/gatekeeper-interface/gatekeeper";
import { HookDeliveryQueue } from "@composable-os/gatekeeper-kit/hook-delivery-queue";
import { formatMinor } from "./money.js";
import type { PaymentsEvent, PaymentsProviderName } from "./types.js";

/** Recent events kept. */
const MAX_RECENT_EVENTS = 100;
/** Event ids remembered for replay dedupe: this many, for this long. */
const MAX_SEEN_IDS = 10_000;
const SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const HOOK = "hook";
/** The initiator stub, stored on its own beside the hook's record. */
const HOOK_INITIATOR = "hook:initiator";
const STATS = "stats";

/** What `HookInitiator.startHook()` returns, as this DO uses it. */
type StartedHook = {
  callback: { receiveEvent(event: PaymentsEvent): Promise<void> } & Partial<Disposable>;
  approvalQueue: {
    authorizeObservation(description: ObservationDescription): Promise<void>;
  } & Partial<Disposable>;
};

/** The persistent initiator stub the host handed `HookController.enable()`. */
export type StoredInitiator = { startHook(): Promise<StartedHook> } & Partial<Disposable>;

type HookRecord = {
  /** Names this enablement's deliveries in the queue; a fresh one per enable after a disable. */
  key: string;
  target: HookTargetMetadata;
  enabledAt: number;
};

type Stats = {
  accepted: number;
  duplicates: number;
  rejected: number;
  /** Verified subscription events not delivered, by why (ADR 0485). */
  ignored?: { foreign?: number; unreadable?: number };
};

export type EventsStatus = Stats & { hookEnabled: boolean };

/** One stored event, under the provider event id that carried it. */
type Queued = { deliveryId: string; event: PaymentsEvent };

/** The observation recorded before each delivery: ids, amounts and currency, never personal data. */
export function describeEvent(event: PaymentsEvent): ObservationDescription {
  if (event.kind === "subscription") {
    const invoice = event.invoice
      ? ` Invoice \`${event.invoice.ref}\`: ${formatMinor(event.invoice.amountPaid, event.invoice.currency)} paid.`
      : "";
    return {
      title: `Subscription event ${event.trigger}`,
      description:
        `Received a verified ${event.trigger} event for subscription \`${event.subscription.ref}\` ` +
        `(now ${event.subscription.status}) from ${event.provider} (event \`${event.eventId}\`).${invoice}`,
    };
  }
  const amount = formatMinor(event.amount, event.currency);
  const description =
    event.kind === "payment"
      ? `Received a verified payment of ${amount} for order \`${event.orderId}\` from ` +
        `${event.provider} (checkout \`${event.checkoutRef}\`, event \`${event.eventId}\`).`
      : `Received a verified refund of ${amount}` +
        (event.orderId ? ` for order \`${event.orderId}\`` : "") +
        ` from ${event.provider} (refund \`${event.refundRef}\`, event \`${event.eventId}\`).`;
  return { title: `Payment event ${event.kind}`, description };
}

export class PaymentsEvents extends DurableObject<Cloudflare.Env> {
  readonly #queue: HookDeliveryQueue<Queued>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Never log the event: it is the org's payment data.
    this.#queue = new HookDeliveryQueue<Queued>(ctx.storage.kv, () =>
      console.warn("payments: dropped an event after repeated delivery failures"),
    );
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        event TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS seen_at ON seen (at);
    `);
  }

  /**
   * Records one verified delivery: dedupes on the provider's event id, stores its events and
   * queues them for the hook.
   * @returns Whether the delivery was seen before.
   */
  async receive(eventId: string, events: PaymentsEvent[]): Promise<{ duplicate: boolean }> {
    const now = Date.now();
    const stats = this.#stats();
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT 1 FROM seen WHERE id = ?", eventId).toArray().length > 0) {
      stats.duplicates++;
      this.ctx.storage.kv.put(STATS, stats);
      return { duplicate: true };
    }
    // The caps are kept by key ranges, so a delivery reads only the rows it removes, not the
    // whole table (docs/cloudflare-costs.md). Rowids and seqs grow with each insert, and the
    // newest row is never deleted, so "the newest N" is "above the newest key less N".
    const seen = sql
      .exec<{ rowid: number }>(
        "INSERT INTO seen (id, at) VALUES (?, ?) RETURNING rowid",
        eventId,
        now,
      )
      .one();
    sql.exec("DELETE FROM seen WHERE at < ?", now - SEEN_RETENTION_MS);
    sql.exec("DELETE FROM seen WHERE rowid <= ?", seen.rowid - MAX_SEEN_IDS);
    const hook = this.ctx.storage.kv.get<HookRecord>(HOOK);
    let lastSeq = 0;
    events.forEach((event, index) => {
      lastSeq = sql
        .exec<{ seq: number }>(
          "INSERT INTO events (id, event) VALUES (?, ?) RETURNING seq",
          eventId,
          JSON.stringify(event),
        )
        .one().seq;
      const deliveryId = events.length === 1 ? eventId : `${eventId}#${index}`;
      if (hook) this.#queue.enqueue(hook.key, deliveryId, { deliveryId, event }, now);
    });
    if (lastSeq) sql.exec("DELETE FROM events WHERE seq <= ?", lastSeq - MAX_RECENT_EVENTS);
    stats.accepted++;
    this.ctx.storage.kv.put(STATS, stats);
    if (hook && events.length > 0) await this.ctx.storage.setAlarm(now);
    return { duplicate: false };
  }

  /** Counts a delivery whose signature did not verify. Nothing else is stored. */
  async countRejected(): Promise<void> {
    const stats = this.#stats();
    stats.rejected++;
    this.ctx.storage.kv.put(STATS, stats);
  }

  /**
   * Counts a verified subscription event that is not delivered (ADR 0485): a subscription this
   * host did not start, or one whose shape cannot be read. Nothing else is stored.
   */
  async countIgnored(why: "foreign" | "unreadable"): Promise<void> {
    const stats = this.#stats();
    stats.ignored = { ...stats.ignored, [why]: (stats.ignored?.[why] ?? 0) + 1 };
    this.ctx.storage.kv.put(STATS, stats);
  }

  /** The most recent events, newest first. */
  async listEvents(limit: number): Promise<PaymentsEvent[]> {
    return this.ctx.storage.sql
      .exec<{ event: string }>("SELECT event FROM events ORDER BY seq DESC LIMIT ?", limit)
      .toArray()
      .map((row) => JSON.parse(row.event) as PaymentsEvent);
  }

  async status(): Promise<EventsStatus> {
    return {
      ...this.#stats(),
      hookEnabled: this.ctx.storage.kv.get<HookRecord>(HOOK) !== undefined,
    };
  }

  /**
   * Enables (with an initiator) or disables (null) the hook. Re-enabling an enabled hook replaces
   * its initiator and keeps its pending deliveries.
   */
  async setHook(initiator: StoredInitiator | null, target?: HookTargetMetadata): Promise<void> {
    const existing = this.ctx.storage.kv.get<HookRecord>(HOOK);
    if (initiator === null) {
      if (existing) {
        this.#queue.cancel(existing.key);
        this.ctx.storage.kv.delete(HOOK);
        this.ctx.storage.kv.delete(HOOK_INITIATOR);
      }
      return;
    }
    this.ctx.storage.kv.put(HOOK_INITIATOR, initiator);
    this.ctx.storage.kv.put<HookRecord>(HOOK, {
      key: existing?.key ?? crypto.randomUUID(),
      target: target ?? { workspaceId: "" },
      enabledAt: Date.now(),
    });
  }

  override async alarm(): Promise<void> {
    await this.#queue.run(Date.now(), (hookKey, queued) => this.#deliver(hookKey, queued.event));
    const next = this.#queue.nextDue();
    if (next !== undefined) await this.ctx.storage.setAlarm(next);
  }

  async #deliver(hookKey: string, event: PaymentsEvent): Promise<void> {
    const hook = this.ctx.storage.kv.get<HookRecord>(HOOK);
    // Disabled, or re-enabled afresh since: the delivery is finished without being made.
    const initiator = this.ctx.storage.kv.get<StoredInitiator>(HOOK_INITIATOR);
    if (!hook || hook.key !== hookKey || !initiator) return;
    const started = await initiator.startHook();
    try {
      await started.approvalQueue.authorizeObservation(describeEvent(event));
      await started.callback.receiveEvent(event);
    } finally {
      started.callback[Symbol.dispose]?.();
      started.approvalQueue[Symbol.dispose]?.();
      initiator[Symbol.dispose]?.();
    }
  }

  #stats(): Stats {
    return this.ctx.storage.kv.get<Stats>(STATS) ?? { accepted: 0, duplicates: 0, rejected: 0 };
  }
}

export function eventsStub(
  env: Cloudflare.Env,
  provider: PaymentsProviderName,
): DurableObjectStub<PaymentsEvents> {
  return env.PAYMENTS_EVENTS.get(env.PAYMENTS_EVENTS.idFromName(provider));
}
