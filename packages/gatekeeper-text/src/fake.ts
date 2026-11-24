// The fake text provider, for development and tests (ADR 0672): it sends nothing anywhere. Its
// ledger (one Durable Object) keeps what was "sent" and the checking codes, which tests read
// through `FakeTextControl`, and its webhook (`/in/fake`) takes receipts and replies signed with
// FAKE_WEBHOOK_SECRET, exactly as a real provider's would be checked. It is refused off
// localhost without its own secret, and `cos deploy` refuses it in a live environment.

import { DurableObject } from "cloudflare:workers";
import { ActionApplyError } from "@composable-os/gatekeeper-kit/actions";
import {
  fakeWebhookSecret,
  type ProviderEvent,
  type TextEnv,
  type TextProvider,
  type VerifiedWebhook,
} from "./provider.js";

/** One text the fake "sent". */
export type FakeSent = { providerRef: string; from: string; to: string; text: string; at: string };

/** A code lives this long, and is tried at most this many times. */
const CODE_TTL_MS = 10 * 60_000;
const CODE_TRIES = 5;
/** The ledger keeps this many sent texts. */
const SENT_LIMIT = 500;

export class FakeTextLedger extends DurableObject {
  /** Records a sent text; a number the test marked unreachable is refused before sending. */
  async send(input: { from: string; to: string; text: string }): Promise<FakeSent | null> {
    const kv = this.ctx.storage.kv;
    if (kv.get(`refuse:${input.to}`)) return null;
    const seq = (kv.get<number>("seq") ?? 0) + 1;
    kv.put("seq", seq);
    const sent: FakeSent = { providerRef: `ftx_${seq}`, ...input, at: new Date().toISOString() };
    kv.put(`sent:${String(seq).padStart(10, "0")}`, sent);
    const keys = [...kv.list({ prefix: "sent:" })].map(([key]) => key);
    for (const key of keys.slice(0, Math.max(0, keys.length - SENT_LIMIT))) kv.delete(key);
    return sent;
  }

  async startCheck(to: string): Promise<string> {
    const code = String(
      100_000 + ((crypto.getRandomValues(new Uint32Array(1))[0] as number) % 900_000),
    );
    this.ctx.storage.kv.put(`code:${to}`, { code, at: Date.now(), tries: 0 });
    return code;
  }

  async check(to: string, code: string): Promise<boolean> {
    const kv = this.ctx.storage.kv;
    const held = kv.get<{ code: string; at: number; tries: number }>(`code:${to}`);
    if (!held || Date.now() - held.at > CODE_TTL_MS || held.tries >= CODE_TRIES) return false;
    if (held.code !== code) {
      kv.put(`code:${to}`, { ...held, tries: held.tries + 1 });
      return false;
    }
    kv.delete(`code:${to}`);
    return true;
  }

  /** What was sent, oldest first (tests only, through FakeTextControl). */
  async sent(): Promise<FakeSent[]> {
    return [...this.ctx.storage.kv.list<FakeSent>({ prefix: "sent:" })].map(([, v]) => v);
  }

  /** The code last sent to `to` (tests only), as the member reads it on their phone. */
  async codeFor(to: string): Promise<string | null> {
    return this.ctx.storage.kv.get<{ code: string }>(`code:${to}`)?.code ?? null;
  }

  /** Makes the fake refuse texts to `to` (a test of a refused send). */
  async refuse(to: string, refuse: boolean): Promise<void> {
    if (refuse) this.ctx.storage.kv.put(`refuse:${to}`, true);
    else this.ctx.storage.kv.delete(`refuse:${to}`);
  }

  async clear(): Promise<void> {
    for (const [key] of [...this.ctx.storage.kv.list()]) this.ctx.storage.kv.delete(key);
  }
}

export function fakeLedger(env: TextEnv): DurableObjectStub<FakeTextLedger> {
  const ns = env.FAKE_TEXT_LEDGER as DurableObjectNamespace<FakeTextLedger> | undefined;
  if (!ns) throw new Error("The fake text provider has no ledger binding (FAKE_TEXT_LEDGER).");
  return ns.get(ns.idFromName("fake"));
}

