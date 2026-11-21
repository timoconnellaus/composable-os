// Issue #155: a client product's label (COS_PRODUCT_LABEL, set by `cos deploy`) is what the
// host's own messages call the product. With it set, none of them says "CRM"; with it unset,
// they read as they always have.
import { productName, setProductLabel } from "@composable-os/product";
import { product } from "@composable-os/products/active";
import { afterEach, describe, expect, it } from "vitest";
import { customerCodeEmail } from "../src/customers/code-email.ts";
import { plainDigest } from "../src/notifications/digest.ts";

const digest = () =>
  plainDigest({
    recipient: { userId: "usr_1", name: "Coach", email: "coach@gym.test" },
    date: "2026-11-21",
    items: [],
    unreadTotal: 30,
    pendingApprovals: 0,
    approvalsUrl: null,
  }) as { subject: string; text: string };

afterEach(() => setProductLabel(undefined));

describe("the product's label", () => {
  it("names the product in the host's emails, and nothing says CRM", async () => {
    setProductLabel("Ghetto Movement");
    expect(productName(product)).toBe("Ghetto Movement");
    const code = customerCodeEmail("482913");
    const daily = await digest();
    for (const text of [code.subject, code.text, daily.subject, daily.text]) {
      expect(text).not.toContain("CRM");
    }
    expect(code.subject + code.text).toContain("Ghetto Movement");
    expect(daily.text).toContain("Ghetto Movement");
  });

  it("unset, or blank, leaves the build's own name", () => {
    setProductLabel(undefined);
    expect(productName(product)).toBe(product.strings.name);
    setProductLabel("   ");
    expect(productName(product)).toBe(product.strings.name);
  });
});
