// The agreements entry (stage 44 step 5): the logic the agreement blocks share, web and native.
// It reads the host's refusals, retries once when what is due changed, builds exactly the input
// the host checks from what a person gave, and records a drawn signature within the host's
// limits. Fixture values only.
import { describe, expect, it } from "vitest";
import {
  AGREEMENTS_HOOKS_CALL,
  type AgreementVersion,
  ApiError,
  agreeInput,
  agreementBlockedWords,
  agreementRefusal,
  agreeProblems,
  boxPoint,
  createAgreementsHooks,
  type DuePerson,
  documentBlocks,
  dueForRefusal,
  dueSteps,
  emptyAgreeForm,
  forgetAfter,
  inkLength,
  NetworkError,
  purchaseErrorWords,
  SIGNATURE_LIMITS,
  StrokeRecorder,
  signatureEnough,
  strokePath,
  withAgreements,
} from "../src/index.ts";

const version = (extra: Partial<AgreementVersion> = {}): AgreementVersion => ({
  id: "agv_1",
  documentId: "agd_1",
  number: 1,
  kind: "waiver",
  title: "Fixture waiver",
  body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "Fixture text." }] }] },
  tickLabel: "I have read the fixture",
  questions: null,
  how: "typed",
  effectiveFrom: "2026-11-01T00:00:00.000Z",
  hash: "h",
  ...extra,
});

const due = {
  rule: "agreements_due",
  documents: [
    { documentId: "agd_1", title: "Fixture waiver", versionId: "agv_1", personId: "per_me" },
    { documentId: "agd_2", title: "Fixture health", versionId: "agv_2", personId: "per_kid" },
  ],
};

describe("agreementRefusal", () => {
  it("reads the host's refusal, direct or inside a pack tool's error", () => {
    const direct = new ApiError("invalid_input", "x", 400, due);
    const wrapped = new ApiError("extension_error", "x", 400, {
      extension: "bookings",
      tool: "book",
      code: "invalid_input",
      details: due,
    });
    for (const error of [direct, wrapped]) {
      const refusal = agreementRefusal(error);
      expect(refusal?.kind).toBe("due");
      expect(refusal && "documents" in refusal ? refusal.documents : []).toEqual([
        { documentId: "agd_1", title: "Fixture waiver", versionId: "agv_1", personId: "per_me" },
        { documentId: "agd_2", title: "Fixture health", versionId: "agv_2", personId: "per_kid" },
      ]);
    }
  });

  it("tells a minor payer, a change and stale agreements apart, and ignores anything else", () => {
    expect(
      agreementRefusal(
        new ApiError("invalid_input", "x", 400, { rule: "agreements_due", reason: "minor_payer" }),
      ),
    ).toMatchObject({
      kind: "minor_payer",
      message: "A parent or guardian needs to buy this for you.",
    });
    expect(
      agreementRefusal(new ApiError("conflict", "x", 409, { rule: "agreements_changed" }))?.kind,
    ).toBe("changed");
    expect(
      agreementRefusal(new ApiError("invalid_input", "x", 400, { rule: "agreement_not_asked" }))
        ?.kind,
    ).toBe("read_again");
    expect(agreementRefusal(new ApiError("invalid_input", "x", 400, { rule: "capacity" }))).toBe(
      null,
    );
    expect(agreementRefusal(new Error("network"))).toBe(null);
    expect(agreementRefusal(null)).toBe(null);
  });
});

describe("withAgreements", () => {
  it("calls once more when what is due changed, told why, and no more than once", async () => {
    const seen: (string | null)[] = [];
    const changed = new ApiError("conflict", "x", 409, { rule: "agreements_changed" });
    const outcome = await withAgreements(async (previous) => {
      seen.push(previous?.kind ?? null);
      if (seen.length === 1) throw changed;
      return "booked";
    });
    expect(outcome).toEqual({ kind: "done", value: "booked" });
    expect(seen).toEqual([null, "changed"]);
    await expect(
      withAgreements(async () => {
        throw changed;
      }),
    ).rejects.toBe(changed);
  });

  it("answers what is due, and a minor payer, without calling again; throws anything else", async () => {
    let calls = 0;
    const outcome = await withAgreements(async () => {
      calls += 1;
      throw new ApiError("invalid_input", "x", 400, due);
    });
    expect(calls).toBe(1);
    expect(outcome.kind).toBe("due");
    const other = new ApiError("invalid_input", "x", 400, { rule: "capacity" });
    await expect(
      withAgreements(async () => {
        throw other;
      }),
    ).rejects.toBe(other);
  });
});

