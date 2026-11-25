// The site's Worker reads the signed-in customer over its HOST binding. It compiles once
// `cos init` has written the typed client to src/composable-os/.
import { forVisitor } from "@composable-os/client";
import { createCustomerClient } from "../composable-os/customer.ts";

export interface HostBinding {
  fetch(
    input: string,
    init?: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
}

/**
 * `request` is the browser's: its customer cookie and Cloudflare's `cf-connecting-ip` go to the host
 * (`forVisitor`), and nothing else it carries, so the host limits calls per real visitor.
 */
export async function displayName(
  host: HostBinding,
  request: { headers: { get(name: string): string | null } },
): Promise<string> {
  const api = createCustomerClient({
    baseUrl: "https://host",
    fetch: (url, init) => host.fetch(url, init),
    headers: () => forVisitor(request),
  });
  const me = await api.call("me.get", {});
  return me.displayName;
}
