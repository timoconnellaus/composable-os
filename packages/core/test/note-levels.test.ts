// Stage 56 step 1 (ADRs 0830, 0831, 0832): note levels. A `coaches` note is read by its author,
// the staff who look after its Person, admins and holders of notes:clients, each read audited; a
// `sensitive` note by its author, admins and holders of notes:sensitive, listed locked and opened
// one at a time, each opening audited. Both are out of every bulk path (timelines of those who may
// not read them, search, query.sql, exports, the Trash, counts, embeddings, summaries, the audit
// log an AI reads), no AI actor reads either with any grant, and the audit holds none of the text.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { embeddingTexts } from "../src/ai/embedding.ts";
import {
  activitySummaryInput,
  recordSummaryInput,
  storeSummaryStatement,
} from "../src/ai/summaries.ts";
import { type ActingUser, type Actor, invoke } from "../src/index.ts";
import { auditRows, context, createUser, db, refusal, unique } from "./helpers.ts";

let admin: ActingUser;
let otherAdmin: ActingUser;
let author: ActingUser;
let carer: ActingUser;
let member: ActingUser;
let manager: ActingUser;
let keeper: ActingUser;
let person: string;
let otherPerson: string;

const as = (user: ActingUser, actor: Actor = "human") =>
  context(
    user,
    actor === "human"
      ? {}
      : {
          actor,
          origin: {
            surface: actor === "mcp" ? "mcp" : actor === "assistant" ? "assistant" : "automation",
          },
        },
  );

async function timelineIds(user: ActingUser, actor: Actor = "human", recordId = person) {
  const page = await invoke(
    "activity.listForRecord",
    { object: "person", recordId, limit: 100 },
    as(user, actor),
  );
  return page.items;
}

async function log(
  user: ActingUser,
  level: "staff" | "coaches" | "sensitive",
  body: string,
  links: { object: string; id: string }[] = [{ object: "person", id: person }],
) {
  return invoke("activity.log", { type: "note", body, level, links }, as(user));
}

