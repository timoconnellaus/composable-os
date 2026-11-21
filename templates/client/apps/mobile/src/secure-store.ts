// The device session's tokens, in the phone's secure store (the keychain, the keystore).
import type { TokenStore, Tokens } from "@composable-os/client";
import * as SecureStore from "expo-secure-store";

// A customer's session and a staff member's (ADR 0451) each have their own slot: a device holds
// at most one of each, and they never mix.
function slot(key: string): TokenStore {
  return {
    async load() {
      const value = await SecureStore.getItemAsync(key);
      return value ? (JSON.parse(value) as Tokens) : null;
    },
    async save(tokens) {
      if (tokens) await SecureStore.setItemAsync(key, JSON.stringify(tokens));
      else await SecureStore.deleteItemAsync(key);
    },
  };
}

/** The customer's device session. */
export const secureStore: TokenStore = slot("composable-os.session");
/** A staff member's device session (a pack role's, signed in through the system browser). */
export const staffSecureStore: TokenStore = slot("composable-os.staff-session");
