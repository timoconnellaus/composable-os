// The mobile app's builds a host knows (stage 63, ADR 0901): `core_app_build`, one row per build
// sent to a store's testing track, written by `cos app record` with the deploy credential, as the
// deploy path writes core_install (deploy.ts). No operation writes it, and it holds no personal
// data. The table is core migration 1370 (stage 63 step 4): a host on an older release has none,
// and then nothing is recorded yet.
import { CloudflareApiError, type CloudflareClient } from "./cloudflare.ts";

export const APP_PLATFORMS = ["ios", "android"] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

/** One row of core_app_build. */
export interface AppBuildRecord {
  environment: string;
  platform: AppPlatform;
  /** The version people see (`mobile.app.version`). */
  app_version: string;
  /** The build number, the same on both platforms in one CI run. */
  build_number: number;
  /** The API version the build's generated client calls (`v1`). */
  api_version: string;
  /** The bundle identifier (iOS) or package name (Android) it was built with. */
  app_id: string;
  commit_sha: string | null;
  uploaded_at: string;
  /** 1 until the minimum build for its platform passes it (stage 63 step 4). */
  supported: number;
}

const COLUMNS = [
  "environment",
  "platform",
  "app_version",
  "build_number",
  "api_version",
  "app_id",
  "commit_sha",
  "uploaded_at",
  "supported",
] as const satisfies readonly (keyof AppBuildRecord)[];

/** A record refused: the reason is for the person running the command. */
export class AppBuildRefused extends Error {}

const missingTable = (error: unknown) =>
  error instanceof CloudflareApiError && /no such table/i.test(error.message);

/**
 * An environment's recorded builds, the highest build first (at most `limit`), or null when the
 * host has no core_app_build yet (a release before stage 63 step 4).
 */
export async function appBuildsViaApi(
  api: CloudflareClient,
  accountId: string,
  databaseId: string,
  environment: string,
  limit = 200,
): Promise<AppBuildRecord[] | null> {
  try {
    const [first] = await api.queryD1<AppBuildRecord>(
      accountId,
      databaseId,
      `SELECT ${COLUMNS.join(", ")} FROM core_app_build WHERE environment = ? ORDER BY build_number DESC, platform LIMIT ${Math.max(1, Math.min(1000, limit))}`,
      [environment],
    );
    return first?.results ?? [];
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
}

/** The next build number: the highest recorded, across both platforms, plus one. */
export function nextBuildNumber(builds: readonly AppBuildRecord[]): number {
  return builds.reduce((max, b) => Math.max(max, Number(b.build_number)), 0) + 1;
}

/**
 * Why `appId` may not be built for `platform`: the latest recorded build there has another id. A
 * store id never changes once published (a new id is a new app in the store).
 */
export function recordedIdProblem(
  builds: readonly AppBuildRecord[],
  platform: AppPlatform,
  appId: string,
): string | null {
  const latest = builds.find((b) => b.platform === platform);
  if (!latest || latest.app_id === appId) return null;
  return `the ${platform} app was recorded as ${latest.app_id} (build ${latest.build_number}); product.ts now says ${appId}. A store id never changes once published: put it back, or make a new app in the store on purpose and say so in an ADR`;
}

/**
 * Records one build (`cos app record`). Re-recording the same build of the same commit is a no-op
 * ("already"); a build number already used or lower than the platform's highest, or an id that
 * differs from the recorded one, is refused.
 */
export async function recordAppBuildViaApi(
  api: CloudflareClient,
  accountId: string,
  databaseId: string,
  record: AppBuildRecord,
): Promise<"recorded" | "already"> {
  const builds = await appBuildsViaApi(api, accountId, databaseId, record.environment, 1000);
  if (builds === null) {
    throw new AppBuildRefused(
      "the host has no core_app_build yet: it is on a release from before the app's builds were recorded (stage 63). Upgrade the host first (cos deploy), then record the build",
    );
  }
  const same = builds.find(
    (b) => b.platform === record.platform && Number(b.build_number) === record.build_number,
  );
  if (same) {
    if (same.commit_sha === record.commit_sha && same.app_id === record.app_id) return "already";
    throw new AppBuildRefused(
      `${record.platform} build ${record.build_number} is already recorded (commit ${same.commit_sha ?? "none"}): each build number is used once`,
    );
  }
  const problem = recordedIdProblem(builds, record.platform, record.app_id);
  if (problem) throw new AppBuildRefused(problem);
  const highest = builds.find((b) => b.platform === record.platform);
  if (highest && Number(highest.build_number) > record.build_number) {
    throw new AppBuildRefused(
      `${record.platform} build ${record.build_number} is lower than build ${highest.build_number}, already recorded: the stores take only a higher one`,
    );
  }
  await api.queryD1(
    accountId,
    databaseId,
    `INSERT INTO core_app_build (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
    COLUMNS.map((c) => record[c]),
  );
  return "recorded";
}
