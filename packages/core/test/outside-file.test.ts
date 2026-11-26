// Stage 65 step 4 (ADR 0923): the file source. A list exported from a booking system, uploaded by
// a person with bookingSystem:manage: decoded by its content, mapped (suggested, given or saved),
// dry run without writing anything, and loaded exactly as the dry run said or refused. Every row
// enters the copy through the one ingest, so an erased person stays erased across loads. The file
// is hostile input; nothing of it but the contract's mapped rows is kept, and nothing of a row is
// logged. Only a person may preview or load; never an AI, MCP, Code Mode, an extension or an
// automation, whatever the preset. Against real D1. Every person here is invented.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, type Actor, invokeByName } from "../src/index.ts";
import { decodeFile } from "../src/outside/file.ts";
import { runOutsideListsDue } from "../src/outside/notices.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

const NOW = "2026-11-24T09:00:00.000Z";

async function call<T>(
  name: string,
  input: unknown,
  user: ActingUser,
  actor: Actor = "human",
  now = NOW,
): Promise<T> {
  const surface =
    actor === "assistant"
      ? "assistant"
      : actor === "mcp"
        ? "mcp"
        : actor === "automation"
          ? "automation"
          : actor === "extension"
            ? "extension"
            : "ui";
  return (await invokeByName(
    name,
    input,
    context(user, {
      actor,
      origin: { surface, ...(actor === "extension" ? { extensionId: "someext" } : {}) },
      clock: () => new Date(now),
    }),
  )) as T;
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}
const utf8 = (text: string) => b64(new TextEncoder().encode(text));

interface Preview {
  ready: boolean;
  missing: string[];
  headers: string[];
  mapping: { columns: Record<string, string>; values?: Record<string, Record<string, string>> };
  mappingFrom: string;
  encoding: string;
  rows: { read: number; refused: number };
  issueCount: number;
  issues: { row: number; column?: string; problem: string }[];
  formulaLike: number;
  outcome: {
    changes: { new: number; changed: number; unchanged: number; removed: number };
    kept: number;
    notKept: number;
    dropped: number;
    previouslyErased: number;
    linked: number;
    links: number;
    toMatch: number;
    unlinked: number;
    items: Record<string, number>;
  };
  linking: { ref: string; name: string; to: string }[];
  waiting: { ref: string; name: string; why: string }[];
  statements: number;
  fingerprint: string;
}

type Kind = "members" | "timetable";

function preview(user: ActingUser, kind: Kind, file: string, extra: Record<string, unknown> = {}) {
  return call<Preview>("outside.file.preview", { kind, file, ...extra }, user);
}

/** The dry run, then the load with its fingerprint. */
async function load(
  user: ActingUser,
  kind: Kind,
  file: string,
  extra: Record<string, unknown> = {},
) {
  const dry = await preview(user, kind, file, extra);
  expect(dry.ready, dry.missing.join()).toBe(true);
  const out = await call<{ outcome: Preview["outcome"] }>(
    "outside.file.load",
    { kind, file, ...extra, fingerprint: dry.fingerprint },
    user,
  );
  return { dry, out };
}

