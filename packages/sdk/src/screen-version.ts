// A screen version's manifest (stage 75 step 3, ADR 0961): the one shape a build writes and the
// host checks. A version is the built output of a client's screens: its files, each named by the
// SHA-256 of its bytes, and this manifest (the files, the entry, the API contract version it was
// built against, and what built it from what). The host stores and checks a version; it never
// builds one, and never changes one once it is sealed.
//
// It lives here, in the SDK, so the build (the client template's browser-only build, `cos`) and
// the host check the same rules: import `@composable-os/sdk/screen-version`. Nothing here depends
// on Cloudflare: `screenVersionManifestOf` hashes with Web Crypto, which Node, a browser and a Worker
// all have.
//
// What the manifest does not carry, on purpose:
// - **A content type.** The host decides it from the path's extension (`screenContentType`);
//   a type from the upload is never trusted, and a manifest that names one is refused.
// - **A person's name.** Who sealed a version is the host's own record (a staff user id), so a
//   sealed version never holds personal data an erase would have to change.
// - **A signature.** The desktop wrapper (stage 76) checks a signed manifest. What is signed is
//   the manifest's canonical text (`canonicalScreenVersionManifest`), whose SHA-256 the host records at
//   seal; a signature is a record of its own beside the version, so adding one never changes a
//   sealed version. Nothing signs yet.
import { z } from "zod";

/**
 * What a version is the built output of. Only a client's web app for now; another kind of
 * built output, if one is ever wanted, is one more value here and in migration 1490's
 * CHECK, with its own published pointer, since retention and listing are per kind.
 */
export const SCREEN_VERSION_KINDS = ["web"] as const;
export type ScreenVersionKind = (typeof SCREEN_VERSION_KINDS)[number];

/** The manifest's format; another is refused. */
export const SCREEN_VERSION_MANIFEST_FORMAT = "cos-screens/1";

/**
 * The limits of one version. A client's screens built as a single-page app are a few hundred
 * files and a few megabytes; these leave room for fonts and pictures while keeping a version
 * something a desktop app downloads whole and the host checks in one call.
 */
export const SCREEN_VERSION_LIMITS = Object.freeze({
  /** Files in one version. */
  maxFiles: 1000,
  /** One file's bytes: Cloudflare's limit for a static asset, so a version is also servable as one. */
  maxFileBytes: 25 * 1024 * 1024,
  /** All of a version's bytes together. */
  maxTotalBytes: 50 * 1024 * 1024,
  /** A path, in bytes (its characters are ASCII). */
  maxPathLength: 200,
  /** Folders deep, the file included. */
  maxPathDepth: 10,
  // So a manifest is at most about 330 KB (1000 files of a 200-character path, a hash and a
  // size), inside the HTTP surface's 1 MB body: it needs no limit of its own.
});

/** The content type the host serves a file with, by its extension. Nothing else is taken. */
export const SCREEN_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
});

/** The content type of `path`, from its extension; null for one the host does not serve. */
export function screenContentType(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const type = SCREEN_CONTENT_TYPES[name.slice(dot + 1).toLowerCase()];
  return type ?? null;
}

// One segment of a path: letters, digits and . _ - ~ @ + only, never "." or "..". Nothing a URL,
// a shell, Windows or macOS reads otherwise (no %, ?, #, :, \, space, control character or NUL).
const SEGMENT = /^[A-Za-z0-9._~@+-]{1,100}$/;

/** Why `path` is not a file name a version may hold; null when it may. */
export function screenPathProblem(path: string): string | null {
  if (typeof path !== "string" || path.length === 0) return "a path is never empty";
  if (path.length > SCREEN_VERSION_LIMITS.maxPathLength) {
    return `a path is at most ${SCREEN_VERSION_LIMITS.maxPathLength} characters`;
  }
  if (path.startsWith("/")) return "a path is relative: it never starts with /";
  const segments = path.split("/");
  if (segments.length > SCREEN_VERSION_LIMITS.maxPathDepth) {
    return `a path is at most ${SCREEN_VERSION_LIMITS.maxPathDepth} folders deep`;
  }
  for (const segment of segments) {
    if (segment === "") return "a path has no empty part (no // and no trailing /)";
    if (segment === "." || segment === "..") return "a path has no . or .. part";
    if (!SEGMENT.test(segment)) {
      return "a path's parts are letters, digits and . _ - ~ @ + only";
    }
  }
  if (!screenContentType(path)) {
    return `a file's extension is one the host serves: ${Object.keys(SCREEN_CONTENT_TYPES).join(", ")}`;
  }
  return null;
}

/** A SHA-256, as 64 lowercase hex characters. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

const screenFileSchema = z.strictObject({
  path: z.string().max(SCREEN_VERSION_LIMITS.maxPathLength),
  sha256: z.string().regex(SHA256_HEX, "a SHA-256 in lowercase hex"),
  size: z.number().int().min(0).max(SCREEN_VERSION_LIMITS.maxFileBytes),
});

/** An API contract version, as the host names them (ADR 0417): `v1`, `v2`, … */
export const API_CONTRACT_VERSION = /^v[1-9][0-9]{0,3}$/;

