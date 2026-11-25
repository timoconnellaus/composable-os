// My account's blocks drawn with the host's answers (fixture values), web and native, and the
// client template's mobile Account tab (stage 48 criterion 12, and the review of #467's F2, F5):
//
// - the template's Account tab is the native shell, with "Needs your attention" and the sections
//   the host lists, over the app's React Query;
// - a shell leaves out a base section the host lists that it draws nothing for;
// - money owed on an order leads to paying it: on the web, the order's row in Orders with a pay
//   button (order.checkout); in the app, the website.
import {
  ACCOUNT_HOOKS_CALL,
  type AccountOrder,
  type AccountPortal,
  AGREEMENTS_HOOKS_CALL,
  type AttentionItem,
  createAccountHooks,
  createAgreementsHooks,
} from "@composable-os/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountTab } from "../../templates/client/apps/mobile/src/account.tsx";
import { AccountScreen } from "../native-account/account-screen.tsx";
import { YourOrders as NativeOrders } from "../native-account-orders/orders.tsx";
import { NeedsAttention } from "../web-account-attention/attention.tsx";
import { YourOrders as WebOrders } from "../web-account-orders/orders.tsx";
import { presses } from "./react-native-shim.tsx";

const base = (key: string, label: string, order: number) => ({
  key,
  pack: null,
  label,
  order,
  web: null,
  native: null,
});

const PORTAL: AccountPortal = {
  sections: [
    base("orders", "Orders", 60),
    base("agreements", "Agreements", 70),
    base("details", "Your details", 90),
    // A base section from a newer host that this copy of the shell draws nothing for.
    base("later", "Something added later", 97),
    base("delete", "Delete my account", 99),
  ],
  paysSubscription: false,
};

const item = (extra: Partial<AttentionItem>): AttentionItem => ({
  key: "k",
  kind: "agree",
  person: { id: "per_me", name: "Hannah Okafor", self: true },
  record: { object: "agreement", id: "agr_1", title: "Waiver" },
  at: "2026-12-01T00:00:00.000Z",
  amount: null,
  currency: null,
  usesLeft: null,
  link: null,
  ...extra,
});

const ATTENTION = {
  days: 7,
  items: [
    item({ key: "a", kind: "agree" }),
    item({
      key: "b",
      kind: "balance_due",
      record: { object: "order", id: "ord_camp", title: "Summer camp" },
      amount: 20000,
      currency: "AUD",
    }),
  ],
};

const order = (extra: Partial<AccountOrder>): AccountOrder => ({
  id: "ord_camp",
  state: "part_paid",
  currency: "AUD",
  total: 30000,
  paid: 10000,
  balance: 20000,
  refunded: 0,
  pay: "deposit",
  deposit: 10000,
  balanceDueAt: "2026-12-10",
  expiresAt: null,
  paidAt: null,
  createdAt: "2026-11-20T00:00:00.000Z",
  taxAmount: 0,
  taxRefunded: 0,
  subscriptionId: null,
  lines: [
    {
      id: "ol_1",
      position: 0,
      title: "Summer camp",
      quantity: 1,
      unitPrice: 30000,
      total: 30000,
      taxAmount: 0,
    },
  ],
  receiptUrl: null,
  ...extra,
});

const ME = {
  id: "per_me",
  displayName: "Hannah Okafor",
  givenName: "Hannah",
  familyName: "Okafor",
  primaryEmail: "hannah@example.com",
  primaryPhone: null,
  signInEmail: "hannah@example.com",
  signInEmailVerified: true,
};

/** What the host answers, by operation (the orders read is keyed under my.list). */
const ANSWERS: Record<string, unknown> = {
  "me.portal": PORTAL,
  "me.attention": ATTENTION,
  "me.get": ME,
  "subscription.list": { items: [], nextCursor: null },
  "my.list": { orders: [order({})], nextCursor: null },
};

/** A client holding every operation the account and agreements hooks call, answering ANSWERS. */
function fakeClient(calls: { name: string; input: unknown }[] = []) {
  const operations = Object.fromEntries(
    [...Object.values(ACCOUNT_HOOKS_CALL), ...Object.values(AGREEMENTS_HOOKS_CALL)]
      .flat()
      .map((name) => [name, {}]),
  );
  return {
    operations,
    query: (name: string, input: unknown) => ({
      queryKey: [name, input],
      queryFn: async () => ANSWERS[name],
    }),
    mutation: (name: string) => ({
      mutationKey: [name],
      mutationFn: async (input: unknown) => {
        calls.push({ name, input });
        return { url: "https://pay.example/checkout" };
      },
    }),
    call: async (name: string) => ANSWERS[name],
  };
}

