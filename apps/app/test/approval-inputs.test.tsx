// A queued call with nothing (or not everything) to preview shows its inputs, and its title carries
// how many records it touches (ADR 0022 amendment, 2026-11-22): the agent's reason is never the
// only description of what approving will do. The inbox and the chat's card share these pieces.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { actionTitle } from "../src/components/approvals/describe.ts";
import { DryRunNotes, ToolCallPreview } from "../src/components/approvals/tool-call-preview.tsx";

describe("a queued call with no preview", () => {
  it("lists its inputs, and says it runs on approval", () => {
    const html = renderToStaticMarkup(
      <ToolCallPreview
        input={{ id: "aut_1", object: "person", recordIds: ["a", "b"] }}
        pending
        ranAtQueue={false}
        tool={false}
      />,
    );
    expect(html).toContain('data-testid="call-inputs"');
    expect(html).toContain("It runs, once you approve, with:");
    expect(html).toContain("recordIds");
    expect(html).toContain("[&quot;a&quot;,&quot;b&quot;]");
  });

  it("titles a bulk call by its count", () => {
    expect(actionTitle("automation.run", [], {}, 500)).toBe("Run automation (500 records)");
  });

  it("says a tool queued before the fix may already have run", () => {
    const html = renderToStaticMarkup(<ToolCallPreview input={{ id: "x" }} pending ranAtQueue />);
    expect(html).toContain('data-testid="tool-ran-at-queue"');
    expect(html).toContain("Rejecting it is recommended");
  });

  it("shows the dry run's notes", () => {
    const html = renderToStaticMarkup(<DryRunNotes notes={["Runs on approval: it uses x"]} />);
    expect(html).toContain("Runs on approval: it uses x");
  });
});