async function count(sqlText: string, ...params: unknown[]) {
  return (
    (
      await env.DB.prepare(sqlText)
        .bind(...params)
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

/** What the copy and its settings hold, to show a dry run wrote nothing. */
async function copyState() {
  const tables = [
    "core_outside_list",
    "core_outside_person",
    "core_outside_membership",
    "core_outside_membership_type",
    "core_outside_class",
    "core_outside_booking",
    "core_outside_staff",
    "core_outside_match",
    "core_activity",
    "core_notifications",
  ];
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = await count(`SELECT count(*) AS n FROM ${t}`);
  out.settings = await env.DB.prepare("SELECT * FROM core_outside_settings").first();
  return out;
}

/** Every row of every table, as text, that contains one of `needles` (case-insensitive). */
async function findAnywhere(needles: readonly string[]) {
  const { results: tables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'core_search%' AND name <> 'd1_migrations'",
  ).all<{ name: string }>();
  const hits: string[] = [];
  const lower = needles.map((n) => n.toLowerCase());
  for (const { name } of tables) {
    const { results } = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
    for (const row of results) {
      if (name === "core_audit" && String(row.operation).endsWith(".erase")) continue;
      const text = JSON.stringify(row).toLowerCase();
      for (const needle of lower) if (text.includes(needle)) hits.push(`${name}: ${needle}`);
    }
  }
  return hits;
}

async function createPerson(admin: ActingUser, email: string, name = unique("Person")) {
  return (
    await call<{ id: string }>("person.create", { displayName: name, emails: [{ email }] }, admin)
  ).id;
}

/** A members file of this test's own: every ref, address and name carries the tag. */
function membersFile(tag: string) {
  const at = (who: string) => `${who}@${tag}.example.com`;
  const text = [
    "Client ID,First,Last,E-mail,Phone,Notes,Plan,Plan status,End",
    `${tag}-1,Avery,Sample${tag},${at("avery")},+61 400 111 222,SECRETNOTE${tag},Gold Monthly,Active,`,
    `${tag}-2,Blake,Example${tag},${at("blake")},,,Gold Monthly,Active,`,
    `${tag}-3,Casey,Test${tag},${at("family")},,,10 Pack,Active,2027-01-01`,
    `${tag}-4,Devon,Test${tag},${at("family")},,,Gold Monthly,Active,`,
    `${tag}-5,Emery,Lead${tag},${at("lead")},,,,,`,
    `${tag}-6,"=HYPERLINK(""http://x.example.com"")","Line one${tag}\nline two",${at("formula")},,,Gold Monthly,Active,`,
    `${tag}-7,Finley,Bad${tag},${at("bad")},,,Gold Monthly,Active,32/13/2026`,
  ].join("\r\n");
  return { text, file: utf8(text), at };
}

const WORDS = { membershipType: { "Gold Monthly": "membership", "10 Pack": "pass" } };
const COLUMNS: Record<string, string> = {
  ref: "Client ID",
  givenName: "First",
  familyName: "Last",
  email: "E-mail",
  membershipType: "Plan",
  membershipStatus: "Plan status",
  until: "End",
};
/** A mapping given in full for a file with this header line: its columns, and the value map. */
function given(text: string, values: Record<string, Record<string, string>> = WORDS) {
  const headers = (text.split(/\r?\n/)[0] ?? "").split(",");
  const columns = Object.fromEntries(
    Object.entries(COLUMNS).filter(([, h]) => headers.includes(h)),
  );
  return { mapping: { columns, values } };
}

let admin: ActingUser;
beforeAll(async () => {
  admin = await createUser("admin");
});

describe("the dry run and the load", () => {
  it("suggests a mapping, reports what would happen and why rows are refused, and writes nothing", async () => {
    const tag = unique("fm").toLowerCase();
    const f = membersFile(tag);
    const avery = await createPerson(admin, f.at("avery"));
    const before = await copyState();
    const dry = await preview(admin, "members", f.file);
    expect(await copyState()).toEqual(before);
    expect(dry.mappingFrom).toBe("suggested");
    expect(dry.mapping.columns).toMatchObject({
      ref: "Client ID",
      givenName: "First",
      familyName: "Last",
      email: "E-mail",
      membershipType: "Plan",
      membershipStatus: "Plan status",
      until: "End",
    });
    // The Phone and Notes columns are no field: never read.
    expect(Object.values(dry.mapping.columns)).not.toContain("Phone");
    expect(Object.values(dry.mapping.columns)).not.toContain("Notes");
    expect(dry.encoding).toBe("utf-8");
    expect(dry.rows).toEqual({ read: 7, refused: 0 });
    expect(dry.issues).toEqual([
      expect.objectContaining({
        row: 7,
        column: "End",
        problem: expect.stringMatching(/not a date/),
      }),
    ]);
    expect(dry.outcome).toMatchObject({
      changes: { new: 6, changed: 0, unchanged: 0, removed: 0 },
      kept: 6,
      notKept: 1,
      dropped: 0,
      linked: 1,
      toMatch: 2,
      unlinked: 3,
    });
    expect(dry.linking).toEqual([{ ref: `${tag}-1`, name: `Avery Sample${tag}`, to: avery }]);
    expect(dry.waiting.map((w) => [w.ref, w.why])).toEqual([
      [`${tag}-3`, "shared_address"],
      [`${tag}-4`, "shared_address"],
    ]);
    // A formula is text: counted, never evaluated.
    expect(dry.formulaLike).toBe(1);
    expect(dry.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("loads exactly what the dry run said, keeps no column the contract does not use, and saves the mapping", async () => {
    const tag = unique("fl").toLowerCase();
    const f = membersFile(tag);
    const avery = await createPerson(admin, f.at("avery"));
    const { dry, out } = await load(admin, "members", f.file, given(f.text));
    expect(out.outcome).toEqual(dry.outcome);
    const rows = await env.DB.prepare(
      "SELECT ref, given_name, family_name, person_id, link_how, why_kept FROM core_outside_person WHERE ref LIKE ? ORDER BY ref",
    )
      .bind(`${tag}-%`)
      .all();
    expect(rows.results.map((r) => [r.ref, r.why_kept, r.person_id])).toEqual([
      [`${tag}-1`, "member", avery],
      [`${tag}-2`, "member", null],
      [`${tag}-3`, "pass", null],
      [`${tag}-4`, "member", null],
      [`${tag}-6`, "member", null],
      [`${tag}-7`, "member", null],
    ]);
    // The formula is the text it was; the newline inside a quoted cell is one space.
    const formula = rows.results.find((r) => r.ref === `${tag}-6`);
    expect(formula?.given_name).toBe('=HYPERLINK("http://x.example.com")');
    expect(formula?.family_name).toBe(`Line one${tag} line two`);
    // The value map said what "10 Pack" is.
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_membership WHERE person_ref = ? AND kind = 'pass'",
        `${tag}-3`,
      ),
    ).toBe(1);
    // Neither the phone nor the note is anywhere, nor the file; the list's log holds headers.
    expect(
      await findAnywhere([`SECRETNOTE${tag}`, "+61 400 111 222", f.file.slice(0, 40)]),
    ).toEqual([]);
    const audit = await env.DB.prepare(
      "SELECT input, result FROM core_audit WHERE operation = 'outside.file.load' ORDER BY at DESC, id DESC LIMIT 1",
    ).first<{ input: string; result: string }>();
    expect(audit?.input).not.toContain(tag);
    expect(audit?.result ?? "").not.toContain(tag);
    expect(audit?.result ?? "").not.toContain("avery");
    // The next export of the same shape loads with the saved mapping.
    const settings = await call<{ mappings: Record<string, unknown> }>(
      "outside.settings.get",
      {},
      admin,
    );
    expect(settings.mappings.members).toMatchObject({
      columns: { email: "E-mail" },
      values: WORDS,
    });
    const again = await preview(admin, "members", f.file);
    expect(again.mappingFrom).toBe("saved");
    expect(again.outcome.changes).toEqual({ new: 0, changed: 0, unchanged: 6, removed: 0 });
    // Another shape (a column more, though every saved column is there) is suggested afresh,
    // never read with a mapping that misses what the file now has.
    const other = await preview(
      admin,
      "members",
      utf8(
        f.text
          .replace("Notes,Plan,", "Notes,Barcode,Plan,")
          .replace(/,Gold Monthly,/, ",123,Gold Monthly,"),
      ),
    );
    expect(other.mappingFrom).toBe("suggested");
  });

  it("replaces the list of its kind: who is not in the new file goes, with their link", async () => {
    const tag = unique("fr").toLowerCase();
    const f = membersFile(tag);
    await createPerson(admin, f.at("avery"));
    await load(admin, "members", f.file, given(f.text));
    const next = [
      "Client ID,First,Last,E-mail,Plan,Plan status",
      `${tag}-2,Blake,Renamed${tag},${f.at("blake")},Gold Monthly,Active`,
      `${tag}-9,Gray,New${tag},${f.at("gray")},Gold Monthly,Active`,
    ].join("\n");
    const { dry } = await load(admin, "members", utf8(next), given(next));
    expect(dry.mappingFrom).toBe("given");
    expect(dry.outcome.changes).toEqual({ new: 1, changed: 1, unchanged: 0, removed: 5 });
    expect(
      await count("SELECT count(*) AS n FROM core_outside_person WHERE ref LIKE ?", `${tag}-%`),
    ).toBe(2);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_list WHERE state = 'current' AND kind = 'members'",
      ),
    ).toBe(1);
  });

  it("refuses a load when the file, the mapping, the export date or the copy changed since the dry run", async () => {
    const tag = unique("fs").toLowerCase();
    const f = membersFile(tag);
    const dry = await preview(admin, "members", f.file, given(f.text));
    const stale = async (input: Record<string, unknown>) =>
      refusal(
        call(
          "outside.file.load",
          {
            kind: "members",
            file: f.file,
            ...given(f.text),
            ...input,
            fingerprint: dry.fingerprint,
          },
          admin,
        ),
      );
    expect(
      (
        await stale({
          file: utf8(`${f.text}\n${tag}-8,Hal,X,hal@${tag}.example.com,,,Gold Monthly,Active,`),
        })
      ).code,
    ).toBe("conflict");
    expect((await stale({ exportedOn: "2026-11-20" })).code).toBe("conflict");
    expect((await stale(given(f.text, {}))).code).toBe("conflict");
    // A Person who now holds an address changes who would link.
    await createPerson(admin, f.at("blake"));
    const before = await copyState();
    const changed = await stale({});
    expect(changed.code).toBe("conflict");
    expect(changed.details).toMatchObject({ rule: "outside_preview_stale" });
    expect(await copyState()).toEqual(before);
  });
});

describe("an erased person stays erased across loads", () => {
  it("keeps nothing of them by the same ref, a new ref on their address, or their ref on a new address, and says how many", async () => {
    const tag = unique("fe").toLowerCase();
    const address = `gone@${tag}.example.com`;
    const header = "Client ID,First,Last,E-mail,Plan,Plan status";
    const row = (ref: string, mail: string) =>
      `${ref},Gone,Person${tag},${mail},Gold Monthly,Active`;
    const keep = `${tag}-k,Kept,Person${tag},kept@${tag}.example.com,Gold Monthly,Active`;
    const person = await createPerson(admin, address);
    await load(
      admin,
      "members",
      utf8([header, row(`${tag}-g`, address), keep].join("\n")),
      given(header),
    );
    expect(
      await env.DB.prepare("SELECT person_id FROM core_outside_person WHERE ref = ?")
        .bind(`${tag}-g`)
        .first(),
    ).toEqual({ person_id: person });
    await call("person.erase", { id: person }, admin);

    for (const [ref, mail, why] of [
      [`${tag}-g`, address, "previouslyErased"],
      [`${tag}-new`, address, "erasedAddress"],
      [`${tag}-g`, `moved@${tag}.example.com`, "previouslyErased"],
    ] as const) {
      const file = utf8([header, row(ref, mail), keep].join("\n"));
      const { dry, out } = await load(admin, "members", file, given(header));
      expect(dry.outcome.dropped, `${ref} ${mail}`).toBe(1);
      expect(dry.outcome.previouslyErased).toBe(why === "previouslyErased" ? 1 : 0);
      expect(out.outcome.dropped).toBe(1);
      // Nothing of them: no row, no name, no address; the other person is kept.
      expect(dry.linking).toEqual([]);
      expect(dry.waiting).toEqual([]);
      expect(await count("SELECT count(*) AS n FROM core_outside_person WHERE ref = ?", ref)).toBe(
        0,
      );
      expect(
        await count(
          "SELECT count(*) AS n FROM core_outside_person WHERE given_name = 'Gone' OR address = ? OR address = ?",
          address,
          mail,
        ),
      ).toBe(0);
      expect(
        await count("SELECT count(*) AS n FROM core_outside_person WHERE ref = ?", `${tag}-k`),
      ).toBe(1);
      expect(
        await count("SELECT count(*) AS n FROM core_outside_membership WHERE person_ref = ?", ref),
      ).toBe(0);
    }
  });

  it("drops an erased member's bookings and an erased coach from a timetable, and scrubs the coach's name from titles", async () => {
    const tag = unique("ft").toLowerCase();
    const member = `${tag}-m`;
    const memberAddress = `member@${tag}.example.com`;
    const coachName = `Riley Coach${tag}`;
    const coachAddress = `coach@${tag}.example.com`;
    const person = await createPerson(admin, memberAddress);
    const coachPerson = await createPerson(admin, coachAddress);
    await load(
      admin,
      "members",
      utf8(
        [
          "Client ID,First,Last,E-mail,Plan",
          `${member},Member,One${tag},${memberAddress},Gold Monthly`,
        ].join("\n"),
      ),
      given("Client ID,First,Last,E-mail,Plan"),
    );
    const timetable = (extra = "") =>
      utf8(
        [
          "Class ID,Class,Starts,Coach,Coach email,Client ID,Email,Status",
          `${tag}-c1,Strength with ${coachName},2026-11-25 07:00,${coachName},${coachAddress},${member},,Booked`,
          `${tag}-c1,Strength with ${coachName},2026-11-25 07:00,${coachName},${coachAddress},${tag}-other,,Checked in`,
          `${tag}-c2,Mobility,2026-11-26 18:00,Sky Coach${tag},,,,`,
          extra,
        ].join("\n"),
      );
    const first = await load(admin, "timetable", timetable());
    expect(first.dry.mapping.columns).toMatchObject({
      person: "Client ID",
      personEmail: "Email",
      bookingState: "Status",
      staffEmail: "Coach email",
    });
    expect(first.dry.outcome.items).toMatchObject({ classes: 2, bookings: 2 });
    expect(
      await env.DB.prepare("SELECT booked FROM core_outside_class WHERE ref = ?")
        .bind(`${tag}-c1`)
        .first(),
    ).toEqual({ booked: 2 });
    expect(
      await env.DB.prepare("SELECT state FROM core_outside_booking WHERE person_ref = ?")
        .bind(`${tag}-other`)
        .first(),
    ).toEqual({ state: "attended" });

    // The member and the coach (a Person, never a staff account) are erased; the next timetable
    // names them again.
    await call("person.erase", { id: person }, admin);
    await call("person.erase", { id: coachPerson }, admin);
    const { dry } = await load(admin, "timetable", timetable());
    expect(dry.outcome.dropped).toBeGreaterThanOrEqual(1);
    expect(
      await count("SELECT count(*) AS n FROM core_outside_booking WHERE person_ref = ?", member),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_booking WHERE person_ref = ?",
        `${tag}-other`,
      ),
    ).toBe(1);
    expect(await findAnywhere([coachName, coachAddress])).toEqual([]);
    expect(
      await env.DB.prepare("SELECT title, staff_ref FROM core_outside_class WHERE ref = ?")
        .bind(`${tag}-c1`)
        .first(),
    ).toEqual({ title: "Strength with [erased]", staff_ref: null });
  });
});

describe("the file is hostile input", () => {
  const header = "E-mail,First,Plan\n";
  const one = (tag: string, name = "Plain") =>
    `${header}one@${tag}.example.com,${name},Gold Monthly\n`;

  it("reads UTF-8 with or without a mark, UTF-16 either way with or without one, and Windows-1252, by content", async () => {
    const text = "E-mail,First\nrené@example.com,Zoë Ångström\n";
    const enc = (s: string) => new TextEncoder().encode(s);
    const utf16 = (s: string, le: boolean, bom: boolean) => {
      const out = new Uint8Array((s.length + (bom ? 1 : 0)) * 2);
      const all = bom ? `﻿${s}` : s;
      for (let i = 0; i < all.length; i++) {
        const c = all.charCodeAt(i);
        out[i * 2] = le ? c & 0xff : c >> 8;
        out[i * 2 + 1] = le ? c >> 8 : c & 0xff;
      }
      return out;
    };
    const latin = Uint8Array.from(text, (c) => c.charCodeAt(0));
    for (const [bytes, encoding] of [
      [enc(text), "utf-8"],
      [new Uint8Array([0xef, 0xbb, 0xbf, ...enc(text)]), "utf-8"],
      [utf16(text, true, true), "utf-16le"],
      [utf16(text, false, true), "utf-16be"],
      [utf16(text, true, false), "utf-16le"],
      [latin, "windows-1252"],
    ] as const) {
      const out = decodeFile(bytes);
      expect(out, encoding).toEqual({ text, encoding });
    }
    // Windows-1252's own characters in 0x80 to 0x9F.
    expect(decodeFile(new Uint8Array([0x61, 0x80, 0x93, 0x94])).text).toBe("a€“”");
    const dry = await preview(admin, "members", b64(utf16(text, true, true)));
    expect(dry.encoding).toBe("utf-16le");
  });

  it("refuses what is not a delimited text export, saying what it is, whatever the name", async () => {
    const cases: [number[] | string, RegExp][] = [
      [[0x50, 0x4b, 0x03, 0x04, 1, 2, 3], /workbook or a zip/],
      [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0], /old Excel/],
      [[0x25, 0x50, 0x44, 0x46, 0x2d], /PDF/],
      [[0x1f, 0x8b, 8, 0], /gzip/],
      ["<html><table><tr><td>a</td></tr></table></html>", /web page or XML/],
      ['[{"email":"a@example.com"}]', /JSON/],
      ["a,b\n1,\u00002\n", /NUL/],
    ];
    for (const [content, message] of cases) {
      const bytes =
        typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
      const e = await refusal(preview(admin, "members", b64(bytes)));
      expect(e.code, String(message)).toBe("invalid_input");
      expect(e.message).toMatch(message);
    }
    expect((await refusal(preview(admin, "members", "not base64!"))).code).toBe("invalid_input");
    expect(() => decodeFile(new Uint8Array())).toThrow(/empty/);
  });

  it("enforces the size, row, column and cell limits, and refuses duplicate headers and a missing header row", async () => {
    const tag = unique("fh").toLowerCase();
    const big = `${header}${"x".repeat(10_000_001)}`;
    expect((await refusal(preview(admin, "members", utf8(big)))).code).toBe("invalid_input");
    const rows = `${header}${`a@${tag}.example.com,A,Gold\n`.repeat(20_001)}`;
    expect((await refusal(preview(admin, "members", utf8(rows)))).message).toMatch(
      /over 20000 rows/,
    );
    const wide = `${Array.from({ length: 101 }, (_, i) => `c${i}`).join(",")}\n`;
    expect((await refusal(preview(admin, "members", utf8(wide)))).message).toMatch(
      /more than 100 columns/,
    );
    const long = `${header}a@${tag}.example.com,"${"y".repeat(10_001)}",Gold\n`;
    const e = await refusal(preview(admin, "members", utf8(long)));
    expect(e.message).toMatch(/Row 1, column 2 is longer than 10000/);
    expect(e.message).not.toContain("yyyy");
    expect(
      (await refusal(preview(admin, "members", utf8("E-mail,Plan,e-mail\na@x.example.com,G,b\n"))))
        .message,
    ).toMatch(/two columns named/);
    const noHeader = await refusal(
      preview(admin, "members", utf8(`one@${tag}.example.com,Plain,Gold\n`)),
    );
    expect(noHeader.details).toMatchObject({ rule: "outside_no_header" });
  });

  it("merges a person's repeated rows, names a repeated membership, and asks for a missing required column", async () => {
    const tag = unique("fd").toLowerCase();
    const text = [
      "Client ID,E-mail,Plan,Start",
      `${tag}-1,a@${tag}.example.com,Gold Monthly,2026-01-01`,
      `${tag}-1,a@${tag}.example.com,Gold Monthly,2026-01-01`,
      `${tag}-1,other@${tag}.example.com,10 Pack,2026-02-01`,
    ].join("\n");
    const dry = await preview(admin, "members", utf8(text));
    expect(dry.outcome.kept).toBe(1);
    expect(dry.issues.map((i) => i.problem)).toEqual([
      expect.stringMatching(/twice; the first is kept/),
      expect.stringMatching(/another address/),
    ]);
    expect(dry.rows.refused).toBe(1);
    const missing = await preview(admin, "members", utf8("First,Plan\nA,Gold\n"));
    expect(missing).toMatchObject({ ready: false, missing: ["email"] });
    expect(
      (
        await refusal(
          call(
            "outside.file.load",
            { kind: "members", file: utf8("First,Plan\nA,Gold\n"), fingerprint: "x" },
            admin,
          ),
        )
      ).code,
    ).toBe("invalid_input");
    void one;
  });

  it("refuses a value map that would capture a person's value", async () => {
    const tag = unique("fv").toLowerCase();
    const file = utf8(
      `Client ID,First,Last,E-mail,Plan\n${tag}-1,Morgan,Quill${tag},m@${tag}.example.com,Gold Monthly\n`,
    );
    for (const word of [`Quill${tag}`, "Morgan", `m@${tag}.example.com`, "0400 111 222"]) {
      const e = await refusal(
        preview(
          admin,
          "members",
          file,
          given("Client ID,First,Last,E-mail,Plan", { membershipType: { [word]: "membership" } }),
        ),
      );
      expect(e.details, word).toMatchObject({ rule: "outside_value_map_personal" });
      expect(e.message).not.toContain(word);
    }
    // The export's own word for a plan is fine.
    expect(
      (
        await preview(
          admin,
          "members",
          file,
          given("Client ID,First,Last,E-mail,Plan", {
            membershipType: { "Gold Monthly": "membership" },
          }),
        )
      ).ready,
    ).toBe(true);
  });
});

