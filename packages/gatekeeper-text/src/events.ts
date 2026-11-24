// TextEvents: one Durable Object for the deployment (`idFromName("events")`), as the payments
// gatekeeper's PaymentsEvents (ADR 0672). It
// - remembers the provider event ids it has seen (replay dedupe);
// - knows which host key each sent text had (`providerRef → ref`), so a receipt names its row;
// - keeps the numbers that replied STOP (a SHA-256 of each, never the number) and refuses a text
//   to one even if the host asks, until START;
// - answers HELP with a fixed text, at most once a day per number;
// - holds the hook's initiator and delivers each event to the host through the kit's hook
//   delivery queue, retried from its alarm.
// Any other reply is not read or stored (stage 36 adds a receiver).

import { DurableObject } from "cloudflare:workers";
import type {
  HookTargetMetadata,
  ObservationDescription,
} from "@composable-os/gatekeeper-interface/gatekeeper";
import { HookDeliveryQueue } from "@composable-os/gatekeeper-kit/hook-delivery-queue";
import { type ProviderEvent, providerFor, senderNumber } from "./provider.js";
import { helpAnswer, keywordOf, segmentsOf } from "./text.js";
import type { TextEvent } from "./types.js";

/** Event ids remembered for replay dedupe: this many, for this long. */
const MAX_SEEN_IDS = 10_000;
const SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Sent texts' references kept for their receipts: this many, for this long. */
const MAX_REFS = 20_000;
const REF_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const HELP_EVERY_MS = 24 * 60 * 60 * 1000;

const HOOK = "hook";
const HOOK_INITIATOR = "hook:initiator";
const BUSINESS = "business";

type StartedHook = {
  callback: { receiveEvent(event: TextEvent): Promise<void> } & Partial<Disposable>;
  approvalQueue: {
    authorizeObservation(description: ObservationDescription): Promise<void>;
  } & Partial<Disposable>;
};
export type StoredInitiator = { startHook(): Promise<StartedHook> } & Partial<Disposable>;
type HookRecord = { key: string; target: HookTargetMetadata; enabledAt: number };
type Queued = { event: TextEvent };

export async function numberHash(number: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(number));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The observation recorded before each delivery: what happened, never a number or words. */
export function describeEvent(event: TextEvent): ObservationDescription {
  if (event.kind === "receipt") {
    return {
      title: `Text ${event.status}`,
      description: `The ${event.provider} provider reported text \`${event.providerRef}\` ${event.status} (event \`${event.eventId}\`).`,
    };
  }
  return {
    title: `Text reply ${event.keyword.toUpperCase()}`,
    description: `A number replied ${event.keyword.toUpperCase()} to the business's texts (event \`${event.eventId}\`).`,
  };
}

