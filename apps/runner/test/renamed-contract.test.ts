// Stage 20 (ADR 0400): the extension contract no longer says `crm`. Code written against the old
// contract is refused, and the refusal names the new form (acceptance criterion 5).
import {
  OLD_OPS_MODULE,
  OLD_OPS_SPECIFIER,
  OLD_VIEW_PREFIX,
  renamedMessage,
  renamedView,
  validateManifest,
} from "@composable-os/sdk";
import { describe, expect, it } from "vitest";
import { buildExtension } from "../src/extensions/build.ts";
import { buildScript } from "../src/extensions/code-mode.ts";
import { typecheckExtension } from "../src/extensions/typecheck.ts";

const manifest = (modules: string[]) => ({
  id: "fixture",
  label: "Fixture",
  version: "1.0.0",
  contractVersion: 1,
  permissions: { read: ["person"], modules },
});

describe("an extension written against the old contract", () => {
  it("is refused at build when it imports the old host module, naming codemode:ops and ctx.ops", () => {
    const built = buildExtension({
      "index.ts": `import { defineExtension } from "@composable-os/sdk";
import { ${OLD_OPS_MODULE} } from "${OLD_OPS_SPECIFIER}";
export default defineExtension(${JSON.stringify(manifest(["ops"]))});
export const people = () => ${OLD_OPS_MODULE}.call("person.list", {});
`,
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.issues).toHaveLength(1);
    expect(built.issues[0]).toMatchObject({ code: "import", path: "index.ts" });
    expect(built.issues[0]?.message).toContain(`"${OLD_OPS_SPECIFIER}" was renamed "codemode:ops"`);
    expect(built.issues[0]?.message).toContain("ctx.ops");
  });

  it("is refused by the manifest check when it declares the old module, naming ops", () => {
    const old = validateManifest(manifest([OLD_OPS_MODULE]));
    const messages = old.issues.map((issue) => issue.message).join("\n");
    expect(messages).toContain(`The "${OLD_OPS_MODULE}" module was renamed "ops"`);
    expect(validateManifest(manifest(["ops"])).issues).toEqual([]);
  });

  it("does not type-check when a tool calls the old context module", () => {
    const source = (module: string) => ({
      "index.ts": `import { defineExtension, defineTool, z } from "@composable-os/sdk";
const people = defineTool({
  description: "Lists people",
  risk: "read",
  input: z.object({}),
  output: z.object({ count: z.number() }),
  async handler(_input, ctx) {
    const page = (await ctx.${module}.call("person.list", {})) as { items: unknown[] };
    return { count: page.items.length };
  },
});
export default defineExtension({
  id: "fixture",
  version: "1.0.0",
  contractVersion: 1,
  label: "Fixture",
  permissions: { read: ["person"], modules: ["ops"] },
  tools: { people },
});
`,
    });
    expect(typecheckExtension(source("ops"))).toEqual([]);
    const issues = typecheckExtension(source(OLD_OPS_MODULE));
    expect(issues.map((i) => i.message).join("\n")).toMatch(
      new RegExp(`Property '${OLD_OPS_MODULE}' does not exist`),
    );
  });
});

describe("a Code Mode script written against the old contract", () => {
  it("is refused when it imports the old module, naming the new import", () => {
    const built = buildScript(
      `import { ${OLD_OPS_MODULE} } from "${OLD_OPS_SPECIFIER}";\nexport default () => ${OLD_OPS_MODULE}.call("person.list", {});`,
    );
    expect(built).toEqual({
      ok: false,
      message: `"${OLD_OPS_SPECIFIER}" was renamed: import { ops } from "codemode:ops" and call ops.call(…)`,
    });
    expect(
      buildScript(
        `import { ops } from "codemode:ops";\nexport default () => ops.call("person.list", {});`,
      ).ok,
    ).toBe(true);
  });
});

describe("the old view names", () => {
  it("each map to the view named for its object", () => {
    const old = (suffix: string) => `${OLD_VIEW_PREFIX}${suffix}`;
    expect(renamedView(old("people"))).toBe("rec_person");
    expect(renamedView(old("organisations"))).toBe("rec_organisation");
    expect(renamedView(old("affiliations"))).toBe("rec_affiliation");
    expect(renamedView(old("activities"))).toBe("rec_activity");
    expect(renamedView(old("activity_links"))).toBe("rec_activity_link");
    expect(renamedView(old("tasks"))).toBe("rec_task");
    expect(renamedView(old("task_links"))).toBe("rec_task_link");
    expect(renamedView(old("record_tags"))).toBe("rec_record_tag");
    expect(renamedView(old("users"))).toBe("rec_user");
    expect(renamedView(old("stage_history"))).toBe("rec_stage_history");
    expect(renamedView(old("x_deals_deal"))).toBe("rec_x_deals_deal");
    expect(renamedView("rec_person")).toBeNull();
    expect(renamedMessage(old("nothing"))).toContain("were renamed rec_*");
    expect(renamedMessage("rec_person")).toBeNull();
  });
});
