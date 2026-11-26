// Stage 56 step 3 (ADR 0834): record files, a note's photos and PDFs. Criteria 9 (types from the
// bytes, size limits, a real GPS photo kept without its location), 10 (served only to a caller who
// may read the note now: the one not-found otherwise, the Trash, audited serves at levels 2 and 3),
// 11 (never in the media library), 16's Trash purge, 17 (no file name or bytes in the audit), 20
// (bounded statements), and the step's own rules: an upload waits for its note and is purged if
// none takes it, the limits are held before and after the bytes arrive, the cap, erase. Against a
// real local R2 bucket.
import { env } from "cloudflare:workers";
import { RECORD_FILES_PER_NOTE } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { packRoleReaches } from "../src/pack-roles.ts";
import {
  type ActingUser,
  type Actor,
  coreInvoker,
  coreOperations,
  drainAllBlobDeletions,
  FILES_PREFIX,
  handleFiles,
  invoke,
  type MediaStore,
  purgeRecordFiles,
} from "../src/index.ts";
import { outside, PUBLIC } from "./customer-fixtures.ts";
import { GPS_JPEG, GPS_PNG, GPS_WEBP } from "./fixtures/record-files/photos.ts";
import { context, createUser, db, refusal, unique } from "./helpers.ts";
import { meterStatements } from "./statement-meter.ts";

const bucket = (env as unknown as { MEDIA_TEST: R2Bucket }).MEDIA_TEST;
const store: MediaStore = {
  put: async (key, bytes, type) => {
    await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
  },
  get: async (key) => {
    const object = await bucket.get(key);
    return object ? { body: object.body, size: object.size } : null;
  },
  delete: async (keys) => {
    await bucket.delete(keys);
  },
};
const blobs = {
  get: async () => null,
  put: async () => {},
  delete: (keys: string[]) => store.delete(keys),
};

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const text = (s: string) => new TextEncoder().encode(s);
const jpeg = () => fromBase64(GPS_JPEG);
const png = () => fromBase64(GPS_PNG);
const webp = () => fromBase64(GPS_WEBP);
const pdf = () => text("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF\n");

