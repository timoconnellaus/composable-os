// Videos in Cloudflare Stream (stage 42, ADR 0475, ADR 0476): the provider interface the media
// library talks to, the token the host signs for one playback, and the real provider over
// Stream's REST API. The fake one, for tests and local development, is `stream-fake.ts`.
//
// Stream is on the deployment's own Cloudflare account. The host reaches it itself, as it reaches
// R2 and Cloudflare Images, rather than through a gatekeeper: no extension, model or client can
// call it (only the media operations do), and signing a playback token must not cost a call to
// anything. Its credentials are the host's own Worker secrets (STREAM_API_TOKEN, the signing key),
// set by a person at deploy time, never stored in the database and never configurable by an AI.
// See ADR 0475 for why the Workers binding is not used.
//
// Every video is created with `requireSignedURLs: true`, and nothing in the host can turn it off:
// a Stream id alone plays nothing. A token is bound to one video (`sub`), lives at most an hour
// (Stream allows 24), and never allows a download (no `downloadable` claim).
import { OperationError } from "../errors.ts";

/** What Stream says about one video, in the host's words. */
export interface StreamVideoDetails {
  uid: string;
  /** uploading: no file yet; processing: Stream is encoding it; ready: it plays; failed. */
  state: "uploading" | "processing" | "ready" | "failed";
  /** Why it failed: Stream's reason code. */
  reason: string | null;
  /** Seconds, once known. */
  duration: number | null;
  width: number | null;
  height: number | null;
  /** Whether a token is needed to play it. The host makes every video so. */
  requireSignedURLs: boolean;
}

/** One caption track as Stream lists it. */
export interface StreamCaption {
  language: string;
  label: string;
  generated: boolean;
  state: "processing" | "ready" | "failed";
}

/** A one-time address the staff browser sends the file to. */
export interface StreamUpload {
  uid: string;
  url: string;
  /** `tus`: resumable, for any size (chunks of `chunkBytes`); `post`: one form post, small files. */
  protocol: "tus" | "post";
  chunkBytes: number;
}

/** The calls the media library makes to Stream. */
export interface StreamProvider {
  readonly name: "stream" | "fake";
  /**
   * A one-time direct upload address for one file of `bytes` bytes, for a video that requires a
   * signed token to play and may be played only from `allowedOrigins`. The address stops at
   * `expiresAt`.
   */
  createUpload(input: {
    name: string;
    bytes: number;
    maxDurationSeconds: number;
    allowedOrigins: readonly string[];
    expiresAt: string;
  }): Promise<StreamUpload>;
  /** Stream copies the video from an address (the import's way in). */
  copyFromUrl(input: {
    url: string;
    name: string;
    allowedOrigins: readonly string[];
  }): Promise<{ uid: string }>;
  /** The video's state, or null when Stream has no such video. */
  details(uid: string): Promise<StreamVideoDetails | null>;
  /** Makes it require a signed token again, and play only from these origins. */
  secure(uid: string, allowedOrigins: readonly string[]): Promise<void>;
  /** Deletes the video and its copies. Deleting one that is gone already is not a failure. */
  delete(uid: string): Promise<void>;
  /** Adds or replaces a WebVTT caption track. */
  uploadCaption(uid: string, language: string, vtt: Uint8Array): Promise<void>;
  /** Asks Stream to generate a caption track in a language it supports. */
  generateCaption(uid: string, language: string): Promise<StreamCaption>;
  deleteCaption(uid: string, language: string): Promise<void>;
  listCaptions(uid: string): Promise<StreamCaption[]>;
}

/** Signs a playback token for one video. */
export interface StreamSigner {
  sign(input: { uid: string; expiresAt: Date; notBefore?: Date }): Promise<string>;
}

/** Where a token plays. */
export interface StreamPlayback {
  /** HLS, for every player (a phone's, hls.js on the web). */
  hls: string;
  dash: string;
  /** Stream's own player in an iframe. */
  iframe: string;
  /** The poster frame Stream made. */
  thumbnail: string;
}

/** Everything the host needs to hold videos. */
export interface VideoHost {
  readonly provider: StreamProvider;
  readonly signer: StreamSigner;
  playback(token: string): StreamPlayback;
  /** The hostnames a video may be played from: the company's web origins and the host's. */
  readonly allowedOrigins: readonly string[];
}

