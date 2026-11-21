// The mobile app: sign-in, then two tabs, a public Home and the signed-in Account, which shows the
// customer's own record from me.get. The screens are plain React Native; the host is src/host.ts.
import Constants from "expo-constants";
import { useEffect, useMemo, useState } from "react";
import {
  Button as NativeButton,
  SafeAreaView,
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

function Account({ session, onSignedOut }: { session: Session; onSignedOut: () => void }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    session.api.call("me.get", {}).then((me) => setName(me.displayName));
  }, [session]);
  return (
    <View>
      <Text style={styles.title}>{name ? `Signed in as ${name}` : "Loading"}</Text>
      <NativeButton title="Sign out" onPress={() => session.signOut().then(onSignedOut)} />
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
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 },
  tabs: { flexDirection: "row", justifyContent: "space-around", paddingBottom: 16 },
});
