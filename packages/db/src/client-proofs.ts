// Proofs the host puts on what it hands a client by a name or by props (stage 66 step 4, review of
// PR #512, S1; hardening, #515; ADR 0615): a Durable Object's name, a web app's binding to
// ClientApp, an entrypoint minted for a gatekeeper, the app's binding to the runner, the host's
// bindings to cos-client-db's query path and each call on it. Each is an HMAC under one of the
// host's keys (never in a client's environment), so code that can reach a raw namespace or mint an
// entrypoint (`exports`, `ctx.exports`) still cannot make one that names another client: it does
// not hold the key, and the receiving side checks the proof before it decides the client.
//
// Two keys, because they rotate differently (#515, S4):
// - `COS_BINDING_KEY` names objects. An object's name is fixed for its life (its storage is found
//   by it), so this key is never rotated in place: a new key names new, empty objects.
// - `COS_PROPS_KEY` signs props (bindings' props set at deploy, entrypoints minted at run time)
//   and the calls on cos-client-db. Props are made again at every deploy or call, so it rotates:
//   the new key goes in `COS_PROPS_KEY`, the old one in `COS_PROPS_KEY_PREVIOUS`, which is still
//   accepted (never used to sign) until every binding has been redeployed with the new one.
// A client's proofs also bind its secret generation (registry_clients.secret_generation, written
// once when the client is added), so a proof made for a client id before it was removed is no
// proof for a client added later under the same id (#515, S3; the registry also refuses a reused
// id, registry migration 0794).
//
// Synchronous, because a Durable Object namespace's `idFromName` is: SHA-256 and HMAC written out
// here (FIPS 180-4, RFC 2104), checked against WebCrypto in packages/db/test/client-proofs.test.ts.

/** The key that names clients' objects: never rotated in place (see above). */
export const BINDING_KEY = "COS_BINDING_KEY";
/** The key that signs props and calls, and the one before a rotation (still accepted). */
export const PROPS_KEY = "COS_PROPS_KEY";
export const PROPS_KEY_PREVIOUS = "COS_PROPS_KEY_PREVIOUS";

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** SHA-256 of `data`. */
export function sha256(data: Uint8Array): Uint8Array {
  const length = data.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 2 ** 32));
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e as number, 6) ^ rotr(e as number, 11) ^ rotr(e as number, 25);
      const ch = ((e as number) & (f as number)) ^ (~(e as number) & (g as number));
      const t1 = ((hh as number) + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const s0 = rotr(a as number, 2) ^ rotr(a as number, 13) ^ rotr(a as number, 22);
      const maj =
        ((a as number) & (b as number)) ^
        ((a as number) & (c as number)) ^
        ((b as number) & (c as number));
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = ((d as number) + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh] as number[];
    for (let i = 0; i < 8; i++) h[i] = ((h[i] as number) + (next[i] as number)) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i] as number);
  return out;
}

const encoder = new TextEncoder();

/** HMAC-SHA256 of `message` under `key`. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = key.length > 64 ? sha256(key) : key;
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    const byte = block[i] ?? 0;
    inner[i] = byte ^ 0x36;
    outer[i] = byte ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function keyIn(env: object, name: string): string | null {
  const key = (env as Record<string, unknown>)[name];
  return typeof key === "string" && key.length >= 32 ? key : null;
}

/** The host's object-naming key from its real `env`, or null when it is not bound. */
export function hostBindingKey(env: object): string | null {
  return keyIn(env, BINDING_KEY);
}

/** The key props are signed with now, or null when it is not bound. */
export function hostPropsKey(env: object): string | null {
  return keyIn(env, PROPS_KEY);
}

/** Every key a props proof is accepted under: the current one, then the one before a rotation. */
export function acceptedPropsKeys(env: object): string[] {
  return [keyIn(env, PROPS_KEY), keyIn(env, PROPS_KEY_PREVIOUS)].filter(
    (key): key is string => key !== null,
  );
}

/** The environments a host serves its clients in (registry_clients.environment). */
const ENVIRONMENTS = ["live", "staging"] as const;
export type ProofEnvironment = (typeof ENVIRONMENTS)[number];

/**
 * The environment a Worker's `env` holds (`COS_HOST_ENVIRONMENT`: the host's Workers and
 * cos-client-db each have it), or null when it holds none or another value. Every props proof
 * binds it (review of #520, M4), so a staging host's proof is no proof on a live one even if the
 * two shared a key or a cos-client-db.
 */
export function proofEnvironment(env: object): ProofEnvironment | null {
  const value = (env as Record<string, unknown>).COS_HOST_ENVIRONMENT;
  return (ENVIRONMENTS as readonly unknown[]).includes(value) ? (value as ProofEnvironment) : null;
}

