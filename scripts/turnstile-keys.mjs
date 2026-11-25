// Cloudflare's documented Turnstile test keys (stage 29, ADRs 0722 and 0728): site keys whose
// widget always passes, blocks or challenges, and secrets that always pass or fail. Local
// development uses them (scripts/dev-setup.mjs); a real deploy must never, since an always-passing
// secret turns the spam check off for good. scripts/deploy.mjs refuses them.

/** A site key (`1x00000000000000000000AA`) or a secret (`1x0000000000000000000000000000000AA`). */
const TEST_KEY = /^[1-3]x0{20,31}[A-F]{2}$/;

/** Whether `value` is one of Cloudflare's Turnstile test keys. */
export function isTurnstileTestKey(value) {
  return typeof value === "string" && TEST_KEY.test(value.trim());
}

/** The names among `env`'s Turnstile keys that hold a test key, for the deploy's refusal. */
export function turnstileTestKeysIn(env) {
  return ["TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY"].filter((name) =>
    isTurnstileTestKey(env[name]),
  );
}
