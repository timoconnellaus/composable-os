// The Expo app reads the signed-in customer over HTTPS with its access token. It compiles once
// `cos init` has written the typed client to src/composable-os/.
import { createCustomerClient } from "./composable-os/customer.ts";

export async function displayName(
  hostUrl: string,
  accessToken: string,
  fetchImpl: Parameters<typeof createCustomerClient>[0]["fetch"],
): Promise<string> {
  const api = createCustomerClient({
    baseUrl: hostUrl,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    headers: () => ({ authorization: `Bearer ${accessToken}` }),
  });
  const me = await api.call("me.get", {});
  return me.displayName;
}
