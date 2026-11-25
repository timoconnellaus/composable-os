// Server functions behind sign-in: system status for the shell and the stage 0 smoke test.
import { env } from "cloudflare:workers";
import { ForbiddenError, resolveActingUser } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { createServerFn } from "@tanstack/react-start";
import { getHealth } from "./health.ts";
import { runner } from "./runner.ts";

export const getSystemHealth = createServerFn({ method: "GET" }).handler(async () =>
  getHealth(env),
);

/**
 * Starts cos-runner's hello-world Workflow through the RUNNER service binding: an admin's only
 * (stage 47 review), since it starts work on the runner.
 */
export const startHelloWorkflow = createServerFn({ method: "POST" })
  .validator((input: { name: string }) => ({ name: String(input.name).slice(0, 100) }))
  .handler(async ({ data, context }) => {
    const principal = context.principal;
    const user = principal ? await resolveActingUser(createCrmDb(env.DB), principal) : null;
    if (user?.role !== "admin") throw new ForbiddenError("Only an admin starts the hello workflow");
    return runner(env).startHelloWorkflow(data.name);
  });

export const getHelloWorkflowStatus = createServerFn({ method: "GET" })
  .validator((input: { id: string }) => ({ id: String(input.id) }))
  .handler(async ({ data }) => runner(env).helloWorkflowStatus(data.id));
