// The operator's keys file (stage 66 step 7, ADR 0618): a fleet deployment's keys, made once by
// `cos fleet keys --out <file>` and read by every fleet deploy, because the props each host
// Worker's bindings carry are signed with the props key. Written only where the operator says,
// with mode 0600, never inside a git working tree (a repository is the one place a key must not
// end up), and never printed: the redactor is given every value as it is read.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { newHostKeys, publicKeyOf } from "@composable-os/db/registry-sealing";
import type { FleetKeys } from "@composable-os/release";

export const KEYS_FORMAT = "cos-fleet-keys/1";

export interface KeysFile extends FleetKeys {
  format: typeof KEYS_FORMAT;
  environment: "live" | "staging";
  /** Public: what the operator's command seals given secrets to. */
  secretsPublicKey: string;
  createdAt: string;
}

export class KeysError extends Error {}

/** The git working tree `path` is in, or null. */
export function workTreeOf(path: string): string | null {
  let dir = resolve(dirname(path));
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function randomKey(): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    // The host refuses a key of fewer than 16 distinct byte values (ADR 0616): draw again.
    if (new Set(bytes).size < 16) continue;
    return Buffer.from(bytes).toString("base64url");
  }
}

/** New keys for a fleet deployment (one environment's; staging and live never share). */
export async function newFleetKeys(environment: "live" | "staging"): Promise<KeysFile> {
  const host = await newHostKeys();
  const bindingKey = randomKey();
  let propsKey = randomKey();
  while (propsKey === bindingKey) propsKey = randomKey();
  return {
    format: KEYS_FORMAT,
    environment,
    rootKey: host.rootKey,
    secretsPrivateKey: host.secretsPrivateKey,
    secretsPublicKey: host.secretsPublicKey,
    bindingKey,
    propsKey,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Writes a new keys file at `path`: refused when one is there (a second set of keys would orphan
 * every client's objects and secrets), or when `path` is inside a git working tree.
 */
export function writeKeysFile(path: string, keys: KeysFile): void {
  const tree = workTreeOf(path);
  if (tree) {
    throw new KeysError(
      `${path} is inside the git working tree ${tree}: keep the keys file outside any repository`,
    );
  }
  if (existsSync(path)) {
    throw new KeysError(`${path} exists: a deployment's keys are made once; it is not replaced`);
  }
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

/** A SHA-256 of the root, binding and props keys, kept in the deployment's state. */
export function keysFingerprint(
  keys: Pick<FleetKeys, "rootKey" | "bindingKey" | "propsKey">,
): string {
  return createHash("sha256")
    .update(`cos/fleet-keys/v1\n${keys.rootKey}\n${keys.bindingKey}\n${keys.propsKey}`)
    .digest("hex");
}

/**
 * Why `keys` is not the keys file the deployment was installed with, or null when it is: its
 * sealing public key and its keys' fingerprint must be the state's. A different file would set new
 * keys on every Worker: every client's objects unreachable, every sealed secret unopenable.
 */
export function keysMismatch(
  fleet: { secretsPublicKey: string; keysFingerprint?: string },
  keys: KeysFile,
): string | null {
  if (keys.secretsPublicKey !== fleet.secretsPublicKey) {
    return "its sealing public key is not the one the deployment was installed with";
  }
  if (fleet.keysFingerprint && keysFingerprint(keys) !== fleet.keysFingerprint) {
    return "its root, binding or props key is not the one the deployment was installed with";
  }
  return null;
}

/** Reads and checks a keys file; every value goes to `redact` before anything else is done. */
export async function readKeysFile(
  path: string,
  redact: (value: string) => void,
): Promise<KeysFile> {
  if (!existsSync(path)) throw new KeysError(`no keys file at ${path}`);
  const mode = statSync(path).mode & 0o077;
  if (mode !== 0) {
    throw new KeysError(
      `${path} can be read by others (mode ${(statSync(path).mode & 0o777).toString(8)}): chmod 600 it`,
    );
  }
  let keys: KeysFile;
  try {
    keys = JSON.parse(readFileSync(path, "utf8")) as KeysFile;
  } catch {
    throw new KeysError(`${path} is not a keys file`);
  }
  for (const name of [
    "rootKey",
    "secretsPrivateKey",
    "secretsPrivateKeyPrevious",
    "bindingKey",
    "propsKey",
    "propsKeyPrevious",
  ] as const) {
    const value = keys[name];
    if (typeof value === "string") redact(value);
  }
  if (keys.format !== KEYS_FORMAT) throw new KeysError(`${path} is not a ${KEYS_FORMAT} file`);
  if (keys.bindingKey === keys.propsKey) {
    throw new KeysError("the binding key and the props key are one value: they must differ");
  }
  if ((await publicKeyOf(keys.secretsPrivateKey)).text !== keys.secretsPublicKey) {
    throw new KeysError("the keys file's public key is not its private key's");
  }
  return keys;
}
