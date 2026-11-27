// The staff UI's reads while the host still installs its packs (issue #558): a read refused with
// `details.installing` is asked again every 5 s for up to 30 s; any other typed refusal is not.
import { describe, expect, it } from "vitest";
import { OperationCallError } from "../src/lib/operations.ts";
import { createQueryClient } from "../src/lib/query.ts";

const { retry, retryDelay } = createQueryClient().getDefaultOptions().queries as {
  retry: (failures: number, error: unknown) => boolean;
  retryDelay: (failures: number, error: unknown) => number;
};

const installing = new OperationCallError({
  code: "timeout",
  message: "This host is still installing its packs: try again in a few seconds",
  details: { installing: true, retryAfterSeconds: 5 },
});

describe("a read while the host installs its packs", () => {
  it("is retried every 5 s, six times (30 s)", () => {
    expect(retry(0, installing)).toBe(true);
    expect(retry(5, installing)).toBe(true);
    expect(retry(6, installing)).toBe(false);
    expect(retryDelay(0, installing)).toBe(5_000);
  });

  it("another typed refusal is still not retried", () => {
    expect(retry(0, new OperationCallError({ code: "timeout", message: "slow" }))).toBe(false);
    expect(retry(0, new OperationCallError({ code: "not_found", message: "none" }))).toBe(false);
  });
});
