// The Customer account card sits above the Family card on a Person's page. It holds its place while
// customer.list loads: when it rendered nothing until then, it arrived late, pushed the Family card
// down, and took the family picker, open, off the screen with it (#264).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CustomerAccountCard } from "../src/components/people/customer-account-card.tsx";
import { opKey } from "../src/lib/query.ts";

const PERSON = "per_01KA8ZQ7Y2V3N4M5P6R7S8T9W0";

function render(client: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CustomerAccountCard personId={PERSON} />
    </QueryClientProvider>,
  );
}

describe("the Customer account card", () => {
  it("holds its place while it loads", () => {
    const html = render(new QueryClient());
    expect(html).toContain('data-testid="customer-account"');
    expect(html).toContain("Customer account");
    expect(html).toContain('data-testid="customer-account-loading"');
  });

  it("says when there is no account, once loaded", () => {
    const client = new QueryClient();
    client.setQueryData(opKey("customer.list", { personId: PERSON, limit: 1 }), { items: [] });
    const html = render(client);
    expect(html).toContain("No customer account");
    expect(html).not.toContain("customer-account-loading");
  });

  // Stage 48: the pending address change (masked, never its code), the open erase request, and
  // the admins' buttons, each the host's operation.
  it("shows a pending address change, an open erase request and the admins' buttons", () => {
    const client = new QueryClient();
    client.setQueryData(opKey("customer.list", { personId: PERSON, limit: 1 }), {
      items: [
        {
          id: "cus_1",
          personId: PERSON,
          email: "member@example.com",
          status: "active",
          linkState: "linked",
          createdAt: "2026-11-01T00:00:00.000Z",
          lastSignInAt: null,
          sessions: 1,
          emailChange: {
            newEmail: "n•••@example.org",
            startedBy: "staff",
            createdAt: "2026-11-25T09:00:00.000Z",
            expiresAt: "2099-11-25T09:15:00.000Z",
            expired: false,
          },
          eraseRequest: {
            requestedAt: "2026-11-24T00:00:00.000Z",
            dueAt: "2026-12-24T00:00:00.000Z",
          },
        },
      ],
      nextCursor: null,
    });
    const html = render(client);
    expect(html).toContain('data-testid="customer-email-change"');
    expect(html).toContain("n•••@example.org");
    expect(html).toContain('data-testid="customer-erase-request"');
    for (const button of [
      "Disable",
      "Sign out everywhere",
      "Cancel address change",
      "Change sign-in address",
    ]) {
      expect(html).toContain(`>${button}</button>`);
    }
    expect(html).not.toContain(">Enable</button>");
  });
});