describe("what is due", () => {
  const people: DuePerson[] = [
    {
      personId: "per_kid",
      name: "Kid",
      self: false,
      canAgree: true,
      due: [
        {
          documentId: "agd_2",
          kind: "health",
          title: "H",
          reason: "never",
          version: version({ id: "agv_2", documentId: "agd_2" }),
        },
      ],
    },
    {
      personId: "per_me",
      name: "Me",
      self: true,
      canAgree: true,
      due: [
        {
          documentId: "agd_1",
          kind: "waiver",
          title: "W",
          reason: "agree_again",
          version: version(),
        },
      ],
    },
  ];

  it("matches a refusal's documents to what each person has due, leaving out what is not", () => {
    const steps = dueForRefusal(people, [
      ...due.documents,
      { documentId: "agd_9", title: "Gone", versionId: "agv_9", personId: "per_me" },
    ]);
    expect(steps.map((s) => [s.person.personId, s.item.documentId])).toEqual([
      ["per_me", "agd_1"],
      ["per_kid", "agd_2"],
    ]);
    // A visitor's refusal names no Person: the caller's own.
    expect(
      dueForRefusal(people, [
        { documentId: "agd_1", title: "W", versionId: "agv_1", personId: null },
      ]).map((s) => s.person.personId),
    ).toEqual(["per_me"]);
  });

  it("puts the caller's own first, then each child's", () => {
    expect(dueSteps(people).map((s) => s.person.personId)).toEqual(["per_me", "per_kid"]);
  });
});

describe("agreeing to one version", () => {
  const health = version({
    kind: "health",
    questions: [
      { key: "q1", text: "Fixture one?", noteOnYes: true },
      { key: "q2", text: "Fixture two?", noteOnYes: false },
    ],
    how: "drawn",
  });

  it("says what is missing, field by field", () => {
    const form = emptyAgreeForm(health);
    expect(agreeProblems(health, form, null).map((p) => p.field)).toEqual([
      "answer:q1",
      "answer:q2",
      "ticked",
      "typedName",
      "signature",
    ]);
    const typed = version();
    expect(
      agreeProblems(typed, { ticked: true, typedName: "  Fixture  ", answers: {} }, null),
    ).toEqual([]);
  });

  it("sends the version shown, the name trimmed, a note only on a yes that asks for one", () => {
    const pad = new StrokeRecorder();
    pad.begin([10, 10]);
    pad.extend([300, 200]);
    pad.end();
    const form = {
      ticked: true,
      typedName: " Fixture Name ",
      answers: { q1: { yes: true, note: " a note " }, q2: { yes: false, note: "ignored" } },
    };
    expect(agreeInput(health, form, pad.signature())).toEqual({
      versionId: health.id,
      typedName: "Fixture Name",
      signature: {
        width: 1000,
        height: 400,
        strokes: [
          [
            [10, 10],
            [300, 200],
          ],
        ],
      },
      answers: [
        { key: "q1", yes: true, note: "a note" },
        { key: "q2", yes: false },
      ],
    });
    // A typed document never carries a signature, and a form without questions no answers.
    expect(agreeInput(version(), form, pad.signature())).toEqual({
      versionId: "agv_1",
      typedName: "Fixture Name",
    });
  });
});

describe("a drawn signature", () => {
  it("maps the screen to the box as integers, inside it, and refuses what is not a number", () => {
    expect(boxPoint(150, 50, 300, 100)).toEqual([500, 200]);
    expect(boxPoint(-5, 500, 300, 100)).toEqual([0, 400]);
    expect(boxPoint(Number.NaN, Number.POSITIVE_INFINITY, 300, 100)).toEqual([0, 0]);
    expect(boxPoint(10, 10, 0, 0)).toEqual([0, 0]);
  });

  it("takes a dot as too little ink, and a line as enough", () => {
    const pad = new StrokeRecorder();
    pad.begin([100, 100]);
    pad.extend([101, 100]); // closer than a step: nothing added
    pad.end();
    expect(pad.strokes).toEqual([[[100, 100]]]);
    expect(signatureEnough(pad.signature())).toBe(false);
    pad.begin([100, 100]);
    pad.extend([400, 100]);
    expect(inkLength(pad.signature()?.strokes ?? [])).toBe(300);
    expect(signatureEnough(pad.signature())).toBe(true);
    pad.clear();
    expect(pad.signature()).toBe(null);
  });

  it("stops at the host's limits on strokes and size, so what it sends is never too large", () => {
    const pad = new StrokeRecorder();
    for (let i = 0; i < 40; i++) {
      pad.begin([i * 10, 10]);
      pad.extend([i * 10 + 5, 300]);
      pad.end();
    }
    expect(pad.strokes.length).toBe(SIGNATURE_LIMITS.strokes);
    expect(pad.full).toBe(true);

    const long = new StrokeRecorder();
    long.begin([0, 0]);
    for (let i = 1; i < 20_000; i++) long.extend([(i * 7) % 1000, (i * 13) % 400]);
    const signature = long.signature();
    const points = (signature?.strokes ?? []).reduce((n, s) => n + s.length, 0);
    expect(long.full).toBe(true);
    expect(points).toBeLessThanOrEqual(SIGNATURE_LIMITS.points);
    expect(JSON.stringify(signature).length).toBeLessThanOrEqual(SIGNATURE_LIMITS.bytes);
  });

  it("draws a stroke as an SVG path in the box's units", () => {
    expect(
      strokePath([
        [1, 2],
        [3, 4],
      ]),
    ).toBe("M 1 2 L 3 4");
    expect(strokePath([[1, 2]])).toBe("M 1 2 l 0.5 0");
    expect(strokePath([])).toBe("");
  });
});

