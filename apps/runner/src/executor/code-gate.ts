// Code Mode's per-user concurrency limit (ADR 0043): one small Durable Object per user
// (getByName(userId)) holding at most one lease. A lease expires on its own after the script's
// timeout plus a margin, so a crashed caller cannot lock a user out. The DO does no other work and
// is idle (hibernated) between runs. The rate limit is separate: the Workers Rate Limiting binding
// in cos-app (CODE_MODE_RATE_LIMIT).
import { DurableObject } from "cloudflare:workers";
import { ClientDurableObject, refreshOnEachCall } from "@composable-os/db/client-entries";

interface Lease {
  token: string;
  until: number;
}

/** One per client and user on a many-client host: named `<client>:<proof>:<userId>` (ADR 0615). */
export class CodeModeGate extends ClientDurableObject(DurableObject<Env>) {
  /** A lease token, or null while another run of this user holds an unexpired lease. */
  async acquire(ttlMs: number): Promise<string | null> {
    const now = Date.now();
    const held = await this.ctx.storage.get<Lease>("lease");
    if (held && held.until > now) return null;
    const token = crypto.randomUUID();
    await this.ctx.storage.put("lease", { token, until: now + ttlMs } satisfies Lease);
    return token;
  }

  async release(token: string): Promise<void> {
    const held = await this.ctx.storage.get<Lease>("lease");
    if (held?.token === token) await this.ctx.storage.delete("lease");
  }
}

// Every async method re-reads the client's admission first (stage 66, review of #512, M2).
refreshOnEachCall(CodeModeGate);
