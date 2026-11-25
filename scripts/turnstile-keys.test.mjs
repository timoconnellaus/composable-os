// The deploy refuses Cloudflare's Turnstile test keys (stage 29, review of PR #461).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isTurnstileTestKey, turnstileTestKeysIn } from "./turnstile-keys.mjs";

test("Cloudflare's documented test site keys and secrets are test keys", () => {
  for (const key of [
    "1x00000000000000000000AA",
    "2x00000000000000000000AB",
    "1x00000000000000000000BB",
    "2x00000000000000000000BB",
    "3x00000000000000000000FF",
    "1x0000000000000000000000000000000AA",
    "2x0000000000000000000000000000000AA",
    "3x0000000000000000000000000000000AA",
  ]) {
    assert.equal(isTurnstileTestKey(key), true, key);
  }
});

test("a real-looking key is not", () => {
  assert.equal(isTurnstileTestKey("0x4AAAAAAABkMYinukE8nzYS"), false);
  assert.equal(isTurnstileTestKey("0x4AAAAAAABkMYinukE8nzYS_secret_XXXXXXXXXXX"), false);
  assert.equal(isTurnstileTestKey(undefined), false);
});

test("names which of the two hold one", () => {
  assert.deepEqual(
    turnstileTestKeysIn({
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      TURNSTILE_SITE_KEY: "0x4AAAAAAABkMYinukE8nzYS",
    }),
    ["TURNSTILE_SECRET_KEY"],
  );
});
