// Sign-in and devices (stage 48), for the mobile app: every place the signed-in customer is
// signed in, when each began and was last used, and signing one out. Which sessions are theirs is
// the host's (me.sessions.list, me.sessions.revoke). Signing out of this device is the app's own
// (`onSignOut`: the template's session.signOut, which ends the tokens and forgets them).
import {
  type AccountHooks,
  accountErrorWords,
  orderedSessions,
  sessionWords,
} from "@composable-os/client";
import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { theme } from "../native-base/theme.ts";

type Hooks = Pick<AccountHooks, "useSessions" | "useRevokeSession">;

export function SignInAndDevices({
  account,
  onSignOut,
}: {
  account: Hooks;
  /** Signs this device out and goes back to sign-in. */
  onSignOut: () => void;
}) {
  const sessions = account.useSessions();
  const revoke = account.useRevokeSession();
  const [error, setError] = useState<string | null>(null);
  if (sessions.isPending) return <ActivityIndicator color={theme.color.muted} />;
  if (sessions.error || !sessions.data) {
    return (
      <Text style={styles.body} accessibilityRole="alert">
        We could not load where you are signed in.
      </Text>
    );
  }
  const items = orderedSessions(sessions.data.items);

  async function signOutOne(id: string) {
    setError(null);
    try {
      await revoke.mutateAsync({ id });
      sessions.refetch?.();
    } catch (e) {
      setError(accountErrorWords(e));
    }
  }

  return (
    <View style={styles.part}>
      <List>
        {items.map((session) => {
          const words = sessionWords(session);
          return <Row key={session.id} title={words.title} detail={words.detail} />;
        })}
      </List>
      {items
        .filter((session) => !session.current)
        .map((session) => (
          <Button
            key={session.id}
            quiet
            label={`Sign out ${sessionWords(session).title}`}
            disabled={revoke.isPending}
            onPress={() => void signOutOne(session.id)}
          />
        ))}
      <Button label="Sign out of this device" onPress={onSignOut} />
      {error ? (
        <Text style={styles.body} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  part: { gap: theme.space.md },
  body: { fontSize: theme.font.body, color: theme.color.text },
});
