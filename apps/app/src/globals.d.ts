// Build-time constants injected by vite.config.ts (and vitest.config.ts for tests).
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;

// The shipped packs' staff screens (stage 47, ADR 0660), generated at build time by
// screens-plugin.ts: one lazy loader per screen, keyed `<pack>/<screen>`. Empty on the server.
declare module "virtual:cos-screens" {
  export const SCREENS: Readonly<
    Record<
      string,
      () => Promise<{
        Component: unknown;
        createHooks: unknown;
        calls: Readonly<Record<string, readonly string[]>>;
      }>
    >
  >;
  /** Every pack's hooks factory by pack id, for the development page (`/blocks`). */
  export const PACK_HOOKS: Readonly<
    Record<
      string,
      () => Promise<{ createHooks: unknown; calls: Readonly<Record<string, readonly string[]>> }>
    >
  >;
}

// Each shipped pack's screen gate fingerprint, as the build read the repository's packs
// (screens-plugin.ts): the host lists a pack's screens only when its installed manifest matches.
declare module "virtual:cos-screens-built" {
  export const BUILT_SCREENS: Readonly<Record<string, string>>;
}

// Node's AsyncLocalStorage, as workerd provides it under nodejs_compat (src/server/request-env.ts
// holds the request's environment in one). Only what the app uses: no Node types here.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
