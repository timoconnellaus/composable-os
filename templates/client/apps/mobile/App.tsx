// The mobile app: sign-in, then two tabs, a public Home and the signed-in Account, My account's
// sections over the account entry (@composable-os/client). The screens are plain React Native; the
// host is src/host.ts.
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
  MANAGE_ON_WEBSITE_WORDS,
  orderedSessions,
  orderMoney,
  orderStateWords,
  RECEIPT_EMAILED_WORDS,
  SIGN_IN_AGAIN_WORDS,
  sessionWords,
  showsReceiptNote,
} from "@composable-os/client";
import Constants from "expo-constants";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  Linking,
  Button as NativeButton,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { hostSession } from "./src/host.ts";
import { secureRandom } from "./src/secure-random.ts";
import { secureStore } from "./src/secure-store.ts";

type TabKey = "home" | "account";

export default function App() {
  const session = useMemo(
    () =>
      hostSession({
        hostUrl: String(Constants.expoConfig?.extra?.hostUrl ?? ""),
        store: secureStore,
        deviceName: Constants.deviceName ?? "Phone",
        random: secureRandom,
      }),
    [],
  );
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [tab, setTab] = useState<TabKey>("home");

  useEffect(() => {
    session.signedIn().then(setSignedIn);
  }, [session]);

  if (signedIn === null) return null;
  if (!signedIn) return <SignIn session={session} onSignedIn={() => setSignedIn(true)} />;
  return (
    <SafeAreaView style={styles.app}>
      <View style={styles.body}>
        {tab === "home" ? (
          <Text style={styles.title}>Welcome</Text>
        ) : (
          <Account
            session={session}
            onSignedOut={() => {
              setSignedIn(false);
              setTab("home");
            }}
          />
        )}
      </View>
      <View style={styles.tabs}>
        <NativeButton title="Home" onPress={() => setTab("home")} />
        <NativeButton title="Account" onPress={() => setTab("account")} />
      </View>
    </SafeAreaView>
  );
}

type Session = ReturnType<typeof hostSession>;

interface Loaded {
  me: AccountMe;
  sessions: AccountSession[];
  family: AccountFamily;
  orders: AccountOrder[];
  subscriptions: AccountSubscription[];
  due: string[];
  attention: AttentionItem[];
}

/**
 * My account (stage 48), plain: the sections the account entry gives (`accountSections`), each
 * the host's answer. Money is the website's (ADR 0714): the card opens the business's website
 * account page (`extra.websiteUrl`, from product.ts by app.config.ts). Copy the native-account
 * block (cos add native-account) for the styled screen with the packs' sections.
 */
