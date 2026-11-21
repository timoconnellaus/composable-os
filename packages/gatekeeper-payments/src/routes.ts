// The public routes, served by the vendor's fetch under BASE_URL (the CRM proxies
// /gatekeeper/payments/* here):
//
//   POST {base}/in/stripe       Stripe webhook
//   POST {base}/in/fake         fake provider webhook (fake only)
//   GET  {base}/fake/pay/:ref   the fake hosted page (fake only)
//   POST {base}/fake/pay/:ref   pay or cancel on the fake page (fake only)

import { eventsStub } from "./events.js";
import {
  type FakeSubscriptionStep,
  type FakeWebhookBody,
  fakeLedger,
  fakePayPage,
  verifyFakeWebhook,
} from "./fake.js";
import { formatMinor } from "./money.js";
import {
  baseUrl,
  fakeEnabled,
  fakeWebhookSecret,
  stripeAccount,
  stripeApiBase,
  stripeSecretKey,
  stripeWebhookSecret,
  type VerifiedWebhook,
} from "./provider.js";
import { signatureHeader } from "./signature.js";
import { StripeProvider, verifyStripeWebhook, withStripeTaxLines } from "./stripe.js";
import type { PaymentsProviderName } from "./types.js";

type Env = Cloudflare.Env;

/** The largest webhook body accepted; a larger one is answered 413. */
const MAX_BODY_BYTES = 256 * 1024;
/** The largest fake page form accepted. */
const MAX_FORM_BYTES = 16 * 1024;
/** Request headers read from a delivery: at most this many, each value at most this long. */
const MAX_HEADERS = 100;
const MAX_HEADER_VALUE = 8 * 1024;
const FAKE_REF = /^fcs_[A-Za-z0-9]{1,64}$/;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function methodNotAllowed(allow: string): Response {
  return json(405, { ok: false, error: "method not allowed" }, { allow });
}

const notFound = () => json(404, { ok: false, error: "not found" });

/** Reads at most `limit` bytes of the body, or undefined if it is longer. */
async function readBounded(request: Request, limit: number): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) return undefined;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of headers) {
    if (++count > MAX_HEADERS) break;
    record[name.toLowerCase()] = value.slice(0, MAX_HEADER_VALUE);
  }
  return record;
}

/** The path below the BASE_URL's path, or undefined when the request is outside it. */
function relativePath(env: Env, pathname: string): string | undefined {
  const basePath = new URL(baseUrl(env)).pathname.replace(/\/+$/, "");
  if (basePath === "") return pathname;
  if (!pathname.startsWith(`${basePath}/`)) return undefined;
  return pathname.slice(basePath.length);
}

/** Serves every public route. */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const path = relativePath(env, new URL(request.url).pathname);
  if (path === undefined) return notFound();
  if (path === "/in/stripe") return handleInbound(request, env, "stripe");
  if (path === "/in/fake") {
    return fakeEnabled(env) ? handleInbound(request, env, "fake") : notFound();
  }
  if (!fakeEnabled(env)) return notFound();
  // No route reads the ledger: on a staging host on the public internet it would show every
  // checkout, its return address (a guest's order link, with its token) and its amount. Tests read
  // it through the ledger's own binding.
  if (path.startsWith("/fake/pay/")) {
    const ref = path.slice("/fake/pay/".length);
    if (!FAKE_REF.test(ref)) return notFound();
    if (request.method === "GET") return showFakePage(env, ref);
    if (request.method === "POST") return submitFakePage(request, env, ref);
    return methodNotAllowed("GET, POST");
  }
  if (path.startsWith("/fake/portal/")) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    // The fake customer portal: inert. It shows nothing from the ledger and changes nothing.
    return new Response(FAKE_PORTAL_PAGE, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      },
    });
  }
  return notFound();
}

