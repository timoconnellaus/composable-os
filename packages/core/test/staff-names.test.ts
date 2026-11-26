// Staff read names (stage 38 step 6, ADR 0708): what the host gives with a published record for a
// `staffNames` field (the related record's id, title and declared order), and that it holds the
// contract's rule again when it reads. The fixture is reconciled without the contract check (as
// a registry holding a manifest from before the rule would be), so a target with row rules of its
// own (publishable, a customer) and one whose title is not plain text reach the read: none of
// them is given a name. The contract refuses them at install (packages/sdk/test/staff-names.test.ts,
// apps/runner/test/knowledge.test.ts).
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser } from "./helpers.ts";

const EXT = extId("sn");
const PAGE = `${EXT}.page`;

const m = manifest(EXT, {
  objects: {
    page: {
      label: "Page",
      plural: "Pages",
      titleField: "title",
      fields: {
        title: { type: "text", label: "Title", required: true },
        chapter: { type: "relation", label: "Chapter", to: `${EXT}.chapter` },
        draft: { type: "relation", label: "Draft chapter", to: `${EXT}.versioned` },
        owned: { type: "relation", label: "Owned", to: `${EXT}.owned` },
        mail: { type: "relation", label: "Mailbox", to: `${EXT}.mailbox` },
      },
      publishable: {
        content: ["title", "chapter", "draft", "owned", "mail"],
        staffRead: true,
        staffNames: [{ field: "chapter", order: "order" }, "draft", "owned", "mail"],
      },
    },
    chapter: {
      label: "Chapter",
      plural: "Chapters",
      titleField: "name",
      fields: { name: { type: "text", label: "Name" }, order: { type: "number", label: "Order" } },
    },
    versioned: {
      label: "Versioned",
      plural: "Versioned",
      titleField: "name",
      fields: { name: { type: "text", label: "Name" } },
      publishable: { content: ["name"] },
    },
    owned: {
      label: "Owned",
      plural: "Owned",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        who: { type: "relation", label: "Who", to: "person" },
      },
      customer: { field: "who", read: ["name"], write: [] },
    },
    mailbox: {
      label: "Mailbox",
      plural: "Mailboxes",
      titleField: "address",
      fields: { address: { type: "email", label: "Address" } },
    },
  },
});

let admin: ActingUser;

const create = async (object: string, values: Record<string, unknown>) =>
  ((await invoke("record.create", { object, values }, context(admin))) as { id: string }).id;

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(m);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', ?, 'c1', ?, ?, ?, ?)",
  )
    .bind(EXT, m.version, JSON.stringify(m), admin.id, now, now)
    .run();
});

describe("staffNames as the host reads them (ADR 0708)", () => {
  it("gives a plain target's id, title and order, and nothing for a target the rule refuses", async () => {
    const chapter = await create(`${EXT}.chapter`, { name: "Safety", order: 2 });
    const draft = await create(`${EXT}.versioned`, { name: "Unpublished chapter" });
    const owned = await create(`${EXT}.owned`, { name: "A customer's own" });
    const mail = await create(`${EXT}.mailbox`, { address: "someone@example.com" });
    const page = await create(PAGE, { title: "Spills", chapter, draft, owned, mail });
    await invoke("record.publish", { object: PAGE, id: page }, context(admin));
    const read = (await invoke("content.staffGet", { object: PAGE, id: page }, context(admin))) as {
      names?: Record<string, unknown>;
    };
    expect(read.names).toEqual({ chapter: { id: chapter, title: "Safety", order: 2 } });
    const list = (await invoke("content.staffList", { object: PAGE }, context(admin))) as {
      items: { id: string; names?: Record<string, unknown> }[];
    };
    expect(list.items.find((i) => i.id === page)?.names).toEqual(read.names);
  });
});