/** The manifest of a version, as a build writes it. */
export const screenVersionManifestSchema = z
  .strictObject({
    format: z.literal(SCREEN_VERSION_MANIFEST_FORMAT),
    /** The file a browser opens first: one of `files`, an .html file. */
    entry: z.string().max(SCREEN_VERSION_LIMITS.maxPathLength),
    /** The API contract version the screens were built against (ADR 0417). */
    contract: z.string().regex(API_CONTRACT_VERSION, "an API contract version: v1, v2, …"),
    files: z.array(screenFileSchema).min(1).max(SCREEN_VERSION_LIMITS.maxFiles),
    /** What built it, from what. No person's name: the host records who sealed it. */
    build: z.strictObject({
      tool: z.string().trim().min(1).max(100),
      from: z
        .strictObject({
          repository: z.string().trim().min(1).max(300).optional(),
          commit: z
            .string()
            .regex(/^[0-9a-f]{7,64}$/, "a commit id in lowercase hex")
            .optional(),
          ref: z.string().trim().min(1).max(200).optional(),
        })
        .optional(),
    }),
  })
  .superRefine((manifest, ctx) => {
    for (const problem of screenVersionManifestProblems(manifest)) {
      ctx.addIssue({ code: "custom", message: problem.message, path: problem.path });
    }
  });

export type ScreenVersionManifest = z.infer<typeof screenVersionManifestSchema>;
export type ScreenVersionManifestFile = ScreenVersionManifest["files"][number];

/** What is wrong with a manifest's files and entry beyond its shape (empty when nothing is). */
export function screenVersionManifestProblems(
  manifest: Pick<ScreenVersionManifest, "entry" | "files">,
): { message: string; path: (string | number)[] }[] {
  const problems: { message: string; path: (string | number)[] }[] = [];
  const folded = new Map<string, string>();
  let total = 0;
  manifest.files.forEach((file, at) => {
    total += file.size;
    const problem = screenPathProblem(file.path);
    if (problem) {
      problems.push({ message: `${file.path}: ${problem}`, path: ["files", at, "path"] });
      return;
    }
    // Two names one disk would take for the same file (macOS and Windows fold case).
    const key = file.path.toLowerCase();
    const before = folded.get(key);
    if (before !== undefined) {
      problems.push({
        message:
          before === file.path
            ? `${file.path} is named twice`
            : `${file.path} and ${before} differ only in case`,
        path: ["files", at, "path"],
      });
      return;
    }
    folded.set(key, file.path);
  });
  // A file that is also a folder of another ("a.js" and "a.js/b.js") cannot be on a disk.
  for (const [key, path] of folded) {
    const parts = key.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const folder = parts.slice(0, depth).join("/");
      const clash = folded.get(folder);
      if (clash !== undefined) {
        problems.push({ message: `${clash} is a file and a folder of ${path}`, path: ["files"] });
      }
    }
  }
  if (total > SCREEN_VERSION_LIMITS.maxTotalBytes) {
    problems.push({
      message: `a version's files are at most ${SCREEN_VERSION_LIMITS.maxTotalBytes} bytes together; these are ${total}`,
      path: ["files"],
    });
  }
  if (!manifest.files.some((file) => file.path === manifest.entry)) {
    problems.push({
      message: `the entry ${manifest.entry} is not one of the files`,
      path: ["entry"],
    });
  } else if (!/\.html$/.test(manifest.entry)) {
    problems.push({ message: "the entry is an .html file", path: ["entry"] });
  }
  return problems;
}

/**
 * The manifest's canonical text: keys in a fixed order, files by path, no spaces. Its SHA-256 is
 * the version's fingerprint, and what a signature (stage 76) will sign.
 */
export function canonicalScreenVersionManifest(manifest: ScreenVersionManifest): string {
  const from = manifest.build.from;
  return JSON.stringify({
    format: manifest.format,
    entry: manifest.entry,
    contract: manifest.contract,
    files: [...manifest.files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((file) => ({ path: file.path, sha256: file.sha256, size: file.size })),
    build: {
      tool: manifest.build.tool,
      ...(from
        ? {
            from: {
              ...(from.repository !== undefined ? { repository: from.repository } : {}),
              ...(from.commit !== undefined ? { commit: from.commit } : {}),
              ...(from.ref !== undefined ? { ref: from.ref } : {}),
            },
          }
        : {}),
    },
  });
}

/** The SHA-256 of `bytes`, as lowercase hex. */
export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A build's manifest from its files: each one's hash and size, checked against the rules here,
 * so a build finds out before it uploads anything. Throws a `ZodError` naming every problem.
 */
export async function screenVersionManifestOf(
  files: readonly { path: string; bytes: Uint8Array }[],
  options: { entry: string; contract: string; build: ScreenVersionManifest["build"] },
): Promise<ScreenVersionManifest> {
  return screenVersionManifestSchema.parse({
    format: SCREEN_VERSION_MANIFEST_FORMAT,
    entry: options.entry,
    contract: options.contract,
    files: await Promise.all(
      files.map(async (file) => ({
        path: file.path,
        sha256: await sha256OfBytes(file.bytes),
        size: file.bytes.byteLength,
      })),
    ),
    build: options.build,
  });
}
