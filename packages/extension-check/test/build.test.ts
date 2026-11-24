// buildExtension's import rules: the same as the type check's (src/resolve.ts).
import { describe, expect, it } from "vitest";
import { buildExtension } from "../src/build.ts";

describe("buildExtension", () => {
  it("resolves an own file named with .js to its .ts, as the type check does", () => {
    const built = buildExtension({
      "index.ts": 'import { b } from "./util.js";\nexport default b;',
      "util.ts": "export const b = 2;",
    });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.modules["index.js"]).toContain('from "./util.js"');
  });

  it("resolves a nested file and refuses one outside the extension", () => {
    const built = buildExtension({
      "index.ts": 'import { a } from "./lib";\nimport { x } from "../x";\nexport default a + x;',
      "lib/index.ts": 'export { a } from "../tools/a.ts";',
      "tools/a.ts": "export const a = 1;",
    });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.issues).toEqual([
        {
          code: "import",
          path: "index.ts",
          message: 'Cannot import "../x": not a file of this extension',
        },
      ]);
    }
  });
});
