// My account (stage 48), plain: what needs the signed-in customer's attention, then their orders,
// agreements, family, payment method (for someone who pays a subscription), details (with
// changing the sign-in address), where they are signed in and deleting the account, in the
// order the account entry gives (`accountSections` in @composable-os/client). Every figure and
// list is the host's answer; nothing here works out what is owed or allowed. For a styled page
// with the packs' sections, copy the web-account block (cos add web-account).
import {
  type AccountFamily,
  type AccountMe,
  type AccountOrder,
  type AccountSession,
  type AccountSubscription,
  type AttentionItem,
  accountClient,
  accountDay,
  accountErrorWords,
  accountSections,
  attentionWords,
  DELETE_WORD,
  type DeletePreview,
  type DetailsForm,
  deleteConfirmInput,
  deletePreviewWords,
  detailsForm,
  detailsInput,
  detailsProblems,
  emailChangeErrorWords,
  emailChangeProblem,
  formatMinor,
  hiddenSections,
  isDeletePreview,
  isSignInAgain,
  loadOrders,
  orderedSessions,
  orderMoney,
  orderStateWords,
  RECEIPT_EMAILED_WORDS,
  SIGN_IN_AGAIN_WORDS,
  sessionWords,
  showsReceiptNote,
} from "@composable-os/client";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { signedOut } from "../agreements.ts";
import { useScreenHost } from "../screen-host/index.ts";

