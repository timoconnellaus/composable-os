// The little of the Fetch API the client uses, declared here so the runtime depends on no
// platform's types (ADR 0418). The global `fetch` of a browser, a Worker, Node and React Native
// all fit `FetchLike`, and so does a Worker's service binding (`env.HOST.fetch`).

export interface ResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

/** Plain JSON, as the surface sends it. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