/** Every audit row and change that holds `text`, anywhere. */
async function auditHolding(text: string): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM core_audit WHERE instr(coalesce(input, ''), ?1) > 0
        OR instr(coalesce(result, ''), ?1) > 0 OR instr(coalesce(error, ''), ?1) > 0)
      + (SELECT COUNT(*) FROM core_audit_changes WHERE instr(diff, ?1) > 0) AS n`,
  )
    .bind(text)
    .first<{ n: number }>();
  return Number(rows?.n ?? 0);
}

beforeAll(async () => {
  admin = await createUser("admin");
  otherAdmin = await createUser("admin");
  author = await createUser("member");
  carer = await createUser("member");
  member = await createUser("member");
  manager = await createUser("member");
  keeper = await createUser("member");
  await invoke(
    "user.setPermissions",
    { id: manager.id, permissions: ["notes:clients"] },
    as(admin),
  );
  await invoke(
    "user.setPermissions",
    { id: keeper.id, permissions: ["notes:sensitive"] },
    as(admin),
  );
  person = (await invoke("person.create", { displayName: unique("Member") }, as(admin))).id;
  otherPerson = (await invoke("person.create", { displayName: unique("Other") }, as(admin))).id;
  await invoke("carer.set", { personId: person, userId: carer.id }, as(admin));
});

describe("a note kept to a client's coaches", () => {
  let note: string;
  let word: string;

  beforeAll(async () => {
    word = unique("coachword");
    note = (await log(author, "coaches", `Session: ${word} squats went well`)).id;
  });

  it("is read by its author, the coach who looks after the person, admins and notes:clients", async () => {
    for (const reader of [author, carer, admin, manager]) {
      const items = await timelineIds(reader);
      const found = items.find((a) => a.id === note);
      expect(found, reader.name).toMatchObject({
        level: "coaches",
        body: expect.stringContaining(word),
      });
      const one = await invoke("activity.get", { id: note }, as(reader));
      expect(one.body).toContain(word);
    }
  });

  it("is nowhere for a member who does not look after the person, not even by id", async () => {
    expect((await timelineIds(member)).map((a) => a.id)).not.toContain(note);
    expect((await refusal(invoke("activity.get", { id: note }, as(member)))).code).toBe(
      "not_found",
    );
    expect((await refusal(invoke("activity.getBody", { id: note }, as(member)))).code).toBe(
      "not_found",
    );
    expect((await refusal(invoke("note.open", { id: note }, as(member)))).code).toBe("not_found");
    const history = await invoke(
      "audit.listForRecord",
      { object: "activity", recordId: note },
      as(member),
    );
    expect(history.items).toEqual([]);
  });

  it("is in no bulk path, for anyone", async () => {
    for (const reader of [member, admin]) {
      const feed = await invoke("activity.list", { limit: 100 }, as(reader));
      expect(feed.items.map((a) => a.id)).not.toContain(note);
      const search = await invoke("search.global", { query: word }, as(reader));
      expect(search.hits).toEqual([]);
      const sql = await invoke(
        "query.sql",
        { sql: `SELECT id FROM rec_activity WHERE body LIKE '%${word}%' OR id = '${note}'` },
        as(reader),
      );
      expect(sql.rows).toEqual([]);
      const links = await invoke(
        "query.sql",
        { sql: `SELECT activity_id FROM rec_activity_link WHERE activity_id = '${note}'` },
        as(reader),
      );
      expect(links.rows).toEqual([]);
      const csv = await invoke("export.csv", { object: "activity", maxRows: 1000 }, as(reader));
      expect(csv.csv).not.toContain(word);
    }
    const docs = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_search_docs WHERE object_type = 'activity' AND record_id = ?",
    )
      .bind(note)
      .first<{ n: number }>();
    expect(docs?.n).toBe(0);
  });

  it("audits each read with its id and no text", async () => {
    await timelineIds(carer);
    const rows = await auditRows("activity.listForRecord", carer.id);
    expect(rows.length).toBeGreaterThan(0);
    const last = rows.at(-1) as { result: string; actor: string };
    expect(JSON.parse(last.result)).toEqual({ notes: [note] });
    await invoke("activity.get", { id: note }, as(manager));
    const gets = await auditRows("activity.get", manager.id);
    expect(JSON.parse((gets.at(-1) as { result: string }).result)).toEqual({ notes: [note] });
    // A timeline with no such note writes no row: reads by people are not otherwise audited.
    const before = (await auditRows("activity.listForRecord", member.id)).length;
    await timelineIds(member);
    expect((await auditRows("activity.listForRecord", member.id)).length).toBe(before);
    expect(await auditHolding(word)).toBe(0);
  });

  it("stops being read on the next read after the grant, the looks-after or the account goes", async () => {
    const extra = await createUser("member");
    await invoke(
      "user.setPermissions",
      { id: extra.id, permissions: ["notes:clients"] },
      as(admin),
    );
    expect((await timelineIds(extra)).map((a) => a.id)).toContain(note);
    await invoke("user.setPermissions", { id: extra.id, permissions: [] }, as(admin));
    expect((await timelineIds(extra)).map((a) => a.id)).not.toContain(note);

    const coach = await createUser("member");
    const row = await invoke("carer.set", { personId: person, userId: coach.id }, as(admin));
    expect((await timelineIds(coach)).map((a) => a.id)).toContain(note);
    expect(
      (await invoke("carer.list", { personId: person }, as(member))).items.map((c) => c.user.id),
    ).toContain(coach.id);
    await invoke("carer.end", { id: row.id }, as(admin));
    expect((await timelineIds(coach)).map((a) => a.id)).not.toContain(note);
    // Their own note stays theirs after they stop looking after the person.
    const own = (await log(coach, "coaches", "Their own")).id;
    expect((await timelineIds(coach)).map((a) => a.id)).toContain(own);

    const leaver = await createUser("member");
    const theirs = (await log(leaver, "coaches", "Before leaving")).id;
    expect((await timelineIds(leaver)).map((a) => a.id)).toContain(theirs);
    await env.DB.prepare("UPDATE core_user SET deactivated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), leaver.id)
      .run();
    expect((await timelineIds(leaver)).map((a) => a.id)).not.toContain(theirs);
  });
});

describe("a sensitive note", () => {
  let note: string;
  let word: string;

  beforeAll(async () => {
    word = unique("sensitiveword");
    note = (await log(member, "sensitive", `Injury: ${word} left knee`)).id;
  });

  it("is listed locked to its author, admins and notes:sensitive, and opened one at a time", async () => {
    for (const reader of [member, admin, keeper]) {
      const found = (await timelineIds(reader)).find((a) => a.id === note);
      expect(found, reader.name).toMatchObject({
        level: "sensitive",
        locked: true,
        subject: null,
        body: null,
        authorUserId: member.id,
      });
      expect(await invoke("activity.get", { id: note }, as(reader))).toMatchObject({
        locked: true,
        body: null,
      });
      expect((await invoke("activity.getBody", { id: note }, as(reader))).body).toBeNull();
      const opened = await invoke("note.open", { id: note }, as(reader));
      expect(opened.body).toContain(word);
      expect(opened.locked).toBeUndefined();
      const rows = await auditRows("note.open", reader.id);
      expect(JSON.parse((rows.at(-1) as { result: string }).result)).toEqual({ notes: [note] });
    }
    expect(await auditHolding(word)).toBe(0);
  });

  it("is nothing to anyone else: no row, no count, not found by id", async () => {
    for (const reader of [author, carer, manager]) {
      expect((await timelineIds(reader)).map((a) => a.id)).not.toContain(note);
      expect((await refusal(invoke("activity.get", { id: note }, as(reader)))).code).toBe(
        "not_found",
      );
      expect((await refusal(invoke("note.open", { id: note }, as(reader)))).code).toBe("not_found");
    }
    const counted = await invoke("record.count", { object: "activity" }, as(admin));
    const staff = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_activity WHERE deleted_at IS NULL AND private_to IS NULL AND level = 'staff'",
    ).first<{ n: number }>();
    expect(counted.count).toBe(staff?.n);
  });

  it("can be written by any member, who reads no other sensitive note", async () => {
    const mine = (await log(author, "sensitive", "Their circumstance")).id;
    const seen = (await timelineIds(author)).map((a) => a.id);
    expect(seen).toContain(mine);
    expect(seen).not.toContain(note);
    expect((await invoke("note.open", { id: mine }, as(author))).body).toBe("Their circumstance");
  });

  it("stays out of the Trash for those who may not read it", async () => {
    const gone = (await log(member, "sensitive", "To the Trash")).id;
    await invoke("activity.delete", { id: gone }, as(member));
    const theirs = await invoke("trash.list", { object: "activity" }, as(member));
    expect(theirs.items.map((i) => i.id)).toContain(gone);
    const others = await invoke("trash.list", { object: "activity" }, as(author));
    expect(others.items.map((i) => i.id)).not.toContain(gone);
  });
});

describe("AI actors", () => {
  let coaches: string;
  let sensitive: string;
  let staff: string;

  beforeAll(async () => {
    coaches = (await log(admin, "coaches", `AI-hidden ${unique("a")}`)).id;
    sensitive = (await log(admin, "sensitive", `AI-hidden ${unique("b")}`)).id;
    staff = (await log(admin, "staff", "A long staff note ".repeat(60))).id;
  });

  it("read nothing of level 2 and 3 notes, with every grant", async () => {
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      for (const user of [admin, manager, keeper, carer]) {
        const ids = (await timelineIds(user, actor)).map((a) => a.id);
        expect(ids).not.toContain(coaches);
        expect(ids).not.toContain(sensitive);
        for (const id of [coaches, sensitive]) {
          expect((await refusal(invoke("activity.get", { id }, as(user, actor)))).code).toBe(
            "not_found",
          );
        }
        expect((await refusal(invoke("note.open", { id: sensitive }, as(user, actor)))).code).toBe(
          "forbidden",
        );
      }
      const audit = await invoke("audit.list", { limit: 200 }, as(admin, actor));
      const touched = audit.items.flatMap((row) => row.changes.map((c) => c.recordId));
      expect(touched).not.toContain(coaches);
      expect(touched).not.toContain(sensitive);
      expect(audit.items.map((row) => row.operation)).not.toContain("note.open");
    }
  });

  it("never have them in summaries or embeddings", async () => {
    expect(await activitySummaryInput(db.query, coaches)).toBeNull();
    expect(await activitySummaryInput(db.query, sensitive)).toBeNull();
    expect(await activitySummaryInput(db.query, staff)).not.toBeNull();
    const texts = await embeddingTexts(db.query, "activity", [coaches, sensitive, staff]);
    expect([...texts.keys()]).toEqual([staff]);
  });

  it("cannot write one, lower or change a level, delete a note or set who looks after whom", async () => {
    for (const actor of ["assistant", "mcp"] as const) {
      const write = await refusal(
        invoke(
          "activity.log",
          { type: "note", body: "x", level: "coaches", links: [{ object: "person", id: person }] },
          as(admin, actor),
        ),
      );
      expect(write.code).toBe("forbidden");
      const raise = await refusal(
        invoke("activity.update", { id: staff, level: "coaches" }, as(admin, actor)),
      );
      expect(raise.details?.rule).toBe("note_level_person");
      const carerSet = await refusal(
        invoke("carer.set", { personId: person, userId: member.id }, as(admin, actor)),
      );
      expect(carerSet.code).toBe("forbidden");
    }
    // An AI's delete of a note is refused in the handler, so no approval can apply it.
    const del = await refusal(invoke("activity.delete", { id: staff }, as(admin, "assistant")));
    expect(del.details?.rule).toBe("note_delete_person");
  });
});

describe("who changes a note and its level", () => {
  it("the author or notes:manage changes and deletes; others are refused", async () => {
    const note = (await log(author, "staff", "Plain note")).id;
    const other = await refusal(
      invoke("activity.update", { id: note, body: "Changed by another" }, as(member)),
    );
    expect(other.code).toBe("forbidden");
    expect((await refusal(invoke("activity.delete", { id: note }, as(member)))).code).toBe(
      "forbidden",
    );
    await invoke("activity.update", { id: note, body: "Changed by its author" }, as(author));
    await invoke("activity.update", { id: note, body: "Changed by an admin" }, as(admin));
  });

  it("anyone who may change it raises a level; lowering needs notes:manage, a person", async () => {
    const word = unique("raised");
    const note = (await log(author, "staff", `Was staff ${word}`)).id;
    const raised = await invoke("activity.update", { id: note, level: "coaches" }, as(author));
    expect(raised.level).toBe("coaches");
    expect((await timelineIds(member)).map((a) => a.id)).not.toContain(note);
    const search = await invoke("search.global", { query: word }, as(admin));
    expect(search.hits).toEqual([]);
    const lower = await refusal(
      invoke("activity.update", { id: note, level: "staff" }, as(author)),
    );
    expect(lower.details?.rule).toBe("note_level_lower");
    await invoke("activity.update", { id: note, level: "staff" }, as(admin));
    expect((await timelineIds(member)).map((a) => a.id)).toContain(note);
    expect(
      (await invoke("search.global", { query: word }, as(member))).hits.map((h) => h.id),
    ).toEqual([note]);
    // Raised once, its text left the audit log for good (ADR 0019's redaction), lowered or not.
    expect(await auditHolding(word)).toBe(0);
  });

  it("lowering a sensitive note needs notes:sensitive too", async () => {
    const managerOnly = await createUser("member");
    await invoke(
      "user.setPermissions",
      { id: managerOnly.id, permissions: ["notes:manage"] },
      as(admin),
    );
    const note = (await log(managerOnly, "sensitive", "Theirs")).id;
    const refused = await refusal(
      invoke("activity.update", { id: note, level: "coaches" }, as(managerOnly)),
    );
    expect(refused.details?.rule).toBe("note_level_lower");
  });

  it("a kept note is about exactly one Person, and only a note has a level", async () => {
    const two = await refusal(
      log(author, "coaches", "Two people", [
        { object: "person", id: person },
        { object: "person", id: otherPerson },
      ]),
    );
    expect(two.details?.rule).toBe("note_one_person");
    const none = await refusal(
      log(author, "sensitive", "Nobody", [{ object: "organisation", id: "org_none" }]),
    );
    expect(none.details?.rule).toBe("note_one_person");
    const call = await invoke(
      "activity.log",
      { type: "call", subject: "A call", links: [{ object: "person", id: person }] },
      as(author),
    );
    const level = await refusal(
      invoke("activity.update", { id: call.id, level: "coaches" }, as(author)),
    );
    expect(level).toMatchObject({ code: "invalid_input", details: { field: "level" } });
  });
});

describe("the notes permissions", () => {
  it("are restricted: granted by another human admin, never to oneself, audited", async () => {
    const listed = await invoke("user.grantablePermissions", {}, as(admin));
    for (const permission of ["notes:clients", "notes:sensitive", "notes:manage"]) {
      expect(listed.items.find((g) => g.permission === permission)).toMatchObject({
        from: "core",
        restricted: true,
        forFixedRole: false,
      });
    }
    const self = await refusal(
      invoke(
        "user.setPermissions",
        { id: otherAdmin.id, permissions: ["notes:sensitive"] },
        as(otherAdmin),
      ),
    );
    expect(self.details?.rule).toBe("self_grant");
    const ai = await refusal(
      invoke(
        "user.setPermissions",
        { id: member.id, permissions: ["notes:clients"] },
        as(admin, "assistant"),
      ),
    );
    expect(ai.code).toBe("forbidden");
    await invoke(
      "user.setPermissions",
      { id: otherAdmin.id, permissions: ["notes:manage"] },
      as(admin),
    );
    const rows = await auditRows("user.setPermissions", admin.id);
    expect(rows.length).toBeGreaterThan(0);
  });
});

/** What one call ran on D1: each statement's bound variables. */
let ran: number[] = [];
const counted = new Proxy(env.DB, {
  get(target, key) {
    if (key === "prepare") {
      return (query: string) => {
        const statement = target.prepare(query);
        return new Proxy(statement, {
          get(inner, name) {
            if (name === "bind") {
              return (...values: unknown[]) => {
                ran.push(values.length);
                return inner.bind(...values);
              };
            }
            const value = Reflect.get(inner, name);
            if (typeof value === "function") {
              if (name === "all" || name === "first" || name === "run" || name === "raw") {
                ran.push(0);
              }
              return value.bind(inner);
            }
            return value;
          },
        });
      };
    }
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const countedDb = createCrmDb(counted);

describe("the timeline read with the note scope, in a bounded number of statements", () => {
  it("does not grow with the notes on the page", async () => {
    const busy = (await invoke("person.create", { displayName: unique("Busy") }, as(admin))).id;
    await invoke("carer.set", { personId: busy, userId: carer.id }, as(admin));
    const counts: number[][] = [];
    for (const total of [3, 60]) {
      while ((await timelineIds(admin, "human", busy)).length < total) {
        const level = (["staff", "coaches", "sensitive"] as const)[counts.length % 3] ?? "staff";
        await invoke(
          "activity.log",
          { type: "note", body: unique("n"), level, links: [{ object: "person", id: busy }] },
          as(admin),
        );
        await invoke(
          "activity.log",
          {
            type: "note",
            body: unique("n"),
            level: "coaches",
            links: [{ object: "person", id: busy }],
          },
          as(admin),
        );
      }
      ran = [];
      await invoke(
        "activity.listForRecord",
        { object: "person", recordId: busy, limit: 100 },
        { ...as(carer), db: countedDb },
      );
      counts.push(ran);
    }
    const [small, large] = counts as [number[], number[]];
    expect(large.length).toBe(small.length);
    expect(large.length).toBeLessThan(20);
    expect(Math.max(...large)).toBeLessThan(100);
  });
});

// The review of PR #373: each sequence it reproduced, kept as a test.
describe("copies of a kept note's text", () => {
  it("the Trash names a kept note by its type, never its text, even to those who may read it", async () => {
    const word = unique("trashword");
    const sensitive = (await log(member, "sensitive", `${word} torn ACL`)).id;
    const coaches = (await log(member, "coaches", `${word} knee`)).id;
    await invoke("activity.delete", { id: sensitive }, as(member));
    await invoke("activity.delete", { id: coaches }, as(member));
    for (const reader of [keeper, admin, member]) {
      const items = (await invoke("trash.list", { object: "activity", limit: 100 }, as(reader)))
        .items;
      for (const item of items.filter((i) => i.id === sensitive || i.id === coaches)) {
        expect(item.name).toBe("note");
      }
      expect(JSON.stringify(items)).not.toContain(word);
    }
  });

  it("raising a note takes away the cached summaries built from it", async () => {
    const p = (await invoke("person.create", { displayName: unique("Summed") }, as(admin))).id;
    const word = unique("summaryword");
    const note = (await log(author, "staff", `${word} keep quiet`, [{ object: "person", id: p }]))
      .id;
    const facts = await recordSummaryInput(db.query, "person", p);
    expect(facts.sources).toContain(note);
    await db.query.executeQuery(
      (
        await storeSummaryStatement(
          db.query,
          facts,
          "model",
          { text: `Summary: ${word} mentioned`, model: "model" },
          new Date().toISOString(),
          admin.id,
        )
      ).compile(),
    );
    await invoke("activity.update", { id: note, level: "sensitive" }, as(author));
    for (const actor of ["human", "assistant"] as const) {
      const summary = await invoke(
        "summary.get",
        { subject: { kind: "record", object: "person", id: p } },
        as(member, actor),
      );
      expect(summary.text).toBeNull();
    }
  });

  it("raising or lowering a note queues its vector to be dropped or made again", async () => {
    const note = (await log(author, "staff", "Embedded once")).id;
    const queued = async () =>
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM core_embedding_queue WHERE object_type = 'activity' AND record_id = ?",
        )
          .bind(note)
          .first<{ n: number }>()
      )?.n;
    await env.DB.prepare("DELETE FROM core_embedding_queue WHERE record_id = ?").bind(note).run();
    await invoke("activity.update", { id: note, level: "coaches" }, as(author));
    expect(await queued()).toBe(1);
    expect((await embeddingTexts(db.query, "activity", [note])).size).toBe(0);
    await env.DB.prepare("DELETE FROM core_embedding_queue WHERE record_id = ?").bind(note).run();
    await invoke("activity.update", { id: note, level: "staff" }, as(admin));
    expect(await queued()).toBe(1);
    expect((await embeddingTexts(db.query, "activity", [note])).size).toBe(1);
  });

  it("raising a note redacts the text its staff-level history held in the audit log", async () => {
    const word = unique("historyword");
    const note = (await log(author, "staff", `${word} first`)).id;
    await invoke("activity.update", { id: note, body: `${word} second` }, as(author));
    expect(await auditHolding(word)).toBeGreaterThan(0);
    await invoke("activity.update", { id: note, level: "coaches" }, as(author));
    expect(await auditHolding(word)).toBe(0);
    const marks = await env.DB.prepare(
      "SELECT operation FROM core_audit_redactions WHERE record_id = ?",
    )
      .bind(note)
      .all<{ operation: string }>();
    expect(marks.results.length).toBeGreaterThan(0);
    expect(new Set(marks.results.map((m) => m.operation))).toEqual(new Set(["activity.update"]));
  });
});

describe("who looks after whom", () => {
  it("nobody sets themselves with people:link alone", async () => {
    const linker = await createUser("member");
    await invoke("user.setPermissions", { id: linker.id, permissions: ["people:link"] }, as(admin));
    const note = (await log(author, "coaches", "Not theirs")).id;
    const self = await refusal(
      invoke("carer.set", { personId: person, userId: linker.id }, as(linker)),
    );
    expect(self.details?.rule).toBe("carer_self");
    expect((await refusal(invoke("activity.get", { id: note }, as(linker)))).code).toBe(
      "not_found",
    );
    // Setting someone else is what the permission is for.
    const other = await createUser("member");
    await invoke("carer.set", { personId: person, userId: other.id }, as(linker));
  });

  it("a coach reads nothing of a Person in the Trash", async () => {
    const p = (await invoke("person.create", { displayName: unique("Trashed") }, as(admin))).id;
    const coach = await createUser("member");
    await invoke("carer.set", { personId: p, userId: coach.id }, as(admin));
    const note = (await log(author, "coaches", "About someone", [{ object: "person", id: p }])).id;
    expect((await invoke("activity.get", { id: note }, as(coach))).id).toBe(note);
    await invoke("person.delete", { id: p }, as(admin));
    expect((await refusal(invoke("activity.get", { id: note }, as(coach)))).code).toBe("not_found");
  });
});

describe("a note's level changed meanwhile", () => {
  it("fails a change planned from the old level whole", async () => {
    const note = (await log(author, "coaches", "Racing")).id;
    // The author's edit reads the note at `coaches`; an admin raises it before the edit commits.
    const racing = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await target
              .prepare("UPDATE core_activity SET level = 'sensitive' WHERE id = ?")
              .bind(note)
              .run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const stale = await refusal(
      invoke(
        "activity.update",
        { id: note, body: "Edited from the old read" },
        { ...as(author), db: createCrmDb(racing) },
      ),
    );
    expect(stale.details?.rule).toBe("note_changed");
    const row = await env.DB.prepare("SELECT level, body FROM core_activity WHERE id = ?")
      .bind(note)
      .first<{ level: string; body: string }>();
    expect(row).toEqual({ level: "sensitive", body: "Racing" });
  });
});
