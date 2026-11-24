// A second fake provider, for the swap test (acceptance criterion 8): another module with its own
// wire format (a form-encoded webhook with its own signature header) behind the same
// `TextProvider` interface. Choosing it is one setting (`TEXT_PROVIDER`) and this one module.

import type { ProviderModule, TextProvider } from "../src/provider";

const sent: { to: string; text: string }[] = [];
const codes = new Map<string, string>();

export const secondSent = sent;

export function secondProvider(): TextProvider {
  return {
    name: "second",
    async send(input) {
      sent.push({ to: input.to, text: input.text });
      return { providerRef: `snd-${sent.length}` };
    },
    async startCheck(input) {
      codes.set(input.to, "424242");
    },
    async check(input) {
      const ok = codes.get(input.to) === input.code;
      if (ok) codes.delete(input.to);
      return ok;
    },
    async verifyWebhook(headers, body) {
      if (headers["x-second-token"] !== "second-secret")
        return { ok: false, reason: "bad signature" };
      const form = new URLSearchParams(new TextDecoder().decode(body));
      const at = new Date().toISOString();
      const id = form.get("MessageId") ?? "";
      if (form.get("Kind") === "status") {
        return {
          ok: true,
          eventId: id,
          events: [
            {
              type: "receipt",
              providerRef: form.get("Ref") ?? "",
              status: form.get("Status") === "DELIVRD" ? "delivered" : "failed",
              at,
            },
          ],
        };
      }
      return {
        ok: true,
        eventId: id,
        events: [{ type: "reply", from: form.get("From") ?? "", body: form.get("Body") ?? "", at }],
      };
    },
  };
}

export const SECOND_MODULE: ProviderModule = {
  title: "Second fake",
  unavailable: () => undefined,
  open: () => secondProvider(),
};