/** Whether `needle` appears anywhere in `bytes`. */
function holds(bytes: Uint8Array, needle: string): boolean {
  const n = text(needle);
  outer: for (let i = 0; i + n.length <= bytes.length; i++) {
    for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

let admin: ActingUser;
let author: ActingUser;
let carer: ActingUser;
let member: ActingUser;
let keeper: ActingUser;
let person: string;
let photoKind: string;
let photoKindName: string;

const as = (user: ActingUser, actor: Actor = "human", extra: Record<string, unknown> = {}) =>
  context(user, {
    ...(actor === "human"
      ? {}
      : { actor, origin: { surface: actor === "mcp" ? "mcp" : "assistant" } }),
    media: store,
    ...extra,
  } as never);

async function upload(
  user: ActingUser,
  bytes: Uint8Array,
  options: { name?: string; note?: string; actor?: Actor } = {},
) {
  return invoke(
    "file.upload",
    { name: options.name ?? "photo.jpg", ...(options.note ? { note: options.note } : {}) },
    as(user, options.actor, { upload: { bytes } }),
  );
}

/** A note of the photo kind about `person`, with these files uploaded by its author first. */
async function noteWith(
  user: ActingUser,
  level: "staff" | "coaches" | "sensitive",
  files: Uint8Array[] = [jpeg()],
  about = person,
) {
  const ids: string[] = [];
  for (const bytes of files) ids.push((await upload(user, bytes)).id);
  const note = await invoke(
    "activity.log",
    {
      type: "note",
      kindId: photoKind,
      level,
      links: [{ object: "person", id: about }],
      files: ids,
    },
    as(user),
  );
  return { note: note.id, files: ids, activity: note };
}

async function serve(user: ActingUser, id: string, actor: Actor = "human") {
  return invoke("file.serve", { id }, as(user, actor));
}

beforeAll(async () => {
  admin = await createUser("admin");
  author = await createUser("member");
  carer = await createUser("member");
  member = await createUser("member");
  keeper = await createUser("member");
  await invoke(
    "user.setPermissions",
    { id: keeper.id, permissions: ["notes:sensitive"] },
    as(admin),
  );
  person = (await invoke("person.create", { displayName: unique("Member") }, as(admin))).id;
  await invoke("carer.set", { personId: person, userId: carer.id }, as(admin));
  photoKindName = unique("Photos");
  photoKind = (
    await invoke(
      "note.kinds.save",
      { name: photoKindName, lowestLevel: "staff", filesAllowed: true },
      as(admin),
    )
  ).id;
});

describe("what a file may be (criterion 9)", () => {
  it("is a JPEG, PNG or WebP picture or a PDF, typed from its bytes, whatever its name", async () => {
    for (const [bytes, type] of [
      [jpeg(), "image/jpeg"],
      [png(), "image/png"],
      [webp(), "image/webp"],
      [pdf(), "application/pdf"],
    ] as const) {
      const stored = await upload(author, bytes, { name: "anything.txt" });
      expect(stored.type).toBe(type);
    }
  });

  it("refuses SVG, HTML named .jpg, HEIC, GIF, an empty file and a broken picture", async () => {
    const heic = new Uint8Array([
      0, 0, 0, 0x18, ...text("ftypheic"), 0, 0, 0, 0, ...text("mif1heic"), 0, 0, 0, 0,
    ]);
    for (const [what, bytes, reason] of [
      [
        "an SVG",
        text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        "type",
      ],
      ["HTML renamed .jpg", text("<!doctype html><script>alert(document.cookie)</script>"), "type"],
      ["a HEIC photo", heic, "type"],
      ["a GIF", text("GIF89a\x01\x00\x01\x00\x00\x00\x00;"), "type"],
      ["an empty file", new Uint8Array(), "empty"],
      ["a JPEG header and nothing of a picture", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]), "type"],
      ["a PDF header with no end", text("%PDF-1.4\n<script>"), "type"],
    ] as const) {
      const refused = await refusal(upload(author, bytes, { name: "photo.jpg" }));
      expect(refused, what).toMatchObject({ code: "invalid_input", details: { reason } });
    }
  });

  it("refuses a picture over 10 MB and a PDF over 20 MB", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(jpeg().subarray(0, 4));
    expect(await refusal(upload(author, big))).toMatchObject({
      details: { reason: "too_large" },
    });
    const bigPdf = new Uint8Array(20 * 1024 * 1024 + 1);
    bigPdf.set(text("%PDF-1.4\n"));
    expect(await refusal(upload(author, bigPdf))).toMatchObject({
      details: { reason: "too_large" },
    });
  });

  it("keeps a real phone photo without its location, camera, XMP and comment", async () => {
    const original = jpeg();
    // The fixture is what a phone writes: GPS, make and model, XMP and a comment.
    for (const needle of ["PhoneMakerCo", "PocketCam", "GPSLatitude", "Taken at 12 Example St"]) {
      expect(holds(original, needle), needle).toBe(true);
    }
    const stored = await upload(author, original);
    const object = await bucket.get(`${FILES_PREFIX}${stored.id}`);
    const kept = new Uint8Array(await (object as R2ObjectBody).arrayBuffer());
    for (const needle of [
      "PhoneMakerCo",
      "PocketCam",
      "GPSLatitude",
      "Taken at 12 Example St",
      "2026:11:20",
      "http://ns.adobe.com",
    ]) {
      expect(holds(kept, needle), needle).toBe(false);
    }
    // The GPS IFD pointer (tag 0x8825) is gone; the orientation stays, alone, so it stands up.
    expect(holds(kept, "\x88\x25")).toBe(false);
    expect(holds(kept, "Exif\0\0")).toBe(true);
    expect(kept.byteLength).toBeLessThan(original.byteLength);
    expect(stored).toMatchObject({ width: 48, height: 32, bytes: kept.byteLength });
    // The image itself is byte for byte the same: its scan is copied, never encoded again.
    const scan = (b: Uint8Array) => {
      const at = b.findIndex((v, i) => v === 0xff && b[i + 1] === 0xda);
      return Array.from(b.subarray(at));
    };
    expect(scan(kept)).toEqual(scan(original));
  });

  it("keeps a PNG and a WebP without their EXIF, text and XMP", async () => {
    for (const bytes of [png(), webp()]) {
      expect(holds(bytes, "PhoneMakerCo")).toBe(true);
      const stored = await upload(author, bytes);
      const object = await bucket.get(`${FILES_PREFIX}${stored.id}`);
      const kept = new Uint8Array(await (object as R2ObjectBody).arrayBuffer());
      for (const needle of ["PhoneMakerCo", "Example St", "GPSLatitude", "eXIf", "EXIF"]) {
        expect(holds(kept, needle), `${stored.type} ${needle}`).toBe(false);
      }
      expect(stored).toMatchObject({ width: 48, height: 32 });
    }
  });

  it("stores a PDF as it was sent", async () => {
    const bytes = pdf();
    const stored = await upload(author, bytes);
    const object = await bucket.get(`${FILES_PREFIX}${stored.id}`);
    expect(new Uint8Array(await (object as R2ObjectBody).arrayBuffer())).toEqual(bytes);
  });
});