function Account({ session, onSignedOut }: { session: Session; onSignedOut: () => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const websiteUrl = String(Constants.expoConfig?.extra?.websiteUrl ?? "");
  const load = useCallback(async () => {
    const api = session.api;
    try {
      const [me, sessions, family, orders, subscriptions, due, attention] = await Promise.all([
        api.call("me.get", {}),
        api.call("me.sessions.list", {}),
        api.call("me.family", {}),
        loadOrders(accountClient(api)),
        api.call("subscription.list", { limit: 50 }),
        // What the host says is still to be agreed to (stage 44). Copy the
        // native-agreements-due block to read and agree to each in the app.
        api.call("me.agreements.due", {}).catch(() => ({ people: [] })),
        // What needs their attention, or a child's (ADR 0711). Copy native-account for the
        // styled list that opens each item's section.
        api.call("me.attention", {}).catch(() => ({ days: 7, items: [] })),
      ]);
      setData({
        me,
        sessions: sessions.items,
        family,
        orders: orders.orders,
        subscriptions: subscriptions.items as AccountSubscription[],
        due: due.people
          .filter((p) => p.due.length)
          .map((p) =>
            p.self
              ? p.due.map((d) => d.title).join(", ")
              : `for ${p.name.split(" ")[0]}: ${p.due.map((d) => d.title).join(", ")}`,
          ),
        attention: attention.items,
      });
    } catch {
      setFailed(true);
    }
  }, [session]);
  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <Text accessibilityRole="alert">We could not load your account.</Text>;
  if (!data) return <Text style={styles.title}>Loading</Text>;
  const signOut = () => session.signOut().then(onSignedOut);
  const sections: Record<string, () => ReactNode> = {
    orders: () =>
      data.orders.length ? (
        data.orders.map((order) => (
          <View key={order.id}>
            <Text>{`${accountDay(order.createdAt)}: ${orderStateWords(order)}`}</Text>
            {order.lines.map((line) => (
              <Text
                key={line.id}
              >{`${line.title}: ${formatMinor(line.total, order.currency)}`}</Text>
            ))}
            <Text>
              {orderMoney(order)
                .map((row) => `${row.label} ${row.value}`)
                .join(" · ")}
            </Text>
            {showsReceiptNote(order) ? <Text>{RECEIPT_EMAILED_WORDS}</Text> : null}
          </View>
        ))
      ) : (
        <Text>You have no orders yet.</Text>
      ),
    agreements: () =>
      data.due.length ? (
        <Text accessibilityRole="alert">{`Before you book, please read and agree to: ${data.due.join("; ")}.`}</Text>
      ) : (
        <Text>Nothing to agree to.</Text>
      ),
    family: () => (
      <>
        {data.family.dependants.length ? (
          <Text>{`You act for: ${data.family.dependants.map((p) => p.name).join(", ")}`}</Text>
        ) : null}
        {data.family.guardians.length ? (
          <Text>{`Acting for you: ${data.family.guardians.map((p) => p.name).join(", ")}`}</Text>
        ) : null}
        <Text>
          To book for a child or agree for them, ask the business to link them to your account.
        </Text>
      </>
    ),
    payment: () => (
      <>
        <Text>Your card is kept by the payment provider.</Text>
        <NativeButton
          title={MANAGE_ON_WEBSITE_WORDS}
          disabled={!websiteUrl}
          onPress={() => void Linking.openURL(websiteUrl)}
        />
      </>
    ),
    details: () => <Details session={session} me={data.me} onSaved={load} />,
    delete: () => <Delete session={session} me={data.me} onDeleted={onSignedOut} />,
    devices: () =>
      orderedSessions(data.sessions).map((s) => {
        const words = sessionWords(s);
        return (
          <View key={s.id}>
            <Text>{`${words.title}. ${words.detail}.`}</Text>
            {s.current ? (
              <NativeButton title="Sign out" onPress={signOut} />
            ) : (
              <NativeButton
                title="Sign it out"
                onPress={() =>
                  void session.api.call("me.sessions.revoke", { id: s.id }).then(load, load)
                }
              />
            )}
          </View>
        );
      }),
  };
  return (
    <ScrollView contentContainerStyle={styles.sections}>
      <Text style={styles.title}>My account</Text>
      <Text>{data.me.displayName}</Text>
      <Text style={styles.heading}>Needs your attention</Text>
      {data.attention.length ? (
        data.attention.map((item) => {
          const words = attentionWords(item);
          return (
            <Text key={item.key}>
              {[words.whose, words.title, words.detail].filter(Boolean).join(": ")}
            </Text>
          );
        })
      ) : (
        <Text>Nothing needs your attention.</Text>
      )}
      {accountSections([], hiddenSections(data.subscriptions)).map((section) => (
        <View key={section.key} accessibilityLabel={section.label}>
          <Text style={styles.heading}>{section.label}</Text>
          {sections[section.key]?.()}
        </View>
      ))}
    </ScrollView>
  );
}

function Details({
  session,
  me,
  onSaved,
}: {
  session: Session;
  me: AccountMe;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<DetailsForm>(() => detailsForm(me));
  const [said, setSaid] = useState<string | null>(null);
  async function save() {
    const problems = detailsProblems(form);
    if (problems.length) return setSaid(problems.map((p) => p.message).join(". "));
    const input = detailsInput(me, form);
    if (!input) return setSaid("Nothing to save.");
    try {
      await session.api.call("me.update", input);
      setSaid("Saved.");
      await onSaved();
    } catch (error) {
      setSaid(accountErrorWords(error));
    }
  }
  return (
    <View style={styles.form}>
      <SimpleInput
        label="Name"
        value={form.displayName}
        onChange={(v) => setForm({ ...form, displayName: v })}
      />
      <SimpleInput
        label="Phone"
        value={form.primaryPhone}
        onChange={(v) => setForm({ ...form, primaryPhone: v })}
      />
      <Text>{`You sign in with ${me.signInEmail}`}</Text>
      <NativeButton title="Save" onPress={() => void save()} />
      {said ? <Text>{said}</Text> : null}
      <ChangeAddress session={session} me={me} onChanged={onSaved} />
    </View>
  );
}

/**
 * Signing in again in place when the host asks for a recent sign-in (`sign_in_again`, ADR 0712):
 * a code to their own sign-in address, then `onDone`, which runs what they were doing again.
 */
function SignInAgain({
  session,
  email,
  onDone,
}: {
  session: Session;
  email: string;
  onDone: () => void;
}) {
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  return (
    <View style={styles.form}>
      <Text>{SIGN_IN_AGAIN_WORDS}</Text>
      {sent ? <SimpleInput label="Code" value={code} onChange={setCode} /> : null}
      <NativeButton
        title={sent ? "Sign in and carry on" : "Email me a code"}
        onPress={async () => {
          if (!sent) setSent(await session.requestCode(email));
          else if (await session.signIn(email, code.trim())) onDone();
        }}
      />
    </View>
  );
}

/** Changing the sign-in address: a code to the new address, entered here (ADR 0712). */
function ChangeAddress({
  session,
  me,
  onChanged,
}: {
  session: Session;
  me: AccountMe;
  onChanged: () => Promise<void>;
}) {
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
        session={session}
        email={me.signInEmail}
        onDone={() => {
          setAgain(null);
          again();
        }}
      />
    );
  }
  return (
    <View style={styles.form}>
      {sent ? (
        <>
          <Text>{`We emailed a code to ${sent}. Enter it within 15 minutes.`}</Text>
          <SimpleInput label="Code" value={code} onChange={setCode} />
          <NativeButton
            title="Change my sign-in address"
            onPress={() =>
              void run(async () => {
                const done = await session.api.call("me.email.confirm", { code: code.trim() });
                setSent(null);
                setSaid(`You now sign in with ${done.signInEmail}.`);
                await onChanged();
              })
            }
          />
        </>
      ) : (
        <>
          <SimpleInput label="New sign-in address" value={email} onChange={setEmail} />
          <NativeButton
            title="Email me a code"
            onPress={() => {
              const problem = emailChangeProblem(email, me.signInEmail);
              if (problem) return setSaid(problem);
              void run(async () => {
                setSent(
                  (await session.api.call("me.email.change", { email: email.trim() })).newEmail,
                );
              });
            }}
          />
        </>
      )}
      {said ? <Text>{said}</Text> : null}
    </View>
  );
}

