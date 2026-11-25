import {
  createTicketingHooks,
  TICKETING_HOOKS_CALL,
  type TicketingOperations,
} from "@composable-os/pack-ticketing/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  type CodeScanner,
  DoorScannerScreen,
} from "../../../packs/ticketing/blocks/ticketing-native-scanner/door-scanner-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { doorScans } from "./data/ticketing.ts";

const codes = ["TK7QM2XR94PA", "TK3HWN8D21LC", "TK9BFE4K67TS"];

const ticketing = createTicketingHooks(
  react,
  fakeClient<TicketingOperations>(TICKETING_HOOKS_CALL, {
    "x.ticketing.checkIn": ({ code }) =>
      doorScans[Math.max(0, codes.indexOf(code))] as (typeof doorScans)[number],
  }),
);

/**
 * A stand-in for the app's camera (expo-camera in the client template): a dark viewfinder that
 * "reads" the next code when pressed, so the picture can show the door after three scans.
 */
const Camera: CodeScanner = ({ onCode, paused }) => {
  const [next, setNext] = useState(0);
  return (
    <Pressable
      onPress={() => {
        if (paused) return;
        onCode(codes[next % codes.length] as string);
        setNext((n) => n + 1);
      }}
      style={{
        height: 300,
        borderRadius: 12,
        backgroundColor: "#1f2933",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: 180,
          height: 180,
          borderWidth: 3,
          borderColor: "#ffffff",
          borderRadius: 16,
          opacity: paused ? 0.4 : 0.9,
        }}
      />
      <Text style={{ color: "#e5e7eb", marginTop: 16 }}>Point the camera at a ticket</Text>
    </Pressable>
  );
};

export default function Preview() {
  return (
    <DoorScannerScreen ticketing={ticketing} Scanner={Camera} title="Door · Spring Yoga Retreat" />
  );
}

/** Three tickets scanned: the third is let in with a balance owing. */
export const click = [
  "Point the camera",
  "Scan the next",
  "Point the camera",
  "Scan the next",
  "Point the camera",
];