/** The longest a playback token lives: an hour (Stream allows 24). */
export const PLAYBACK_MAX_SECONDS = 3600;
/** A direct upload address stops after this long. */
export const UPLOAD_ADDRESS_SECONDS = 6 * 3600;
/** Above this a direct upload is resumable (tus); Stream's basic upload takes at most 200 MB. */
export const BASIC_UPLOAD_MAX_BYTES = 200 * 1000 * 1000;
/** tus chunks: a multiple of 256 KiB, at least 5 MiB (Stream's rule). 50 MiB. */
export const TUS_CHUNK_BYTES = 200 * 256 * 1024;

let host: VideoHost | undefined;

/**
 * Sets the deployment's video host for this isolate: once, from the Worker's env, in each
 * entrypoint that runs the media operations (cos-app, cos-runner). Tests set a fake.
 */
export function setVideoHost(value: VideoHost | undefined): void {
  host = value;
}

/** The video host, or undefined where Stream is not configured. */
export function videoHost(): VideoHost | undefined {
  return host;
}

/** The video host, or the configuration error. */
export function requireVideoHost(): VideoHost {
  if (!host) {
    throw new OperationError("config", "Video is not configured here: set up Cloudflare Stream", {
      reason: "stream_not_configured",
    });
  }
  return host;
}

// --- Tokens ---------------------------------------------------------------------------------------

const encoder = new TextEncoder();

/** base64url of bytes, no padding. */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Bytes of base64url (or base64) text. */
export function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/**
 * A signer from a Stream signing key: its id and its JWK, as `POST /stream/keys` returns them
 * (`jwk` base64-encoded) or as the JWK's JSON. Stream verifies the token itself (RS256, `kid` in
 * the header and the claims, the video's id as `sub`, `exp` in seconds), so playing costs no call
 * to Stream's token API.
 */
export function streamSigner(keyId: string, jwk: string | JsonWebKey): StreamSigner {
  let key: Promise<CryptoKey> | undefined;
  const load = () => {
    key ??= crypto.subtle.importKey(
      "jwk",
      typeof jwk === "string" ? parseJwk(jwk) : jwk,
      RS256,
      false,
      ["sign"],
    );
    return key;
  };
  return {
    async sign({ uid, expiresAt, notBefore }) {
      const header = { alg: "RS256", kid: keyId };
      const claims = {
        sub: uid,
        kid: keyId,
        exp: Math.floor(expiresAt.getTime() / 1000),
        ...(notBefore ? { nbf: Math.floor(notBefore.getTime() / 1000) } : {}),
      };
      const unsigned = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(
        encoder.encode(JSON.stringify(claims)),
      )}`;
      const signature = await crypto.subtle.sign(RS256, await load(), encoder.encode(unsigned));
      return `${unsigned}.${base64url(new Uint8Array(signature))}`;
    },
  };
}

function parseJwk(text: string): JsonWebKey {
  const trimmed = text.trim();
  const json = trimmed.startsWith("{") ? trimmed : new TextDecoder().decode(fromBase64url(trimmed));
  return JSON.parse(json) as JsonWebKey;
}

/** The claims of a token, unverified: for the fake and for tests. */
export function tokenClaims(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(part))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Playback addresses on the account's customer subdomain: the token in place of the id. */
export function streamPlayback(customerCode: string, token: string): StreamPlayback {
  const base = `https://customer-${customerCode}.cloudflarestream.com/${encodeURIComponent(token)}`;
  return {
    hls: `${base}/manifest/video.m3u8`,
    dash: `${base}/manifest/video.mpd`,
    iframe: `${base}/iframe`,
    thumbnail: `${base}/thumbnails/thumbnail.jpg`,
  };
}

// --- The real provider: Stream's REST API ------------------------------------------------------

/** What the real provider needs: the account, an API token with Stream Write, and `fetch`. */
export interface StreamApiOptions {
  accountId: string;
  apiToken: string;
  /** Tests point it elsewhere; default https://api.cloudflare.com/client/v4. */
  apiBase?: string;
  fetch?: typeof fetch;
}

interface ApiEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: { code?: number; message?: string }[];
}

interface ApiVideo {
  uid?: string;
  readyToStream?: boolean;
  status?: { state?: string; errorReasonCode?: string; errReasonCode?: string };
  duration?: number;
  input?: { width?: number; height?: number };
  requireSignedURLs?: boolean;
}

interface ApiCaption {
  language?: string;
  label?: string;
  generated?: boolean;
  status?: string;
}

const known = (n: number | undefined) => (typeof n === "number" && n >= 0 ? n : null);

