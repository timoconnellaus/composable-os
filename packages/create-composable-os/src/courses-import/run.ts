// `cos courses import <folder>` (stage 42, ADR 0495): loads a studio's courses, bundles, videos,
// students' access and progress from an old course platform's export into a host, as the person
// running it, on the shared import door (import-door/, ADR 0470).
//
//   cos courses import ./export --host https://admin.example.com [--email you@example.com]
//                      [--dry-run] [--publish] [--yes] [--wait <minutes>]
//
// Videos in videos/ are read from disk a chunk at a time (a 20 GB file is never held whole), and
// hashed once to find them again on a re-run.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { sessionHost } from "../import-door/host.ts";
import { confirmer, signInForRun } from "../import-door/sign-in.ts";
import type { Io } from "../io.ts";
import { coursesReportLines, runCoursesImport, type VideoSource } from "./engine.ts";
import { type CoursesFolder, readCoursesFolder } from "./format.ts";

export interface CoursesImportFlags {
  host?: string;
  email?: string;
  dryRun?: boolean;
  publish?: boolean;
  yes?: boolean;
  /** Minutes to wait for Stream to have the videos ready. */
  wait?: number;
}

const filesIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()) : [];

/** The folder as text and bytes; videos only by name and size. */
export function readCoursesDisk(dir: string): CoursesFolder {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${dir} is not a folder`);
  const json = (sub: string) =>
    new Map(
      filesIn(join(root, sub))
        .filter((n) => n.toLowerCase().endsWith(".json"))
        .map((n) => [n, readFileSync(join(root, sub, n), "utf8")] as const),
    );
  const bytes = (sub: string) =>
    new Map(
      filesIn(join(root, sub)).map(
        (n) => [n, new Uint8Array(readFileSync(join(root, sub, n)))] as const,
      ),
    );
  const text = (name: string) =>
    existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : null;
  return {
    courses: json("courses"),
    bundles: json("bundles"),
    videos: new Map(
      filesIn(join(root, "videos")).map(
        (n) => [n, statSync(join(root, "videos", n)).size] as const,
      ),
    ),
    captions: bytes("captions"),
    pictures: bytes("pictures"),
    downloads: bytes("downloads"),
    access: text("access.csv"),
    progress: text("progress.csv"),
  };
}

/** A video on disk: its size, its SHA-256 (streamed once) and its bytes a chunk at a time. */
function videoOnDisk(path: string): VideoSource {
  const size = statSync(path).size;
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(8 * 1024 * 1024);
    for (let at = 0; at < size; ) {
      const read = readSync(fd, buffer, 0, buffer.length, at);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
      at += read;
    }
  } finally {
    closeSync(fd);
  }
  return {
    size,
    sha256: hash.digest("hex"),
    async read(offset, length) {
      const handle = openSync(path, "r");
      try {
        const out = Buffer.alloc(length);
        const got = readSync(handle, out, 0, length, offset);
        return new Uint8Array(out.subarray(0, got));
      } finally {
        closeSync(handle);
      }
    },
  };
}

/** `cos courses import <folder>`. */
export async function coursesImport(
  positional: string[],
  flags: CoursesImportFlags,
  io: Io,
): Promise<number> {
  const dir = positional[0];
  if (!dir) {
    io.err(
      "Usage: cos courses import <folder> --host <https://host> [--email <you>] [--dry-run] [--publish] [--yes] [--wait <minutes>]\n\n" +
        "The folder: courses/*.json, bundles/*.json, videos/, captions/, pictures/, downloads/, access.csv, progress.csv. See docs/importing.md.",
    );
    return 2;
  }
  const host = flags.host?.replace(/\/+$/, "");
  if (!host || !/^https?:\/\//.test(host)) {
    io.err("--host is the host's address, e.g. https://admin.example.com");
    return 2;
  }
  const plan = readCoursesFolder(readCoursesDisk(dir));
  if (plan.problems.length) {
    io.err(`Nothing was written: ${plan.problems.length} problem(s) in ${dir}.`);
    for (const p of plan.problems) io.err(`  ${p.file}: ${p.message}`);
    return 1;
  }
  io.out(
    `${plan.courses.length} course(s), ${plan.bundles.length} bundle(s), ${plan.videos.size} video(s), ${plan.access.length} access row(s) and ${plan.progress?.length ?? 0} progress row(s) in ${dir}.`,
  );
  const videos = new Map<string, VideoSource>();
  for (const [ref, v] of plan.videos) {
    if (v.file) {
      io.out(`Reading videos/${v.file}…`);
      videos.set(v.file, videoOnDisk(join(resolve(dir), "videos", v.file)));
    }
    void ref;
  }

  let session: Awaited<ReturnType<typeof signInForRun>>;
  try {
    session = await signInForRun(host, flags.email, io, "cos courses import");
  } catch (error) {
    io.err(`Could not sign in: ${(error as Error).message}`);
    return 1;
  }
  try {
    const report = await runCoursesImport(
      plan,
      sessionHost(host, () => session.headers()),
      {
        dryRun: Boolean(flags.dryRun),
        publish: Boolean(flags.publish),
        confirm: confirmer(io, flags.yes),
        videoFiles: (name) => videos.get(name),
        waitMs: (flags.wait ?? 10) * 60_000,
        progress: (line) => io.out(line),
      },
    );
    for (const line of coursesReportLines(report, Boolean(flags.dryRun))) {
      (report.problems.length ? io.err : io.out)(line);
    }
    return report.problems.length ? 1 : report.waiting.length ? 3 : 0;
  } finally {
    await session.signOut();
  }
}