describe("a drawn signature, more", () => {
  it("reaches the point limit before the byte limit when the points are short", () => {
    const pad = new StrokeRecorder();
    pad.begin([0, 0]);
    // Two-unit steps of one-digit points: each point costs few bytes, so the points run out first.
    for (let i = 1; i < 6_000; i++) pad.extend([i % 2 ? 2 : 0, 0]);
    const signature = pad.signature();
    const points = (signature?.strokes ?? []).reduce((n, s) => n + s.length, 0);
    expect(pad.full).toBe(true);
    expect(points).toBe(SIGNATURE_LIMITS.points);
    expect(JSON.stringify(signature).length).toBeLessThan(SIGNATURE_LIMITS.bytes - 1_000);
  });

  it("draws with one pointer: a second finger starts, moves and lifts nothing", () => {
    const pad = new StrokeRecorder();
    expect(pad.begin([100, 100], 1)).toBe(true);
    expect(pad.begin([900, 300], 2)).toBe(false);
    expect(pad.extend([900, 300], 2)).toBe(false);
    expect(pad.extend([200, 100], 1)).toBe(true);
    pad.end(2); // the second finger lifting ends nothing
    expect(pad.extend([300, 100], 1)).toBe(true);
    pad.end(1);
    expect(pad.strokes).toEqual([
      [
        [100, 100],
        [200, 100],
        [300, 100],
      ],
    ]);
    // Once lifted, another pointer may draw.
    expect(pad.begin([500, 200], 2)).toBe(true);
  });
});

describe("after a call", () => {
  it("forgets the mutation whether it succeeded or failed", async () => {
    let resets = 0;
    const ok = { mutateAsync: async (n: number) => n + 1, reset: () => resets++ };
    expect(await forgetAfter(ok, 1)).toBe(2);
    const failed = {
      mutateAsync: async () => {
        throw new Error("no");
      },
      reset: () => resets++,
    };
    await expect(forgetAfter(failed, 1)).rejects.toThrow("no");
    expect(resets).toBe(2);
  });

  it("says what went wrong for agreements and the connection, and nothing for the rest", () => {
    expect(
      purchaseErrorWords(new ApiError("conflict", "x", 409, { rule: "agreements_changed" })),
    ).toMatch(/changed just now/);
    expect(
      purchaseErrorWords(
        new ApiError("conflict", "x", 409, { rule: "agreement_version_replaced" }),
      ),
    ).toMatch(/changed just now/);
    expect(purchaseErrorWords(new NetworkError("down"))).toMatch(/still here/);
    expect(purchaseErrorWords(new ApiError("invalid_input", "x", 400, { rule: "x" }))).toBe(null);
    expect(agreementBlockedWords(new ApiError("invalid_input", "x", 400, due))).toMatch(
      /can't be given here yet/,
    );
    expect(agreementBlockedWords(new ApiError("invalid_input", "x", 400, {}))).toBe(null);
  });
});

describe("a document's words", () => {
  it("keeps the blocks a person reads and leaves out anything else", () => {
    const blocks = documentBlocks({
      blocks: [
        { type: "heading", level: 1, content: [{ type: "text", text: "H" }] },
        { type: "image", media: "med_1", alt: "" },
        { type: "list", style: "bullet", items: [{ content: [{ type: "text", text: "a" }] }] },
      ],
    });
    expect(blocks.map((b) => b.type)).toEqual(["heading", "list"]);
    expect(documentBlocks(null)).toEqual([]);
  });
});

describe("hooks", () => {
  it("offers only the hooks the client can back", () => {
    const react = {
      useQuery: () => ({ data: undefined, isPending: true, error: null }),
      useMutation: () => ({
        mutate() {},
        mutateAsync: async () => undefined as never,
        data: undefined,
        isPending: false,
        error: null,
      }),
    };
    const call = () => ({ queryKey: [], queryFn: async () => undefined });
    const publicOnly = {
      operations: { "agreement.guestVersions": {} },
      query: call,
      mutation: () => ({ mutationKey: [], mutationFn: async () => undefined }),
    };
    const hooks = createAgreementsHooks(react as never, publicOnly);
    expect(Object.keys(hooks)).toEqual(["useGuestVersions"]);
    expect(Object.keys(AGREEMENTS_HOOKS_CALL)).toContain("useAccept");
  });
});