/**
 * Whether `proof` is a props proof of `parts` for `purpose`, in `env`'s environment, under a key
 * `env` accepts. False when `env` names no environment: nothing is accepted then.
 */
export function isPropsProof(
  env: object,
  proof: unknown,
  purpose: string,
  ...parts: string[]
): boolean {
  const environment = proofEnvironment(env);
  if (!environment) return false;
  return acceptedPropsKeys(env).some((key) =>
    isBindingProof(key, proof, purpose, environment, ...parts),
  );
}

/** A props proof of `parts` for `purpose`, in `env`'s environment, under its props key now. */
export function propsProof(env: object, purpose: string, ...parts: string[]): string {
  const key = hostPropsKey(env);
  if (!key) throw new Error(`${PROPS_KEY} is not bound: nothing can be minted`);
  const environment = proofEnvironment(env);
  if (!environment)
    throw new Error("COS_HOST_ENVIRONMENT is not live or staging: nothing can be minted");
  return bindingProof(key, purpose, environment, ...parts);
}

/** A client's secret generation as a proof binds it ("" for a client written before 0792). */
export function generationPart(generation: string | null | undefined): string {
  return typeof generation === "string" ? generation : "";
}

/**
 * The proof of `parts` for `purpose` under the host's key: 32 hex characters (128 bits of an
 * HMAC-SHA256), with each part separated so no two lists of parts give the same message.
 */
export function bindingProof(key: string, purpose: string, ...parts: string[]): string {
  const message = [purpose, ...parts].map((part) => `${part.length}:${part}`).join("\n");
  return hex(hmacSha256(encoder.encode(key), encoder.encode(message))).slice(0, 32);
}

/** Whether `proof` is the host's for `purpose` and `parts`, compared in constant time. */
export function isBindingProof(
  key: string | null,
  proof: unknown,
  purpose: string,
  ...parts: string[]
): boolean {
  if (!key || typeof proof !== "string" || proof.length !== 32) return false;
  const expected = bindingProof(key, purpose, ...parts);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) {
    difference |= expected.charCodeAt(i) ^ proof.charCodeAt(i);
  }
  return difference === 0;
}

/** What cos-app's binding to cos-runner says it is (its props, with the proof). */
export const RUNNER_CALLER = Object.freeze({ caller: "cos-app" });

/** The props of cos-app's binding to cos-runner, as the deploy engine writes them (step 7). */
export function runnerCallerProps(
  propsKey: string,
  environment: ProofEnvironment,
): { caller: string; proof: string } {
  return { ...RUNNER_CALLER, proof: bindingProof(propsKey, PROOF.runnerCaller, environment) };
}

/**
 * The props of a web app's binding to ClientApp, as the deploy writes them (step 8): the client,
 * its generation, and the proof of both.
 */
export function clientAppProps(
  propsKey: string,
  environment: ProofEnvironment,
  client: string,
  generation: string | null,
): { client: string; proof: string } {
  return {
    client,
    proof: bindingProof(propsKey, PROOF.clientApp, environment, client, generationPart(generation)),
  };
}

/** The Workers that may call cos-client-db's query path: the host's two (#515, S1). */
export const CLIENT_DB_CALLERS = Object.freeze(["cos-app", "cos-runner"] as const);
export type ClientDbCaller = (typeof CLIENT_DB_CALLERS)[number];

/**
 * The props of a host Worker's binding to cos-client-db's `ClientDbQueries`, as the deploy engine
 * writes them (step 7): `{ "binding": "CLIENT_DB_QUERIES", "service": "cos-client-db",
 * "entrypoint": "ClientDbQueries", "props": { "caller": "cos-app", "proof": … } }`.
 */
export function clientDbCallerProps(
  propsKey: string,
  environment: ProofEnvironment,
  caller: ClientDbCaller,
): { caller: ClientDbCaller; proof: string } {
  return { caller, proof: bindingProof(propsKey, PROOF.clientDbCaller, environment, caller) };
}

/** What each proof is for: one purpose a kind of thing, so a proof of one is never another's. */
export const PROOF = Object.freeze({
  /** A Durable Object's name: `<client>:<proof>:<name>`, of the client, its generation, the name. */
  object: "object",
  /** A web app's binding to ClientApp: `props: { client, proof }` of the client and generation. */
  clientApp: "client-app",
  /** An entrypoint the integration host mints for a gatekeeper. */
  callback: "callback",
  /** The app's binding to the runner: `props: { caller: "cos-app", proof }`. */
  runnerCaller: "runner-caller",
  /** A host Worker's binding to cos-client-db's query path: `props: { caller, proof }`. */
  clientDbCaller: "client-db-caller",
  /** One call on cos-client-db's query path, for one client: its target's `proof`. */
  clientDb: "client-db",
});