describe("an upload waits for its note", () => {
  it("is served to no one, its uploader included, until a note takes it", async () => {
    const staged = await upload(author, jpeg());
    expect(staged.note).toBeNull();
    for (const user of [author, admin]) {
      expect((await refusal(serve(user, staged.id))).code).toBe("not_found");
    }
    const note = await invoke(
      "activity.log",
      {
        type: "note",
        kindId: photoKind,
        links: [{ object: "person", id: person }],
        files: [staged.id],
      },
      as(author),
    );
    // A note may be its files alone.
    expect(note.body).toBeNull();
    expect(note.files?.map((f) => f.id)).toEqual([staged.id]);
    expect(await serve(member, staged.id)).toMatchObject({ type: "image/jpeg" });
  });

  it("is attached only by its uploader, once, within the day", async () => {
    const staged = await upload(author, jpeg());
    const attach = (user: ActingUser) =>
      invoke(
        "activity.log",
        {
          type: "note",
          kindId: photoKind,
          links: [{ object: "person", id: person }],
          files: [staged.id],
        },
        as(user),
      );
    expect(await refusal(attach(member))).toMatchObject({ details: { rule: "file_not_found" } });
    await attach(author);
    expect(await refusal(attach(author))).toMatchObject({ details: { rule: "file_not_found" } });
  });

  it("is refused on a kind that takes no files, and from an AI", async () => {
    const staged = await upload(author, jpeg());
    expect(
      await refusal(
        invoke(
          "activity.log",
          { type: "note", body: "x", links: [{ object: "person", id: person }], files: [staged.id] },
          as(author),
        ),
      ),
    ).toMatchObject({ details: { rule: "kind_no_files" } });
    for (const actor of ["assistant", "mcp"] as const) {
      expect((await refusal(upload(author, jpeg(), { actor }))).code, actor).toBe("forbidden");
      const ai = await refusal(
        invoke(
          "activity.log",
          {
            type: "note",
            kindId: photoKind,
            body: "x",
            links: [{ object: "person", id: person }],
            files: [staged.id],
          },
          as(author, actor),
        ),
      );
      expect(ai.details?.rule, actor).toBe("file_person");
    }
    // Only a person decides a kind takes files.
    const kind = await invoke("note.kinds.save", { name: unique("NoFiles") }, as(admin));
    for (const actor of ["assistant", "mcp"] as const) {
      for (const input of [
        { id: photoKind, name: photoKindName, filesAllowed: false },
        { id: kind.id, name: kind.name, filesAllowed: true },
      ]) {
        const refused = await refusal(invoke("note.kinds.save", input, as(admin, actor)));
        expect(refused.details?.rule, actor).toBe("note_kind_files_person");
      }
    }
  });

  it("is purged a day later if no note took it, its R2 object with it", async () => {
    const staged = await upload(author, jpeg());
    const key = `${FILES_PREFIX}${staged.id}`;
    expect(await bucket.head(key)).not.toBeNull();
    await purgeRecordFiles(db.query, new Date());
    expect(await env.DB.prepare("SELECT id FROM core_record_file WHERE id = ?").bind(staged.id).first()).not.toBeNull();
    await purgeRecordFiles(db.query, new Date(Date.now() + 25 * 3_600_000));
    expect(
      await env.DB.prepare("SELECT id FROM core_record_file WHERE id = ?").bind(staged.id).first(),
    ).toBeNull();
    await drainAllBlobDeletions(db.query, blobs);
    expect(await bucket.head(key)).toBeNull();
  });

  it("is never stored when its row does not commit", async () => {
    const before = await bucket.list({ prefix: FILES_PREFIX });
    // The storage cap is held at commit: a row of a file a moment before took the room.
    await env.DB.prepare(
      "INSERT INTO core_settings (key, value, updated_at) VALUES ('record_files', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
      .bind(JSON.stringify({ capBytes: 1024 * 1024 * 1024 }), new Date().toISOString())
      .run();
    const filler = `fil_${unique("filler")}`;
    try {
      await env.DB.prepare(
        "INSERT INTO core_record_file (id, key, name, type, bytes, sha256, uploaded_by, created_at) VALUES (?, ?, 'x', 'application/pdf', ?, ?, ?, ?)",
      )
        .bind(filler, `files/${filler}`, 1024 * 1024 * 1024 - 100, "0".repeat(64), admin.id, new Date().toISOString())
        .run();
      expect(await refusal(upload(author, jpeg()))).toMatchObject({
        details: { reason: "storage_full" },
      });
      const after = await bucket.list({ prefix: FILES_PREFIX });
      expect(after.objects.length).toBe(before.objects.length);
    } finally {
      await env.DB.prepare("DELETE FROM core_record_file WHERE id = ?").bind(filler).run();
      await env.DB.prepare("DELETE FROM core_settings WHERE key = 'record_files'").run();
    }
  });
});

describe("limits", () => {
  it("a note has at most 20 files, held before and after the bytes arrive", async () => {
    const { note } = await noteWith(author, "staff", [pdf()]);
    for (let i = 1; i < RECORD_FILES_PER_NOTE; i++) await upload(author, pdf(), { note });
    // Before the bytes: the route asks file.checkUpload with the size it was told.
    expect(
      await refusal(invoke("file.checkUpload", { note, bytes: 10 }, as(author))),
    ).toMatchObject({ details: { reason: "too_many" } });
    // After: file.upload asks again.
    expect(await refusal(upload(author, pdf(), { note }))).toMatchObject({
      details: { reason: "too_many" },
    });
  });

  it("only the note's author, or someone who manages notes, adds a file to it", async () => {
    const { note } = await noteWith(author, "staff");
    expect((await refusal(upload(member, jpeg(), { note }))).code).toBe("forbidden");
    expect(await upload(admin, jpeg(), { note })).toMatchObject({ note });
  });

  it("an account holds at most 20 uploads waiting for their note", async () => {
    const user = await createUser("member");
    for (let i = 0; i < 20; i++) await upload(user, pdf());
    expect(await refusal(upload(user, pdf()))).toMatchObject({ details: { reason: "too_many" } });
  });

  it("the storage cap refuses an upload past it, and tells admins as it fills", async () => {
    await invoke("file.storage.setCap", { capBytes: 1024 * 1024 * 1024 }, as(admin));
    expect((await refusal(invoke("file.storage.setCap", { capBytes: 2 ** 31 }, as(member)))).code).toBe("forbidden");
    const usage = await invoke("file.storage.get", {}, as(admin));
    expect(usage.capBytes).toBe(1024 * 1024 * 1024);
    const filler = `fil_${unique("filler")}`;
    try {
      // Room for the PDF below (under 100 bytes) and not for the photo (over 1,000).
      const fill = 1024 * 1024 * 1024 - usage.usedBytes - 1000;
      await env.DB.prepare(
        "INSERT INTO core_record_file (id, key, name, type, bytes, sha256, uploaded_by, created_at) VALUES (?, ?, 'x', 'application/pdf', ?, ?, ?, ?)",
      )
        .bind(filler, `files/${filler}`, fill, "0".repeat(64), admin.id, new Date().toISOString())
        .run();
      // Nine tenths full: the upload goes, and every admin is told, naming no file or client.
      await upload(author, pdf());
      const notice = await env.DB.prepare(
        "SELECT title, body FROM core_notifications WHERE user_id = ? AND dedupe_key LIKE 'files.storage:%'",
      )
        .bind(admin.id)
        .first<{ title: string; body: string }>();
      expect(notice?.title).toBe("File storage is nearly full");
      // Past it: refused before the bytes are read and after.
      expect(
        await refusal(invoke("file.checkUpload", { bytes: 5000 }, as(author))),
      ).toMatchObject({ details: { reason: "storage_full" } });
      expect(await refusal(upload(author, jpeg()))).toMatchObject({
        details: { reason: "storage_full" },
      });
    } finally {
      await env.DB.prepare("DELETE FROM core_record_file WHERE id = ?").bind(filler).run();
      await env.DB.prepare("DELETE FROM core_settings WHERE key = 'record_files'").run();
    }
  });
});

describe("who is served a file (criterion 10)", () => {
  it("a staff note's file: every staff account, a person only", async () => {
    const { files } = await noteWith(author, "staff");
    const id = files[0] as string;
    for (const user of [author, member, admin]) {
      expect(await serve(user, id), user.name).toMatchObject({ id, type: "image/jpeg" });
    }
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      expect((await refusal(serve(admin, id, actor))).code, actor).toBe("forbidden");
    }
  });

  it("a coaches note's file: its author, the carer and admins, each serve audited by id", async () => {
    const { note, files } = await noteWith(author, "coaches", [jpeg()]);
    const id = files[0] as string;
    for (const user of [author, carer, admin]) {
      await serve(user, id);
      const row = await env.DB.prepare(
        "SELECT result FROM core_audit WHERE operation = 'file.serve' AND user_id = ? ORDER BY at DESC LIMIT 1",
      )
        .bind(user.id)
        .first<{ result: string }>();
      expect(JSON.parse(row?.result ?? "null"), user.name).toEqual({ files: [id], notes: [note] });
    }
    expect((await refusal(serve(member, id))).code).toBe("not_found");
    // Looking after them ended: on the next serve, nothing.
    const other = await createUser("member");
    const p = (await invoke("person.create", { displayName: unique("P") }, as(admin))).id;
    const looks = await invoke("carer.set", { personId: p, userId: other.id }, as(admin));
    const theirs = await noteWith(author, "coaches", [jpeg()], p);
    const fid = theirs.files[0] as string;
    expect(await serve(other, fid)).toMatchObject({ id: fid });
    await invoke("carer.end", { id: looks.id }, as(admin));
    expect((await refusal(serve(other, fid))).code).toBe("not_found");
  });

  it("a sensitive note's file: its author, admins and notes:sensitive; listed only once opened", async () => {
    const { note, files } = await noteWith(author, "sensitive", [pdf()]);
    const id = files[0] as string;
    for (const user of [author, admin, keeper]) expect(await serve(user, id)).toMatchObject({ id });
    for (const user of [carer, member]) expect((await refusal(serve(user, id))).code).toBe("not_found");
    const listed = await invoke(
      "activity.listForRecord",
      { object: "person", recordId: person, limit: 100 },
      as(keeper),
    );
    const row = listed.items.find((a) => a.id === note);
    expect(row).toMatchObject({ locked: true });
    expect(row?.files).toBeUndefined();
    const opened = await invoke("note.open", { id: note }, as(keeper));
    expect(opened.files?.map((f) => f.id)).toEqual([id]);
  });

  it("a note in the Trash serves no file; restored, it does again", async () => {
    const { note, files } = await noteWith(author, "staff");
    const id = files[0] as string;
    await invoke("activity.delete", { id: note }, as(author));
    expect((await refusal(serve(author, id))).code).toBe("not_found");
    await invoke("activity.restore", { id: note }, as(author));
    expect(await serve(author, id)).toMatchObject({ id });
  });

  it("is no customer's, no public caller's, and no pack role's", async () => {
    const { files } = await noteWith(author, "staff");
    const id = files[0] as string;
    const customer = outside({ kind: "customer", customerId: "cus_x", personId: person });
    for (const ctx of [customer, outside(PUBLIC)]) {
      // Closed to them: the operation does not exist for them (ADR 0402), whatever the id.
      expect((await refusal(invoke("file.serve", { id }, ctx as never))).code).toBe(
        "unknown_operation",
      );
    }
    // No pack role reaches a file operation, whatever it may read (step 4 opens the coach's).
    const role = {
      name: "x.coach",
      extension: "x",
      label: "Coach",
      permissions: ["x:coach"],
      read: ["x.class"],
    };
    for (const op of coreOperations.filter((o) => o.name.startsWith("file."))) {
      expect(packRoleReaches(role, op), op.name).toBe(false);
    }
  });

  it("every file operation is staff only, a person's, and not on MCP", () => {
    const ops = coreOperations.filter((o) => o.name.startsWith("file."));
    expect(ops.map((o) => o.name).sort()).toEqual([
      "file.checkUpload",
      "file.delete",
      "file.serve",
      "file.storage.get",
      "file.storage.setCap",
      "file.upload",
    ]);
    for (const op of ops) {
      expect(op.audiences ?? ["staff"], op.name).toEqual(["staff"]);
      expect(op.actors, op.name).toEqual(["human"]);
      expect(op.mcp?.expose, op.name).toBe(false);
    }
  });
});

