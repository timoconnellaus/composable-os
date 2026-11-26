// Stage 65 step 4, the review of PR #519 (ADR 0923): an erased person never comes back through a
// file, however their address is written (S1) or whatever else the row carries (S2), nor through
// an erase that lands between a load's plan and its batch (S3); the file is never stored, not
// even where an approval floor would make the load wait (S4); a file whose first row is data, or
// a mapping that copies a person's data into the copy's own text, is refused (M3, M4). Against
// real D1. Every person here is invented.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, type InvocationContext, invokeByName } from "../src/index.ts";
import { planMembers } from "../src/outside/ingest.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

const NOW = "2026-11-24T09:00:00.000Z";
const char = (code: number) => String.fromCharCode(code);

function utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

function ctx(user: ActingUser, extra: Partial<InvocationContext> = {}): InvocationContext {
  return context(user, { clock: () => new Date(NOW), ...extra });
}

async function call<T>(name: string, input: unknown, user: ActingUser, extra = {}) {
  return (await invokeByName(name, input, ctx(user, extra))) as T;
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

interface Preview {
  ready: boolean;
  fingerprint: string;
  issues: { row: number; problem: string }[];
  outcome: {
    dropped: number;
    previouslyErased: number;
    kept: number;
    items: Record<string, number>;
  };
}

async function load(
  user: ActingUser,
  kind: string,
  file: string,
  extra: Record<string, unknown> = {},
) {
  const dry = await call<Preview>("outside.file.preview", { kind, file, ...extra }, user);
  await call("outside.file.load", { kind, file, ...extra, fingerprint: dry.fingerprint }, user);
  return dry;
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

async function createPerson(admin: ActingUser, email: string) {
  return (
    await call<{ id: string }>(
      "person.create",
      { displayName: unique("Person"), emails: [{ email }] },
      admin,
    )
  ).id;
}

let admin: ActingUser;
beforeAll(async () => {
  admin = await createUser("admin");
});

describe("S1: an erased person's address however the file writes it", () => {
  it("keeps nothing of them: hidden characters, compatibility forms, case, quotes, brackets, a new id", async () => {
    const tag = unique("ra").toLowerCase();
    const domain = `${tag}.example.com`;
    const address = `gone@${domain}`;
    const family = `Erased${tag}`;
    const keep = `kept@${domain}`;
    // Loaded and linked by address (no id column: the ref is the address), then erased.
    const person = await createPerson(admin, address);
    await load(
      admin,
      "members",
      utf8(`E-mail,First,Last,Plan\n${address},Gone,${family},Gold\n${keep},Kept,Person,Gold\n`),
    );
    expect(
      await count("SELECT count(*) AS n FROM core_outside_person WHERE person_id = ?", person),
    ).toBe(1);
    await call("person.erase", { id: person }, admin);

    const fullwidth = [..."gone"].map((c) => char(c.charCodeAt(0) + 0xfee0)).join("");
    const variants = [
      `gone${char(0x200b)}@${domain}`, // zero-width space
      `gone${char(0x2060)}@${domain}`, // word joiner
      `go${char(0xad)}ne@${domain}`, // soft hyphen
      `gone${char(0x202e)}@${domain}`, // right-to-left override
      `${char(0xfeff)}gone@${domain}`, // a byte-order mark in the cell
      `${fullwidth}${char(0xff20)}${domain}`, // fullwidth letters and at sign (NFKC)
      `GoNe@${domain.toUpperCase()}`, // mixed case
      `"gone@${domain}"`, // quoted inside the cell
      `<gone@${domain}>`, // angle brackets
      `Gone Person <gone@${domain}>`, // a display name and brackets
    ];
    for (const [i, written] of variants.entries()) {
      const cell = `"${written.replace(/"/g, '""')}"`;
      for (const [header, row] of [
        // No id column: the ref is the address.
        ["E-mail,First,Last,Plan", `${cell},Gone,${family},Gold`],
        // A new booking-system id beside it.
        ["Client ID,E-mail,First,Last,Plan", `${tag}-new${i},${cell},Gone,${family},Gold`],
      ] as const) {
        const file = utf8(
          `${header}\n${row}\n${header.includes("Client") ? `${tag}-k,` : ""}${keep},Kept,Person,Gold\n`,
        );
        const dry = await load(admin, "members", file);
        expect(dry.outcome.dropped, `variant ${i} ${header}`).toBe(1);
        expect(dry.outcome.kept, `variant ${i} ${header}`).toBe(1);
        expect(
          await count(
            "SELECT count(*) AS n FROM core_outside_person WHERE family_name = ?",
            family,
          ),
          `variant ${i}`,
        ).toBe(0);
      }
    }
    // Nothing of theirs anywhere: not their name, not their address in a ref.
    expect(await findAnywhere([family, address])).toEqual([]);
  });

  it("leaves out a row whose address the host does not take, and never builds a ref from it", async () => {
    const tag = unique("rb").toLowerCase();
    const file = utf8(
      `Client ID,E-mail,First,Last,Plan\n${tag}-1,not..valid@@${tag}.example.com,Left,Out${tag},Gold\n${tag}-2,ok@${tag}.example.com,Kept,In${tag},Gold\n`,
    );
    const dry = await call<Preview>("outside.file.preview", { kind: "members", file }, admin);
    expect(dry.issues).toEqual([
      expect.objectContaining({ row: 1, problem: "not an address: the row is left out" }),
    ]);
    // The issue names no value.
    expect(JSON.stringify(dry.issues)).not.toContain("valid@@");
    expect(dry.outcome.kept).toBe(1);
    await call("outside.file.load", { kind: "members", file, fingerprint: dry.fingerprint }, admin);
    expect(await findAnywhere([`Out${tag}`, "not..valid"])).toEqual([]);
  });
});

describe("S1, at the ingest: any source", () => {
  it("keeps nothing of a person whose address the host does not take, whatever their ref", async () => {
    const tag = unique("ri").toLowerCase();
    const plan = await planMembers(
      db.query,
      {
        people: [
          {
            ref: `${tag}-new`,
            email: `gone${char(0x200b)}@${tag}.example.com`,
            givenName: "Gone",
            familyName: `Ingest${tag}`,
            memberStatus: "member",
            active: true,
            modifiedAt: null,
          },
        ],
        membershipTypes: [],
        memberships: [],
      },
      { exportedOn: "2026-11-23", by: admin.id, now: NOW, rows: 1, refused: 0 },
    );
    expect(plan.counts).toMatchObject({ kept: 0, notKept: 1 });
    expect(JSON.stringify(plan.rows)).not.toContain(`Ingest${tag}`);
  });
});

describe("S2: every address a timetable row carries is checked", () => {
  it("drops a booking whose row gives a new id and an erased person's address", async () => {
    const tag = unique("rt").toLowerCase();
    const address = `booked@${tag}.example.com`;
    const person = await createPerson(admin, address);
    await call("person.erase", { id: person }, admin);
    const file = utf8(
      [
        "Class ID,Class,Starts,Client ID,Email,Status",
        `${tag}-c1,Strength,2026-11-25 07:00,${tag}-newid,${address},Booked`,
        `${tag}-c1,Strength,2026-11-25 07:00,${tag}-other,other@${tag}.example.com,Booked`,
      ].join("\n"),
    );
    const dry = await load(admin, "timetable", file);
    expect(dry.outcome.dropped).toBe(1);
    expect(dry.outcome.items).toMatchObject({ bookings: 1 });
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_booking WHERE person_ref = ?",
        `${tag}-newid`,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_booking WHERE person_ref = ?",
        `${tag}-other`,
      ),
    ).toBe(1);
  });
});