export class TextEvents extends DurableObject<Cloudflare.Env> {
  readonly #queue: HookDeliveryQueue<Queued>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Never log the event: it names a member's number.
    this.#queue = new HookDeliveryQueue<Queued>(ctx.storage.kv, () =>
      console.warn("text: dropped an event after repeated delivery failures"),
    );
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS seen_at ON seen (at);
      CREATE TABLE IF NOT EXISTS refs (provider_ref TEXT PRIMARY KEY, ref TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS refs_at ON refs (at);
      CREATE TABLE IF NOT EXISTS stops (number_hash TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS help (number_hash TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `);
  }

  /** A text the facet sent: its host key, for its receipts; and the business's name, for HELP. */
  async sent(providerRef: string, ref: string | null, business: string | null): Promise<void> {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    if (ref) {
      const row = sql
        .exec<{ rowid: number }>(
          "INSERT OR REPLACE INTO refs (provider_ref, ref, at) VALUES (?, ?, ?) RETURNING rowid",
          providerRef,
          ref,
          now,
        )
        .one();
      sql.exec("DELETE FROM refs WHERE at < ?", now - REF_RETENTION_MS);
      sql.exec("DELETE FROM refs WHERE rowid <= ?", row.rowid - MAX_REFS);
    }
    if (business && this.ctx.storage.kv.get(BUSINESS) !== business) {
      this.ctx.storage.kv.put(BUSINESS, business);
    }
  }

  /** Whether `number` replied STOP (and not START since). */
  async isStopped(number: string): Promise<boolean> {
    const hash = await numberHash(number);
    return (
      this.ctx.storage.sql.exec("SELECT 1 FROM stops WHERE number_hash = ?", hash).toArray()
        .length > 0
    );
  }

  /**
   * Records one verified delivery: dedupes on the provider's event id, applies STOP and START,
   * answers HELP, and queues what the host must know.
   */
  async receive(
    provider: string,
    eventId: string,
    events: ProviderEvent[],
  ): Promise<{ duplicate: boolean; queued: number }> {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT 1 FROM seen WHERE id = ?", eventId).toArray().length > 0) {
      return { duplicate: true, queued: 0 };
    }
    const seen = sql
      .exec<{ rowid: number }>(
        "INSERT INTO seen (id, at) VALUES (?, ?) RETURNING rowid",
        eventId,
        now,
      )
      .one();
    sql.exec("DELETE FROM seen WHERE at < ?", now - SEEN_RETENTION_MS);
    sql.exec("DELETE FROM seen WHERE rowid <= ?", seen.rowid - MAX_SEEN_IDS);
    const out: TextEvent[] = [];
    for (const [index, e] of events.entries()) {
      const id = events.length === 1 ? eventId : `${eventId}#${index}`;
      if (e.type === "receipt") {
        const ref =
          sql
            .exec<{ ref: string }>("SELECT ref FROM refs WHERE provider_ref = ?", e.providerRef)
            .toArray()[0]?.ref ?? null;
        out.push({
          kind: "receipt",
          eventId: id,
          provider,
          ref,
          providerRef: e.providerRef,
          status: e.status,
          at: e.at,
          ...(e.costMinor !== undefined ? { costMinor: e.costMinor } : {}),
        });
        continue;
      }
      const keyword = keywordOf(e.body);
      // Not a keyword: not read further, not stored, not passed on (stage 36 adds a receiver).
      if (!keyword || !/^\+[1-9]\d{7,14}$/.test(e.from)) continue;
      const hash = await numberHash(e.from);
      if (keyword === "stop") {
        sql.exec("INSERT OR REPLACE INTO stops (number_hash, at) VALUES (?, ?)", hash, now);
      } else if (keyword === "start") {
        sql.exec("DELETE FROM stops WHERE number_hash = ?", hash);
      }
      let answeredSegments: number | undefined;
      if (keyword === "help") answeredSegments = await this.#answerHelp(e.from, hash, now);
      out.push({
        kind: "reply",
        eventId: id,
        provider,
        from: e.from,
        keyword,
        at: e.at,
        ...(answeredSegments ? { answeredSegments } : {}),
      });
    }
    const hook = this.ctx.storage.kv.get<HookRecord>(HOOK);
    if (hook) {
      for (const event of out) this.#queue.enqueue(hook.key, event.eventId, { event }, now);
      if (out.length) await this.ctx.storage.setAlarm(now);
    }
    return { duplicate: false, queued: hook ? out.length : 0 };
  }

  /** HELP's fixed answer, once a day per number; its segments, or undefined when none went. */
  async #answerHelp(from: string, hash: string, now: number): Promise<number | undefined> {
    const sql = this.ctx.storage.sql;
    const last = sql
      .exec<{ at: number }>("SELECT at FROM help WHERE number_hash = ?", hash)
      .toArray()[0]?.at;
    if (last !== undefined && now - last < HELP_EVERY_MS) return undefined;
    const text = helpAnswer(this.ctx.storage.kv.get<string>(BUSINESS) ?? null);
    try {
      await providerFor(this.env).send({ from: senderNumber(this.env), to: from, text });
    } catch {
      // Not answered (no provider, or it refused): asked again, it is tried again.
      return undefined;
    }
    sql.exec("INSERT OR REPLACE INTO help (number_hash, at) VALUES (?, ?)", hash, now);
    return segmentsOf(text);
  }

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

  async hookEnabled(): Promise<boolean> {
    return this.ctx.storage.kv.get<HookRecord>(HOOK) !== undefined;
  }

  override async alarm(): Promise<void> {
    await this.#queue.run(Date.now(), (hookKey, queued) => this.#deliver(hookKey, queued.event));
    const next = this.#queue.nextDue();
    if (next !== undefined) await this.ctx.storage.setAlarm(next);
  }

  async #deliver(hookKey: string, event: TextEvent): Promise<void> {
    const hook = this.ctx.storage.kv.get<HookRecord>(HOOK);
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
}

export function eventsStub(env: Cloudflare.Env): DurableObjectStub<TextEvents> {
  return env.TEXT_EVENTS.get(env.TEXT_EVENTS.idFromName("events"));
}