describe("who may preview and load a list", () => {
  it("only a person with bookingSystem:manage: never an AI, MCP, Code Mode, an extension or an automation, under any preset", async () => {
    const tag = unique("fw").toLowerCase();
    const file = utf8(`E-mail,Plan\nw@${tag}.example.com,Gold\n`);
    const member = await createUser("member");
    expect((await refusal(preview(member, "members", file))).code).toBe("forbidden");
    const dry = await preview(admin, "members", file);
    const loadInput = { kind: "members", file, fingerprint: dry.fingerprint };
    for (const preset of ["balanced", "autonomous"] as const) {
      await setPreset(preset);
      try {
        for (const actor of ["assistant", "mcp", "automation", "extension"] as const) {
          for (const [name, input] of [
            ["outside.file.preview", { kind: "members", file }],
            ["outside.file.load", loadInput],
          ] as const) {
            expect(
              (await refusal(call(name, input, admin, actor))).code,
              `${preset} ${actor} ${name}`,
            ).toBe("forbidden");
          }
        }
        const code = await refusal(
          invokeByName(
            "outside.file.load",
            loadInput,
            context(admin, {
              actor: "mcp",
              origin: { surface: "mcp", clientId: "c", clientName: "Code", sessionId: "cap_code" },
              grantedPermissions: ["bookingSystem:manage"],
              clock: () => new Date(NOW),
            }),
          ),
        );
        expect(code.code, `${preset} code mode`).toBe("forbidden");
      } finally {
        await setPreset("balanced");
      }
    }
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_person WHERE address = ?",
        `w@${tag}.example.com`,
      ),
    ).toBe(0);
    const granted = await createUser("member");
    await call(
      "user.setPermissions",
      { id: granted.id, permissions: ["bookingSystem:manage"] },
      admin,
    );
    await load(granted, "members", file);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_person WHERE address = ?",
        `w@${tag}.example.com`,
      ),
    ).toBe(1);
  });
});

