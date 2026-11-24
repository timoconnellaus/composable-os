// `cos app upload --platform android` (stage 63, ADR 0901): one Android build to the store's
// internal testing track, in the client's own store account, over the store's publishing API with
// the upload account key a person set as a CI secret (ANDROID_STORE_SERVICE_ACCOUNT). With
// --listing, the store listing's text from the repo too (apps/mobile/store/<locale>/).
//
// The track is always `internal`: no command releases to the public (decision 4). A person
// promotes a tested build in the store's console after the client's yes. The iPhone build is sent
// by the workflow with the platform's own upload tool, so there is no `--platform ios` here.
//
// Not yet tried against the real store: the API calls follow its public reference (v3, "edits").
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { buildFor, envFlag, type LISTING_FILES, listingLocales, listingText } from "./app.ts";
import { loadClientProduct } from "./client-repo.ts";
import { CliError, type Deps, type Flags, str } from "./main.ts";

/** The store's publishing API (tests: COS_ANDROID_STORE_API). */
const STORE_API = "https://androidpublisher.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
/** The only track cos uploads to. */
export const TESTING_TRACK = "internal";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

const base64url = (bytes: Uint8Array | string) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A signed assertion for the account's key, exchanged for an access token (RFC 7523). */
async function accessToken(account: ServiceAccount, fetcher: typeof fetch): Promise<string> {
  const der = Buffer.from(
    account.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
    "base64",
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: account.token_uri,
      iat: now,
      exp: now + 600,
    }),
  )}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)),
  );
  const response = await fetcher(account.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64url(signature)}`,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string };
  if (!response.ok || !body.access_token) {
    throw new CliError(
      `The Android store refused the upload account key (${response.status}): check ANDROID_STORE_SERVICE_ACCOUNT and its access in the client's store account.`,
    );
  }
  return body.access_token;
}

function serviceAccount(deps: Deps): ServiceAccount {
  const text = (deps.env as Record<string, string | undefined>).ANDROID_STORE_SERVICE_ACCOUNT;
  if (!text?.trim()) {
    throw new CliError(
      "ANDROID_STORE_SERVICE_ACCOUNT is not set: a person sets it as a CI secret (cos app credentials).",
    );
  }
  let account: Partial<ServiceAccount>;
  try {
    account = JSON.parse(text) as Partial<ServiceAccount>;
  } catch {
    throw new CliError("ANDROID_STORE_SERVICE_ACCOUNT is not the upload account's JSON key.");
  }
  if (!account.client_email || !account.private_key || !account.token_uri) {
    throw new CliError(
      "ANDROID_STORE_SERVICE_ACCOUNT has no client_email, private_key or token_uri: it is not the upload account's JSON key.",
    );
  }
  deps.redactor.add(account.private_key);
  return account as ServiceAccount;
}

export interface AndroidUpload {
  packageName: string;
  /** The app bundle's bytes (.aab). */
  bundle: Uint8Array<ArrayBuffer>;
  /** The listing per locale: title, short and full description. Absent: the listing is kept. */
  listings?: {
    language: string;
    title: string;
    shortDescription: string;
    fullDescription: string;
  }[];
  /** What is new in this build, per locale. */
  releaseNotes: { language: string; text: string }[];
  /** A draft release (the store's only kind for an app it has not yet published). */
  draft: boolean;
}

/**
 * Sends one build to the internal testing track in one edit: insert, upload the bundle, the
 * listings, the track's release, commit. Nothing is committed when a step fails. Returns the
 * version code the store read from the bundle.
 */
