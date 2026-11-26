// The Knowledge pack's headless entry (stage 38 step 6, ADR 0708): its plain functions only
// format what the host answered (which version, since when, who has confirmed), read a refusal
// for the reader (a newer version published meanwhile, already confirmed), and make the read
// status CSV safe to open in a spreadsheet; its hooks are only those the client holds, read
// status is kept out of the cache once off screen, and the help centre's hooks name help pages,
// never procedures.
import { describe, expect, it } from "vitest";
import {
  bySection,
  confirmLabel,
  createKnowledgeHooks,
  HELP_PAGE,
  helpPageHead,
  KNOWLEDGE_HOOKS_CALL,
  knowledgeRefusal,
  myStanding,
  PROCEDURE,
  type Published,
  readStatusCsv,
  type ToReadAnswer,
  versionLine,
} from "../client/index.ts";

const mine: ToReadAnswer = {
  toRead: [
    {
      id: "rec_a",
      title: "Opening up",
      version: 3,
      publishedAt: "2026-03-03T09:00:00.000Z",
      since: "2026-03-03T09:00:00.000Z",
    },
  ],
  confirmed: [
    {
      id: "rec_b",
      title: "Closing",
      version: 2,
      publishedAt: "2026-02-01T09:00:00.000Z",
      confirmedAt: "2026-02-02T09:00:00.000Z",
    },
  ],
};

describe("what the reader says", () => {
  it("names the wording by its version and its publish date, and the confirmation by both", () => {
    expect(versionLine(4, "2026-03-03T09:00:00.000Z")).toBe("Version 4, published 3 March 2026");
    expect(versionLine(4)).toBe("Version 4");
    expect(confirmLabel("Injuries", 4)).toBe('I have read and understood "Injuries" (version 4)');
  });

  it("offers a confirmation only for the version shown when it is the one asked for", () => {
    expect(myStanding(mine, "rec_a", 3)).toEqual({
      kind: "to_read",
      since: "2026-03-03T09:00:00.000Z",
    });
    // The screen shows version 2, but version 3 is the one to confirm: read that first.
    expect(myStanding(mine, "rec_a", 2)).toEqual({ kind: "newer", version: 3 });
    expect(myStanding(mine, "rec_b", 2)).toEqual({
      kind: "confirmed",
      version: 2,
      confirmedAt: "2026-02-02T09:00:00.000Z",
    });
    expect(myStanding(mine, "rec_c", 1)).toEqual({ kind: "not_asked" });
    // Before the list has loaded nothing is offered.
    expect(myStanding(undefined, "rec_a", 3)).toEqual({ kind: "not_asked" });
  });

  it("reads the host's refusals, as the confirm tool passes them on", () => {
    // A tool's error carries the host's code and details one level in.
    const stale = {
      name: "ApiError",
      code: "extension_error",
      message: "Version 2 is not the current one",
      details: { code: "conflict", details: { reason: "not_current", current: 3 } },
    };
    expect(knowledgeRefusal(stale)).toMatchObject({ kind: "not_current", current: 3 });
    expect(
      knowledgeRefusal({ code: "conflict", details: { reason: "already_confirmed" } }).kind,
    ).toBe("already_confirmed");
    expect(knowledgeRefusal({ code: "x", details: { code: "not_found" } }).kind).toBe("not_found");
    expect(knowledgeRefusal({ code: "forbidden" }).kind).toBe("forbidden");
    expect(knowledgeRefusal({ name: "NetworkError" }).kind).toBe("network");
    expect(knowledgeRefusal(new Error("boom"))).toEqual({ kind: "other", message: "boom" });
  });

  it("reads the same refusals in the shape the admin's staff client throws them", () => {
    // apps/app/src/lib/staff-client.ts: the surface's code (`extension_error` for a tool) and the
    // tool's inner details only (the host's `{ reason, current }`, or `{ object, id }`).
    const surface = (details: unknown) =>
      Object.assign(new Error("Refused"), { code: "extension_error", details });
    expect(knowledgeRefusal(surface({ reason: "not_current", current: 5 }))).toMatchObject({
      kind: "not_current",
      current: 5,
    });
    expect(knowledgeRefusal(surface({ reason: "already_confirmed" })).kind).toBe(
      "already_confirmed",
    );
    expect(knowledgeRefusal(surface({ object: "knowledge.procedure", id: "rec_1" })).kind).toBe(
      "not_found",
    );
  });

  it("groups procedures by the section name the host gave with each, none last", () => {
    const p = (id: string, section?: string): Published => ({
      object: PROCEDURE,
      id,
      values: { title: id },
      ...(section ? { names: { section } } : {}),
    });
    const groups = bySection([p("a", "Safety"), p("b"), p("c", "Front desk"), p("d", "Safety")]);
    expect(groups.map((g) => [g.name, g.items.map((i) => i.id)])).toEqual([
      ["Front desk", ["c"]],
      ["Safety", ["a", "d"]],
      ["Other", ["b"]],
    ]);
    // With no section at all, one list with no heading.
    expect(bySection([p("a"), p("b")])).toEqual([{ name: null, items: [p("a"), p("b")] }]);
  });
});