export const Route = createFileRoute("/account")({
  loader: async ({ context }) => {
    const me = await context.screenHost.me();
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
  attention: AttentionItem[];
}

function Account() {
  const signedInAs = Route.useLoaderData();
  const host = useScreenHost();
  const navigate = useNavigate();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const api = host.api;
    try {
      const [me, sessions, family, orders, subscriptions, attention] = await Promise.all([
        api.call("me.get", {}),
        api.call("me.sessions.list", {}),
        api.call("me.family", {}),
        loadOrders(accountClient(api)),
        api.call("subscription.list", { limit: 50 }),
        api.call("me.attention", {}).catch(() => ({ days: 7, items: [] })),
      ]);
      setData({
        me,
        sessions: sessions.items,
        family,
        orders: orders.orders,
        subscriptions: subscriptions.items,
        attention: attention.items,
      });
    } catch (error) {
      if (signedOut(error)) await navigate({ to: "/sign-in" });
      else setFailed(true);
    }
  }, [host, navigate]);
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
    details: () => (
      <>
        <Details me={data.me} onSaved={load} />
        <ChangeAddress me={data.me} onChanged={load} />
      </>
    ),
    devices: () => <Devices sessions={data.sessions} onChanged={load} />,
    delete: () => <Delete me={data.me} />,
  };
  return (
    <main>
      <h1>My account</h1>
      <p>{data.me.displayName}</p>
      <section aria-label="Needs your attention">
        <h2>Needs your attention</h2>
        {data.attention.length ? (
          <ul>
            {data.attention.map((item) => {
              const words = attentionWords(item);
              return (
                <li key={item.key}>
                  {[words.whose, words.title, words.detail].filter(Boolean).join(": ")}
                </li>
              );
            })}
          </ul>
        ) : (
          <p>Nothing needs your attention.</p>
        )}
      </section>
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
  const host = useScreenHost();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <p>Your card is kept by the payment provider.</p>
      <button
        type="button"
        onClick={async () => {
          try {
            const opened = await host.api.call("subscription.portal", {
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
  const host = useScreenHost();
  const [form, setForm] = useState<DetailsForm>(() => detailsForm(me));
  const [said, setSaid] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const problems = detailsProblems(form);
    if (problems.length) return setSaid(problems.map((p) => p.message).join(". "));
    const input = detailsInput(me, form);
    if (!input) return setSaid("Nothing to save.");
    try {
      await host.api.call("me.update", input);
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

/**
 * Signing in again in place when the host asks for a recent sign-in (`sign_in_again`, ADR 0712):
 * a code to their own sign-in address through the ScreenHost, then `onDone`. With tokens, the
 * new device session replaces this one (`replaces`), so the old one does not live on beside it.
 */
function SignInAgain({ email, onDone }: { email: string; onDone: () => void }) {
  const host = useScreenHost();
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (!sent) setSent(await host.requestCode(email));
        else if (await host.signIn(email, code.trim())) onDone();
        else setSaid("That code did not work. Check it, or ask for a new one.");
      }}
    >
      <p>{SIGN_IN_AGAIN_WORDS}</p>
      {sent ? (
        <label>
          The code we emailed you
          <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
      ) : null}
      <button type="submit">{sent ? "Sign in and carry on" : "Email me a code"}</button>
      {said ? <p role="alert">{said}</p> : null}
    </form>
  );
}

/** Changing the sign-in address: a code to the new address, entered here (ADR 0712). */
function ChangeAddress({ me, onChanged }: { me: AccountMe; onChanged: () => Promise<void> }) {
  const { api } = useScreenHost();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [again, setAgain] = useState<(() => void) | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  async function run(act: () => Promise<void>) {
    setSaid(null);
    try {
      await act();
    } catch (error) {
      if (isSignInAgain(error)) setAgain(() => () => void run(act));
      else setSaid(emailChangeErrorWords(error));
    }
  }
  if (again) {
    return (
      <SignInAgain
        email={me.signInEmail}
        onDone={() => {
          setAgain(null);
          again();
        }}
      />
    );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (sent) {
          void run(async () => {
            const done = await api.call("me.email.confirm", { code: code.trim() });
            setSent(null);
            setSaid(`You now sign in with ${done.signInEmail}.`);
            await onChanged();
          });
          return;
        }
        const problem = emailChangeProblem(email, me.signInEmail);
        if (problem) return setSaid(problem);
        void run(async () => {
          setSent((await api.call("me.email.change", { email: email.trim() })).newEmail);
        });
      }}
      style={{ display: "grid", gap: 8, maxWidth: 360 }}
    >
      {sent ? (
        <label style={{ display: "grid" }}>
          {`The code we emailed to ${sent}`}
          <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
      ) : (
        <label style={{ display: "grid" }}>
          New sign-in address
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
      )}
      <button type="submit">{sent ? "Change my sign-in address" : "Email me a code"}</button>
      {said ? <p role="status">{said}</p> : null}
    </form>
  );
}

/**
 * Deleting the account: the host's preview shown in full, then DELETE typed to confirm exactly
 * that (ADR 0713). Nothing is deleted without the preview (`deleteConfirmInput`).
 */
function Delete({ me }: { me: AccountMe }) {
  const host = useScreenHost();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [typed, setTyped] = useState("");
  const [again, setAgain] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  async function look() {
    setSaid(null);
    try {
      const answer = await host.api.call("me.deleteAccount", {});
      if (isDeletePreview(answer)) setPreview(answer);
    } catch (error) {
      if (isSignInAgain(error)) setAgain(true);
      else setSaid(accountErrorWords(error));
    }
  }
  async function confirm() {
    const input = deleteConfirmInput(preview, typed);
    if (!input) return setSaid(`Type ${DELETE_WORD} to confirm`);
    try {
      await host.api.call("me.deleteAccount", input);
      // The host has ended every session of the account; nothing of it stays in this page.
      await host.forget();
      await navigate({ to: "/" });
    } catch (error) {
      if (isSignInAgain(error)) setAgain(true);
      else {
        setPreview(null);
        setSaid(accountErrorWords(error));
      }
    }
  }
  if (again) {
    return (
      <SignInAgain
        email={me.signInEmail}
        onDone={() => {
          setAgain(false);
          void look();
        }}
      />
    );
  }
  if (!preview) {
    return (
      <>
        <button type="button" onClick={() => void look()}>
          See what deleting my account does
        </button>
        {said ? <p role="alert">{said}</p> : null}
      </>
    );
  }
  const words = deletePreviewWords(preview);
  return (
    <>
      <ul>
        {[...words.ends, ...words.cancelled].map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {words.left.length ? <p>{`Left for the business: ${words.left.join("; ")}`}</p> : null}
      <p>{words.erase}</p>
      <label>
        {`To confirm, type ${DELETE_WORD}`}
        <input value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
      <button
        type="button"
        disabled={!deleteConfirmInput(preview, typed)}
        onClick={() => void confirm()}
      >
        Delete my account
      </button>
      {said ? <p role="alert">{said}</p> : null}
    </>
  );
}

function Devices({
  sessions,
  onChanged,
}: {
  sessions: AccountSession[];
  onChanged: () => Promise<void>;
}) {
  const host = useScreenHost();
  const navigate = useNavigate();
  return (
    <ul>
      {orderedSessions(sessions).map((session) => {
        const words = sessionWords(session);
        return (
          <li key={session.id}>
            {`${words.title}. ${words.detail}. `}
            {session.current ? (
              <button
                type="button"
                onClick={async () => {
                  await host.signOut();
                  await navigate({ to: "/" });
                }}
              >
                Sign out
              </button>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  await host.api.call("me.sessions.revoke", { id: session.id });
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
