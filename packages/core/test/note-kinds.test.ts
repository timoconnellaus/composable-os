// Stage 56 step 2 (ADR 0833): note kinds and their templates. Every staff account reads the kinds;
// a person holding notes:manage keeps them. A note has a kind (Note when none is given, and every
// note held before kinds), starts at its kind's level and is never below its lowest, for every
// writer (the operations, and migration 1232's triggers behind them). A kind's template fills the
// note's body from its sections. An AI may draft a kind's name and template, which waits for a
// person who holds notes:manage, and never sets its levels or retires one.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, type Actor, invoke, PendingApprovalError } from "../src/index.ts";
import { context, createUser, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;
let kindKeeper: ActingUser;
let person: string;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

const as = (user: ActingUser, actor: Actor = "human") =>
  context(
    user,
    actor === "human"
      ? {}
      : actor === "mcp"
        ? {
            actor,
            origin: {
              surface: "mcp",
              clientId: "client-1",
              clientName: "Test client",
              sessionId: unique("mcp"),
            },
          }
        : { actor, origin: { surface: actor === "assistant" ? "assistant" : "automation" } },
  );

const kindsOf = async (user: ActingUser, includeRetired = false) =>
  (await invoke("note.kinds.list", { includeRetired }, as(user))).items;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  kindKeeper = await createUser("member");
  await invoke(
    "user.setPermissions",
    { id: kindKeeper.id, permissions: ["notes:manage"] },
    as(admin),
  );
  person = (await invoke("person.create", { displayName: unique("Member") }, as(admin))).id;
});

describe("the kinds that ship", () => {
  it("are listed to every staff account in the composer's order, with their templates", async () => {
    const items = await kindsOf(member);
    const shipped = items.filter((k) => k.key !== null);
    expect(shipped.map((k) => [k.key, k.name, k.defaultLevel, k.lowestLevel])).toEqual([
      ["note", "Note", "staff", "staff"],
      ["session", "Session note", "coaches", "staff"],
      ["sensitive", "Sensitive", "sensitive", "sensitive"],
      ["from_client", "From the client", "coaches", "staff"],
    ]);
    const session = shipped.find((k) => k.key === "session");
    expect(session?.sections.map((s) => [s.key, s.label, s.required])).toEqual([
      ["worked_on", "Worked on", true],
      ["how_it_went", "How it went", false],
      ["next_time", "Next time", false],
    ]);
    expect(session?.levels).toEqual(["staff", "coaches", "sensitive"]);
    expect(shipped.find((k) => k.key === "sensitive")?.levels).toEqual(["sensitive"]);
    expect(shipped.find((k) => k.key === "from_client")?.filesAllowed).toBe(true);
  });

  it("Note stays every staff account's and is never retired", async () => {
    expect(
      (
        await refusal(
          invoke(
            "note.kinds.save",
            { id: "nkd_note", name: "Note", defaultLevel: "coaches" },
            as(admin),
          ),
        )
      ).details?.rule,
    ).toBe("note_kind_default");
    expect(
      (await refusal(invoke("note.kinds.retire", { id: "nkd_note" }, as(admin)))).details?.rule,
    ).toBe("note_kind_default");
    // The database holds it too, whatever writes.
    await expect(
      env.DB.prepare(
        "UPDATE core_note_kind SET lowest_level = 'coaches' WHERE id = 'nkd_note'",
      ).run(),
    ).rejects.toThrow();
  });
});

