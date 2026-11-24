// Stage 34 step 2 (ADR 0692, #225): the folded address. `foldAddress` (code), `foldedSql` (the
// SQL the checks run) and migration 0955's index are the same rule written three times, so this
// holds them together, and shows the index serves the lookup and costs an address write nothing.
// `samePeople` is every Person sharing a folded address, in two bound values however many there
// are. The rules that use it (trials, intro offers) are tested where they are:
// subscription-access and memberships-platform.
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { foldAddress, foldedSql, samePeople } from "../src/index.ts";
import { db, unique } from "./helpers.ts";

const NOW = new Date().toISOString();

function emailRow(personId: string, email: string, i: number) {
  return env.DB.prepare(
    "INSERT INTO core_person_emails (id, person_id, email, is_primary, position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(`eml_${personId}_${i}`, personId, email, i === 0 ? 1 : 0, i, NOW);
}

async function addPerson(emails: string[]): Promise<string> {
  const id = `per_${unique("fold")}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_person (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(id, "Folded", NOW, NOW),
    ...emails.map((email, i) => emailRow(id, email, i)),
  ]);
  return id;
}

async function foldedOf(personId: string): Promise<string[]> {
  const rows = await db.query
    .selectFrom("core_person_emails as e")
    .select(foldedSql("e.email").as("folded"))
    .where("e.person_id", "=", personId)
    .orderBy("e.position")
    .execute();
  return rows.map((r) => r.folded);
}

async function same(personId: string): Promise<string[]> {
  const rows = await samePeople(db.query, personId).execute();
  return rows.map((r) => r.person_id).sort();
}

describe("the folded address", () => {
  it("drops a +tag on every domain, folds no dots, and is the same in code and in the database", async () => {
    const tag = unique("f").toLowerCase();
    const cases: [string, string][] = [
      [`${tag}+1@x.example`, `${tag}@x.example`],
      [`${tag}+gym+2@x.example`, `${tag}@x.example`],
      [`${tag}+@x.example`, `${tag}@x.example`],
      [`a.b.${tag}@x.example`, `a.b.${tag}@x.example`],
      [`a.b.${tag}+1@gmail.com`, `a.b.${tag}@gmail.com`],
      [`+${tag}@x.example`, `+${tag}@x.example`],
      [`${tag}@x.example`, `${tag}@x.example`],
    ];
    for (const [address, folded] of cases) expect(foldAddress(address)).toBe(folded);
    expect(foldAddress(`  ${tag.toUpperCase()}+Tag@X.Example `)).toBe(`${tag}@x.example`);
    expect(foldAddress("not an address")).toBeNull();
    const person = await addPerson(cases.map(([address]) => address));
    expect(await foldedOf(person)).toEqual(cases.map(([, folded]) => folded));
  });

  it("is looked up through migration 0955's index, and writing an address costs no more for it", async () => {
    const tag = unique("plan").toLowerCase();
    const person = await addPerson([`${tag}+1@x.example`]);
    const compiled = samePeople(db.query, person).compile();
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`)
      .bind(...compiled.parameters)
      .all<{ detail: string }>();
    expect(results.map((r) => r.detail).join("\n")).toMatch(/core_person_emails_folded_idx/);
    // Nothing is written beside the address itself: no trigger on it (review of step 2: a
    // trigger keeping a stored folded form doubled every address write through search's).
    const { results: triggers } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'core_person_emails' AND sql LIKE '%instr%'",
    ).all<{ name: string }>();
    expect(triggers).toEqual([]);
    const tagged = await emailRow(person, `${tag}+2@x.example`, 1).run();
    const plain = await emailRow(person, `${tag}.plain@x.example`, 2).run();
    expect(tagged.meta.rows_written).toBe(plain.meta.rows_written);
  });

  it("counts every Person sharing one, one in the Trash too, in two bound values", async () => {
    const tag = unique("s").toLowerCase();
    const one = await addPerson([`${tag}+1@x.example`]);
    const two = await addPerson([`other.${tag}@x.example`, `${tag}+2@x.example`]);
    const bare = await addPerson([`${tag}@x.example`]);
    const dotted = await addPerson([`${tag.slice(0, 1)}.${tag.slice(1)}@x.example`]);
    const trashed = await addPerson([`${tag}+trash@x.example`]);
    const none = await addPerson([]);
    await env.DB.prepare("UPDATE core_person SET deleted_at = ? WHERE id = ?")
      .bind(NOW, trashed)
      .run();
    const all = [one, two, bare, trashed].sort();
    expect(await same(one)).toEqual(all);
    expect(await same(two)).toEqual(all);
    expect(await same(trashed)).toEqual(all);
    expect(await same(dotted)).toEqual([dotted]);
    expect(await same(none)).toEqual([none]);
    expect(samePeople(db.query, one).compile().parameters).toHaveLength(2);
    // foldedSql binds nothing: the index serves only the same expression.
    expect(sql`${foldedSql("e.email")}`.compile(db.query).parameters).toEqual([]);
  });
});
