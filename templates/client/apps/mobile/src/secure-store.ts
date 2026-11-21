// The device session's tokens, in the phone's secure store (the keychain, the keystore).
import type { TokenStore, Tokens } from "@composable-os/client";
import * as SecureStore from "expo-secure-store";

const KEY = "composable-os.session";

export const secureStore: TokenStore = {
  async load() {
    const value = await SecureStore.getItemAsync(KEY);
    return value ? (JSON.parse(value) as Tokens) : null;
  },
  async save(tokens) {
    if (tokens) await SecureStore.setItemAsync(KEY, JSON.stringify(tokens));
    else await SecureStore.deleteItemAsync(KEY);
  },
};
