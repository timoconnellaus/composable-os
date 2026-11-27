// The agreement pages' calls (stage 44), from the browser: the generated client over this site's
// operation route (/api/v1/op/, src/server.ts lets these operations through), with the
// customer's cookie. What is due, and whether an agreement is taken, is the host's answer. The
// pages themselves take their client from the ScreenHost (src/screen-host/), which in the server
// build is this one.
import { ApiError } from "@composable-os/client";
import { createCustomerClient } from "./client/customer.ts";

/** The customer's typed client in the browser, over this site's operation route. */
export function browserApi() {
  return createCustomerClient({ baseUrl: window.location.origin });
}

/**
 * Whether an error means nobody is signed in: the me.* operations are customers' only, so the
 * public is told there is no such operation; a device session that has ended is refused 401.
 */
export function signedOut(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "unknown_operation" || error.status === 401);
}
