// Stage 53 step 7 (ADR 0803): a birthday on Person, day and month only. Staff set it with
// person.setBirthday, the member with me.birthday.set; each write carries its value mark (a
// person's, the member's); an AI may not change a birthday the member gave. A merge keeps the
// survivor's unless it has none; erase removes it. The birthday entry rule finds the People whose
// birthday it is in the business's zone through one indexed statement a page.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  BIRTHDAY_PAGE,
  birthdayPeople,
  birthdaysOn,
  type CustomerPrincipal,
  coreRegistry,
  invoke,
  type OutsideInvocationContext,
} from "../src/index.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

let admin: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
});

afterEach(async () => {
  await setPreset("balanced");
});

const person = async (name = unique("P")) =>
  (await invoke("person.create", { displayName: name }, context(admin))).id;

/** A Person with a customer account. */
async function customer(): Promise<CustomerPrincipal> {
  const personId = await person();
  const id = `cus_${unique("c")}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  )
    .bind(id, personId, `${unique("m")}@customers.example`, now, now)
    .run();
  return { kind: "customer", customerId: id, personId };
}

const as = (principal: CustomerPrincipal): OutsideInvocationContext => ({
  principal,
  db,
  origin: { surface: "client" },
});

async function refused(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  throw new Error("expected a refusal");
}

const columns = (id: string) =>
  env.DB.prepare("SELECT birth_day, birth_month FROM core_person WHERE id = ?")
    .bind(id)
    .first<{ birth_day: number | null; birth_month: number | null }>();

const mark = (id: string) =>
  env.DB.prepare(
    "SELECT standing FROM core_value_mark WHERE object_type = 'person' AND record_id = ? AND field = 'birthday'",
  )
    .bind(id)
    .first<{ standing: string }>();

const setBirthday = (id: string, birthday: unknown, ctx = context(admin)) =>
  invoke("person.setBirthday", { id, birthday } as never, ctx);

describe("the fields", () => {
  it("are day and month, both or neither, a day the month has", async () => {
    const id = await person();
    const set = (day: unknown, month: unknown) =>
      env.DB.prepare("UPDATE core_person SET birth_day = ?, birth_month = ? WHERE id = ?")
        .bind(day, month, id)
        .run();
    for (const [day, month] of [
      [31, 4],
      [30, 2],
      [0, 1],
      [12, 13],
      [12, null],
      [null, 5],
    ]) {
      await expect(set(day, month), `${day}/${month}`).rejects.toThrow(/CHECK/);
    }
    await set(29, 2);
    await set(31, 12);
    await set(null, null);
    expect(await columns(id)).toEqual({ birth_day: null, birth_month: null });
  });

  it("are in no rec_* view, so in no export or dashboard", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('rec_person') WHERE name LIKE 'birth%'",
    ).all();
    expect(results).toEqual([]);
  });
});

describe("person.setBirthday", () => {
  it("records day and month with a person's mark, shows it on the Person, and clears it", async () => {
    const id = await person();
    expect((await invoke("person.get", { id }, context(admin))).birthday).toBeNull();
    const after = await setBirthday(id, { day: 14, month: 3 });
    expect(after.birthday).toEqual({ day: 14, month: 3 });
    expect(await columns(id)).toEqual({ birth_day: 14, birth_month: 3 });
    expect((await mark(id))?.standing).toBe("person");
    const audit = await env.DB.prepare(
      `SELECT c.diff FROM core_audit_changes c JOIN core_audit a ON a.id = c.audit_id
        WHERE a.operation = 'person.setBirthday' AND c.record_id = ?`,
    )
      .bind(id)
      .first<{ diff: string }>();
    expect(JSON.parse(audit?.diff ?? "{}")).toEqual({
      birthday: { before: null, after: { day: 14, month: 3 } },
    });
    await setBirthday(id, null);
    expect(await columns(id)).toEqual({ birth_day: null, birth_month: null });
  });

  it("refuses a day the month does not have, and a year", async () => {
    const id = await person();
    for (const birthday of [
      { day: 30, month: 2 },
      { day: 31, month: 11 },
      { day: 1, month: 1, year: 1990 },
      { day: 0, month: 1 },
    ]) {
      expect(await refused(setBirthday(id, birthday)), JSON.stringify(birthday)).toBe(
        "invalid_input",
      );
    }
    expect((await setBirthday(id, { day: 29, month: 2 })).birthday).toEqual({ day: 29, month: 2 });
  });

  it("is a staff write: records:write", () => {
    const op = coreRegistry.get("person.setBirthday");
    expect(op?.permission).toBe("records:write");
    expect(op?.risk).toBe("write");
    expect(op?.audiences ?? ["staff"]).toEqual(["staff"]);
  });

  it("an AI's write is marked the AI's", async () => {
    await setPreset("autonomous");
    const id = await person();
    await setBirthday(id, { day: 2, month: 6 }, context(admin, { actor: "assistant" }));
    expect((await mark(id))?.standing).toBe("ai");
  });
});

describe("me.birthday", () => {
  it("the member sets and reads their own, marked theirs", async () => {
    const m = await customer();
    expect(await invoke("me.birthday.get", {}, as(m))).toEqual({ birthday: null });
    expect(await invoke("me.birthday.set", { birthday: { day: 9, month: 8 } }, as(m))).toEqual({
      birthday: { day: 9, month: 8 },
    });
    expect(await columns(m.personId)).toEqual({ birth_day: 9, birth_month: 8 });
    expect((await mark(m.personId))?.standing).toBe("customer");
    expect(await invoke("me.birthday.get", {}, as(m))).toEqual({
      birthday: { day: 9, month: 8 },
    });
    expect(
      await refused(invoke("me.birthday.set", { birthday: { day: 31, month: 9 } }, as(m))),
    ).toBe("invalid_input");
    // It names no Person: the caller's own is the only one it can change.
    expect(
      await refused(invoke("me.birthday.set", { id: m.personId, birthday: null } as never, as(m))),
    ).toBe("invalid_input");
    await invoke("me.birthday.set", { birthday: null }, as(m));
    expect(await columns(m.personId)).toEqual({ birth_day: null, birth_month: null });
  });

  it("touches only the caller's Person", async () => {
    const m = await customer();
    const other = await customer();
    await invoke("me.birthday.set", { birthday: { day: 1, month: 1 } }, as(m));
    expect(await columns(other.personId)).toEqual({ birth_day: null, birth_month: null });
  });

  it("is open to customers only, never to MCP", () => {
    for (const name of ["me.birthday.get", "me.birthday.set"]) {
      const op = coreRegistry.get(name);
      expect(op?.audiences, name).toEqual(["customer"]);
      expect(op?.hostInternal, name).toBe(true);
      expect(op?.mcp?.expose, name).toBe(false);
    }
  });

  it("an AI may not change a birthday the member gave; a person may", async () => {
    await setPreset("autonomous");
    const m = await customer();
    await invoke("me.birthday.set", { birthday: { day: 5, month: 5 } }, as(m));
    for (const actor of ["assistant", "mcp"] as const) {
      expect(
        await refused(setBirthday(m.personId, { day: 6, month: 5 }, context(admin, { actor }))),
        actor,
      ).toBe("forbidden");
      expect(await refused(setBirthday(m.personId, null, context(admin, { actor }))), actor).toBe(
        "forbidden",
      );
    }
    expect(await columns(m.personId)).toEqual({ birth_day: 5, birth_month: 5 });
    await setBirthday(m.personId, { day: 6, month: 5 });
    expect((await mark(m.personId))?.standing).toBe("person");
    // Once a person gave it, an AI may correct it.
    await setBirthday(m.personId, { day: 7, month: 5 }, context(admin, { actor: "assistant" }));
    expect(await columns(m.personId)).toEqual({ birth_day: 7, birth_month: 5 });
  });
});

describe("merge and erase", () => {
  it("a merge keeps the survivor's birthday, or takes the duplicate's with its mark", async () => {
    const survivor = await person();
    const merged = await customer();
    await invoke("me.birthday.set", { birthday: { day: 3, month: 4 } }, as(merged));
    await invoke(
      "person.merge",
      { survivorId: survivor, mergedId: merged.personId },
      context(admin),
    );
    expect(await columns(survivor)).toEqual({ birth_day: 3, birth_month: 4 });
    // Taken from the member's own: still theirs, so an AI may not change it.
    expect((await mark(survivor))?.standing).toBe("customer");

    const keeps = await person();
    const other = await person();
    await setBirthday(keeps, { day: 10, month: 10 });
    await setBirthday(other, { day: 11, month: 11 });
    const result = await invoke(
      "person.merge",
      { survivorId: keeps, mergedId: other },
      context(admin),
    );
    expect(result.birthday).toEqual({ day: 10, month: 10 });
    expect(await columns(keeps)).toEqual({ birth_day: 10, birth_month: 10 });
  });

  // The review of PR #431, finding 1: an AI's merge may not drop or carry away a birthday the
  // member gave; a person's may.
  it("an AI's merge may not carry the member's birthday to the survivor, laundering its mark", async () => {
    await setPreset("autonomous");
    const survivor = await person();
    const member = await customer();
    await invoke("me.birthday.set", { birthday: { day: 3, month: 4 } }, as(member));
    const merge = invoke(
      "person.merge",
      { survivorId: survivor, mergedId: member.personId },
      context(admin, { actor: "assistant" }),
    );
    expect(await refused(merge)).toBe("forbidden");
    expect(await columns(survivor)).toEqual({ birth_day: null, birth_month: null });
    // So the AI cannot then overwrite it on the survivor either: the member's mark stands.
    expect((await mark(member.personId))?.standing).toBe("customer");
  });

  it("an AI's merge may not replace the member's birthday with one it set", async () => {
    await setPreset("autonomous");
    const member = await customer();
    await invoke("me.birthday.set", { birthday: { day: 3, month: 4 } }, as(member));
    const planted = await person();
    await setBirthday(planted, { day: 25, month: 12 }, context(admin, { actor: "assistant" }));
    for (const actor of ["assistant", "mcp"] as const) {
      const merge = invoke(
        "person.merge",
        { survivorId: planted, mergedId: member.personId },
        context(admin, { actor }),
      );
      expect(await refused(merge), actor).toBe("forbidden");
    }
    expect(await invoke("me.birthday.get", {}, as(member))).toEqual({
      birthday: { day: 3, month: 4 },
    });
    // A person may merge them; the survivor's birthday is kept, as the rule says.
    await invoke(
      "person.merge",
      { survivorId: planted, mergedId: member.personId },
      context(admin),
    );
    expect(await columns(planted)).toEqual({ birth_day: 25, birth_month: 12 });
  });

  it("an AI's merge that leaves the member's birthday as it is goes on", async () => {
    await setPreset("autonomous");
    const member = await customer();
    await invoke("me.birthday.set", { birthday: { day: 8, month: 9 } }, as(member));
    const other = await person();
    await invoke(
      "person.merge",
      { survivorId: member.personId, mergedId: other },
      context(admin, { actor: "assistant" }),
    );
    expect((await mark(member.personId))?.standing).toBe("customer");
  });

  it("erase removes the birthday and its mark", async () => {
    const id = await person();
    await setBirthday(id, { day: 20, month: 1 });
    await invoke("person.erase", { id }, context(admin));
    expect(await columns(id)).toBeNull();
    expect(await mark(id)).toBeNull();
  });
});

describe("a birthday set meanwhile", () => {
  // The review of PR #431, finding 2: a write planned from the birthday it read fails whole when
  // the birthday changed before it committed (the member's own, while an AI's was on its way).
  it("fails the write's batch as a conflict, and a write over the value read goes through", async () => {
    const id = await person();
    await setBirthday(id, { day: 4, month: 4 });
    const guard = (day: number | null, month: number | null) =>
      env.DB.prepare(
        "INSERT INTO core_birthday_guard (person_id, birth_day, birth_month) VALUES (?, ?, ?)",
      )
        .bind(id, day, month)
        .run();
    await expect(guard(null, null)).rejects.toThrow(/core_birthday_changed/);
    await expect(guard(5, 4)).rejects.toThrow(/core_birthday_changed/);
    await guard(4, 4);
    const kept = await env.DB.prepare("SELECT count(*) AS n FROM core_birthday_guard").first<{
      n: number;
    }>();
    expect(kept?.n).toBe(0);
  });

  it("person.setBirthday carries the guard: a batch planned from a stale read is refused", async () => {
    const id = await person();
    // The member sets theirs between the AI's read and its commit: simulated by a write the
    // batch does not know of, made before it runs.
    let raced = false;
    const racing = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await target
                .prepare("UPDATE core_person SET birth_day = 1, birth_month = 2 WHERE id = ?")
                .bind(id)
                .run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const outcome = await refused(
      invoke(
        "person.setBirthday",
        { id, birthday: { day: 9, month: 9 } },
        context(admin, { db: createCrmDb(racing) }),
      ),
    );
    expect(raced).toBe(true);
    expect(outcome).toBe("conflict");
    expect(await columns(id)).toEqual({ birth_day: 1, birth_month: 2 });
  });
});

describe("the field on the generic paths", () => {
  // The review of PR #431, finding 3: nothing takes a birthday silently and does nothing.
  it("record.update names person.setBirthday, and person.update refuses it", async () => {
    const id = await person();
    const generic = await invoke(
      "record.update",
      { object: "person", id, values: { birthday: { day: 1, month: 1 } } },
      context(admin),
    ).then(
      () => null,
      (e: { message?: string }) => e.message ?? "",
    );
    expect(generic).toContain("person.setBirthday");
    expect(
      await refused(
        invoke("person.update", { id, birthday: { day: 1, month: 1 } } as never, context(admin)),
      ),
    ).toBe("invalid_input");
    expect(await columns(id)).toEqual({ birth_day: null, birth_month: null });
  });
});

describe("the birthday entry rule", () => {
  it("is the day in the business's zone, and 29 February is kept on the 28th in other years", () => {
    // 14:30 on 6 November in UTC is 01:30 on 7 November in Sydney.
    expect(birthdaysOn("2026-11-06T14:30:00Z", "Australia/Sydney")).toEqual({
      date: "2026-11-07",
      month: 11,
      days: [7],
    });
    expect(birthdaysOn("2026-11-06T14:30:00Z", "UTC").days).toEqual([6]);
    expect(birthdaysOn("2027-02-28T12:00:00Z", "UTC")).toMatchObject({ month: 2, days: [28, 29] });
    expect(birthdaysOn("2028-02-28T12:00:00Z", "UTC").days).toEqual([28]);
    expect(birthdaysOn("2028-02-29T12:00:00Z", "UTC").days).toEqual([29]);
  });

  it("finds the live People whose birthday it is, and nobody without one", async () => {
    const today = await person();
    const leap = await person();
    const tomorrow = await person();
    const none = await person();
    const trashed = await person();
    await setBirthday(today, { day: 28, month: 2 });
    await setBirthday(leap, { day: 29, month: 2 });
    await setBirthday(tomorrow, { day: 1, month: 3 });
    await setBirthday(trashed, { day: 28, month: 2 });
    await invoke("person.delete", { id: trashed }, context(admin));
    const found = async (now: string) => (await birthdayPeople(db.query, { now, zone: "UTC" })).ids;
    const in2027 = await found("2027-02-28T09:00:00Z");
    expect(in2027).toEqual(expect.arrayContaining([today, leap]));
    for (const id of [tomorrow, none, trashed]) expect(in2027).not.toContain(id);
    const in2028 = await found("2028-02-28T09:00:00Z");
    expect(in2028).toContain(today);
    expect(in2028).not.toContain(leap);
  });

  it("reads one indexed statement a page, however many People", async () => {
    // A day nobody else in this file has: 17 July.
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = await person();
      await setBirthday(id, { day: 17, month: 7 });
      ids.push(id);
    }
    let statements = 0;
    const counted = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") {
          return (query: string) => {
            statements++;
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const countedDb = createCrmDb(counted);
    const now = "2026-07-17T08:00:00Z";
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const page: { ids: string[]; next: string | null } = await birthdayPeople(countedDb.query, {
        now,
        zone: "UTC",
        after,
        limit: 3,
      });
      seen.push(...page.ids);
      after = page.next;
      pages++;
    } while (after);
    expect(seen.sort()).toEqual([...ids].sort());
    expect(statements).toBe(pages);
    expect(BIRTHDAY_PAGE).toBeLessThanOrEqual(500);

    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM core_person
        WHERE birth_month = ? AND birth_day IN (?) AND deleted_at IS NULL
          AND merged_into_id IS NULL AND id > ? ORDER BY id LIMIT ?`,
    )
      .bind(7, 17, "", 500)
      .all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join("\n")).toContain("core_person_birthday_idx");
  });
});
