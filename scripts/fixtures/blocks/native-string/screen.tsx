// A fixture: an app screen that reaches billing through a helper in a subfolder.
import { cancel } from "./lib/call.ts";

export function Screen({ client }: { client: { mutation(name: string): unknown } }) {
  return cancel(client);
}
