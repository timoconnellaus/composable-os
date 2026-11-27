// The operator's Worker (stage 66 step 7, ADR 0618): `operatorFetch` from packages/db, and
// nothing else. See wrangler.jsonc and packages/db/src/operator.ts for who may call it and what
// it touches.
import { rebuildRecordViews } from "@composable-os/core/record-views";
import { type OperatorEnv, operatorFetch } from "@composable-os/db/operator";

export default {
  fetch: (request: Request, env: Env) =>
    operatorFetch(request, env as unknown as OperatorEnv, { rebuildRecordViews }),
} satisfies ExportedHandler<Env>;