function toDetails(uid: string, video: ApiVideo): StreamVideoDetails {
  const state = video.status?.state ?? "";
  return {
    uid,
    state:
      state === "ready" || video.readyToStream
        ? "ready"
        : state === "error"
          ? "failed"
          : state === "pendingupload"
            ? "uploading"
            : "processing",
    reason: video.status?.errorReasonCode || video.status?.errReasonCode || null,
    duration: known(video.duration),
    width: known(video.input?.width),
    height: known(video.input?.height),
    requireSignedURLs: video.requireSignedURLs === true,
  };
}

function toCaption(caption: ApiCaption): StreamCaption {
  return {
    language: String(caption.language ?? ""),
    label: String(caption.label ?? caption.language ?? ""),
    generated: caption.generated === true,
    state:
      caption.status === "inprogress"
        ? "processing"
        : caption.status === "error"
          ? "failed"
          : "ready",
  };
}

/** tus `Upload-Metadata`: `key base64(value)` pairs, a bare key for a flag. */
function tusMetadata(pairs: [string, string | true][]): string {
  return pairs
    .map(([key, value]) =>
      value === true ? key : `${key} ${btoa(String.fromCharCode(...encoder.encode(value)))}`,
    )
    .join(",");
}

/**
 * The provider over Stream's REST API (developers.cloudflare.com/api/resources/stream, checked
 * 2026-11-22; ADR 0475 lists each call and its source).
 */
export function streamApiProvider(options: StreamApiOptions): StreamProvider {
  const base = `${(options.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "")}/accounts/${encodeURIComponent(options.accountId)}/stream`;
  const doFetch = options.fetch ?? fetch;
  const auth = { authorization: `Bearer ${options.apiToken}` };

  async function call<T>(
    path: string,
    init: RequestInit & { allow404?: boolean } = {},
  ): Promise<T | null> {
    const response = await doFetch(`${base}${path}`, {
      ...init,
      headers: { ...auth, ...(init.headers as Record<string, string> | undefined) },
    });
    if (response.status === 404 && init.allow404) return null;
    const body = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;
    if (!response.ok || body.success === false) {
      const message = body.errors?.[0]?.message ?? `Stream answered ${response.status}`;
      throw new OperationError("integration_error", `Cloudflare Stream: ${message}`, {
        reason: "stream",
        status: response.status,
      });
    }
    return (body.result ?? null) as T | null;
  }
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    name: "stream",
    async createUpload(input) {
      if (input.bytes <= BASIC_UPLOAD_MAX_BYTES) {
        // POST /stream/direct_upload: a one-time address for one form post of the file.
        const result = await call<{ uid?: string; uploadURL?: string }>("/direct_upload", {
          ...json({
            maxDurationSeconds: input.maxDurationSeconds,
            requireSignedURLs: true,
            allowedOrigins: input.allowedOrigins,
            expiry: input.expiresAt,
            meta: { name: input.name },
          }),
        });
        if (!result?.uid || !result.uploadURL) {
          throw new OperationError("integration_error", "Cloudflare Stream gave no upload address");
        }
        return {
          uid: result.uid,
          url: result.uploadURL,
          protocol: "post",
          chunkBytes: input.bytes,
        };
      }
      // POST /stream?direct_user=true (tus): the one-time address is the Location header and
      // the video's id is the stream-media-id header.
      const response = await doFetch(`${base}?direct_user=true`, {
        method: "POST",
        headers: {
          ...auth,
          "Tus-Resumable": "1.0.0",
          "Upload-Length": String(input.bytes),
          "Upload-Metadata": tusMetadata([
            ["name", input.name],
            ["requiresignedurls", true],
            ["maxDurationSeconds", String(input.maxDurationSeconds)],
            ["expiry", input.expiresAt],
            ...(input.allowedOrigins.length
              ? [["allowedorigins", input.allowedOrigins.join(",")] as [string, string]]
              : []),
          ]),
        },
      });
      const url = response.headers.get("location");
      const uid = response.headers.get("stream-media-id");
      if (!response.ok || !url || !uid) {
        throw new OperationError(
          "integration_error",
          `Cloudflare Stream answered ${response.status}`,
          {
            reason: "stream",
            status: response.status,
          },
        );
      }
      return { uid, url, protocol: "tus", chunkBytes: TUS_CHUNK_BYTES };
    },
    async copyFromUrl(input) {
      const result = await call<{ uid?: string }>("/copy", {
        ...json({
          url: input.url,
          meta: { name: input.name },
          requireSignedURLs: true,
          allowedOrigins: input.allowedOrigins,
        }),
      });
      if (!result?.uid)
        throw new OperationError("integration_error", "Cloudflare Stream gave no video id");
      return { uid: result.uid };
    },
    async details(uid) {
      const video = await call<ApiVideo>(`/${encodeURIComponent(uid)}`, { allow404: true });
      return video ? toDetails(uid, video) : null;
    },
    async secure(uid, allowedOrigins) {
      await call(`/${encodeURIComponent(uid)}`, {
        ...json({ uid, requireSignedURLs: true, allowedOrigins }),
      });
    },
    async delete(uid) {
      await call(`/${encodeURIComponent(uid)}`, { method: "DELETE", allow404: true });
    },
    async uploadCaption(uid, language, vtt) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(vtt)], { type: "text/vtt" }), `${language}.vtt`);
      await call(`/${encodeURIComponent(uid)}/captions/${encodeURIComponent(language)}`, {
        method: "PUT",
        body: form,
      });
    },
    async generateCaption(uid, language) {
      const result = await call<ApiCaption>(
        `/${encodeURIComponent(uid)}/captions/${encodeURIComponent(language)}/generate`,
        { method: "POST" },
      );
      return toCaption({ language, ...(result ?? {}), generated: true });
    },
    async deleteCaption(uid, language) {
      await call(`/${encodeURIComponent(uid)}/captions/${encodeURIComponent(language)}`, {
        method: "DELETE",
        allow404: true,
      });
    },
    async listCaptions(uid) {
      const result = await call<ApiCaption[]>(`/${encodeURIComponent(uid)}/captions`);
      return (result ?? []).map(toCaption);
    },
  };
}

