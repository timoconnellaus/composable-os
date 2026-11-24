// The provider-neutral interface every text message provider implements (ADR 0672), and which one
// this deployment uses. The business pays its own provider account (stage 30, decision 1): the
// provider's keys are this Worker's secrets only, set by a person, never readable back, never in
// the host. A second provider is a second module in `TEXT_PROVIDERS` and one setting
// (`TEXT_PROVIDER` in product.ts); nothing in the host changes.

import { stripTrailingSlashes } from "@composable-os/gatekeeper-interface/gatekeeper";
import { fakeTextProvider } from "./fake.js";

/** What a provider reported, once its signature checked out. */
export type ProviderEvent =
  | {
      type: "receipt";
      providerRef: string;
      status: "delivered" | "failed";
      at: string;
      costMinor?: number;
    }
  /** A text a number sent the business's sender number. Read for STOP, START and HELP only. */
  | { type: "reply"; from: string; body: string; at: string };

export type VerifiedWebhook =
  | { ok: true; eventId: string; events: ProviderEvent[] }
  | { ok: false; reason: string };

export interface TextProvider {
  readonly name: string;
  /**
   * Sends one text from the business's sender number. Throws `ActionApplyError` when the
   * provider refused it before sending, `ActionOutcomeUnknownError` when it may have gone.
   */
  send(input: { from: string; to: string; text: string }): Promise<{ providerRef: string }>;
  /** Sends a checking code to `to`; the code is the provider's, never seen by the host. */
  startCheck(input: { from: string; to: string }): Promise<void>;
  /** Whether `code` is the one sent to `to` (each code checks once). */
  check(input: { to: string; code: string }): Promise<boolean>;
  /** Verifies a webhook delivery; returns its events, or why it was refused. */
  verifyWebhook(
    headers: Record<string, string>,
    body: Uint8Array,
    nowSeconds: number,
  ): Promise<VerifiedWebhook>;
}

/** The environment a provider module reads. */
export type TextEnv = {
  TEXT_PROVIDER?: string | undefined;
  TEXT_SENDER_NUMBER?: string | undefined;
  BASE_URL?: string | undefined;
  FAKE_WEBHOOK_SECRET?: string | undefined;
  FAKE_TEXT_LEDGER?: DurableObjectNamespace | undefined;
};

/** One provider: its title, why it cannot be used here (if it cannot), and how it is opened. */
export interface ProviderModule {
  title: string;
  unavailable(env: TextEnv): string | undefined;
  open(env: TextEnv): TextProvider;
}

function stringVar(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The public base the routes are served under, without a trailing slash. */
export function baseUrl(env: TextEnv): string {
  return stripTrailingSlashes(stringVar(env.BASE_URL) || "http://localhost:5173/gatekeeper/text");
}

/** The fake provider's signing secret when FAKE_WEBHOOK_SECRET is empty. Not a secret. */
export const DEFAULT_FAKE_WEBHOOK_SECRET = "fake-text-dev-secret";

/**
 * Whether the fake may run here: given its own signing secret, or served on this machine only.
 * The default secret is public, so with it anyone who can reach the webhook could report a STOP
 * or a delivery; a deployment reachable from elsewhere (a staging host) must set its own. A live
 * environment never turns the fake on at all (`cos deploy` refuses it, as the payments fake).
 */
export function fakeSecretOrLocal(env: TextEnv): boolean {
  if (stringVar(env.FAKE_WEBHOOK_SECRET) !== "") return true;
  try {
    const { protocol, hostname } = new URL(baseUrl(env));
    return protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export function fakeWebhookSecret(env: TextEnv): string {
  return stringVar(env.FAKE_WEBHOOK_SECRET) || DEFAULT_FAKE_WEBHOOK_SECRET;
}

/** The providers this release has: the fake only, until a business's own account is set up. */
export const TEXT_PROVIDERS: Readonly<Record<string, ProviderModule>> = {
  fake: {
    title: "Fake provider (development)",
    unavailable: (env) =>
      fakeSecretOrLocal(env)
        ? undefined
        : "The fake text provider needs its own signing secret here: the FAKE_WEBHOOK_SECRET " +
          "secret of cos-gatekeeper-text, which cos deploy generates for an environment marked " +
          "live: false. Without one it runs only on localhost.",
    open: (env) => fakeTextProvider(env),
  },
};

/** The provider named by TEXT_PROVIDER, among `modules`, or why there is none to use. */
export function providerModule(
  env: TextEnv,
  modules: Readonly<Record<string, ProviderModule>> = TEXT_PROVIDERS,
): { name: string; module: ProviderModule } | { problem: string } {
  const name = stringVar(env.TEXT_PROVIDER);
  if (!name) {
    return {
      problem:
        "No text provider is set up in this deployment: product.ts names it (TEXT_PROVIDER) and " +
        "a person sets its keys as secrets of cos-gatekeeper-text.",
    };
  }
  const module = Object.hasOwn(modules, name) ? modules[name] : undefined;
  if (!module) return { problem: `This release has no text provider ${name}.` };
  const why = module.unavailable(env);
  if (why) return { problem: why };
  if (!/^\+[1-9]\d{7,14}$/.test(stringVar(env.TEXT_SENDER_NUMBER))) {
    return {
      problem:
        "The business's sender number is not set: TEXT_SENDER_NUMBER in product.ts, in " +
        "international form.",
    };
  }
  return { name, module };
}

/** The provider to send through, or an Error saying why there is none. */
export function providerFor(
  env: TextEnv,
  modules: Readonly<Record<string, ProviderModule>> = TEXT_PROVIDERS,
): TextProvider {
  const found = providerModule(env, modules);
  if ("problem" in found) throw new Error(found.problem);
  return found.module.open(env);
}

export function senderNumber(env: TextEnv): string {
  return stringVar(env.TEXT_SENDER_NUMBER);
}
