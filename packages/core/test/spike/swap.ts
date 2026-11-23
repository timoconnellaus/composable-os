// SPIKE: put a client's Durable Object database where the D1 binding is, for every test.
import { env } from "cloudflare:workers";
import { clientDatabase } from "./client-db.ts";

const bindings = env as unknown as { DB: D1Database; CLIENT_DB: DurableObjectNamespace };
const real = bindings.DB;
bindings.DB = clientDatabase(bindings.CLIENT_DB as never, "gym-a");
if (bindings.DB === real) throw new Error("spike: could not replace env.DB");
