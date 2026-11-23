// Routine mail (ADR 0590) in the core: the gate lets a routine send apply under Balanced and
// Autonomous and not under Cautious, and the deploy floor still holds or stops it; a send the host
// held, or one the gatekeeper did not give the routine kind, always waits for a person; the
// settings are a human admin's only; a runtime extension may not declare or send routine mail.
import { validateManifest } from "@composable-os/sdk";
import { describe, expect, it } from "vitest";
import {
  type ActingUser,
  checkManifest,
  evaluateGate,
  invokeByName,
  type OutboundSubmission,
  parseFloor,
  siteLink,
  siteOriginOf,
  submitOutbound,
} from "../src/index.ts";
import { extId } from "./extension-helpers.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

/** An extension declaring one kind of routine mail about its own records. */
function mailer(id: string) {
  const { manifest } = validateManifest({
    id,
    version: "1.0.0",
    contractVersion: 1,
    permissions: { modules: ["ops", "routine-mail"] },
    objects: {
      visit: {
        label: "Visit",
        plural: "Visits",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title" },
          person: { type: "relation", label: "Person", to: "person" },
        },
      },
    },
    routineMail: {
      thanks: {
        label: "Thanks",
        description: "After a visit.",
        about: "visit",
        slots: { title: { field: "title" } },
        messages: { thanks: { subject: "Thanks", text: "Thanks for {title}." } },
      },
    },
  });
  if (!manifest) throw new Error("the test's manifest is invalid");
  return manifest;
}

describe("who may declare it", () => {
  it("a runtime extension (written in the app, by the assistant or by hand) cannot", async () => {
    const id = extId("rm");
    const now = new Date().toISOString();
    const runtime = await checkManifest(db.query, id, mailer(id), now, { source: "runtime" });
    expect(runtime.plan).toBeNull();
    expect(runtime.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "outside_audience", path: "routineMail.thanks" }),
        expect.objectContaining({ code: "outside_audience", path: "permissions.modules.1" }),
      ]),
    );
    const shipped = await checkManifest(db.query, id, mailer(id), now, { source: "shipped" });
    expect(shipped.issues).toEqual([]);
  });
});

const routineGate = (preset: "cautious" | "balanced" | "autonomous", floor = "") =>
  evaluateGate(
    {
      actor: "automation",
      risk: "outbound",
      outbound: { autoApprovable: false, enabled: false, routine: true },
    },
    { preset },
    parseFloor(floor),
  ).decision;

describe("the gate", () => {
  it("applies routine mail under Balanced and Autonomous, and reviews it under Cautious", () => {
    expect(routineGate("balanced")).toBe("auto");
    expect(routineGate("autonomous")).toBe("auto");
    expect(routineGate("cautious")).toBe("review");
  });

  it("an operator's floor wins: review holds it, deny stops it", () => {
    expect(routineGate("balanced", '{"*":{"outbound":"review"}}')).toBe("review");
    expect(routineGate("balanced", '{"automation":{"outbound":"review"}}')).toBe("review");
    expect(routineGate("balanced", '{"*":{"outbound":"deny"}}')).toBe("deny");
    expect(routineGate("autonomous", '{"*":{"*":"deny"}}')).toBe("deny");
  });

  it("is no help to anything not routine: an automation's ordinary send is reviewed", () => {
    expect(
      evaluateGate(
        {
          actor: "automation",
          risk: "outbound",
          outbound: { autoApprovable: false, enabled: false },
        },
        { preset: "balanced" },
      ).decision,
    ).toBe("review");
  });
});

let member: ActingUser;
function submission(
  action: number,
  tag: string,
  routineMail: OutboundSubmission["routineMail"],
  extra: Partial<OutboundSubmission> = {},
): OutboundSubmission {
  return {
    connectionId: `con_${unique("c").toUpperCase()}`,
    connectionTitle: "Gym mail",
    vendor: "email-send",
    facetKey: `f-${action}`,
    resourceTitle: "gym@example.com",
    action,
    description: {
      title: "Send email: Booked: Strength",
      description: "To member@members.test",
      fields: [{ label: "To", value: "member@members.test" }],
      implementsRevert: false,
      autoApprovable: false,
      actionKind: { tag, label: tag },
    },
    actor: "automation",
    user: member,
    origin: { surface: "automation", automationId: "bookings.bookingConfirmed", runId: "arn_1" },
    reason: "Routine email",
    routineMail,
    ...extra,
  };
}

