// What nothing in the app may do: buy or change a subscription's billing (ADRs 0478, 0490; stage
// 63, ADR 0905). One set of rules for two checks: the block lint over the platform's blocks
// (scripts/check-blocks.mjs, which imports this file) and `cos app check` over a client's own app
// code. A product rule, not a security boundary: the host still decides every call.

/** Comments and the contents of strings replaced by spaces, keeping line numbers. */
export function codeOnly(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\") {
          out += " ";
          i++;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** An operation that buys, or changes what a subscription charges. */
export const PURCHASE_OPERATION =
  /^(?:order\.(?:start|checkout|cancel)|subscription\.(?:start|cancel|resume|portal|change|pause|coolOff)|x\.[a-z0-9]+\.(?:buy|orderStart|checkout|subscribe))$/;

/** A subscription's billing operations: never in a native block (stage 32a, ADR 0490). */
export const BILLING_OPERATION = /^subscription\.(?:start|cancel|resume|portal|change|pause|coolOff)$/;

/** The hooks that change a subscription's billing (the client's and the packs'). */
export const BILLING_HOOK =
  /\b(?:useSubscribe|useCancelSubscription|useResumeSubscription|useBillingPortal|useCoolOff)\b/;

/** The hooks that buy or change billing, as code (not in a comment or a string). */
const BUY_HOOK =
  /\b(?:useBuy\w*|useCheckout\w*|useOrderStart|useSubscribe|useCancelSubscription|useResumeSubscription|useBillingPortal|useCoolOff)\b/;

/** An operation's name as a string: `"order.start"`, `'x.courses.buy'`. */
const OPERATION_STRING = /["'`]((?:order|subscription|x\.[a-z0-9]+)\.[a-zA-Z]+)["'`]/g;

export interface PurchaseProblem {
  line: number;
  /** What it names: the operation or the hook. */
  names: string;
}

/**
 * Where a client's app code buys (stage 63): a buying or billing operation named as a string, or
 * a buying hook called. Reading what a person holds (`order.get`, `subscription.list`) is fine.
 */
export function scanPurchases(source: string): PurchaseProblem[] {
  const problems: PurchaseProblem[] = [];
  const code = codeOnly(source).split("\n");
  source.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(OPERATION_STRING)) {
      if (PURCHASE_OPERATION.test(match[1] as string)) {
        problems.push({ line: index + 1, names: match[1] as string });
      }
    }
    const hook = BUY_HOOK.exec(code[index] ?? "");
    if (hook) problems.push({ line: index + 1, names: hook[0] });
  });
  return problems;
}