const FAKE_PORTAL_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fake customer portal</title></head>
<body><p>A development stand-in for the provider's customer portal: the card, billing details and
past invoices would be here. Nothing can be cancelled or changed on it.</p></body></html>`;

/**
 * Moves a fake subscription's schedule on by one step and delivers what the provider would send
 * (tests and development only: there is no route to it).
 */
export async function advanceFakeSubscription(
  env: Env,
  ref: string,
  step: FakeSubscriptionStep,
): Promise<FakeWebhookBody[]> {
  const result = await fakeLedger(env).stepSubscription(ref, step);
  if (!result.ok) throw new Error(`The fake provider cannot ${step}: ${result.reason}.`);
  for (const body of result.deliveries) await deliverFakeEvent(env, body);
  return result.deliveries;
}

/** `POST {base}/in/:provider`: one webhook delivery, verified before anything is stored. */
export async function handleInbound(
  request: Request,
  env: Env,
  provider: PaymentsProviderName,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readBounded(request, MAX_BODY_BYTES);
  if (body === undefined) return json(413, { ok: false, error: "payload too large" });
  const headers = headerRecord(request.headers);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const verified: VerifiedWebhook =
    provider === "stripe"
      ? await verifyStripeWebhook(stripeWebhookSecret(env), headers, body, nowSeconds)
      : await verifyFakeWebhook(fakeWebhookSecret(env), headers, body, nowSeconds);
  const events = eventsStub(env, provider);
  if (!verified.ok) {
    if (verified.retry) return json(500, { ok: false, error: "try again" });
    await events.countRejected();
    return json(401, { ok: false, error: verified.reason });
  }
  const reads = verified.reads ?? [];
  if (verified.events.length === 0 && reads.length === 0) {
    return json(200, { ok: true, ignored: true });
  }
  let received = verified.events;
  const stripe = () =>
    new StripeProvider({
      secretKey: stripeSecretKey(env),
      webhookSecret: stripeWebhookSecret(env),
      apiBase: stripeApiBase(env),
      account: stripeAccount(env),
    });
  if (provider === "stripe" && received.some((e) => e.kind === "payment" && e.tax)) {
    // Each line's tax is on the session's line items, not in the webhook: read it before storing.
    const client = stripe();
    try {
      received = await Promise.all(
        received.map((event) => withStripeTaxLines(event, (ref) => client.taxLines(ref))),
      );
    } catch {
      return json(500, { ok: false, error: "try again" });
    }
  }
  if (provider === "stripe" && reads.length > 0) {
    // A subscription event is stored as a current read of the subscription (and its invoice),
    // made now with the pinned version, not as the event's own copy (ADR 0485).
    const client = stripe();
    try {
      for (const read of reads) {
        const event = await client.readSubscriptionEvent(verified.eventId, read);
        if (event) received = [...received, event];
      }
    } catch {
      return json(500, { ok: false, error: "try again" });
    }
    if (received.length === 0) return json(200, { ok: true, ignored: true });
  }
  const { duplicate } = await events.receive(verified.eventId, received);
  return json(200, duplicate ? { ok: true, duplicate: true } : { ok: true });
}

/**
 * Delivers a fake provider event to this Worker's own `/in/fake` route, in process, signed the way
 * any delivery must be, so the signature check runs on it too.
 */
export async function deliverFakeEvent(env: Env, payload: FakeWebhookBody): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = await signatureHeader(
    fakeWebhookSecret(env),
    body,
    Math.floor(Date.now() / 1000),
  );
  const request = new Request(`${baseUrl(env)}/in/fake`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fake-signature": signature },
    body,
  });
  const response = await handleInbound(request, env, "fake");
  if (response.status !== 200) {
    throw new Error(`The fake provider's delivery was answered ${response.status}.`);
  }
}

/**
 * The origin a checkout returns the buyer to, as recorded when the host opened it (the host
 * checks `returnUrl` against the deployment's listed sites, ADR 0429), for the page's
 * `form-action`: a browser holds a form's redirects to it, so the redirect back after Pay or
 * Cancel must be allowed, and nothing else.
 */
function returnOrigin(returnUrl: string): string | null {
  try {
    const url = new URL(returnUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

async function showFakePage(env: Env, ref: string): Promise<Response> {
  const checkout = await fakeLedger(env).getCheckout(ref);
  if (!checkout) return new Response("Not found", { status: 404 });
  const back = returnOrigin(checkout.returnUrl);
  return new Response(fakePayPage(checkout, formatMinor(checkout.amount, checkout.currency)), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${back ? ` ${back}` : ""}; frame-ancestors 'none'; base-uri 'none'`,
    },
  });
}

/**
 * A POST from another site: a named Origin that is not this page's, or Fetch metadata saying
 * cross-site or same-site. An `Origin: null` with same-origin metadata is this page's own form
 * under a withholding referrer policy. A request with neither (a script, a test) is let through:
 * this page is a development stand-in, and every browser sends one or the other on a form POST.
 */
function fromAnotherSite(request: Request): boolean {
  const own = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (origin && origin !== "null" && origin !== own) return true;
  if (site && site !== "same-origin" && site !== "none") return true;
  return origin === "null" && site !== "same-origin";
}

async function submitFakePage(request: Request, env: Env, ref: string): Promise<Response> {
  if (fromAnotherSite(request)) {
    return new Response("Pay from the payment page itself", { status: 403 });
  }
  const raw = await readBounded(request, MAX_FORM_BYTES);
  if (raw === undefined) return new Response("Payload too large", { status: 413 });
  const form = new URLSearchParams(new TextDecoder().decode(raw));
  const outcome = form.get("outcome");
  if (outcome !== "pay" && outcome !== "cancel") {
    return new Response("outcome must be pay or cancel", { status: 400 });
  }
  // The amount is the checkout's, as the host priced it: nothing in the form changes it.

  const ledger = fakeLedger(env);
  if (outcome === "cancel") {
    const checkout = await ledger.getCheckout(ref);
    if (!checkout) return new Response("Not found", { status: 404 });
    return redirect(checkout.returnUrl);
  }
  const country = form.get("country");
  if (country !== null && country !== "" && !/^[A-Z]{2}$/.test(country)) {
    return new Response("country must be two upper-case letters", { status: 400 });
  }
  const paid = await ledger.pay(ref, null, country || null);
  if (!paid.found) return new Response("Not found", { status: 404 });
  // Stripe requires the billing address when it calculates tax; so does the fake.
  if (paid.needsAddress) {
    return new Response("A billing address is required: choose a country", { status: 400 });
  }
  const { checkout } = paid;
  if (paid.newlyPaid && paid.deliveries) {
    // A subscription checkout (ADR 0485): the subscription's events, in the provider's order.
    for (const body of paid.deliveries) await deliverFakeEvent(env, body);
  } else if (paid.newlyPaid) {
    await deliverFakeEvent(env, {
      // One id per checkout: a payment is confirmed once, however often it is delivered.
      id: `fevt_pay_${checkout.ref}`,
      type: "payment.succeeded",
      created: Math.floor(Date.now() / 1000),
      data: {
        orderId: checkout.orderId,
        checkoutRef: checkout.ref,
        amount: checkout.paidAmount ?? checkout.amount,
        currency: checkout.currency,
        paymentRef: checkout.paymentRef,
        ...(checkout.taxReport ? { tax: checkout.taxReport } : {}),
      },
    });
  }
  return redirect(checkout.returnUrl);
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}
