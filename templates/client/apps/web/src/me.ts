// The signed-in customer, for pages: a server function, so it runs in the Worker with the
// request's cookie and the HOST binding.
import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { type HostEnv, signedInCustomer } from "./host.ts";

export const getMe = createServerFn({ method: "GET" }).handler(async () => {
  const me = await signedInCustomer(env as unknown as HostEnv, getRequest());
  return me ? { displayName: me.displayName, primaryEmail: me.primaryEmail } : null;
});
