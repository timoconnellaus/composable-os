// Stage 75 step 3 (ADR 0961): the screen version store. A build is stored as a version that
// cannot be changed and a changed file is refused (criterion 2); every check of the manifest; a
// sealed version fixed against every operation and every SQL path the host has; the retention
// rule and the sweep of unsealed uploads; and one client's versions out of another's reach
// (criterion 7, as far as versions go). Against real D1 and a real local R2 bucket.
import { env } from "cloudflare:workers";
import {
  SCREEN_VERSION_LIMITS,
  type ScreenVersionManifest,
  screenPathProblem,
  screenVersionManifestOf,
  sha256OfBytes,
} from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  clientScopesHeld,
  coreInvoker,
  drainAllBlobDeletions,
  handleScreenVersions,
  invoke,
  KEPT_VERSIONS,
  MAX_OPEN_VERSIONS,
  type MediaStore,
  screenVersionFile,
  sweepScreenVersions,
} from "../src/index.ts";
import { context, createUser, db } from "./helpers.ts";
import { otherClient, otherDatabase, otherDb } from "./other-client.ts";

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
    if (keys.length) await bucket.delete(keys);
  },
};
const blobs = {
  get: async (key: string) => (await bucket.get(key))?.text() ?? null,
  put: async (key: string, value: string) => {
    await bucket.put(key, value);
  },
  delete: (keys: string[]) => store.delete(keys),
  list: async (prefix: string, cursor?: string) => {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    return {
      keys: page.objects.map((o) => o.key),
      ...(page.truncated ? { cursor: page.cursor } : {}),
    };
  },
};

const text = (s: string) => new TextEncoder().encode(s);
let admin: ActingUser;
let member: ActingUser;
const clock = () => new Date();

const asStaff = (extra: Record<string, unknown> = {}, user = admin) =>
  context(user, { media: store, clock: () => clock(), ...extra } as never);

async function attempt(promise: Promise<unknown>) {
  try {
    return { ok: true as const, value: await promise };
  } catch (error) {
    return {
      ok: false as const,
      error: error as { code: string; message: string; details?: Record<string, unknown> },
    };
  }
}

async function begin(sha256: string[] = [], extra: Record<string, unknown> = {}) {
  return (await invoke("screens.versionBegin", { sha256 }, asStaff(extra))) as {
    id: string;
    held: string[];
    expiresAt: string;
  };
}

async function put(version: string, bytes: Uint8Array, sha256?: string) {
  return invoke(
    "screens.versionPut",
    { version, sha256: sha256 ?? (await sha256OfBytes(bytes)) },
    asStaff({ upload: { bytes } }),
  ) as Promise<{ sha256: string; size: number; stored: boolean }>;
}

async function seal(version: string, manifest: unknown) {
  return invoke(
    "screens.versionSeal",
    { version, manifest: manifest as never },
    asStaff(),
  ) as Promise<{
    id: string;
    state: string;
    manifestSha256: string;
    unused: string[];
  }>;
}

/** A small build: an entry, a script, a stylesheet. */
function build(tag: string) {
  return [
    {
      path: "index.html",
      bytes: text(`<!doctype html><script src="assets/app.js"></script>${tag}`),
    },
    { path: "assets/app.js", bytes: text(`console.log(${JSON.stringify(tag)})`) },
    { path: "assets/app.css", bytes: text(`body{color:red}/*${tag}*/`) },
  ];
}

async function manifestOf(files: { path: string; bytes: Uint8Array }[]) {
  return screenVersionManifestOf(files, {
    entry: "index.html",
    contract: "v1",
    build: {
      tool: "vite 8",
      from: { repository: "https://example.test/screens", commit: "abc1234" },
    },
  });
}

/** Begins, puts every file and seals: the stored version. */
async function store3(tag: string) {
  const files = build(tag);
  const version = await begin();
  for (const f of files) await put(version.id, f.bytes);
  const manifest = await manifestOf(files);
  return { ...(await seal(version.id, manifest)), manifest, files };
}

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
});