describe("submitOutbound", () => {
  it("applies the host's routine send with the gatekeeper's routine kind", async () => {
    member = await createUser("member");
    await setPreset("balanced");
    expect(
      (await submitOutbound(db, submission(1, "email.routine", { routine: true }))).decision,
    ).toBe("auto");
  });

  it("holds for a person: a send the host held, even under Autonomous", async () => {
    member = await createUser("member");
    await setPreset("autonomous");
    try {
      const held = await submitOutbound(db, submission(2, "email.routine", { routine: false }));
      expect(held.decision).toBe("review");
      const ordinary = await submitOutbound(db, submission(3, "email.send", { routine: false }));
      expect(ordinary.decision).toBe("review");
    } finally {
      await setPreset("balanced");
    }
  });

  it("holds for a person: the host's routine send the gatekeeper did not confirm", async () => {
    member = await createUser("member");
    await setPreset("balanced");
    const out = await submitOutbound(db, submission(4, "email.send", { routine: true }));
    expect(out.decision).toBe("review");
  });

  it("a routine kind from anyone but the host's routine queue is an ordinary send", async () => {
    member = await createUser("member");
    await setPreset("balanced");
    const out = await submitOutbound(db, submission(5, "email.routine", undefined));
    expect(out.decision).toBe("review");
  });

  it("the floor's deny stops even a routine send", async () => {
    member = await createUser("member");
    await setPreset("balanced");
    const out = await submitOutbound(
      db,
      submission(
        6,
        "email.routine",
        { routine: true },
        { floor: parseFloor('{"*":{"outbound":"deny"}}') },
      ),
    );
    expect(out.decision).toBe("deny");
  });
});

describe("the settings", () => {
  it("are a human admin's: an assistant, MCP, an automation or extension code is refused", async () => {
    const admin = await createUser("admin");
    for (const actor of ["assistant", "mcp", "automation", "extension"] as const) {
      await expect(
        invokeByName(
          "routineMail.settings.update",
          { siteOrigin: "https://evil.test" },
          context(admin, { actor }),
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/forbidden|denied/) });
    }
    const member = await createUser("member");
    await expect(
      invokeByName(
        "routineMail.settings.update",
        { siteOrigin: "https://gym.example" },
        context(member),
      ),
    ).rejects.toThrow();
  });

  it("take an https origin only, and refuse a kind no shipped pack declares", async () => {
    const admin = await createUser("admin");
    for (const bad of [
      "http://gym.example",
      "https://gym.example/path",
      "https://u:p@gym.example",
      "javascript:alert(1)",
    ]) {
      await expect(
        invokeByName("routineMail.settings.update", { siteOrigin: bad }, context(admin)),
      ).rejects.toThrow(/https origin/);
    }
    await expect(
      invokeByName(
        "routineMail.settings.update",
        { kinds: { "nobody.anything": true } },
        context(admin),
      ),
    ).rejects.toThrow(/No shipped pack declares/);
    const saved = await invokeByName(
      "routineMail.settings.update",
      { siteOrigin: "https://gym.example" },
      context(admin),
    );
    expect(saved).toMatchObject({ siteOrigin: "https://gym.example" });
    const read = (await invokeByName("routineMail.get", {}, context(admin))) as {
      siteOrigin: string | null;
      sendsOnItsOwn: string;
    };
    expect(read).toMatchObject({ siteOrigin: "https://gym.example", sendsOnItsOwn: "auto" });
  });
});

describe("links", () => {
  it("only to the business's own site", () => {
    expect(siteOriginOf("https://gym.example")).toBe("https://gym.example");
    expect(siteOriginOf("https://gym.example/")).toBe("https://gym.example");
    expect(siteOriginOf("http://gym.example")).toBeNull();
    const site = "https://gym.example";
    expect(siteLink("https://gym.example/bookings", site)).toBe("https://gym.example/bookings");
    expect(siteLink("https://gym.example.evil.test/bookings", site)).toBeNull();
    expect(siteLink("https://evil.test/https://gym.example", site)).toBeNull();
    expect(siteLink("https://user@gym.example/", site)).toBeNull();
    expect(siteLink("https://gym.example/bookings", null)).toBeNull();
  });
});
