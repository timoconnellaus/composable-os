// The one server function behind every operation call from the UI. Private (not *.public.ts): the
// identity middleware has already resolved the Principal, or refused the request with a 401.

import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { type OperationResult, parseOperationCall, runOperation } from "./operations.ts";
import { requestEnv } from "./request-env.ts";

export const callOperation = createServerFn({ method: "POST" })
  .validator(parseOperationCall)
  .handler(async ({ data, context }): Promise<OperationResult> => {
    return runOperation(
      requestEnv(),
      context.principal ?? null,
      data,
      new URL(getRequest().url).origin,
    );
  });
