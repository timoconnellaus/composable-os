// Contact preferences (stage 30, ADR 0675), for the mobile app: each kind of message the
// signed-in customer may get, on each channel it goes by, and the same for each child they act
// for. A tap turns one channel on or off (news and offers: yes or no, with the words shown). What
// may change is the host's answer (me.contact.choices, me.contact.setChoices): a booking's or a
// payment's email is always sent and shows as such; a child is never asked about news and offers.
import {
  type AccountHooks,
  accountErrorWords,
  type ContactLine,
  type ContactLineChannel,
  contactAllows,
  contactChannelWords,
  contactToggle,
} from "@composable-os/client";
import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { theme } from "../native-base/theme.ts";

type Hooks = Pick<AccountHooks, "useContactChoices" | "useSetContactChoices">;

export function ContactPreferences({ account }: { account: Hooks }) {
  const choices = account.useContactChoices();
  const set = account.useSetContactChoices();
  const [error, setError] = useState<string | null>(null);
  if (choices.isPending) return <ActivityIndicator color={theme.color.muted} />;
  if (choices.error || !choices.data) {
    return (
      <Text style={styles.body} accessibilityRole="alert">
        We could not load your contact preferences.
      </Text>
    );
  }

  async function toggle(personId: string, line: ContactLine, channel: ContactLineChannel) {
    const change = contactToggle(personId, line, channel);
    if (!change) return;
    setError(null);
    try {
      await set.mutateAsync(change);
      choices.refetch?.();
    } catch (e) {
      setError(accountErrorWords(e));
    }
  }

  return (
    <View style={styles.part}>
      {choices.data.people.map((person) => (
        <View key={person.personId} style={styles.part}>
          {person.self ? null : <Text style={styles.heading}>{person.name}</Text>}
          {person.lines.map((line) => (
            <View key={line.scope} style={styles.line}>
              <Text style={styles.title}>{line.label}</Text>
              <Text style={styles.detail}>{line.description}</Text>
              {line.channels.map((channel) => (
                <Button
                  key={channel.channel}
                  quiet={!contactAllows(channel.value)}
                  label={contactChannelWords(channel)}
                  disabled={channel.fixed || set.isPending}
                  onPress={() => void toggle(person.personId, line, channel)}
                />
              ))}
              {line.essential ? (
                <Text style={styles.detail}>
                  Always emailed: it is about something booked or paid for.
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ))}
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
  line: { gap: theme.space.sm },
  heading: { fontSize: theme.font.body, fontWeight: "600", color: theme.color.text },
  title: { fontSize: theme.font.body, fontWeight: "600", color: theme.color.text },
  detail: { fontSize: theme.font.small, color: theme.color.muted },
  body: { fontSize: theme.font.body, color: theme.color.text },
});