/**
 * Deleting the account: the host's preview shown in full, then DELETE typed to confirm exactly
 * that (ADR 0713). Nothing is deleted without the preview (`deleteConfirmInput`).
 */
function Delete({
  session,
  me,
  onDeleted,
}: {
  session: Session;
  me: AccountMe;
  onDeleted: () => void;
}) {
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [typed, setTyped] = useState("");
  const [again, setAgain] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  async function look() {
    setSaid(null);
    try {
      const answer = await session.api.call("me.deleteAccount", {});
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
      await session.api.call("me.deleteAccount", input);
      // The host ended every session: forget this one on the device too.
      await session.signOut().catch(() => undefined);
      onDeleted();
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
        session={session}
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
      <View style={styles.form}>
        <NativeButton title="See what deleting my account does" onPress={() => void look()} />
        {said ? <Text>{said}</Text> : null}
      </View>
    );
  }
  const words = deletePreviewWords(preview);
  return (
    <View style={styles.form}>
      {[...words.ends, ...words.cancelled].map((line) => (
        <Text key={line}>{line}</Text>
      ))}
      {words.left.length ? <Text>{`Left for the business: ${words.left.join("; ")}`}</Text> : null}
      <Text>{words.erase}</Text>
      <SimpleInput label={`Type ${DELETE_WORD}`} value={typed} onChange={setTyped} />
      <NativeButton
        title="Delete my account"
        disabled={!deleteConfirmInput(preview, typed)}
        onPress={() => void confirm()}
      />
      {said ? <Text>{said}</Text> : null}
    </View>
  );
}

function SignIn({ session, onSignedIn }: { session: Session; onSignedIn: () => void }) {
  // Copy the native-sign-in block (cos add native-sign-in) for a styled screen; this one is plain.
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  return (
    <SafeAreaView style={styles.app}>
      <View style={styles.body}>
        <Text style={styles.title}>Sign in</Text>
        <SimpleInput label="Email" value={email} onChange={setEmail} />
        {sent ? <SimpleInput label="Code" value={code} onChange={setCode} /> : null}
        <NativeButton
          title={sent ? "Sign in" : "Email me a code"}
          onPress={async () => {
            if (!sent) setSent(await session.requestCode(email));
            else if (await session.signIn(email, code)) onSignedIn();
          }}
        />
      </View>
    </SafeAreaView>
  );
}

function SimpleInput(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <TextInput
      accessibilityLabel={props.label}
      placeholder={props.label}
      autoCapitalize="none"
      value={props.value}
      onChangeText={props.onChange}
      style={styles.input}
    />
  );
}

const styles = StyleSheet.create({
  app: { flex: 1 },
  body: { flex: 1, padding: 16, gap: 12 },
  title: { fontSize: 24, fontWeight: "600" },
  heading: { fontSize: 18, fontWeight: "600", marginTop: 12 },
  sections: { gap: 8, paddingBottom: 24 },
  form: { gap: 8 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 },
  tabs: { flexDirection: "row", justifyContent: "space-around", paddingBottom: 16 },
});
