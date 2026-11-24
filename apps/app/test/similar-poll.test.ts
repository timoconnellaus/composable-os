// The similar-records card stops asking a minute after it first saw its record not indexed
// (docs/cloudflare-costs.md): a record that is never indexed costs about twelve requests, not one
// every 5 seconds while its page is open.
import { describe, expect, it } from "vitest";
import {
  SIMILAR_POLL_FOR_MS,
  SIMILAR_POLL_MS,
  similarPollInterval,
} from "../src/components/ai/similar-records.tsx";

describe("the similar-records card's polling", () => {
  it("looks again while not indexed, for a minute, then stops", () => {
    expect(similarPollInterval("not_indexed", 0)).toBe(SIMILAR_POLL_MS);
    expect(similarPollInterval("not_indexed", SIMILAR_POLL_FOR_MS - 1)).toBe(SIMILAR_POLL_MS);
    expect(similarPollInterval("not_indexed", SIMILAR_POLL_FOR_MS)).toBe(false);
    expect(SIMILAR_POLL_FOR_MS).toBe(60_000);
  });

  it("does not poll once indexed or when search is off", () => {
    expect(similarPollInterval("ok", 0)).toBe(false);
    expect(similarPollInterval("unavailable", 0)).toBe(false);
    expect(similarPollInterval(undefined, 0)).toBe(false);
  });
});
