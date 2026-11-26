// packages/db is type-checked with the Workers types only. Declare the small surface of
// `node:async_hooks` that client-entries.ts uses (`refreshOnEachCall`); the Workers that bundle it
// run with `nodejs_compat`, which provides it.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<Store> {
    getStore(): Store | undefined;
    run<Result>(store: Store, callback: () => Result): Result;
  }
}
