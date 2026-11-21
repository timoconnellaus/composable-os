// The app's secure random source, from expo-crypto: React Native (Hermes) has no `crypto`, and
// every write the host module makes carries a random idempotency key (and staff browser sign-in a
// PKCE verifier). Passed to hostSession and staffSession (src/host.ts).
import * as Crypto from "expo-crypto";
import type { SecureRandom } from "./host.ts";

export const secureRandom: SecureRandom = {
  bytes: (n) => Crypto.getRandomBytes(n),
  sha256: async (text) =>
    new Uint8Array(
      await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new TextEncoder().encode(text)),
    ),
};
