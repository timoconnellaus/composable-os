// My account (stage 48), plain: the signed-in customer's orders, agreements, family, payment
// method (for someone who pays a subscription), details and where they are signed in, in the
// order the account entry gives (`accountSections` in @composable-os/client). Every figure and
// list is the host's answer; nothing here works out what is owed or allowed. For a styled page
// with the packs' sections, copy the web-account block (cos add web-account).
import {
  type AccountFamily,
  type AccountMe,
  type AccountOrder,
  type AccountSession,
  type AccountSubscription,
  accountClient,
  accountDay,
  accountErrorWords,
  accountSections,
  type DetailsForm,
  detailsForm,
  detailsInput,
  detailsProblems,
  formatMinor,
  hiddenSections,
  loadOrders,
  orderedSessions,
  orderMoney,
  orderStateWords,
  RECEIPT_EMAILED_WORDS,
  sessionWords,
  showsReceiptNote,
} from "@composable-os/client";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { browserApi, signedOut } from "../agreements.ts";
import { getMe } from "../me.ts";

export const Route = createFileRoute("/account")({
  loader: async () => {
    const me = await getMe();
    if (!me) throw redirect({ to: "/sign-in" });
    return me;
  },
  component: Account,
});

interface Loaded {
  me: AccountMe;
  sessions: AccountSession[];
  family: AccountFamily;
  orders: AccountOrder[];
  subscriptions: AccountSubscription[];
}

async function signOut() {
  await fetch("/auth/sign-out", { method: "POST", body: "{}" });
  window.location.assign("/");
}

function Account() {
  const signedInAs = Route.useLoaderData();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const api = browserApi();
    try {
      const [me, sessions, family, orders, subscriptions] = await Promise.all([
        api.call("me.get", {}),
        api.call("me.sessions.list", {}),
        api.call("me.family", {}),
        loadOrders(accountClient(api)),
        api.call("subscription.list", { limit: 50 }),
      ]);
      setData({
        me,
        sessions: sessions.items,
        family,
        orders: orders.orders,
        subscriptions: subscriptions.items as AccountSubscription[],
      });
    } catch (error) {
      if (signedOut(error)) window.location.assign("/sign-in");
      else setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <main role="alert">We could not load your account.</main>;
  if (!data) return <main aria-busy="true">{`Signed in as ${signedInAs.displayName}…`}</main>;

  const sections: Record<string, () => ReactNode> = {
    orders: () => <Orders orders={data.orders} />,
    agreements: () => <Link to="/agreements">Your agreements</Link>,
    family: () => <Family family={data.family} />,
    payment: () => <Payment />,
    details: () => <Details me={data.me} onSaved={load} />,
    devices: () => <Devices sessions={data.sessions} onChanged={load} />,
  };
  return (
    <main>
      <h1>My account</h1>
      <p>{data.me.displayName}</p>
      {accountSections([], hiddenSections(data.subscriptions)).map((section) => (
        <section key={section.key} aria-label={section.label}>
          <h2>{section.label}</h2>
          {sections[section.key]?.()}
        </section>
      ))}
      <p>
        <Link to="/">Home</Link>
      </p>
    </main>
  );
}

function Orders({ orders }: { orders: AccountOrder[] }) {
  if (!orders.length) return <p>You have no orders yet.</p>;
  return (
    <ul>
      {orders.map((order) => (
        <li key={order.id}>
          <p>{`${accountDay(order.createdAt)}: ${orderStateWords(order)}`}</p>
          <ul>
            {order.lines.map((line) => (
              <li key={line.id}>{`${line.title}: ${formatMinor(line.total, order.currency)}`}</li>
            ))}
          </ul>
          <p>
            {orderMoney(order)
              .map((row) => `${row.label} ${row.value}`)
              .join(" · ")}
          </p>
          {showsReceiptNote(order) ? <p>{RECEIPT_EMAILED_WORDS}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function Family({ family }: { family: AccountFamily }) {
  return (
    <>
      {family.dependants.length ? (
        <p>{`You act for: ${family.dependants.map((p) => p.name).join(", ")}`}</p>
      ) : null}
      {family.guardians.length ? (
        <p>{`Acting for you: ${family.guardians.map((p) => p.name).join(", ")}`}</p>
      ) : null}
      <p>To book for a child or agree for them, ask the business to link them to your account.</p>
    </>
  );
}

function Payment() {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <p>Your card is kept by the payment provider.</p>
      <button
        type="button"
        onClick={async () => {
          try {
            const opened = await browserApi().call("subscription.portal", {
              returnUrl: window.location.href,
            });
            window.location.assign(opened.url);
          } catch (error) {
            setProblem(accountErrorWords(error));
          }
        }}
      >
        Change card and see invoices
      </button>
      {problem ? <p role="alert">{problem}</p> : null}
    </>
  );
}

function Details({ me, onSaved }: { me: AccountMe; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<DetailsForm>(() => detailsForm(me));
  const [said, setSaid] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const problems = detailsProblems(form);
    if (problems.length) return setSaid(problems.map((p) => p.message).join(". "));
    const input = detailsInput(me, form);
    if (!input) return setSaid("Nothing to save.");
    try {
      await browserApi().call("me.update", input);
      setSaid("Saved.");
      await onSaved();
    } catch (error) {
      setSaid(accountErrorWords(error));
    }
  }
  const field = (key: keyof DetailsForm, label: string) => (
    <label style={{ display: "grid" }}>
      {label}
      <input value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </label>
  );
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 8, maxWidth: 360 }}>
      {field("displayName", "Name")}
      {field("givenName", "First name")}
      {field("familyName", "Last name")}
      {field("primaryPhone", "Phone")}
      <p>{`You sign in with ${me.signInEmail}`}</p>
      <button type="submit">Save</button>
      {said ? <p role="status">{said}</p> : null}
    </form>
  );
}

function Devices({
  sessions,
  onChanged,
}: {
  sessions: AccountSession[];
  onChanged: () => Promise<void>;
}) {
  return (
    <ul>
      {orderedSessions(sessions).map((session) => {
        const words = sessionWords(session);
        return (
          <li key={session.id}>
            {`${words.title}. ${words.detail}. `}
            {session.current ? (
              <button type="button" onClick={signOut}>
                Sign out
              </button>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  await browserApi().call("me.sessions.revoke", { id: session.id });
                  await onChanged();
                }}
              >
                Sign it out
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
