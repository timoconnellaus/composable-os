// cos-front (stage 66 step 8, ADR 0619): `frontFetch` from packages/db, and nothing else. It
// receives every request for a client's own web hostname, looks the hostname up in the registry
// and hands it to the client's web target, with the client fixed here. In this step the only
// target is the holding page; stage 75 step 5 adds the client's published version.
import { type FrontEnv, frontFetch } from "@composable-os/db/front";

export default {
  fetch: (request: Request, env: Env) => frontFetch(request, env as unknown as FrontEnv),
} satisfies ExportedHandler<Env>;
