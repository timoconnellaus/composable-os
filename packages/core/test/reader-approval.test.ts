// Card readers (stage 50, ADR 0774): the gatekeeper's `payments.reader.register` and `.remove`
// are asked only by the host's own call, whose actions the host's message rule applies at once.
// A reader is a device that takes money, so these always wait for a person, and only a human admin
// approves one (review of PR #348).
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  devJudge,
  type IntegrationRuntime,
  invokeByName,
  type OutboundSubmission,
  submitOutbound,
} from "../src/index.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;
let applied: number[];
let connectionId: string;
let action = 0;

function runtime(): IntegrationRuntime {
  const no = () => Promise.reject(new Error("not used in this test"));
  return {
    availableVendors: async () => ["payments"],
    startConnect: no,
    provision: no,
    redeem: no,
    reconnect: no,
    disconnect: no,
    bindResource: no,
    unbindResource: no,
    configure: no,
    supportedResources: no,
    call: no,
    types: no,
    setSync: no,
    syncNow: no,
    applyOutbound: async (input) => {
      applied.push(input.action);
    },
    rejectOutbound: async () => undefined,
  };
}

/** What the integration host's queue submits for the host's own orders call (`callAsHost`). */
function hostSubmission(tag: string): OutboundSubmission {
  action += 1;
  return {
    connectionId,
    connectionTitle: "Payments",
    vendor: "payments",
    facetKey: "merchant",
    resourceTitle: "Payments with Fake provider",
    action,
    description: {
      title: `Card reader ${action}`,
      description: "Registers a card reader to the business's account.",
      fields: [{ label: "Label", value: "Front desk" }],
      implementsRevert: false,
      autoApprovable: false,
      actionKind: { tag, label: tag },
    },
    actor: "automation",
    user: admin,
    origin: { surface: "automation", automationId: `orders:${connectionId}` },
    hostMessage: true,
  };
}

function approve(id: string, user: ActingUser) {
  return invokeByName(
    "approval.approve",
    { actionIds: [id] },
    { ...context(user), integrations: runtime() },
  );
}

/** The assistant relaying the admin's yes in chat: an AI actor, whatever the words. */
function approveInChat(id: string, user: ActingUser) {
  return invokeByName(
    "approval.decide",
    { actionIds: [id], decision: "approve" },
    {
      ...context(user),
      integrations: runtime(),
      actor: "assistant" as const,
      judge: devJudge,
      assistantTurn: { threadId: "ath_1", messageSeq: 1, text: "yes, approve it", via: "text" },
    },
  );
}

beforeEach(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  applied = [];
  connectionId = `con_${unique("c").toUpperCase()}`;
  // Autonomous: everything a policy could let through goes through, so only the rule holds them.
  await setPreset("autonomous");
});

describe("a card reader's registration and removal", () => {
  it("waits for a person even when the host asks, where a host message would apply at once", async () => {
    for (const tag of ["payments.reader.register", "payments.reader.remove"]) {
      const decision = await submitOutbound(db, hostSubmission(tag));
      expect(decision.decision).toBe("review");
    }
    // The host's own message is still applied at once: the rule is for these kinds only.
    const mail = await submitOutbound(db, hostSubmission("email.send"));
    expect(mail.decision).toBe("auto");
  });

  it("is approved only by a human admin: not a member, not an AI actor", async () => {
    const submission = hostSubmission("payments.reader.register");
    const decision = await submitOutbound(db, submission);
    if (decision.decision !== "review") throw new Error("not reviewed");
    const id = decision.pending.actionId;
    await expect(approve(id, member)).rejects.toThrow(/needs an admin \(integrations:manage\)/);
    await expect(approveInChat(id, admin)).rejects.toThrow(/never by an AI actor/);
    expect(applied).toEqual([]);
    await approve(id, admin);
    expect(applied).toEqual([submission.action]);
  });
});
