// The approvals inbox's card for a waiting email says when a recipient cannot be contacted this
// way (ADR 0678): approving then sends nothing.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type Outbound, OutboundPreview } from "../src/components/approvals/outbound-preview.tsx";

const outbound = (contactBlocked: number | null): Outbound => ({
  vendor: "email-send",
  connectionId: "con_1",
  connectionTitle: "Email",
  facetKey: "k",
  resourceTitle: "crm@example.com",
  action: 1,
  title: "Send email: Hello",
  description: "Sends an email.",
  fields: [{ label: "To", value: "ada@x.test" }],
  actionKind: { tag: "email.send", label: "Send email" },
  autoApprovable: false,
  implementsRevert: false,
  check: null,
  contactBlocked,
});

describe("the inbox's note on a recipient who cannot be contacted", () => {
  it("says how many, and that approving sends nothing", () => {
    expect(renderToStaticMarkup(<OutboundPreview outbound={outbound(1)} />)).toContain(
      "1 recipient cannot be contacted this way: approving sends nothing.",
    );
    expect(renderToStaticMarkup(<OutboundPreview outbound={outbound(2)} />)).toContain(
      "2 recipients cannot be contacted this way",
    );
  });

  it("says nothing when every recipient can be", () => {
    expect(renderToStaticMarkup(<OutboundPreview outbound={outbound(null)} />)).not.toContain(
      "outbound-contact-blocked",
    );
  });
});