/** React functions that answer at once from ANSWERS, as a warm cache would. */
const instant = {
  useQuery: (options: { queryKey: readonly unknown[] }) => ({
    data: ANSWERS[String(options.queryKey[0])] as never,
    isPending: false,
    error: null,
  }),
  useMutation: (options: { mutationFn: (input: unknown) => Promise<unknown> }) => ({
    mutate: (input: unknown) => void options.mutationFn(input),
    mutateAsync: options.mutationFn,
    data: undefined,
    isPending: false,
    error: null,
  }),
};

const hooks = (calls?: { name: string; input: unknown }[]) =>
  createAccountHooks(instant as never, fakeClient(calls));

const draw = (element: ReactElement) => renderToStaticMarkup(element);

beforeEach(() => {
  presses.length = 0;
});

describe("the client template's mobile Account tab is the native shell (criterion 12)", () => {
  it("draws My account with Needs your attention and the host's sections", () => {
    const queryClient = new QueryClient();
    const api = fakeClient();
    // The app's cache as the host's answers fill it, under the typed client's own keys.
    for (const name of ["me.portal", "me.attention", "me.get"]) {
      queryClient.setQueryData([name, {}], ANSWERS[name]);
    }
    queryClient.setQueryData(["subscription.list", { limit: 50 }], ANSWERS["subscription.list"]);
    const opened: string[] = [];
    const session = {
      api,
      requestCode: async () => true,
      signIn: async () => true,
      signOut: async () => {},
    };
    const html = draw(
      <QueryClientProvider client={queryClient}>
        <AccountTab
          session={session as never}
          websiteUrl="https://www.example.com/account"
          onSignedOut={() => {}}
          openUrl={(url) => opened.push(url)}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("My account");
    expect(html).toContain("Hannah Okafor");
    expect(html).toContain("Needs your attention");
    expect(html).toContain("Agree to Waiver");
    expect(html).toContain("The rest to pay for Summer camp");
    for (const label of ["Orders", "Agreements", "Your details", "Delete my account"]) {
      expect(html, label).toContain(label);
    }
    // Money owed on an order opens the website, never a payment page in the app (ADR 0714).
    presses.find((p) => p.text.includes("The rest to pay for Summer camp"))?.onPress();
    expect(opened).toEqual(["https://www.example.com/account"]);
  });
});

describe("a shell shows only the base sections it draws (F2)", () => {
  it("leaves out, in the app, a base section the host lists that this copy has no part for", () => {
    const account = hooks();
    const agreements = createAgreementsHooks(instant as never, fakeClient());
    const html = draw(
      <AccountScreen
        account={account}
        agreements={agreements}
        websiteUrl="https://www.example.com/account"
        signIn={{ requestCode: async () => true, confirm: async () => true }}
        endSession={async () => {}}
        onSignOut={() => {}}
        onDeleted={() => {}}
        openUrl={() => {}}
      />,
    );
    expect(html).toContain("Delete my account");
    expect(html).not.toContain("Something added later");
  });
});

describe("money owed on an order leads to paying it (F5)", () => {
  it("on the web, the order's row in Orders pays it with order.checkout", async () => {
    const calls: { name: string; input: unknown }[] = [];
    const html = draw(
      <WebOrders account={hooks(calls)} returnUrl="https://www.example.com/account" />,
    );
    expect(html).toContain('id="account-order-ord_camp"');
    expect(html).toContain("Pay the rest");
    // Without the pay hook or a return address, the row only shows what is owed.
    const plain = draw(<WebOrders account={{ useOrders: hooks().useOrders }} />);
    expect(plain).not.toContain("Pay the rest");
  });

  it("on the web, the attention item opens the order's row", () => {
    const opened: [string, string | undefined][] = [];
    const html = draw(
      <NeedsAttention
        account={hooks()}
        sections={PORTAL.sections}
        onSection={(key, at) => opened.push([key, at])}
      />,
    );
    expect(html).toContain("Pay the rest");
    expect(html).toContain('data-kind="balance_due"');
  });

  it("in the app, Orders says to pay on the website and opens it", () => {
    let managed = 0;
    const html = draw(<NativeOrders account={hooks()} onManage={() => (managed += 1)} />);
    expect(html).toContain("Pay on the website");
    expect(html).not.toContain("Pay the rest");
    presses.find((p) => p.text.includes("Pay on the website"))?.onPress();
    expect(managed).toBe(1);
  });
});
