import { defineConfig } from "vitest/config";

// Node, not workerd: this is the cos command's side of the check. The same fixtures go through
// the host's extension.check in apps/runner/test/same-issues.test.ts.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 60_000 } });