describe("the file route", () => {
  const route = (user: ActingUser | null, path: string, init: RequestInit = {}) =>
    handleFiles(new Request(`https://host.test${path}`, init), {
      invoker: coreInvoker,
      context: async () => (user ? as(user) : outside(PUBLIC)) as never,
      store,
    });

  it("serves a picture inline and a PDF as a download, so neither can run as a page", async () => {
    const { files } = await noteWith(author, "staff", [jpeg(), pdf()]);
    const picture = await route(author, `/api/files/${files[0]}`);
    expect(picture.status).toBe(200);
    expect(Object.fromEntries(picture.headers)).toMatchObject({
      "content-type": "image/jpeg",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
      "cross-origin-resource-policy": "same-origin",
    });
    expect(picture.headers.get("content-disposition")).toMatch(/^inline; filename="photo\.jpg"/);
    const doc = await route(author, `/api/v1/files/${files[1]}`);
    expect(doc.headers.get("content-type")).toBe("application/pdf");
    expect(doc.headers.get("content-disposition")).toMatch(/^attachment; filename="photo\.jpg\.pdf"/);
    await doc.arrayBuffer();
    await picture.arrayBuffer();
  });

  it("answers one not-found for no file, not yours, signed out and a bad id", async () => {
    const { files } = await noteWith(author, "sensitive");
    const answers = await Promise.all([
      route(member, `/api/files/${files[0]}`),
      route(member, "/api/files/fil_nosuchfile"),
      route(null, `/api/files/${files[0]}`),
      route(author, "/api/files/../../media/x"),
      route(author, `/api/files/${files[0]}`, { method: "DELETE" }),
      route(author, "/api/v1/files", { method: "POST", body: jpeg() }),
    ]);
    const seen = await Promise.all(
      answers.map(async (r) => ({ status: r.status, body: await r.text(), csp: r.headers.get("cache-control") })),
    );
    for (const answer of seen) expect(answer).toEqual(seen[0]);
    expect(seen[0]?.status).toBe(404);
  });

  it("uploads from the admin only, refusing a declared size or a note before reading the body", async () => {
    let read = false;
    // Pulled only when someone reads it.
    const body = () =>
      new ReadableStream(
        {
          pull(controller) {
            read = true;
            controller.enqueue(jpeg());
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
    const post = (query: string, headers: Record<string, string>) =>
      route(author, `/api/files?${query}`, {
        method: "POST",
        headers,
        body: body(),
        duplex: "half",
      } as RequestInit);
    expect((await post("name=a.jpg", { origin: "https://evil.test" })).status).toBe(403);
    expect((await post("name=a.jpg", { "content-length": String(21 * 1024 * 1024) })).status).toBe(413);
    const { note } = await noteWith(admin, "staff");
    expect((await post(`name=a.jpg&note=${note}`, { "content-length": "100" })).status).toBe(403);
    expect(read).toBe(false);
    const ok = await route(author, "/api/files?name=a.jpg", { method: "POST", body: jpeg() });
    expect(ok.status).toBe(200);
    const { data } = (await ok.json()) as { data: { id: string; note: null } };
    expect(data).toMatchObject({ note: null, type: "image/jpeg" });
  });
});

describe("never the media library (criterion 11)", () => {
  it("is not listed by media.list nor found by media.findByHash", async () => {
    const { files } = await noteWith(author, "staff");
    const listed = await invoke("media.list", { limit: 200 }, as(admin));
    expect(listed.items.map((i) => i.id)).not.toContain(files[0]);
    const row = await env.DB.prepare("SELECT sha256 FROM core_record_file WHERE id = ?")
      .bind(files[0])
      .first<{ sha256: string }>();
    const found = await invoke("media.findByHash", { sha256: [row?.sha256 ?? ""] }, as(admin));
    expect(found.items).toEqual([]);
  });
});

describe("the audit log (criterion 17)", () => {
  it("holds a file's id, type and size, never its name or bytes", async () => {
    const name = `${unique("Clearance-Ada-Lovelace")}.pdf`;
    const stored = await upload(author, pdf(), { name });
    await invoke(
      "activity.log",
      { type: "note", kindId: photoKind, links: [{ object: "person", id: person }], files: [stored.id] },
      as(author),
    );
    await serve(author, stored.id);
    await invoke("file.delete", { id: stored.id }, as(author));
    const { results } = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM core_audit WHERE instr(input || coalesce(result, '') || coalesce(error, ''), ?1) > 0)
        + (SELECT COUNT(*) FROM core_audit_changes WHERE instr(diff, ?1) > 0) AS n`,
    )
      .bind(name)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(0);
    for (const needle of ["%PDF", "Catalog"]) {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM core_audit WHERE instr(input || coalesce(result, ''), ?) > 0",
      )
        .bind(needle)
        .first<{ n: number }>();
      expect(row?.n, needle).toBe(0);
    }
  });
});

describe("deleting, the Trash, erase and merge", () => {
  it("a file deleted from its note is gone at once, and its R2 object after the drain", async () => {
    const { files } = await noteWith(author, "staff");
    const id = files[0] as string;
    expect((await refusal(invoke("file.delete", { id }, as(member)))).code).toBe("forbidden");
    expect((await refusal(invoke("file.delete", { id }, as(author, "assistant")))).code).toBe(
      "forbidden",
    );
    await invoke("file.delete", { id }, as(author));
    expect((await refusal(serve(author, id))).code).toBe("not_found");
    await drainAllBlobDeletions(db.query, blobs);
    expect(await bucket.head(`${FILES_PREFIX}${id}`)).toBeNull();
  });

  it("the Trash purge deletes a purged note's files and their R2 objects", async () => {
    const { note, files } = await noteWith(author, "coaches", [jpeg(), pdf()]);
    const kept = await noteWith(author, "staff");
    await invoke("activity.delete", { id: note }, as(author));
    const later = new Date(Date.now() + 31 * 86_400_000);
    await invoke(
      "trash.purge",
      { limit: 100 },
      context(admin, {
        actor: "automation",
        origin: { surface: "system", automationId: "trash.purge" },
        clock: () => later,
      } as never),
    );
    for (const id of files) {
      expect(await env.DB.prepare("SELECT id FROM core_record_file WHERE id = ?").bind(id).first()).toBeNull();
    }
    await drainAllBlobDeletions(db.query, blobs);
    for (const id of files) expect(await bucket.head(`${FILES_PREFIX}${id}`)).toBeNull();
    // A live note's files are untouched.
    expect(await serve(author, kept.files[0] as string)).toBeTruthy();
  });

  it("erasing a Person deletes the files of every note about them, and nothing is left readable", async () => {
    const p = (await invoke("person.create", { displayName: unique("Erased") }, as(admin))).id;
    const other = (await invoke("person.create", { displayName: unique("Other") }, as(admin))).id;
    const own = await noteWith(author, "staff", [jpeg()], p);
    // A note about them and someone else stays, scrubbed; its photo of them goes.
    const sharedUpload = await upload(author, jpeg());
    const shared = await invoke(
      "activity.log",
      {
        type: "note",
        kindId: photoKind,
        body: "Both of them",
        links: [
          { object: "person", id: p },
          { object: "person", id: other },
        ],
        files: [sharedUpload.id],
      },
      as(author),
    );
    await invoke("person.erase", { id: p }, as(admin));
    for (const id of [...own.files, sharedUpload.id]) {
      expect((await refusal(serve(admin, id))).code).toBe("not_found");
      expect(await env.DB.prepare("SELECT id FROM core_record_file WHERE id = ?").bind(id).first()).toBeNull();
    }
    expect((await invoke("activity.get", { id: shared.id }, as(admin))).files).toEqual([]);
    await drainAllBlobDeletions(db.query, blobs);
    for (const id of [...own.files, sharedUpload.id]) {
      expect(await bucket.head(`${FILES_PREFIX}${id}`)).toBeNull();
    }
  });

  it("a merge takes a note's files to the survivor: they follow their note", async () => {
    const survivor = (await invoke("person.create", { displayName: unique("S") }, as(admin))).id;
    const merged = (await invoke("person.create", { displayName: unique("M") }, as(admin))).id;
    const { note, files } = await noteWith(author, "staff", [jpeg()], merged);
    await invoke("person.merge", { survivorId: survivor, mergedId: merged }, as(admin));
    const timeline = await invoke(
      "activity.listForRecord",
      { object: "person", recordId: survivor, limit: 100 },
      as(author),
    );
    expect(timeline.items.find((a) => a.id === note)?.files?.map((f) => f.id)).toEqual(files);
    expect(await serve(author, files[0] as string)).toBeTruthy();
  });

  it("every path that hard-deletes notes deletes their files (no cascade can: migration 1233)", () => {
    const sources = import.meta.glob("../src/**/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const deleting = Object.entries(sources)
      .filter(([, code]) => /deleteFrom\(\s*"core_activity"\s*\)|PURGE_TABLES\[object\]/.test(code))
      .map(([path]) => path.replace("../src/", ""))
      .sort();
    // The inbox deletes a conversation's messages and notes, which take no files (file.upload).
    expect(deleting).toEqual(["inbox/index.ts", "operations/trash.ts", "records/erase.ts"]);
    for (const path of ["operations/trash.ts", "records/erase.ts"]) {
      expect(sources[`../src/${path}`], path).toContain("deleteFilesOfNotes(");
    }
  });
});

describe("bounded reads and purges (criterion 20)", () => {
  it("a timeline's files are one statement, however many notes have them", async () => {
    const meter = meterStatements();
    const count = async (n: number) => {
      const p = (await invoke("person.create", { displayName: unique("T") }, as(admin))).id;
      for (let i = 0; i < n; i++) await noteWith(author, "staff", [pdf()], p);
      meter.reset();
      const page = await invoke(
        "activity.listForRecord",
        { object: "person", recordId: p, limit: 100 },
        context(author, { db: meter.db }),
      );
      expect(page.items.filter((a) => a.files?.length === 1)).toHaveLength(n);
      return meter.bound.length;
    };
    const one = await count(1);
    const many = await count(25);
    expect(many).toBe(one);
    expect(Math.max(...meter.bound)).toBeLessThanOrEqual(100);
  });

  it("file.serve runs a fixed handful of statements", async () => {
    const meter = meterStatements();
    const { files } = await noteWith(author, "coaches");
    meter.reset();
    await invoke("file.serve", { id: files[0] }, context(carer, { db: meter.db }));
    expect(meter.bound.length).toBeLessThanOrEqual(12);
    expect(Math.max(...meter.bound)).toBeLessThanOrEqual(100);
  });

  it("the purge of waiting uploads is bounded per run, at two sizes", async () => {
    const meter = meterStatements();
    const stage = async (n: number) => {
      const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
      const statements = [];
      for (let i = 0; i < n; i++) {
        const id = `fil_${unique("old")}`;
        statements.push(
          env.DB.prepare(
            "INSERT INTO core_record_file (id, key, name, type, bytes, sha256, uploaded_by, created_at) VALUES (?, ?, 'x', 'application/pdf', 10, ?, ?, ?)",
          ).bind(id, `files/${id}`, "0".repeat(64), admin.id, old),
        );
      }
      for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
    };
    await purgeRecordFiles(db.query);
    await stage(3);
    meter.reset();
    const small = await purgeRecordFiles(meter.db.query);
    expect(small).toEqual({ deleted: 3, more: false });
    expect(meter.bound.length).toBe(2);
    await stage(650);
    meter.reset();
    const large = await purgeRecordFiles(meter.db.query);
    expect(large).toEqual({ deleted: 500, more: true });
    expect(meter.bound.length).toBe(10);
    expect(Math.max(...meter.bound)).toBeLessThanOrEqual(100);
    expect(await purgeRecordFiles(db.query)).toEqual({ deleted: 150, more: false });
  });
});
