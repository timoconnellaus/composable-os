// How the client reads an answer that is not the surface's envelope (ADR 0418).
import { describe, expect, it } from "vitest";
import { ApiError, createClient, type FetchLike } from "../src/index.ts";

type Ops = { "thing.get": { kind: "query"; input: { id: string }; output: { id: string } } };
const specs = { "thing.get": { kind: "query", invalidates: [] } } as const;

function answering(status: number, text: string): FetchLike {
  return async () => ({ status, headers: { get: () => null }, text: async () => text });
}

describe("an answer that is not an envelope", () => {
  for (const text of ['"Bad gateway"', "42", "true", "null"]) {
    it(`raises an ApiError for the JSON ${text}`, async () => {
      const api = createClient<Ops>(specs, {
        baseUrl: "https://host",
        fetch: answering(200, text),
        retries: 0,
      });
      const error = await api.call("thing.get", { id: "a" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("internal");
      expect((error as ApiError).status).toBe(200);
    });
  }
});
