// The fake provider's pages (src/integrations/pages.ts), as gatekeeper-kit's connect pages behave.
import { describe, expect, it } from "vitest";
import { connectHandoffPageHtml, escapeHtml } from "../src/integrations/pages.ts";

describe("the fake provider's pages", () => {
  it("escapes every character that matters in text and in a quoted attribute", () => {
    expect(escapeHtml(`a&b<c>"d'`)).toBe("a&#38;b&#60;c&#62;&#34;d&#39;");
  });

  it("hands off only to an exact origin, and says so for anything else", () => {
    expect(connectHandoffPageHtml({ targetOrigin: "https://crm.example", ticket: "t" })).toContain(
      '"https://crm.example"',
    );
    for (const targetOrigin of [
      "not a url",
      "null",
      "https://crm.example/path",
      "data:text/html,x",
    ]) {
      expect(() => connectHandoffPageHtml({ targetOrigin, ticket: "t" })).toThrow(
        "The handoff's targetOrigin is not an origin",
      );
    }
  });
});