describe("a load interrupted half way", () => {
  it("leaves the previous list current: the batch is one transaction", async () => {
    const tag = unique("fi").toLowerCase();
    await load(
      admin,
      "members",
      utf8(`Client ID,E-mail,Plan\n${tag}-old,old@${tag}.example.com,Gold\n`),
    );
    const current = await env.DB.prepare(
      "SELECT id FROM core_outside_list WHERE kind = 'members' AND state = 'current'",
    ).first<{ id: string }>();
    const { planFile } = await import("../src/outside/file.ts");
    const many = Array.from(
      { length: 450 },
      (_, i) => `${tag}-${i},p${i}@${tag}.example.com,Gold`,
    ).join("\n");
    const { plan } = await planFile(
      db.query,
      { kind: "members", bytes: new TextEncoder().encode(`Client ID,E-mail,Plan\n${many}\n`) },
      { userId: admin.id, now: NOW },
    );
    const statements = [...(plan?.statements ?? [])];
    // A statement that fails, after the old list was replaced and the new rows half written.
    statements.splice(
      Math.floor(statements.length / 2),
      0,
      (await import("kysely")).CompiledQuery.raw(
        "INSERT INTO core_outside_list (id) VALUES (NULL)",
      ),
    );
    await expect(db.batch(statements)).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT id FROM core_outside_list WHERE kind = 'members' AND state = 'current'",
      ).first(),
    ).toEqual(current);
    expect(
      await count("SELECT count(*) AS n FROM core_outside_person WHERE ref = ?", `${tag}-old`),
    ).toBe(1);
    expect(
      await count("SELECT count(*) AS n FROM core_outside_person WHERE ref LIKE ?", `${tag}-1%`),
    ).toBe(0);
  });
});

