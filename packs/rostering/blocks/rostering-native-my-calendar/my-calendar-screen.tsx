// My calendar in the app (stage 45 step 7, over step 5's feed, ADR 0628): whether I have a private
// calendar address for my own shifts, making one (or a new one, which stops the old), and switching
// it off. The address is shown once, as the host gives it, then copied (the app's own clipboard,
// passed as `copy`) or opened in the phone's calendar (`openUrl`, React Native's Linking.openURL,
// with the webcal address); it is never stored, and is cleared when the screen closes. A lost
// address is never shown again: make a new one. The same headless entry as the web's screen.
import {
  forgetAfter,
  type RosteringHooks,
  type RosterRefusal,
  rosterRefusal,
} from "@composable-os/pack-rostering/client";
import { useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { Screen } from "../native-base/screen.tsx";
import { Sheet } from "../native-base/sheet.tsx";

type Hooks = Pick<RosteringHooks, "useFeed" | "useFeedRotate" | "useFeedRevoke">;

export function MyCalendarScreen({
  rostering,
  openUrl,
  copy,
}: {
  rostering: Hooks;
  /** Opens the webcal address in the phone's calendar (React Native's `Linking.openURL`). */
  openUrl: (url: string) => Promise<unknown> | unknown;
  /** The app's clipboard, if it has one (for example expo-clipboard's `setStringAsync`). */
  copy?: (text: string) => Promise<unknown> | unknown;
}) {
  const feed = rostering.useFeed();
  const rotate = rostering.useFeedRotate();
  const revoke = rostering.useFeedRevoke();
  const [address, setAddress] = useState<{ https: string; webcal: string } | null>(null);
  const [confirm, setConfirm] = useState<"replace" | "off" | null>(null);
  const [refusal, setRefusal] = useState<RosterRefusal | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => () => setAddress(null), []);
  // Hidden when the app leaves the screen for the background, so the app switcher's snapshot never
  // shows it.
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active") setAddress(null);
    });
    return () => listener.remove();
  }, []);

  async function make() {
    setConfirm(null);
    setRefusal(null);
    setSaid(null);
    setAddress(null);
    try {
      const made = await forgetAfter(rotate, {});
      setAddress({ https: made.https, webcal: made.webcal });
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
    await feed.refetch?.();
  }

  async function off() {
    setConfirm(null);
    setRefusal(null);
    setAddress(null);
    try {
      await revoke.mutateAsync({});
      setSaid("Switched off: the address no longer works.");
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
    await feed.refetch?.();
  }

  const busy = rotate.isPending || revoke.isPending;
  return (
    <Screen title="My calendar">
      <Text>
        A private address your phone's calendar subscribes to: your own shifts, kept up to date.
        Anyone with it sees your shifts, so do not share it. Calendars fetch it on their own
        schedule, often hours apart: this app is always the latest.
      </Text>
      {feed.isPending ? <Text accessibilityRole="progressbar">Loading…</Text> : null}
      {feed.error ? (
        <Text accessibilityRole="alert">{rosterRefusal(feed.error).message}</Text>
      ) : null}
      {refusal ? <Text accessibilityRole="alert">{refusal.message}</Text> : null}
      {said ? <Text accessibilityRole="alert">{said}</Text> : null}
      {address ? (
        <View>
          <Text accessibilityRole="header">Your calendar address (shown this once)</Text>
          <Text selectable>{address.https}</Text>
          <Button label="Add to calendar" onPress={() => openUrl(address.webcal)} />
          {copy ? (
            <Button
              label="Copy the address"
              quiet
              onPress={async () => {
                await copy(address.https);
                setSaid("Copied.");
              }}
            />
          ) : null}
          <Button label="Done" quiet onPress={() => setAddress(null)} />
          <Text>It is not kept here. Lost it? Make a new address: the old one stops working.</Text>
        </View>
      ) : null}
      {feed.data && !address ? (
        <Text>
          {feed.data.active ? "You have a calendar address." : "You have no calendar address."}
        </Text>
      ) : null}
      {feed.data?.active ? (
        <View>
          <Button
            label="Make a new address"
            quiet
            busy={busy}
            onPress={() => setConfirm("replace")}
          />
          <Button label="Switch it off" quiet busy={busy} onPress={() => setConfirm("off")} />
        </View>
      ) : feed.data ? (
        <Button label="Make my calendar address" busy={busy} onPress={make} />
      ) : null}
      <Sheet
        open={confirm !== null}
        title={confirm === "replace" ? "Make a new address?" : "Switch it off?"}
        onClose={() => setConfirm(null)}
      >
        <Text>
          {confirm === "replace"
            ? "The address you have stops working, in every calendar that uses it."
            : "The address stops working; your calendar keeps what it last fetched."}
        </Text>
        <Button
          label={confirm === "replace" ? "Make a new address" : "Switch it off"}
          busy={busy}
          onPress={confirm === "replace" ? make : off}
        />
        <Button label="Keep it" quiet onPress={() => setConfirm(null)} />
      </Sheet>
    </Screen>
  );
}