describe("the read status export", () => {
  it("is the answer on screen as CSV, a name that looks like a formula kept as text", () => {
    const csv = readStatusCsv({
      id: "rec_a",
      title: "Opening up",
      version: 3,
      publishedAt: "2026-03-03T09:00:00.000Z",
      everyone: true,
      roles: [],
      people: [
        {
          account: "usr_1",
          name: "=HYPERLINK(1)",
          email: "a@example.com",
          confirmed: { version: 3, confirmedAt: "2026-03-04T08:00:00.000Z" },
          lastConfirmed: { version: 3, confirmedAt: "2026-03-04T08:00:00.000Z" },
          since: null,
        },
        {
          account: "usr_2",
          name: 'Sam "Sammy" Lee',
          email: "sam@example.com",
          confirmed: null,
          lastConfirmed: { version: 1, confirmedAt: "2026-01-04T08:00:00.000Z" },
          since: "2026-03-03T09:00:00.000Z",
        },
      ],
    });
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      '"Name","Email","Confirmed this version","Confirmed at","Last version confirmed","To read since"',
    );
    expect(lines[1]).toBe(
      `"'=HYPERLINK(1)","a@example.com","yes","2026-03-04T08:00:00.000Z","3",""`,
    );
    expect(lines[2]).toBe(
      '"Sam ""Sammy"" Lee","sam@example.com","no","","1","2026-03-03T09:00:00.000Z"',
    );
  });
});

describe("a help page's head", () => {
  it("is its search title, else its title with the site's name; its description; noindex", () => {
    const page = { values: { title: "Parking", summary: "Where to park." } };
    expect(helpPageHead(page, { siteName: "The Gym" })).toEqual({
      title: "Parking · The Gym",
      description: "Where to park.",
      robots: null,
    });
    expect(
      helpPageHead({ values: { ...page.values, seoTitle: "Park", noindex: true } }).robots,
    ).toBe("noindex");
  });
});

describe("hooks", () => {
  function clientWith(names: readonly string[]) {
    return {
      operations: Object.fromEntries(names.map((n) => [n, { kind: "query", invalidates: [] }])),
      query: (name: string, input: unknown) => ({
        queryKey: [name, input],
        queryFn: async () => ({ name, input }),
      }),
      mutation: (name: string) => ({
        mutationKey: [name],
        mutationFn: async (input: unknown) => ({ name, input }),
      }),
    };
  }
  const seen: { options: Record<string, unknown> }[] = [];
  const react = {
    useQuery: (options: Record<string, unknown>) => {
      seen.push({ options });
      return { data: undefined, isPending: true, error: null };
    },
    useMutation: (options: Record<string, unknown>) => {
      seen.push({ options });
      return { mutate() {}, mutateAsync: async () => undefined, data: undefined, isPending: false };
    },
  } as never;
  const all = [...new Set(Object.values(KNOWLEDGE_HOOKS_CALL).flat())];

  it("a public client gets the help centre's hooks only", () => {
    const visitor = ["x.knowledge.helpTopics", "content.list", "content.get", "content.search"];
    const hooks = createKnowledgeHooks(react, clientWith(visitor)) as Record<string, unknown>;
    expect(Object.keys(hooks).sort()).toEqual(
      [
        "useHelpPage",
        "useHelpPages",
        "useHelpTopics",
        "useSearchHelp",
        // content.search backs staff search too; the host answers a visitor's search of
        // procedures as not found (they are never public).
        "useSearchProcedures",
      ].sort(),
    );
  });

  it("asks for help pages in the help centre's search, and for procedures in staff search", () => {
    const hooks = createKnowledgeHooks(react, clientWith(all)) as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const key = (call: () => unknown) => {
      seen.length = 0;
      call();
      return seen[0]?.options.queryKey;
    };
    expect(key(() => hooks.useSearchHelp?.("park"))).toEqual([
      "content.search",
      { object: HELP_PAGE, q: "park" },
    ]);
    expect(key(() => hooks.useSearchProcedures?.("kit"))).toEqual([
      "content.search",
      { object: PROCEDURE, q: "kit" },
    ]);
    // Nothing is asked for an empty box.
    seen.length = 0;
    hooks.useSearchHelp?.("  ");
    expect(seen[0]?.options.enabled).toBe(false);
  });

  it("keeps read status out of the cache once it is off screen", () => {
    const hooks = createKnowledgeHooks(react, clientWith(all)) as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const gc = (call: () => unknown) => {
      seen.length = 0;
      call();
      return seen[0]?.options.gcTime;
    };
    expect(gc(() => hooks.useReadStatus?.())).toBe(0);
    expect(gc(() => hooks.useReadStatus?.("rec_a"))).toBe(0);
  });
});
