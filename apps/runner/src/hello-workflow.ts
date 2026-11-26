// The stage 0 hello-world Workflow. It proves Workflows deploy and run from cos-app's smoke test;
// real automations replace it in stage 5.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { workflowRun } from "@composable-os/db/client-entries";

export interface HelloParams {
  name: string;
}

export interface HelloOutput {
  greeting: string;
  steps: number;
}

export class HelloWorkflow extends WorkflowEntrypoint<Env, HelloParams> {
  override async run(event: WorkflowEvent<HelloParams>, step: WorkflowStep): Promise<HelloOutput> {
    // As the client its id and params name, on a many-client host (stage 66, ADR 0615).
    const { params } = await workflowRun<Env, HelloParams>(this.env, event);
    const name = await step.do("normalise name", async () => params.name.trim() || "world");
    const greeting = await step.do("greet", async () => `Hello, ${name}!`);
    return { greeting, steps: 2 };
  }
}