describe("the members list's age, told", () => {
  it("tells the holders once 3 days before it stops counting and once when it does, and removes old log rows", async () => {
    const tag = unique("fn").toLowerCase();
    const granted = await createUser("member");
    await call(
      "user.setPermissions",
      { id: granted.id, permissions: ["bookingSystem:manage"] },
      admin,
    );
    await load(admin, "members", utf8(`E-mail,Plan\nn@${tag}.example.com,Gold\n`), {
      exportedOn: "2026-11-24",
    });
    const notices = (user: string) =>
      count(
        "SELECT count(*) AS n FROM core_notifications WHERE user_id = ? AND dedupe_key LIKE 'outside.list.%'",
        user,
      );
    // Day 27 of 31: nothing yet. Day 28: "stops counting soon", once. Day 32: "stopped", once.
    expect(await runOutsideListsDue(db, new Date("2026-12-21T09:00:00Z"))).toMatchObject({
      soon: false,
      old: false,
    });
    expect(await runOutsideListsDue(db, new Date("2026-12-22T09:00:00Z"))).toMatchObject({
      soon: true,
    });
    expect(await runOutsideListsDue(db, new Date("2026-12-22T09:01:00Z"))).toMatchObject({
      soon: false,
      old: false,
    });
    expect(await notices(granted.id)).toBe(1);
    expect(await notices(admin.id)).toBe(1);
    const member = await createUser("member");
    expect(await notices(member.id)).toBe(0);
    expect(await runOutsideListsDue(db, new Date("2026-12-26T09:00:00Z"))).toMatchObject({
      old: true,
    });
    expect(await runOutsideListsDue(db, new Date("2026-12-27T09:00:00Z"))).toMatchObject({
      soon: false,
      old: false,
    });
    expect(await notices(granted.id)).toBe(2);
    const told = await env.DB.prepare(
      "SELECT title, body FROM core_notifications WHERE user_id = ? AND dedupe_key LIKE 'outside.list.%' ORDER BY created_at",
    )
      .bind(granted.id)
      .all<{ title: string; body: string }>();
    expect(told.results.map((r) => r.title)).toEqual([
      "The booking system's members list stops counting soon",
      "The booking system's members list is too old to count",
    ]);
    expect(JSON.stringify(told.results)).not.toContain(tag);
    // A replaced list's log row goes 30 days after it ended.
    await load(admin, "members", utf8(`E-mail,Plan\nn2@${tag}.example.com,Gold\n`));
    const logs = await count(
      "SELECT count(*) AS n FROM core_outside_list WHERE state != 'current'",
    );
    expect(logs).toBeGreaterThan(0);
    expect((await runOutsideListsDue(db, new Date("2027-01-30T09:00:00Z"))).logRows).toBe(logs);
    expect(
      await count("SELECT count(*) AS n FROM core_outside_list WHERE state != 'current'"),
    ).toBe(0);
  });
});
