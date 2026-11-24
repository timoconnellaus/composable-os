// The mobile app: sign-in, then two tabs, a public Home and the signed-in Account, My account's
// sections over the account entry (@composable-os/client). The screens are plain React Native; the
// host is src/host.ts.
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
  MANAGE_ON_WEBSITE_WORDS,
  orderedSessions,
  orderMoney,
  orderStateWords,
  RECEIPT_EMAILED_WORDS,
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
}

/**
 * My account (stage 48), plain: the sections the account entry gives (`accountSections`), each
 * the host's answer. Money is the website's (ADR 0714): the card opens the business's website
 * account page (`extra.websiteUrl` in app.json). Copy the native-account block (cos add
 * native-account) for the styled screen with the packs' sections.
 */
function Account({ session, onSignedOut }: { session: Session; onSignedOut: () => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const websiteUrl = String(Constants.expoConfig?.extra?.websiteUrl ?? "");
  const load = useCallback(async () => {
    const api = session.api;
    try {
      const [me, sessions, family, orders, subscriptions, due] = await Promise.all([
        api.call("me.get", {}),
        api.call("me.sessions.list", {}),
        api.call("me.family", {}),
        loadOrders(accountClient(api)),
        api.call("subscription.list", { limit: 50 }),
        // What the host says is still to be agreed to (stage 44). Copy the
        // native-agreements-due block to read and agree to each in the app.
        api.call("me.agreements.due", {}).catch(() => ({ people: [] })),
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
