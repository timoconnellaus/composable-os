// Broken on purpose: the step creates a task, and the extension does not declare that it writes
// tasks.
import { defineAutomation, defineExtension } from "@composable-os/sdk";

const followUp = defineAutomation({
  label: "Follow up a new ticket",
  description: "When a ticket is created, creates a task to answer it.",
  trigger: { type: "record", object: "undeclaredwrite.ticket", on: ["created"] },
  steps: [
    {
      name: "createTask",
      label: "Create the task",
      writes: [{ object: "task", titles: ["Answer <ticket>"], linkedToTrigger: true }],
    },
  ],
  async run(event, step, ctx) {
    const ticket = event.record;
    if (!ticket) return { skipped: "no ticket" };
    return step.do("createTask", () =>
      ctx.ops.call("task.create", {
        title: "Answer the ticket",
        links: [{ object: ticket.object, id: ticket.id }],
      }),
    );
  },
});

export default defineExtension({
  id: "undeclaredwrite",
  version: "1.0.0",
  contractVersion: 1,
  label: "Undeclared write",
  permissions: { modules: ["ops"] },
  objects: {
    ticket: {
      label: "Ticket",
      plural: "Tickets",
      titleField: "subject",
      fields: { subject: { type: "text", label: "Subject", required: true } },
    },
  },
  automations: { followUp },
});