/** The env a Worker that holds videos reads (ADR 0475). Secrets are never in the database. */
export interface StreamEnv {
  /** The Cloudflare account Stream is on (a var). */
  STREAM_ACCOUNT_ID?: string;
  /** The account's playback subdomain: `customer-<code>.cloudflarestream.com` (a var). */
  STREAM_CUSTOMER_CODE?: string;
  /** An API token with Stream Write on that account (a secret). */
  STREAM_API_TOKEN?: string;
  /** The signing key's id (a var) and its JWK as Stream returned it (a secret). */
  STREAM_SIGNING_KEY_ID?: string;
  STREAM_SIGNING_JWK?: string;
  /** Hostnames a video may be played from, comma separated; empty: derived from the deployment. */
  STREAM_ALLOWED_ORIGINS?: string;
}

/** Hostnames (`example.com`) of origins (`https://example.com`), for Stream's allowedOrigins. */
export function streamHostnames(origins: readonly (string | undefined)[]): string[] {
  const names = new Set<string>();
  for (const origin of origins) {
    for (const part of (origin ?? "").split(",")) {
      const value = part.trim();
      if (!value) continue;
      try {
        names.add(new URL(value.includes("://") ? value : `https://${value}`).hostname);
      } catch {
        // Not an origin: left out.
      }
    }
  }
  return [...names].sort();
}

/**
 * The real video host from a Worker's env, or undefined while Stream is not set up (any part
 * missing). `origins` are the deployment's own (the host's and the company's web apps').
 */
export function streamHostFromEnv(
  env: StreamEnv,
  origins: readonly (string | undefined)[] = [],
): VideoHost | undefined {
  const { STREAM_ACCOUNT_ID, STREAM_CUSTOMER_CODE, STREAM_API_TOKEN } = env;
  const { STREAM_SIGNING_KEY_ID, STREAM_SIGNING_JWK } = env;
  if (
    !STREAM_ACCOUNT_ID ||
    !STREAM_CUSTOMER_CODE ||
    !STREAM_API_TOKEN ||
    !STREAM_SIGNING_KEY_ID ||
    !STREAM_SIGNING_JWK
  ) {
    return undefined;
  }
  const allowed = streamHostnames(
    env.STREAM_ALLOWED_ORIGINS ? [env.STREAM_ALLOWED_ORIGINS] : origins,
  );
  return {
    provider: streamApiProvider({ accountId: STREAM_ACCOUNT_ID, apiToken: STREAM_API_TOKEN }),
    signer: streamSigner(STREAM_SIGNING_KEY_ID, STREAM_SIGNING_JWK),
    playback: (token) => streamPlayback(STREAM_CUSTOMER_CODE, token),
    allowedOrigins: allowed,
  };
}