describe("a note written from a kind", () => {
  it("takes the kind's level and its template's sections, and its body is made from them", async () => {
    const word = unique("squat");
    const note = await invoke(
      "activity.log",
      {
        type: "note",
        kindId: "nkd_session",
        sections: [
          { key: "worked_on", text: `Front ${word}` },
          { key: "next_time", text: "Heavier" },
        ],
        links: [{ object: "person", id: person }],
      },
      as(member),
    );
    expect(note).toMatchObject({
      level: "coaches",
      kind: { id: "nkd_session", name: "Session note" },
      sections: [
        { key: "worked_on", label: "Worked on", text: `Front ${word}` },
        { key: "next_time", label: "Next time", text: "Heavier" },
      ],
    });
    expect(note.body).toBe(`**Worked on**\n\nFront ${word}\n\n**Next time**\n\nHeavier`);
    // The template's text is in no audit row: the note is kept to the client's coaches.
    const held = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM core_audit WHERE instr(coalesce(input, ''), ?1) > 0
         OR instr(coalesce(result, ''), ?1) > 0`,
    )
      .bind(word)
      .first<{ n: number }>();
    expect(Number(held?.n)).toBe(0);
  });

  it("refuses an empty required section, an unknown one, and a body beside the sections", async () => {
    const base = { type: "note" as const, kindId: "nkd_session", level: "staff" as const };
    const links = [{ object: "person", id: person }];
    expect(
      (
        await refusal(
          invoke(
            "activity.log",
            { ...base, sections: [{ key: "how_it_went", text: "Fine" }], links },
            as(member),
          ),
        )
      ).details?.rule,
    ).toBe("note_section_required");
    expect(
      (
        await refusal(
          invoke(
            "activity.log",
            {
              ...base,
              sections: [
                { key: "worked_on", text: "A" },
                { key: "x", text: "B" },
              ],
              links,
            },
            as(member),
          ),
        )
      ).details?.rule,
    ).toBe("note_section_unknown");
    expect(
      (
        await refusal(
          invoke(
            "activity.log",
            { ...base, sections: [{ key: "worked_on", text: "A" }], body: "Also", links },
            as(member),
          ),
        )
      ).details?.rule,
    ).toBe("note_sections_or_body");
    // A kind with a required section is written in its template, not a body alone.
    expect(
      (await refusal(invoke("activity.log", { ...base, body: "Just text", links }, as(member))))
        .details?.rule,
    ).toBe("note_section_required");
  });

  it("is never below its kind's lowest level", async () => {
    const refused = await refusal(
      invoke(
        "activity.log",
        {
          type: "note",
          kindId: "nkd_sensitive",
          level: "coaches",
          body: "Knee",
          links: [{ object: "person", id: person }],
        },
        as(member),
      ),
    );
    expect(refused.details?.rule).toBe("note_below_kind");
    const note = await invoke(
      "activity.log",
      {
        type: "note",
        kindId: "nkd_sensitive",
        body: "Knee",
        links: [{ object: "person", id: person }],
      },
      as(member),
    );
    expect(note.level).toBe("sensitive");
    // Lowering it below the kind's lowest is refused even to an admin, who may lower levels.
    expect(
      (await refusal(invoke("activity.update", { id: note.id, level: "coaches" }, as(admin))))
        .details?.rule,
    ).toBe("note_below_kind");
    // And the database holds it against any writer.
    await expect(
      env.DB.prepare("UPDATE core_activity SET level = 'staff' WHERE id = ?").bind(note.id).run(),
    ).rejects.toThrow(/core_note_below_kind/);
  });

  it("written without a kind is a Note, as every note held before kinds", async () => {
    const note = await invoke(
      "activity.log",
      { type: "note", body: "Called back", links: [{ object: "person", id: person }] },
      as(member),
    );
    expect(note).toMatchObject({ kind: { id: "nkd_note", name: "Note" }, sections: null });
    expect(note.level).toBeUndefined();
    // A note a path wrote without one reads as a Note too.
    await env.DB.prepare("UPDATE core_activity SET kind_id = NULL WHERE id = ?")
      .bind(note.id)
      .run();
    const again = await invoke("activity.get", { id: note.id }, as(member));
    expect(again.kind).toEqual({ id: "nkd_note", name: "Note" });
  });

  it("moves to another kind in use, and its sections are rewritten from the template", async () => {
    const note = await invoke(
      "activity.log",
      { type: "note", body: "Plain", links: [{ object: "person", id: person }] },
      as(member),
    );
    const moved = await invoke(
      "activity.update",
      {
        id: note.id,
        kindId: "nkd_session",
        level: "coaches",
        sections: [{ key: "worked_on", text: "Rows" }],
      },
      as(member),
    );
    expect(moved).toMatchObject({
      kind: { id: "nkd_session" },
      level: "coaches",
      body: "**Worked on**\n\nRows",
    });
    // A body written over it is the note now.
    const plain = await invoke("activity.update", { id: note.id, body: "Rows, 3x8" }, as(member));
    expect(plain).toMatchObject({ body: "Rows, 3x8", sections: null });
  });

  it("is refused a retired kind; notes already of it keep it", async () => {
    const kind = await invoke(
      "note.kinds.save",
      { name: unique("Intake"), sections: [{ label: "Goals", required: true }] },
      as(admin),
    );
    expect(kind.sections).toEqual([{ key: "goals", label: "Goals", hint: null, required: true }]);
    const note = await invoke(
      "activity.log",
      {
        type: "note",
        kindId: kind.id,
        sections: [{ key: "goals", text: "Run 5k" }],
        links: [{ object: "person", id: person }],
      },
      as(member),
    );
    await invoke("note.kinds.retire", { id: kind.id }, as(admin));
    expect((await kindsOf(member)).map((k) => k.id)).not.toContain(kind.id);
    expect((await kindsOf(member, true)).find((k) => k.id === kind.id)?.active).toBe(false);
    expect(
      (
        await refusal(
          invoke(
            "activity.log",
            {
              type: "note",
              kindId: kind.id,
              sections: [{ key: "goals", text: "Swim" }],
              links: [{ object: "person", id: person }],
            },
            as(member),
          ),
        )
      ).details?.rule,
    ).toBe("note_kind_retired");
    expect((await invoke("activity.get", { id: note.id }, as(member))).kind?.id).toBe(kind.id);
    await invoke("note.kinds.retire", { id: kind.id, retired: false }, as(admin));
    expect((await kindsOf(member)).map((k) => k.id)).toContain(kind.id);
  });
});

describe("keeping the kinds", () => {
  it("is for notes:manage: a member is refused, a granted member may", async () => {
    expect(
      (await refusal(invoke("note.kinds.save", { name: unique("Mine") }, as(member)))).code,
    ).toBe("forbidden");
    const kind = await invoke(
      "note.kinds.save",
      {
        name: unique("Review"),
        defaultLevel: "coaches",
        sections: [{ label: "How it went" }, { label: "How it went!", hint: "Again" }],
      },
      as(kindKeeper),
    );
    expect(kind.defaultLevel).toBe("coaches");
    expect(kind.sections.map((s) => s.key)).toEqual(["how_it_went", "how_it_went_2"]);
    // A label changed keeps the section's key, so notes and the template still match.
    const renamed = await invoke(
      "note.kinds.save",
      {
        id: kind.id,
        name: kind.name,
        sections: [{ key: "how_it_went", label: "How did it go" }],
      },
      as(kindKeeper),
    );
    expect(renamed.sections).toEqual([
      { key: "how_it_went", label: "How did it go", hint: null, required: false },
    ]);
    expect(renamed.defaultLevel).toBe("coaches");
  });

  it("refuses a kind starting below its lowest and a second kind of one name", async () => {
    expect(
      (
        await refusal(
          invoke(
            "note.kinds.save",
            { name: unique("Low"), defaultLevel: "staff", lowestLevel: "coaches" },
            as(admin),
          ),
        )
      ).details?.rule,
    ).toBe("note_kind_levels");
    expect(
      (await refusal(invoke("note.kinds.save", { name: "session NOTE" }, as(admin)))).code,
    ).toBe("conflict");
  });

  it("a kind's raised lowest level holds every note written from then on", async () => {
    const kind = await invoke("note.kinds.save", { name: unique("Injury") }, as(admin));
    const before = await invoke(
      "activity.log",
      { type: "note", kindId: kind.id, body: "Old", links: [{ object: "person", id: person }] },
      as(member),
    );
    await invoke(
      "note.kinds.save",
      { id: kind.id, name: kind.name, defaultLevel: "sensitive", lowestLevel: "sensitive" },
      as(admin),
    );
    // The note already written keeps its level.
    expect((await invoke("activity.get", { id: before.id }, as(member))).level).toBeUndefined();
    const after = await invoke(
      "activity.log",
      { type: "note", kindId: kind.id, body: "New", links: [{ object: "person", id: person }] },
      as(member),
    );
    expect(after.level).toBe("sensitive");
  });
});

describe("an AI and the kinds", () => {
  it("drafts a kind's name and template, which waits for a person who holds notes:manage", async () => {
    const queued = await invoke(
      "note.kinds.save",
      { name: unique("Drafted"), sections: [{ label: "Focus" }] },
      as(admin, "mcp"),
    )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(queued).toBeInstanceOf(PendingApprovalError);
    const actionId = (queued as PendingApprovalError).pending.actionId;
    expect(
      (await refusal(invoke("approval.approve", { actionIds: [actionId] }, as(member)))).code,
    ).toBe("forbidden");
    await invoke("approval.approve", { actionIds: [actionId] }, as(kindKeeper));
  });

  it("never sets a kind's levels, nor retires one", async () => {
    const kind = await invoke("note.kinds.save", { name: unique("Plain") }, as(admin));
    for (const actor of ["assistant", "mcp"] as const) {
      const refused = await refusal(
        invoke(
          "note.kinds.save",
          { id: kind.id, name: kind.name, defaultLevel: "coaches" },
          as(admin, actor),
        ),
      );
      expect(refused.details?.rule).toBe("note_kind_level_person");
      expect(
        (
          await refusal(
            invoke(
              "note.kinds.save",
              { name: unique("Tight"), lowestLevel: "coaches", defaultLevel: "coaches" },
              as(admin, actor),
            ),
          )
        ).details?.rule,
      ).toBe("note_kind_level_person");
    }
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      expect(
        (await refusal(invoke("note.kinds.retire", { id: kind.id }, as(admin, actor)))).code,
      ).toMatch(/forbidden|not_found|unknown_operation/);
    }
    expect((await kindsOf(admin)).find((k) => k.id === kind.id)?.defaultLevel).toBe("staff");
  });

  it("writes a kept kind's note only as a person", async () => {
    const refused = await refusal(
      invoke(
        "activity.log",
        {
          type: "note",
          kindId: "nkd_session",
          sections: [{ key: "worked_on", text: "Bench" }],
          links: [{ object: "person", id: person }],
        },
        as(admin, "assistant"),
      ),
    );
    expect(refused.details?.rule).toBe("note_level_person");
  });
});

describe("the review's sequences (PR #434)", () => {
  it("an erase scrubs a surviving note's sections as well as its body", async () => {
    const email = `${unique("erased")}@example.com`;
    const erased = await invoke(
      "person.create",
      { givenName: "Erin", familyName: unique("Gone"), emails: [{ email }] },
      as(member),
    );
    const other = await invoke("person.create", { displayName: unique("Stays") }, as(member));
    const note = await invoke(
      "activity.log",
      {
        type: "note",
        kindId: "nkd_session",
        level: "staff",
        sections: [{ key: "worked_on", text: `Partner work, write to ${email}` }],
        links: [
          { object: "person", id: erased.id },
          { object: "person", id: other.id },
        ],
      },
      as(member),
    );
    await invoke("person.erase", { id: erased.id }, as(admin));
    const row = await env.DB.prepare("SELECT body, sections FROM core_activity WHERE id = ?")
      .bind(note.id)
      .first<{ body: string; sections: string }>();
    expect(row?.body).not.toContain(email);
    expect(row?.sections).not.toContain(email);
    const read = await invoke("activity.get", { id: note.id }, as(member));
    expect(JSON.stringify(read.sections)).not.toContain(email);
    expect(read.sections?.[0]).toMatchObject({ key: "worked_on", label: "Worked on" });
  });

  it("Note never has a required section, so a note written without a kind is never refused", async () => {
    expect(
      (
        await refusal(
          invoke(
            "note.kinds.save",
            { id: "nkd_note", name: "Note", sections: [{ label: "Summary", required: true }] },
            as(admin),
          ),
        )
      ).details?.rule,
    ).toBe("note_kind_default");
    await expect(
      env.DB.prepare(
        `UPDATE core_note_kind SET sections = '[{"key":"s","label":"S","hint":null,"required":true}]'
         WHERE id = 'nkd_note'`,
      ).run(),
    ).rejects.toThrow(/core_note_kind_default/);
    const note = await invoke(
      "activity.log",
      { type: "note", body: "hi", links: [{ object: "person", id: person }] },
      as(member),
    );
    expect(note.kind?.id).toBe("nkd_note");
  });

  it("a note made from sections is held to a body's limit", async () => {
    const kind = await invoke(
      "note.kinds.save",
      {
        name: unique("Long"),
        sections: Array.from({ length: 12 }, (_, i) => ({ label: `Part ${i + 1}` })),
      },
      as(admin),
    );
    const refused = await refusal(
      invoke(
        "activity.log",
        {
          type: "note",
          kindId: kind.id,
          sections: kind.sections.map((s) => ({ key: s.key, text: "x".repeat(20_000) })),
          links: [{ object: "person", id: person }],
        },
        as(member),
      ),
    );
    expect(refused.details?.rule).toBe("note_too_long");
  });

  it("only a person moves a note to another kind", async () => {
    const note = await invoke(
      "activity.log",
      { type: "note", body: "Plain", links: [{ object: "person", id: person }] },
      as(member),
    );
    const refused = await refusal(
      invoke("activity.update", { id: note.id, kindId: "nkd_from_client" }, as(member, "mcp")),
    );
    expect(refused.details?.rule).toBe("note_kind_person");
  });

  it("a note moved to another kind leaves the old template's sections and meets the new one's", async () => {
    const note = await invoke(
      "activity.log",
      {
        type: "note",
        kindId: "nkd_session",
        level: "staff",
        sections: [{ key: "worked_on", text: "Rows" }],
        links: [{ object: "person", id: person }],
      },
      as(member),
    );
    const moved = await invoke("activity.update", { id: note.id, kindId: "nkd_note" }, as(member));
    expect(moved).toMatchObject({ kind: { id: "nkd_note" }, sections: null });
    expect(moved.body).toContain("Rows");
    // Back into a kind with a required section, with no sections: refused, as a new note is.
    expect(
      (await refusal(invoke("activity.update", { id: note.id, kindId: "nkd_session" }, as(member))))
        .details?.rule,
    ).toBe("note_section_required");
  });
});
