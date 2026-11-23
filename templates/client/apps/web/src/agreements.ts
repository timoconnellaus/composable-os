// The agreement pages' calls (stage 44), from the browser: the generated client over this site's
// operation route (/api/v1/op/, src/server.ts lets these operations through), with the
// customer's cookie. What is due, and whether an agreement is taken, is the host's answer.
import { ApiError } from "@composable-os/client";
import { createCustomerClient } from "./client/customer.ts";

/** The customer's typed client in the browser. */
export function browserApi() {
  return createCustomerClient({ baseUrl: window.location.origin });
}

/** Whether an error means nobody is signed in (the me.* operations are customers' only). */
export function signedOut(error: unknown): boolean {
  return error instanceof ApiError && error.code === "unknown_operation";
}
