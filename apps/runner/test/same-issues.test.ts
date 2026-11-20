// Stage 21, acceptance criterion 2 (ADR 0405): the host's `extension.check` reports, for the
// broken fixture extensions of @composable-os/extension-check, exactly the issues in
// fixtures/expected.json. packages/extension-check/test/check.test.ts holds `cos ext check` to the
// same file, so the command and the host report the same issues for the same source.
import type { ActingUser } from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import expected from "../../../packages/extension-check/test/fixtures/expected.json";
import { call, createAdmin } from "./helpers.ts";

const sources = import.meta.glob<string>(
  "../../../packages/extension-check/test/fixtures/*/index.ts",
  { query: "?raw", import: "default", eager: true },
);
const sourceOf = (id: string) => {
  const found = Object.entries(sources).find(([path]) => path.endsWith(`/${id}/index.ts`));
  if (!found) throw new Error(`No fixture ${id}`);
  return found[1];
};

let admin: ActingUser;

beforeAll(async () => {
  admin = await createAdmin();
});

describe("extension.check and cos ext check report the same issues", () => {
  for (const [id, issues] of Object.entries(expected)) {
    it(id, async () => {
      const check = await call<{ ok: boolean; issues: unknown[] }>(admin, "extension.check", {
        id,
        files: { "index.ts": sourceOf(id) },
      });
      expect(check.ok).toBe(false);
      expect(check.issues).toEqual(issues);
    });
  }
});
