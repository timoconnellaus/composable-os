// Stage 34 step 2 (ADR 0692, #225): the folded address. `foldAddress` and migration 0955's
// `core_person_emails.folded` are the same rule, written twice (code and SQL), so this holds them
// together; `samePeople` is every live Person sharing a folded address, in four bound values
// however many there are. The rules that use it (trials, intro offers) are tested where they are:
// subscription-access and memberships-platform.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { foldAddress, samePeople } from "../src/index.ts";
import { db, unique } from "./helpers.ts";

const NOW = new Date().toISOString();

async function addPerson(emails: string[]): Promise<string> {
  const id = `per_${unique("fold")}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_person (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(id, "Folded", NOW, NOW),
    ...emails.map((email, i) =>
      env.DB.prepare(
        "INSERT INTO core_person_emails (id, person_id, email, is_primary, position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(`eml_${id}_${i}`, id, email, i === 0 ? 1 : 0, i, NOW),
    ),
  ]);
  return id;
}

async function foldedOf(personId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT folded FROM core_person_emails WHERE person_id = ? ORDER BY position",
  )
    .bind(personId)
    .all<{ folded: string }>();
  return results.map((r) => r.folded);
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
    // An address changed in place is folded again, and a folded form cannot be written wrong.
    await env.DB.prepare("UPDATE core_person_emails SET email = ? WHERE id = ?")
      .bind(`${tag}+new@y.example`, `eml_${person}_0`)
      .run();
    await env.DB.prepare("UPDATE core_person_emails SET folded = 'wrong' WHERE id = ?")
      .bind(`eml_${person}_1`)
      .run();
    const after = await foldedOf(person);
    expect(after.slice(0, 2)).toEqual([`${tag}@y.example`, `${tag}@x.example`]);
  });

  it("counts every live Person sharing one, never a deleted one, in four bound values", async () => {
    const tag = unique("s").toLowerCase();
    const one = await addPerson([`${tag}+1@x.example`]);
    const two = await addPerson([`other.${tag}@x.example`, `${tag}+2@x.example`]);
    const bare = await addPerson([`${tag}@x.example`]);
    const dotted = await addPerson([`${tag.slice(0, 1)}.${tag.slice(1)}@x.example`]);
    const gone = await addPerson([`${tag}+gone@x.example`]);
    const none = await addPerson([]);
    await env.DB.prepare("UPDATE core_person SET deleted_at = ? WHERE id = ?")
      .bind(NOW, gone)
      .run();
    expect(await same(one)).toEqual([one, two, bare].sort());
    expect(await same(two)).toEqual([one, two, bare].sort());
    expect(await same(dotted)).toEqual([dotted]);
    expect(await same(none)).toEqual([none]);
    // A deleted (merged) Person still counts as themselves, and no one else counts them.
    expect(await same(gone)).toEqual([gone]);
    expect(samePeople(db.query, one).compile().parameters).toHaveLength(4);
  });
});
