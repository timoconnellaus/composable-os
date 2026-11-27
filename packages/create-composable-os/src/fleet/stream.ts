// Videos on a host of many clients (stage 66 step 9, ADR 0618 "The first client's day one", G10):
// the operator's one Cloudflare Stream account, shared by every client of the fleet. Each client's
// part of it is kept apart by the host (ADR 0617, `creatorCheckedVideoHost`): every upload and copy
// stamped with the client as its creator, every call and every playback token for a video another
// client created refused, every video made with signed URLs only, and no call that lists videos.
//
// `cos fleet install` takes the account's settings and keeps them with the deployment:
//   --stream-account-id <id> --stream-customer-code <code> --stream-signing-key-id <id>
//   --stream-token-file <f> --stream-jwk-file <f>
// The three ids are plain vars, written into the deployment's state (`vars` of the app Worker), so
// every later upload, `cos fleet upgrade` included, sets them again; the token and the signing key
// are the app Worker's secrets, set from their files on this install and kept by every later upload
// (`keep_bindings`). The five go together; a re-run with them replaces them. Nothing of the token or
// the key is printed.
import { readFileSync } from "node:fs";
import { CliError, type Flags, str } from "../main.ts";

/** The Stream settings of a fleet: the vars kept in its state, the secrets set on the app Worker. */
export interface StreamSettings {
  vars: { STREAM_ACCOUNT_ID: string; STREAM_CUSTOMER_CODE: string; STREAM_SIGNING_KEY_ID: string };
  secrets: { STREAM_API_TOKEN: string; STREAM_SIGNING_JWK: string };
}

export const STREAM_FLAGS = [
  "stream-account-id",
  "stream-customer-code",
  "stream-signing-key-id",
  "stream-token-file",
  "stream-jwk-file",
] as const;

const HEX32 = /^[0-9a-f]{32}$/;

/** A secret file's value: one trailing line break dropped; never part of an error. */
function secretFile(path: string, what: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new CliError(`${what}: ${path} cannot be read`);
  }
  return text.replace(/\r?\n$/, "");
}

/** Whether `text` is a Stream signing key's JWK: its JSON, or that JSON base64 as Stream gives it. */
export function isSigningJwk(text: string): boolean {
  const trimmed = text.trim();
  let json: string;
  if (trimmed.startsWith("{")) json = trimmed;
  else {
    if (!/^[A-Za-z0-9+/_=-]+$/.test(trimmed)) return false;
    json = Buffer.from(trimmed, "base64").toString("utf8");
  }
  try {
    const key = JSON.parse(json) as Record<string, unknown>;
    // The private RSA key Stream makes: what the host signs playback tokens with.
    return key.kty === "RSA" && typeof key.n === "string" && typeof key.d === "string";
  } catch {
    return false;
  }
}

/**
 * The Stream settings `cos fleet install`'s flags give, checked, or null when none is given. All
 * five or none: half a configuration plays nothing and is refused before anything changes.
 */
export function streamSettingsOf(
  flags: Flags,
  redact: (value: string) => void,
): StreamSettings | null {
  const given = STREAM_FLAGS.filter((f) => str(flags, f) !== undefined);
  if (!given.length) return null;
  const missing = STREAM_FLAGS.filter((f) => str(flags, f) === undefined);
  if (missing.length) {
    throw new CliError(
      `Stream's settings go together: ${missing.map((f) => `--${f}`).join(", ")} ${missing.length > 1 ? "are" : "is"} missing. Nothing was changed.`,
    );
  }
  const accountId = str(flags, "stream-account-id") as string;
  const customerCode = str(flags, "stream-customer-code") as string;
  const keyId = str(flags, "stream-signing-key-id") as string;
  if (!HEX32.test(accountId)) throw new CliError("--stream-account-id is 32 hex characters");
  if (!HEX32.test(keyId)) throw new CliError("--stream-signing-key-id is 32 hex characters");
  if (!/^[a-z0-9]{4,64}$/.test(customerCode)) {
    throw new CliError(
      "--stream-customer-code is the <code> of customer-<code>.cloudflarestream.com",
    );
  }
  const token = secretFile(str(flags, "stream-token-file") as string, "--stream-token-file");
  const jwk = secretFile(str(flags, "stream-jwk-file") as string, "--stream-jwk-file");
  redact(token);
  redact(jwk);
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
    throw new CliError("--stream-token-file does not hold an API token (one line, no spaces)");
  }
  if (!isSigningJwk(jwk)) {
    throw new CliError(
      "--stream-jwk-file does not hold a Stream signing key's JWK (POST /stream/keys' result.jwk)",
    );
  }
  return {
    vars: {
      STREAM_ACCOUNT_ID: accountId,
      STREAM_CUSTOMER_CODE: customerCode,
      STREAM_SIGNING_KEY_ID: keyId,
    },
    secrets: { STREAM_API_TOKEN: token, STREAM_SIGNING_JWK: jwk },
  };
}
