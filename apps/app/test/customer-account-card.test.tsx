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
});