describe("S3: an erase between a load's plan and its batch", () => {
  it("fails the whole batch: the erased row is not put back, and the load is told to run the dry run again", async () => {
    const tag = unique("rr").toLowerCase();
    const address = `race@${tag}.example.com`;
    const family = `Race${tag}`;
    const person = await createPerson(admin, address);
    const file = utf8(`E-mail,First,Last,Plan\n${address},Race,${family},Gold\n`);
    await load(admin, "members", file);
    const dry = await call<Preview>("outside.file.preview", { kind: "members", file }, admin);
    // The load's own batch: the erase commits first, after the load planned.
    let erased = false;
    const racing = createCrmDb(
      new Proxy(env.DB, {
        get(target, prop) {
          if (prop === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (!erased) {
                erased = true;
                await invokeByName("person.erase", { id: person }, ctx(admin));
              }
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
    const e = await refusal(
      invokeByName(
        "outside.file.load",
        { kind: "members", file, fingerprint: dry.fingerprint },
        ctx(admin, { db: racing }),
      ),
    );
    expect(erased).toBe(true);
    expect(e.code).toBe("conflict");
    expect(e.details).toMatchObject({ rule: "outside_preview_stale" });
    expect(
      await count("SELECT count(*) AS n FROM core_outside_person WHERE family_name = ?", family),
    ).toBe(0);
    expect(await findAnywhere([family, address])).toEqual([]);
  });

  it("fails it too for a link or an unlink in between", async () => {
    const tag = unique("rl").toLowerCase();
    const file = utf8(`Client ID,E-mail,First,Plan\n${tag}-1,a@${tag}.example.com,Ann,Gold\n`);
    await load(admin, "members", file);
    const dry = await call<Preview>("outside.file.preview", { kind: "members", file }, admin);
    let done = false;
    const racing = createCrmDb(
      new Proxy(env.DB, {
        get(target, prop) {
          if (prop === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (!done) {
                done = true;
                await invokeByName(
                  "outside.unlink",
                  { kind: "person", ref: `${tag}-1`, why: "not ours" },
                  ctx(admin),
                );
              }
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
    const e = await refusal(
      invokeByName(
        "outside.file.load",
        { kind: "members", file, fingerprint: dry.fingerprint },
        ctx(admin, { db: racing }),
      ),
    );
    expect(e.code).toBe("conflict");
    // The unlink stands.
    expect(
      await env.DB.prepare("SELECT link_how, person_id FROM core_outside_person WHERE ref = ?")
        .bind(`${tag}-1`)
        .first(),
    ).toEqual({ link_how: "staff", person_id: null });
  });
});

describe("S4: the file is never queued for approval", () => {
  it("refuses, saying why, wherever a preset or a floor would make it wait, and keeps nothing of the file", async () => {
    const tag = unique("rq").toLowerCase();
    const family = `Queued${tag}`;
    const file = utf8(`E-mail,First,Last,Plan\nq@${tag}.example.com,Que,${family},Gold\n`);
    const dry = await call<Preview>("outside.file.preview", { kind: "members", file }, admin);
    const floors = [
      { human: { write: "review" } },
      { "*": { write: "review" } },
      { human: { write: "review", read: "review" } },
    ] as const;
    for (const preset of ["cautious", "balanced", "autonomous"] as const) {
      await setPreset(preset);
      try {
        for (const floor of floors) {
          const e = await refusal(
            call(
              "outside.file.load",
              { kind: "members", file, fingerprint: dry.fingerprint },
              admin,
              { floor },
            ),
          );
          expect(e.code, `${preset} ${JSON.stringify(floor)}`).toBe("denied");
          expect(e.details).toMatchObject({ rule: "never_queued" });
          expect(e.message).toMatch(/cannot/);
        }
        // A floor reviewing a person's reads: the dry run is refused the same way.
        const read = await refusal(
          call("outside.file.preview", { kind: "members", file }, admin, {
            floor: { human: { read: "review" } },
          }),
        );
        if (read.code !== "denied") throw new Error(`${preset}: ${read.code}`);
      } finally {
        await setPreset("balanced");
      }
    }
    expect(
      await count(
        "SELECT count(*) AS n FROM core_pending_action WHERE operation LIKE 'outside.file.%'",
      ),
    ).toBe(0);
    expect(await findAnywhere([family, `q@${tag}`, file.slice(0, 40)])).toEqual([]);
  });
});

describe("M3: a file whose first row is data", () => {
  it("is refused, and no header that looks like a value is ever saved", async () => {
    const tag = unique("rh").toLowerCase();
    const coach = `Jane Coach${tag}`;
    const headerless = [
      `Yoga,27 Nov 2026 07:00,${coach}`,
      `Pilates,28 Nov 2026 07:00,${coach}`,
    ].join("\n");
    const e = await refusal(
      call(
        "outside.file.preview",
        {
          kind: "timetable",
          file: utf8(headerless),
          mapping: { columns: { title: "Yoga", startsAt: "27 Nov 2026 07:00", staff: coach } },
        },
        admin,
      ),
    );
    expect(e.details).toMatchObject({ rule: "outside_no_header" });
    expect(e.message).not.toContain(coach);
    // A first row that is a person's name the rows hold, as a column name.
    const named = await refusal(
      call(
        "outside.file.preview",
        {
          kind: "timetable",
          file: utf8(`Yoga,Starts,${coach}\nYoga,2026-11-27 07:00,${coach}\n`),
          mapping: { columns: { title: "Yoga", startsAt: "Starts", staff: coach } },
        },
        admin,
      ),
    );
    expect(named.details).toMatchObject({ rule: "outside_no_header" });
    expect(await findAnywhere([coach])).toEqual([]);
  });

  it("keeps the shape of a saved mapping as a keyed hash, and an admin clears one", async () => {
    const tag = unique("rs").toLowerCase();
    const file = utf8(`E-mail,Plan,Secret column ${tag}\ns@${tag}.example.com,Gold,x\n`);
    await load(admin, "members", file);
    const stored = await env.DB.prepare("SELECT mappings FROM core_outside_settings").first<{
      mappings: string;
    }>();
    expect(stored?.mappings).not.toContain(`Secret column ${tag}`);
    expect(JSON.parse(stored?.mappings ?? "{}").members.shape).toMatch(/^[0-9a-f]{64}$/);
    expect(
      (
        await call<{ mappingFrom: string }>(
          "outside.file.preview",
          { kind: "members", file },
          admin,
        )
      ).mappingFrom,
    ).toBe("saved");
    await call("outside.settings.update", { clearMappings: ["members"] }, admin);
    const settings = await call<{ mappings: Record<string, unknown> }>(
      "outside.settings.get",
      {},
      admin,
    );
    expect(settings.mappings.members).toBeUndefined();
    expect(
      (
        await call<{ mappingFrom: string }>(
          "outside.file.preview",
          { kind: "members", file },
          admin,
        )
      ).mappingFrom,
    ).toBe("suggested");
  });
});

describe("M4: a person's data mapped into the copy's own text", () => {
  it("refuses a phone, an address or the people's names as a plan's name or a class's title", async () => {
    const tag = unique("rp").toLowerCase();
    const members = utf8(
      [
        "E-mail,First,Last,Phone,Plan",
        `a@${tag}.example.com,Avery,One${tag},0400 111 222,Gold`,
        `b@${tag}.example.com,Blake,Two${tag},0400 333 444,Gold`,
        `c@${tag}.example.com,Casey,Three${tag},0400 555 666,Silver`,
      ].join("\n"),
    );
    for (const column of ["Phone", "Last", "E-mail"]) {
      const e = await refusal(
        call(
          "outside.file.preview",
          {
            kind: "members",
            file: members,
            mapping: { columns: { email: "E-mail", membershipType: column } },
          },
          admin,
        ),
      );
      expect(e.details, column).toMatchObject({ rule: "outside_mapping_personal" });
      expect(e.message).not.toMatch(/0400|One|example/);
    }
    const timetable = utf8(
      [
        "Class,Starts,Client email",
        `Strength,2026-11-25 07:00,x@${tag}.example.com`,
        `Mobility,2026-11-26 07:00,y@${tag}.example.com`,
      ].join("\n"),
    );
    const e = await refusal(
      call(
        "outside.file.preview",
        {
          kind: "timetable",
          file: timetable,
          mapping: { columns: { title: "Client email", startsAt: "Starts" } },
        },
        admin,
      ),
    );
    expect(e.details).toMatchObject({ rule: "outside_mapping_personal" });
    // The right columns load; a title with a date in it is no phone number.
    expect(
      (
        await call<Preview>(
          "outside.file.preview",
          {
            kind: "timetable",
            file: utf8(`Class,Starts\nBootcamp 2026-11-25 06:00,2026-11-25 06:00\n`),
          },
          admin,
        )
      ).ready,
    ).toBe(true);
  });
});
