// Which kind of caller a session's approval queue belongs to (ADR 0645, after the review of
// PR #283). The integration host opens a queue for its own mail with one purpose and answers for
// it; every other caller (a person, an extension, an automation, the assistant, MCP, Code Mode)
// reaches this gatekeeper through a queue that answers none of them. The class is read from the
// queue, never from the message.
//
// It keeps the host's mail apart from everyone else's:
// - idempotency keys are remembered per class, so a key another caller used never answers the
//   host's send (and the host's never answers theirs); and an ordinary caller's per caller
//   (`keySpaceOf`, issue #286), so one caller never pre-claims another's key;
// - `listSent()` shows the host's agreements, sign-in and orders mail only to that same queue.
//
// No imports: cos-runner's fake outbox uses this same module.

export type QueueClass = "agreements" | "sign-in" | "routine" | "orders" | "caller";

/** The classes whose sends only the same class may list. */
export const HOST_PRIVATE_CLASSES: ReadonlySet<QueueClass> = new Set([
  "agreements",
  "sign-in",
  "orders",
]);

async function answers(queue: unknown, method: string): Promise<unknown> {
  try {
    // Called as a method: on an RPC stub, `.call` would itself be a remote call.
    const target = queue as Record<string, (() => Promise<unknown>) | undefined>;
    if (typeof target[method] !== "function") return null;
    return await target[method]();
  } catch {
    return null;
  }
}

/** The class of the caller behind `queue`. A queue that answers none of the host's is a caller. */
export async function queueClassOf(queue: unknown): Promise<QueueClass> {
  // The integration host says which of its own purposes opened the queue (a held routine email's
  // queue included, which `hostRoutineMail` answers null for); a caller's queue answers null.
  const purpose = await answers(queue, "hostPurpose");
  if (purpose === "agreements") return "agreements";
  if (purpose === "sign-in") return "sign-in";
  if (purpose === "routine-mail") return "routine";
  if (purpose === "orders") return "orders";
  if (typeof purpose === "string") return "caller";
  if ((await answers(queue, "isHostAgreementMail")) === true) return "agreements";
  if ((await answers(queue, "isHostSignInMail")) === true) return "sign-in";
  const routine = await answers(queue, "hostRoutineMail");
  if (routine && typeof routine === "object") return "routine";
  if ((await answers(queue, "isHostOrders")) === true) return "orders";
  return "caller";
}

/**
 * Where a send's idempotency keys are kept (ADR 0574, issue #286): the host's own classes each in
 * one space; an ordinary caller in its own, named by the host (`callerKeySpace`: who is calling,
 * from how it opened the queue, never from the message), so a person, an MCP app, the assistant,
 * an automation or an extension never answers, nor pre-claims, another's key. Hashed, so any id
 * makes one storage segment. A queue that names no caller (a host older than this) keeps its
 * callers in one shared space, as before.
 */
export async function keySpaceOf(queue: unknown, queueClass: QueueClass): Promise<string> {
  if (queueClass !== "caller") return queueClass;
  const caller = await answers(queue, "callerKeySpace");
  if (typeof caller !== "string" || caller === "") return "caller";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(caller));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `caller-${hex.slice(0, 32)}`;
}

/** The copy's idempotency keys are the host's agreements mail's alone. */
export const AGREEMENT_KEY_PREFIX = "agreement-copy:";