export async function uploadAndroid(
  upload: AndroidUpload,
  account: ServiceAccount,
  options: { api?: string; fetch?: typeof fetch } = {},
): Promise<number> {
  const fetcher = options.fetch ?? fetch;
  const api = options.api ?? STORE_API;
  const token = await accessToken(account, fetcher);
  const app = `applications/${encodeURIComponent(upload.packageName)}`;
  const call = async <T>(
    method: string,
    path: string,
    body?: unknown,
    raw?: Uint8Array<ArrayBuffer>,
  ) => {
    const response = await fetcher(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": raw ? "application/octet-stream" : "application/json",
      },
      ...(raw ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      const message = (() => {
        try {
          return (JSON.parse(text) as { error?: { message?: string } }).error?.message;
        } catch {
          return undefined;
        }
      })();
      throw new CliError(
        `The Android store refused ${method} ${path.replace(/\/edits\/[^/:]+/, "/edits/…")} (${response.status})${message ? `: ${message}` : ""}. Nothing was committed.`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  };
  const edit = await call<{ id: string }>("POST", `/androidpublisher/v3/${app}/edits`, {});
  const editPath = `/androidpublisher/v3/${app}/edits/${encodeURIComponent(edit.id)}`;
  const bundle = await call<{ versionCode: number }>(
    "POST",
    `/upload/androidpublisher/v3/${app}/edits/${encodeURIComponent(edit.id)}/bundles?uploadType=media`,
    undefined,
    upload.bundle,
  );
  for (const listing of upload.listings ?? []) {
    await call("PUT", `${editPath}/listings/${encodeURIComponent(listing.language)}`, listing);
  }
  await call("PUT", `${editPath}/tracks/${TESTING_TRACK}`, {
    track: TESTING_TRACK,
    releases: [
      {
        versionCodes: [String(bundle.versionCode)],
        status: upload.draft ? "draft" : "completed",
        releaseNotes: upload.releaseNotes,
      },
    ],
  });
  await call("POST", `${editPath}:commit`);
  return bundle.versionCode;
}

export async function upload(flags: Flags, deps: Deps): Promise<number> {
  const platform = str(flags, "platform");
  if (platform === "ios") {
    throw new CliError(
      "The iPhone build is sent by the app workflow with the platform's own upload tool; cos app upload sends the Android build.",
    );
  }
  if (platform !== "android")
    throw new CliError("cos app upload --platform android --file <app.aab>.");
  const file = str(flags, "file");
  if (!file?.endsWith(".aab")) throw new CliError("--file is the Android app bundle (.aab).");
  const root = resolve(str(flags, "dir") ?? process.cwd());
  const product = await loadClientProduct(root);
  if (!product.mobile) throw new CliError("product.ts has no mobile app (mobile: { dir }).");
  const build = buildFor(product, envFlag(product, flags));
  if (!build.store) throw new CliError("product.ts gives no mobile.app.");
  const { listing } = build.store;
  const locales = listingLocales(root, listing);
  if (!locales.length) throw new CliError(`${listing} has no locale folder: run cos app check.`);
  const text = (locale: string, name: (typeof LISTING_FILES)[number]["file"]) =>
    listingText(root, listing, locale, name) ?? "";
  const path = resolve(file);
  if (!existsSync(path) || !statSync(path).isFile()) throw new CliError(`There is no ${file}.`);
  const account = serviceAccount(deps);
  const env = deps.env as Record<string, string | undefined>;
  const versionCode = await uploadAndroid(
    {
      packageName: build.store.ids.android,
      bundle: new Uint8Array(readFileSync(path)),
      ...(flags.listing
        ? {
            listings: locales.map((language) => ({
              language,
              title: text(language, "name.txt"),
              shortDescription: text(language, "subtitle.txt"),
              fullDescription: text(language, "description.txt"),
            })),
          }
        : {}),
      releaseNotes: locales.map((language) => ({
        language,
        text: text(language, "release-notes.txt"),
      })),
      draft: Boolean(flags.draft),
    },
    account,
    {
      ...(env.COS_ANDROID_STORE_API ? { api: env.COS_ANDROID_STORE_API } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    },
  );
  deps.io.out(
    `Sent ${build.store.ids.android} build ${versionCode} to the Android store's ${TESTING_TRACK} testing track${flags.listing ? ", with the listing" : ""}${flags.draft ? " (a draft release)" : ""}. Nothing is released to the public: a person does that in the store's console after the client's yes.`,
  );
  return 0;
}