// Each test starts with no upload open (MAX_OPEN_VERSIONS bounds them).
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM core_screen_version_upload WHERE version_id IN (SELECT id FROM core_screen_version WHERE state = 'open')",
    ),
    env.DB.prepare("DELETE FROM core_screen_version WHERE state = 'open'"),
  ]);
});

describe("a build stored as a version (criterion 2)", () => {
  it("is begun, sent file by file, sealed, and then is exactly its manifest's files", async () => {
    const { id, state, manifestSha256, manifest } = await store3("first");
    expect(state).toBe("sealed");
    expect(manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    const got = (await invoke("screens.versionGet", { version: id }, asStaff())) as {
      files: { path: string; contentType: string }[];
      contract: string;
      sealedBy: string;
      manifest: ScreenVersionManifest;
    };
    expect(got.contract).toBe("v1");
    expect(got.sealedBy).toBe(admin.id);
    expect(got.files.map((f) => [f.path, f.contentType])).toEqual([
      ["assets/app.css", "text/css; charset=utf-8"],
      ["assets/app.js", "text/javascript; charset=utf-8"],
      ["index.html", "text/html; charset=utf-8"],
    ]);
    expect(got.manifest.files).toHaveLength(manifest.files.length);
    // A target finds the file through the store, and its bytes are the ones sent.
    const entry = await screenVersionFile(db.query, id, "index.html");
    expect(entry?.contentType).toBe("text/html; charset=utf-8");
    const object = await bucket.get(entry?.objectKey ?? "");
    expect(await object?.text()).toContain("first");
    expect(await screenVersionFile(db.query, id, "assets/missing.js")).toBeNull();
  });

  it("stores a file once whatever number of versions name it", async () => {
    const files = build("shared");
    const first = await begin();
    for (const f of files) await put(first.id, f.bytes);
    await seal(first.id, await manifestOf(files));
    const hashes = await Promise.all(files.map((f) => sha256OfBytes(f.bytes)));
    const second = await begin(hashes);
    expect(second.held).toEqual([...hashes].sort());
    // Sent again anyway: nothing is stored twice.
    expect((await put(second.id, files[0]?.bytes as Uint8Array)).stored).toBe(false);
    await seal(second.id, await manifestOf(files));
    const objects = await bucket.list({ prefix: `screens/${hashes[0]}/` });
    expect(objects.objects).toHaveLength(1);
  });

  it("refuses a file that is not the one named: its bytes are hashed on arrival", async () => {
    const version = await begin();
    const named = await sha256OfBytes(text("the real file"));
    const result = await attempt(put(version.id, text("a changed file"), named));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("hash_mismatch");
    const row = await env.DB.prepare("SELECT count(*) AS n FROM core_screen_blob WHERE sha256 = ?")
      .bind(named)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("refuses a manifest whose size for a file is not the size sent with that hash", async () => {
    const files = build("sizes");
    const version = await begin();
    for (const f of files) await put(version.id, f.bytes);
    const manifest = await manifestOf(files);
    const lying = {
      ...manifest,
      files: manifest.files.map((f, i) => (i === 0 ? { ...f, size: f.size + 1 } : f)),
    };
    const result = await attempt(seal(version.id, lying));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("size_mismatch");
  });

  it("refuses a manifest naming a file never sent", async () => {
    const files = build("missing");
    const version = await begin();
    await put(version.id, files[0]?.bytes as Uint8Array);
    const result = await attempt(seal(version.id, await manifestOf(files)));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.reason).toBe("missing_files");
      expect((result.error.details?.missing as unknown[] | undefined)?.length).toBe(2);
    }
  });

  it("leaves out a file sent that the manifest does not name, and the sweep removes it", async () => {
    const files = build("extra");
    const extra = text("not part of the build");
    const version = await begin();
    for (const f of files) await put(version.id, f.bytes);
    const extraSha = (await put(version.id, extra)).sha256;
    const sealed = await seal(version.id, await manifestOf(files));
    expect(sealed.unused).toEqual([extraSha]);
    expect(await screenVersionFile(db.query, version.id, "extra.txt")).toBeNull();
    const got = (await invoke("screens.versionGet", { version: version.id }, asStaff())) as {
      files: { sha256: string }[];
    };
    expect(got.files.map((f) => f.sha256)).not.toContain(extraSha);
    await sweepScreenVersions(db, new Date(), blobs);
    const left = await env.DB.prepare("SELECT count(*) AS n FROM core_screen_blob WHERE sha256 = ?")
      .bind(extraSha)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    await drainAllBlobDeletions(db.query, blobs, 20);
    expect((await bucket.list({ prefix: `screens/${extraSha}/` })).objects).toHaveLength(0);
  });

  it("takes no file through an operation's input, and needs the upload route for one", async () => {
    const version = await begin();
    const result = await attempt(
      invoke(
        "screens.versionPut",
        { version: version.id, sha256: await sha256OfBytes(text("x")) },
        asStaff(),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("no_file");
  });
});

describe("a version's kind", () => {
  it("is web, the only kind there is: another is refused by the operation and the database", async () => {
    const version = await begin();
    const got = (await invoke("screens.versionGet", { version: version.id }, asStaff())) as {
      kind: string;
    };
    expect(got.kind).toBe("web");
    const refused = await attempt(
      invoke("screens.versionBegin", { kind: "admin" as never }, asStaff()),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("invalid_input");
    const raw = await attempt(
      env.DB.prepare(
        "INSERT INTO core_screen_version (id, kind, state, created_at, created_by, expires_at) VALUES ('scv_kind', 'admin', 'open', '2026', 'u', '2999')",
      ).run(),
    );
    expect(raw.ok).toBe(false);
    if (!raw.ok) expect(raw.error.message).toMatch(/CHECK constraint failed/);
  });
});

describe("the manifest's checks", () => {
  it("refuses paths that leave the version, are absolute, hold a NUL or are too long", () => {
    for (const bad of [
      "../index.html",
      "assets/../../x.js",
      "/index.html",
      "assets//app.js",
      "assets/./app.js",
      "assets\\app.js",
      "a\u0000.js",
      "a b.js",
      "C:/x.js",
      "%2e%2e/x.js",
      `${"a".repeat(SCREEN_VERSION_LIMITS.maxPathLength)}.js`,
      `${"d/".repeat(SCREEN_VERSION_LIMITS.maxPathDepth)}x.js`,
      "script.php",
      "noextension",
      "",
    ]) {
      expect(screenPathProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    for (const good of [
      "index.html",
      "assets/index-BwX3k_9a.js",
      ".well-known/x.json",
      "a@2x.png",
    ]) {
      expect(screenPathProblem(good), good).toBeNull();
    }
  });

  it("refuses at seal a traversal, two names differing only in case, a file that is a folder, an entry not among the files, a content type and too many files", async () => {
    const files = build("checks");
    const version = await begin();
    for (const f of files) await put(version.id, f.bytes);
    const manifest = await manifestOf(files);
    const [first] = manifest.files as [ScreenVersionManifest["files"][number]];
    const cases: [string, unknown][] = [
      ["traversal", { ...manifest, files: [...manifest.files, { ...first, path: "../x.html" }] }],
      ["case", { ...manifest, files: [...manifest.files, { ...first, path: "INDEX.html" }] }],
      [
        "folder",
        { ...manifest, files: [...manifest.files, { ...first, path: "index.html/x.html" }] },
      ],
      ["entry", { ...manifest, entry: "other.html" }],
      ["entry not html", { ...manifest, entry: "assets/app.js" }],
      [
        "content type",
        { ...manifest, files: manifest.files.map((f) => ({ ...f, contentType: "text/html" })) },
      ],
      ["contract", { ...manifest, contract: "1" }],
      [
        "count",
        {
          ...manifest,
          files: Array.from({ length: SCREEN_VERSION_LIMITS.maxFiles + 1 }, (_, i) => ({
            ...first,
            path: `f${i}.js`,
          })),
        },
      ],
      [
        "total",
        {
          ...manifest,
          files: Array.from({ length: 3 }, (_, i) => ({
            ...first,
            path: `big${i}.js`,
            size: SCREEN_VERSION_LIMITS.maxFileBytes,
          })),
        },
      ],
      ["a person's name", { ...manifest, build: { ...manifest.build, by: "Ada Lovelace" } }],
    ];
    for (const [name, bad] of cases) {
      const result = await attempt(seal(version.id, bad));
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.error.code, name).toBe("invalid_input");
    }
    // Still open, and seals with the right manifest.
    expect((await seal(version.id, manifest)).state).toBe("sealed");
  });

  it("refuses a file larger than a version's largest", async () => {
    const version = await begin();
    const big = new Uint8Array(SCREEN_VERSION_LIMITS.maxFileBytes + 1);
    const result = await attempt(put(version.id, big, "0".repeat(64)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("too_large");
  });

  it("bounds what one unsealed version may be sent", async () => {
    const version = await begin();
    // Near the total: fill the version's claims, then one more is refused.
    await env.DB.prepare(
      "INSERT INTO core_screen_version_upload (version_id, sha256, size, received_at) VALUES (?, ?, ?, ?)",
    )
      .bind(
        version.id,
        "f".repeat(64),
        SCREEN_VERSION_LIMITS.maxTotalBytes - 4,
        new Date().toISOString(),
      )
      .run();
    const result = await attempt(put(version.id, text("12345")));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("too_large");
  });
});

describe("a sealed version never changes", () => {
  it("is refused by every operation that writes a version", async () => {
    const { id, files, manifest } = await store3("fixed");
    for (const result of [
      await attempt(put(id, text("one more file"))),
      await attempt(seal(id, manifest)),
      await attempt(put(id, files[0]?.bytes as Uint8Array)),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.details?.reason).toBe("sealed");
    }
  });

  it("is refused by the database whatever writes it", async () => {
    const { id } = await store3("sql");
    const refusals = [
      "UPDATE core_screen_version SET entry = 'other.html' WHERE id = ?1",
      "UPDATE core_screen_version SET kind = 'web' WHERE id = ?1",
      "UPDATE core_screen_version SET state = 'open', expires_at = '2999-01-01' WHERE id = ?1",
      "UPDATE core_screen_version_file SET sha256 = 'x' WHERE version_id = ?1",
      "DELETE FROM core_screen_version_file WHERE version_id = ?1",
      "INSERT INTO core_screen_version_file (version_id, path, sha256, size, content_type) SELECT ?1, 'more.js', sha256, size, 'text/javascript' FROM core_screen_blob LIMIT 1",
      "UPDATE core_screen_blob SET size = size + 1 WHERE sha256 IN (SELECT sha256 FROM core_screen_version_file WHERE version_id = ?1)",
      "UPDATE core_screen_blob SET object_key = 'elsewhere' WHERE sha256 IN (SELECT sha256 FROM core_screen_version_file WHERE version_id = ?1)",
      "DELETE FROM core_screen_blob WHERE sha256 IN (SELECT sha256 FROM core_screen_version_file WHERE version_id = ?1)",
      // One of the last ten: kept.
      "DELETE FROM core_screen_version WHERE id = ?1",
      "INSERT INTO core_screen_version (id, kind, state, created_at, created_by, sealed_at, sealed_by, manifest, manifest_sha256, entry, contract, build_tool, file_count, total_bytes) VALUES (?1 || 'x', 'web', 'sealed', '2026', 'u', '2026', 'u', '{}', 'x', 'index.html', 'v1', 't', 0, 0)",
    ];
    for (const statement of refusals) {
      const result = await attempt(env.DB.prepare(statement).bind(id).run());
      expect(result.ok, statement).toBe(false);
      if (!result.ok) expect(result.error.message, statement).toMatch(/core_screen_/);
    }
    const files = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_screen_version_file WHERE version_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(files?.n).toBe(3);
  });

  it("is out of reach of query.sql, which refuses core tables", async () => {
    for (const sql of [
      "SELECT * FROM core_screen_version",
      "UPDATE core_screen_version SET entry = 'x'",
    ]) {
      const result = await attempt(invoke("query.sql", { sql }, asStaff()));
      expect(result.ok, sql).toBe(false);
    }
  });
});

describe("who may store a version", () => {
  it("needs screens:upload: a member without it is refused", async () => {
    const result = await attempt(invoke("screens.versionBegin", {}, asStaff({}, member)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("is a person: an assistant or MCP caller is refused", async () => {
    for (const actor of ["assistant", "mcp"] as const) {
      const result = await attempt(invoke("screens.versionBegin", {}, asStaff({ actor })));
      expect(result.ok, actor).toBe(false);
    }
  });

  it("is staff: a customer or the public is told no such operation exists", async () => {
    for (const principal of [{ kind: "public" as const }]) {
      const result = await attempt(
        coreInvoker.invokeByName("screens.versionList", {}, { principal, db } as never),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("unknown_operation");
    }
  });

  it("is sent files only with a staff device token, never a cookie", async () => {
    const version = await begin();
    const bytes = text("by route");
    const sha = await sha256OfBytes(bytes);
    const response = await handleScreenVersions(
      new Request(`https://host.test/api/v1/screens/versions/${version.id}/files/${sha}`, {
        method: "PUT",
        headers: { cookie: "session=whatever" },
        body: bytes,
      }),
      {
        invoker: { invokeByName: () => Promise.reject(new Error("never reached")) },
        context: async () => asStaff(),
        media: store,
      },
    );
    expect(response.status).toBe(401);
  });
});

describe("the retention rule and the sweep", () => {
  it("sweeps an upload never sealed after its time, with the files only it was sent", async () => {
    const version = await begin();
    const lone = await put(version.id, text(`only in an abandoned upload ${version.id}`));
    await sweepScreenVersions(db, new Date(Date.now() + 25 * 3_600_000), blobs);
    const row = await env.DB.prepare("SELECT count(*) AS n FROM core_screen_version WHERE id = ?")
      .bind(version.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
    const blob = await env.DB.prepare("SELECT count(*) AS n FROM core_screen_blob WHERE sha256 = ?")
      .bind(lone.sha256)
      .first<{ n: number }>();
    expect(blob?.n).toBe(0);
    await drainAllBlobDeletions(db.query, blobs, 20);
    expect((await bucket.list({ prefix: `screens/${lone.sha256}/` })).objects).toHaveLength(0);
  });

  it("deletes a stray object no row names once its version is no longer open", async () => {
    await bucket.put("screens/".concat("e".repeat(64), "/scv_00000000000000000000000000"), "stray");
    const result = await sweepScreenVersions(db, new Date(), blobs);
    expect(result.strays).toBeGreaterThanOrEqual(1);
    expect(await bucket.get(`screens/${"e".repeat(64)}/scv_00000000000000000000000000`)).toBeNull();
  });

  it("bounds how many uploads are open at once", async () => {
    // Earlier tests left some open: sweep them as if a day had passed.
    await sweepScreenVersions(db, new Date(Date.now() + 25 * 3_600_000), blobs);
    for (let i = 0; i < MAX_OPEN_VERSIONS; i++) await begin();
    const result = await attempt(begin());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("too_many_open");
    await sweepScreenVersions(db, new Date(Date.now() + 25 * 3_600_000), blobs);
  });

  it("keeps the last ten sealed versions and any held, and removes the rest", async () => {
    const made: string[] = [];
    for (let i = 0; i < KEPT_VERSIONS + 2; i++) made.push((await store3(`kept ${i}`)).id);
    const sealed = (
      await env.DB.prepare(
        "SELECT id FROM core_screen_version WHERE state = 'sealed' ORDER BY sealed_at DESC, id DESC",
      ).all<{ id: string }>()
    ).results.map((r) => r.id);
    const kept = sealed.slice(0, KEPT_VERSIONS);
    const oldest = sealed[sealed.length - 1] as string;
    // Step 4's seam: a held version stays whatever its age.
    await env.DB.prepare(
      "INSERT INTO core_screen_version_hold (version_id, reason, until, created_at) VALUES (?, 'published', NULL, ?)",
    )
      .bind(oldest, new Date().toISOString())
      .run();
    await sweepScreenVersions(db, new Date(), blobs);
    const after = (
      await env.DB.prepare("SELECT id FROM core_screen_version WHERE state = 'sealed'").all<{
        id: string;
      }>()
    ).results.map((r) => r.id);
    expect(after.sort()).toEqual([...kept, oldest].sort());
    // A removed version's files are gone with it; a kept one's are all still served.
    for (const id of kept) {
      expect(await screenVersionFile(db.query, id, "index.html"), id).not.toBeNull();
    }
    // The hold ends, and the next sweep lets it go.
    await env.DB.prepare("UPDATE core_screen_version_hold SET until = ? WHERE version_id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), oldest)
      .run();
    await sweepScreenVersions(db, new Date(), blobs);
    const gone = await env.DB.prepare("SELECT count(*) AS n FROM core_screen_version WHERE id = ?")
      .bind(oldest)
      .first<{ n: number }>();
    expect(gone?.n).toBe(0);
    // Every file a kept version names is still in the bucket after the deletions drain.
    await drainAllBlobDeletions(db.query, blobs, 50);
    for (const id of kept) {
      const file = await screenVersionFile(db.query, id, "assets/app.js");
      expect(await bucket.get(file?.objectKey ?? ""), id).not.toBeNull();
    }
    expect(made).toHaveLength(KEPT_VERSIONS + 2);
  });
});

describe.skipIf(clientScopesHeld())("another client (criterion 7, as far as versions go)", () => {
  let otherAdmin: ActingUser;
  beforeAll(async () => {
    otherAdmin = await otherClient();
  });
  const asOther = (extra: Record<string, unknown> = {}) =>
    ({ ...context(otherAdmin), db: otherDb, media: store, ...extra }) as never;

  it("cannot list, read or reference a version or a file of this client's, even by its hash", async () => {
    const { id, files } = await store3("only ours");
    const hashes = await Promise.all(files.map((f) => sha256OfBytes(f.bytes)));
    const listed = (await invoke("screens.versionList", {}, asOther())) as {
      versions: { id: string }[];
    };
    expect(listed.versions.map((v) => v.id)).not.toContain(id);
    const got = await attempt(invoke("screens.versionGet", { version: id }, asOther()));
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe("not_found");
    expect(await screenVersionFile(otherDb.query, id, "index.html")).toBeNull();
    // Its own upload, naming our files by hash: it holds none of them.
    const mine = (await invoke("screens.versionBegin", { sha256: hashes }, asOther())) as {
      id: string;
      held: string[];
    };
    expect(mine.held).toEqual([]);
    const sealed = await attempt(
      invoke(
        "screens.versionSeal",
        { version: mine.id, manifest: await manifestOf(files) },
        asOther(),
      ),
    );
    expect(sealed.ok).toBe(false);
    if (!sealed.ok) expect(sealed.error.details?.reason).toBe("missing_files");
    // Nor can it put into ours.
    const into = await attempt(
      invoke(
        "screens.versionPut",
        { version: id, sha256: hashes[0] as string },
        asOther({ upload: { bytes: files[0]?.bytes } }),
      ),
    );
    expect(into.ok).toBe(false);
    if (!into.ok) expect(into.error.code).toBe("not_found");
    const count = await otherDatabase
      .prepare("SELECT count(*) AS n FROM core_screen_version_file")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});
