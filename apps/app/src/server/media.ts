// The media library's storage in cos-app (stage 28, ADR 0444): originals in the R2 bucket the
// host already binds (`BLOBS`, under `media/`), and Cloudflare Images for the sizes a client asks
// for, when the deployment binds it as `IMAGES`. Without `IMAGES` the original is served.
import {
  createFakeStream,
  creatorCheckedVideoHost,
  type MediaResizer,
  type MediaStore,
  type StreamEnv,
  streamHostFromEnv,
  type VideoHost,
} from "@composable-os/core";
import { clientStampOf } from "@composable-os/db/client-environment";
import { requestEnv } from "./request-env.ts";

/** The part of Cloudflare's Images binding this uses. */
interface ImagesBinding {
  input(stream: ReadableStream): {
    transform(options: { width: number }): {
      output(options: { format: string }): Promise<{ response(): Response }>;
    };
  };
}

export interface MediaEnv {
  BLOBS?: R2Bucket;
  /** Cloudflare Images (optional): `"images": { "binding": "IMAGES" }` in wrangler.jsonc. */
  IMAGES?: ImagesBinding;
}

export function mediaStoreFor(env: MediaEnv): MediaStore | undefined {
  const bucket = env.BLOBS;
  if (!bucket) return undefined;
  return {
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
}

/** What cos-app reads to hold videos in Cloudflare Stream (stage 42, ADR 0475). */
export interface VideoEnv extends StreamEnv {
  /** "true": the fake Stream, for local development only (never in a deployment). */
  STREAM_FAKE?: string;
  BETTER_AUTH_URL?: string;
  CUSTOMER_AUTH_URL?: string;
  API_ALLOWED_ORIGINS?: string;
}

/**
 * The deployment's video host: Cloudflare Stream on its own account once a person has set its
 * vars and secrets (docs/stream-runbook.md), the fake one in local development, else none (the
 * video operations then say video is not configured). Videos play only from the host's origin
 * and the company's web apps'.
 */
export function videoHostFor(env: VideoEnv): VideoHost | undefined {
  const hostUrl = env.BETTER_AUTH_URL || "http://localhost:5173";
  if (env.STREAM_FAKE === "true") {
    return createFakeStream({ baseUrl: `${hostUrl.replace(/\/+$/, "")}/api/v1/media/fake-stream` });
  }
  return streamHostFromEnv(env, [
    env.BETTER_AUTH_URL,
    env.CUSTOMER_AUTH_URL,
    env.API_ALLOWED_ORIGINS,
  ]);
}

/**
 * One client's video host on a host that serves many (stage 66 step 5, ADR 0617): Stream on the
 * account the operator's own token and signing key reach (`deployment`, the host's own env: a
 * client's environment never holds them), playing only from the client's own addresses
 * (`clientEnv`), with the client stamped as the creator of every upload and copy and every call
 * for another creator's video refused. Undefined while Stream is not set up.
 */
export function clientVideoHost(
  deployment: VideoEnv,
  clientEnv: VideoEnv,
  client: string,
): VideoHost | undefined {
  const shared = videoHostFor({
    STREAM_FAKE: deployment.STREAM_FAKE,
    STREAM_ACCOUNT_ID: deployment.STREAM_ACCOUNT_ID,
    STREAM_CUSTOMER_CODE: deployment.STREAM_CUSTOMER_CODE,
    STREAM_API_TOKEN: deployment.STREAM_API_TOKEN,
    STREAM_SIGNING_KEY_ID: deployment.STREAM_SIGNING_KEY_ID,
    STREAM_SIGNING_JWK: deployment.STREAM_SIGNING_JWK,
    // The client's own: where its videos may play.
    STREAM_ALLOWED_ORIGINS: clientEnv.STREAM_ALLOWED_ORIGINS,
    BETTER_AUTH_URL: clientEnv.BETTER_AUTH_URL,
    CUSTOMER_AUTH_URL: clientEnv.CUSTOMER_AUTH_URL,
    API_ALLOWED_ORIGINS: clientEnv.API_ALLOWED_ORIGINS,
  });
  return shared && creatorCheckedVideoHost(shared, client);
}

/**
 * How a many-client host finds the current client's video host (`setVideoHostResolver`): the
 * request's client environment's, made once per environment from `deployment` (the host's own
 * env, read at load by the entry module).
 */
export function clientVideoHosts(deployment: VideoEnv): () => VideoHost | undefined {
  const hosts = new WeakMap<object, { host: VideoHost | undefined }>();
  return () => {
    const env = requestEnv();
    let held = hosts.get(env);
    if (!held) {
      const client = clientStampOf(env);
      held = {
        host: client ? clientVideoHost(deployment, env as unknown as VideoEnv, client) : undefined,
      };
      hosts.set(env, held);
    }
    return held.host;
  };
}

/** Pictures smaller than their original, from Cloudflare Images; the original's type kept. */
export function mediaResizerFor(env: MediaEnv): MediaResizer | undefined {
  const images = env.IMAGES;
  if (!images) return undefined;
  return {
    async resize(body, { width, type }) {
      const result = await images.input(body).transform({ width }).output({ format: type });
      const response = result.response();
      if (!response.body) throw new Error("Cloudflare Images returned no picture");
      return { body: response.body, type: response.headers.get("content-type") ?? type };
    },
  };
}