// ── The webhook's signature: `t=<unix seconds>,v1=<hex>` of HMAC-SHA256(secret, `${t}.${body}`).

const TOLERANCE_SECONDS = 5 * 60;
const encoder = new TextEncoder();

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function signedBytes(t: string, body: Uint8Array): Uint8Array {
  const prefix = encoder.encode(`${t}.`);
  const out = new Uint8Array(prefix.byteLength + body.byteLength);
  out.set(prefix, 0);
  out.set(body, prefix.byteLength);
  return out;
}

/** The signature header for `body`, as the fake provider sends it (and tests make). */
export async function signFakeWebhook(
  secret: string,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const t = String(nowSeconds);
  const key = await hmacKey(secret, "sign");
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, signedBytes(t, encoder.encode(body))),
  );
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function verifySignature(
  secret: string,
  header: string | undefined,
  body: Uint8Array,
  nowSeconds: number,
): Promise<string | null> {
  if (!header) return "missing signature";
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const at = p.indexOf("=");
      return [p.slice(0, at).trim(), p.slice(at + 1).trim()];
    }),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !/^\d{1,12}$/.test(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) {
    return "malformed signature";
  }
  if (Math.abs(nowSeconds - Number(t)) > TOLERANCE_SECONDS) return "stale timestamp";
  const mac = new Uint8Array(v1.match(/../g)?.map((h) => Number.parseInt(h, 16)) ?? []);
  const key = await hmacKey(secret, "verify");
  return (await crypto.subtle.verify("HMAC", key, mac, signedBytes(t, body)))
    ? null
    : "bad signature";
}

/** One delivery of the fake's webhook. */
export type FakeWebhookBody = {
  id: string;
  events: (
    | { type: "receipt"; ref: string; status: "delivered" | "failed"; costMinor?: number }
    | { type: "reply"; from: string; text: string }
  )[];
};

const REF = /^[A-Za-z0-9_.:-]{1,100}$/;

/** Reads a verified fake delivery into provider-neutral events. */
export async function verifyFakeWebhook(
  secret: string,
  headers: Record<string, string>,
  body: Uint8Array,
  nowSeconds: number,
): Promise<VerifiedWebhook> {
  const refused = await verifySignature(secret, headers["x-fake-signature"], body, nowSeconds);
  if (refused) return { ok: false, reason: refused };
  let parsed: FakeWebhookBody;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as FakeWebhookBody;
  } catch {
    return { ok: false, reason: "malformed body" };
  }
  if (typeof parsed?.id !== "string" || !REF.test(parsed.id) || !Array.isArray(parsed.events)) {
    return { ok: false, reason: "malformed body" };
  }
  const at = new Date(nowSeconds * 1000).toISOString();
  const events: ProviderEvent[] = [];
  for (const e of parsed.events.slice(0, 50)) {
    if (e?.type === "receipt" && typeof e.ref === "string" && REF.test(e.ref)) {
      if (e.status !== "delivered" && e.status !== "failed") continue;
      events.push({
        type: "receipt",
        providerRef: e.ref,
        status: e.status,
        at,
        ...(Number.isSafeInteger(e.costMinor) && (e.costMinor as number) >= 0
          ? { costMinor: e.costMinor as number }
          : {}),
      });
    } else if (e?.type === "reply" && typeof e.from === "string" && typeof e.text === "string") {
      events.push({ type: "reply", from: e.from, body: e.text.slice(0, 1600), at });
    }
  }
  return { ok: true, eventId: parsed.id, events };
}

/** The fake provider: the ledger stands in for the network. */
export function fakeTextProvider(env: TextEnv): TextProvider {
  return {
    name: "fake",
    async send(input) {
      const sent = await fakeLedger(env).send(input);
      if (!sent) throw new ActionApplyError("The fake provider refused this number.");
      return { providerRef: sent.providerRef };
    },
    async startCheck(input) {
      await fakeLedger(env).startCheck(input.to);
    },
    async check(input) {
      return fakeLedger(env).check(input.to, input.code);
    },
    verifyWebhook: (headers, body, nowSeconds) =>
      verifyFakeWebhook(fakeWebhookSecret(env), headers, body, nowSeconds),
  };
}
