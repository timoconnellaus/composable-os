// The similar-records card stops asking after a minute (docs/cloudflare-costs.md): a record that
// is never indexed costs twelve requests, not one every 5 seconds while its page is open.
import { describe, expect, it } from "vitest";
import {
  SIMILAR_POLL_MS,
  SIMILAR_POLLS,
  similarPollInterval,
} from "../src/components/ai/similar-records.tsx";

describe("the similar-records card's polling", () => {
  it("looks again while not indexed, for a minute, then stops", () => {
    expect(similarPollInterval("not_indexed", 1)).toBe(SIMILAR_POLL_MS);
    expect(similarPollInterval("not_indexed", SIMILAR_POLLS - 1)).toBe(SIMILAR_POLL_MS);
    expect(similarPollInterval("not_indexed", SIMILAR_POLLS)).toBe(false);
    expect(SIMILAR_POLLS * SIMILAR_POLL_MS).toBe(60_000);
  });

  it("does not poll once indexed or when search is off", () => {
    expect(similarPollInterval("ok", 1)).toBe(false);
    expect(similarPollInterval("unavailable", 1)).toBe(false);
    expect(similarPollInterval(undefined, 0)).toBe(false);
  });
});
