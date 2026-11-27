// One operator's command at a time on the operator's Worker (stage 66 step 7; review of #526, S1).
//
// Opening the operator's Worker sets its token for this command, which cuts off any other command
// still using it, its own rollback included. So the Worker is opened only when a command first
// calls it (`list`, `pause`, `resume` and `secret` touch only the registry and never open it), and
// only after the command has taken the registry's one session row (`takeOperatorSession`): while
// another command holds it, this one is refused before it changes anything. The row is renewed
// with each call and given back when the command ends; a command that was killed holds it until
// its time runs out, or until the operator takes it over deliberately (`--take-over`).
import {
  holdsOperatorSession,
  releaseOperatorSession,
  takeOperatorSession,
} from "@composable-os/db/registry-writes";
import { FleetError } from "./clients.ts";
import type { Operator } from "./operator-client.ts";

/** How long a command holds the operator's Worker without a call (each call renews it). */
export const SESSION_TTL_MS = 30 * 60 * 1000;

export interface SessionOptions {
  command: string;
  takeOver?: boolean;
  now?: () => number;
  /** How often a run renews its session while it is alive (default a third of the time it holds). */
  heartbeatMs?: number;
}

/** The operator's Worker for one command: opened, and the session taken, on its first call. */
export function lazyOperator(
  registry: D1Database,
  open: () => Promise<Operator & { close(): Promise<void> }>,
  options: SessionOptions,
): Operator & { close(): Promise<void>; readonly opened: boolean } {
  const holder = `run-${crypto.randomUUID()}`;
  const now = options.now ?? Date.now;
  let opened: (Operator & { close(): Promise<void> }) | null = null;
  let opening: Promise<Operator & { close(): Promise<void> }> | null = null;
  let held = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };
  const take = async () => {
    // `--take-over` takes the session once, never again: a run that took it over renews only its
    // own, and never takes it back from a later one.
    const taken = await takeOperatorSession(registry, holder, options.command, SESSION_TTL_MS, {
      now: now(),
      ...(options.takeOver && !held ? { takeOver: true } : {}),
    });
    if (!taken.taken) {
      throw new FleetError(
        `Another operator's command (${taken.held.command}) holds the operator's Worker until ${new Date(taken.held.until).toISOString()}: nothing was changed. Run this when it has finished; if it was killed, wait until then or pass --take-over.`,
      );
    }
    if (!held) {
      // Renewed while the run is alive, whatever it is doing (a long migration, an export, an
      // upload between calls): a session lapses only when its run is gone (review of #526, N1).
      heartbeat = setInterval(
        () => {
          take().catch(() => stopHeartbeat());
        },
        options.heartbeatMs ?? SESSION_TTL_MS / 3,
      );
      (heartbeat as { unref?: () => void }).unref?.();
    }
    held = true;
  };
  const ready = async () => {
    if (opened) {
      await take();
      return opened;
    }
    opening ??= (async () => {
      await take();
      opened = await open();
      return opened;
    })();
    return opening;
  };
  return {
    get opened() {
      return opened !== null;
    },
    async op<T>(action: string, body?: Record<string, unknown>) {
      return (await ready()).op<T>(action, body);
    },
    async putFile(client, key, bytes, contentType) {
      return (await ready()).putFile(client, key, bytes, contentType);
    },
    async getExport(path) {
      return (await ready()).getExport(path);
    },
    async claim() {
      await take();
    },
    async close() {
      stopHeartbeat();
      // The token is replaced only by the run that still holds the session: a run another took
      // over from (or whose session lapsed) leaves the Worker to that one (review of #526, N1).
      const mine = held && (await holdsOperatorSession(registry, holder));
      try {
        if (opened && mine) await opened.close();
      } finally {
        if (mine) await releaseOperatorSession(registry, holder);
      }
    },
  };
}
