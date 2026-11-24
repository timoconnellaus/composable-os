// Stage 36 step 1 (ADR 0740, acceptance criterion 15): what the inbox's reads cost. The inbox's
// list and a conversation's read are each a fixed number of statements however many conversations
// and messages there are, and an erase of a Person with a long history of conversations stays a
// handful of statements, each binding one list (D1: 1,000 statements per invocation, 100 bound
// variables per statement; the local runtime enforces neither).
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { newConversationStatement } from "../src/inbox/index.ts";
import { type ActingUser, invoke } from "../src/index.ts";
import { createPerson } from "./fixtures.ts";
import { context, createUser, db } from "./helpers.ts";

let statements = 0;
let maxBound = 0;
let rowsRead = 0;

/** env.DB, counting every statement prepared (reads, and each statement of a batch). */
const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        statements += 1;
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") {
                return (...args: unknown[]) => {
                  maxBound = Math.max(maxBound, args.length);
                  return wrap(s.bind(...args));
                };
              }
              if (p === "all" || p === "run" || p === "first" || p === "raw") {
                return async (...args: unknown[]) => {
                  const result = await (s[p] as (...a: unknown[]) => Promise<unknown>)(...args);
                  const meta = (result as { meta?: { rows_read?: number } } | null)?.meta;
                  rowsRead += meta?.rows_read ?? 0;
                  return result;
                };
              }
              const value = Reflect.get(s, p);
              return typeof value === "function" ? value.bind(s) : value;
            },
          });
        return wrap(target.prepare(query));
      };
    }
    if (prop === "batch") {
      // Hand D1 its own statements: the proxies above only count.
      return (batch: D1PreparedStatement[]) => target.batch(batch);
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const meteredDb = createCrmDb(metered);

let admin: ActingUser;
let member: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
});

/** `count` conversations with the Person, each with `messages` inbound emails, written in SQL. */
async function seed(personId: string, count: number, messages: number) {
  const ids: string[] = [];
  const now = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    const created = await newConversationStatement(db.query, {
      channel: "email",
      personId,
      subject: `Question ${i}`,
      now,
    });
    await db.batch([created.statement]);
    ids.push(created.id);
  }
  for (const id of ids) {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO core_activity (id, type, subject, body, payload, occurred_at, author_actor,
         created_at, updated_at, conversation_id)
       SELECT 'act_' || ? || '_' || i, 'email', 'Re', 'Message ' || i, '{"direction":"inbound"}',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || i || ' minutes'), 'system', ?, ?, ?
       FROM n`,
    )
      .bind(messages, id, now, now, id)
      .run();
    await env.DB.prepare(
      `INSERT INTO core_activity_links (activity_id, object_type, record_id)
       SELECT id, 'person', ? FROM core_activity WHERE conversation_id = ?`,
    )
      .bind(personId, id)
      .run();
  }
  return ids;
}

async function cost<T>(run: () => Promise<T>): Promise<{ statements: number; result: T }> {
  statements = 0;
  const result = await run();
  return { statements, result };
}

describe("the inbox's cost", () => {
  it("lists the inbox in the same statements for 2 conversations as for 60", async () => {
    const few = await createPerson(member);
    const many = await createPerson(member);
    await seed(few.id, 2, 1);
    await seed(many.id, 60, 1);
    const list = (personId: string) =>
      cost(() =>
        invoke("inbox.list", { personId, limit: 100 }, { ...context(member), db: meteredDb }),
      );
    const small = await list(few.id);
    const large = await list(many.id);
    expect(small.result.items).toHaveLength(2);
    expect(large.result.items).toHaveLength(60);
    expect(large.statements).toBe(small.statements);
    expect(small.statements).toBeGreaterThan(0);
    expect(large.statements).toBeLessThanOrEqual(6);
  });

  it("a page of the inbox walks its sort index: 300 open conversations cost what 20 do", async () => {
    // Review of PR #381, finding 5: the list sorted every open conversation in a temporary
    // B-tree; it now reads the page's rows from the sort index and stops.
    const page = async () => {
      rowsRead = 0;
      const out = await invoke(
        "inbox.list",
        { view: "unassigned", limit: 10 },
        { ...context(member), db: meteredDb },
      );
      return { rows: rowsRead, items: out.items.length };
    };
    const people = await Promise.all([1, 2, 3].map(() => createPerson(member)));
    await seed(people[0]?.id as string, 20, 1);
    const small = await page();
    for (const p of people.slice(1)) await seed(p.id, 140, 1);
    const large = await page();
    expect(small.items).toBe(10);
    expect(large.items).toBe(10);
    expect(large.rows - small.rows).toBeLessThan(40);
  });

  it("reads a conversation in the same statements for 1 message as for 400", async () => {
    const person = await createPerson(member);
    const [short, long] = await seed(person.id, 2, 1).then(async ([a]) => [
      a as string,
      ...(await seed(person.id, 1, 400)),
    ]);
    const get = (id: string) =>
      cost(() => invoke("conversation.get", { id }, { ...context(member), db: meteredDb }));
    const small = await get(short as string);
    const large = await get(long as string);
    expect(small.result.messages).toHaveLength(1);
    expect(large.result.messages).toHaveLength(100);
    expect(large.result.earlierCursor).not.toBeNull();
    expect(large.statements).toBe(small.statements);
    expect(small.statements).toBeGreaterThan(0);
    expect(large.statements).toBeLessThanOrEqual(8);
  });

  it("erases a Person with 1,200 messages in a bounded batch", async () => {
    const person = await createPerson(member);
    const ids = await seed(person.id, 12, 100);
    maxBound = 0;
    const erase = await cost(() =>
      invoke("person.erase", { id: person.id }, { ...context(admin), db: meteredDb }),
    );
    expect(erase.statements).toBeGreaterThan(0);
    expect(erase.statements).toBeLessThan(200);
    expect(maxBound).toBeLessThanOrEqual(100);
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_activity WHERE conversation_id IN (SELECT value FROM json_each(?))",
    )
      .bind(JSON.stringify(ids))
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
