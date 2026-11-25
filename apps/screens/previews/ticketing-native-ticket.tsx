import { eventTime } from "@composable-os/pack-ticketing/client";
import { View } from "react-native";
import { TicketScreen } from "../../../packs/ticketing/blocks/ticketing-native-ticket/ticket-screen.tsx";
import { myTickets } from "./data/ticketing.ts";

// A stand-in for the app's QR drawing (react-native-qrcode-svg, say): a grid
// that looks like a QR code of the value, with its three finder squares. It is not a readable
// code; the pictures only need to show where the app draws one.

const N = 25;

function hash(value: string): () => number {
  let h = 2166136261;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h >>> 0) % 1000) / 1000;
  };
}

function finder(x: number, y: number): boolean | null {
  for (const [fx, fy] of [
    [0, 0],
    [N - 7, 0],
    [0, N - 7],
  ] as const) {
    const dx = x - fx;
    const dy = y - fy;
    if (dx >= -1 && dx <= 7 && dy >= -1 && dy <= 7) {
      if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return false;
      const ring = Math.min(dx, dy, 6 - dx, 6 - dy);
      return ring !== 1;
    }
  }
  return null;
}

function FakeQr({ value, size }: { value: string; size: number }) {
  const next = hash(value);
  const cell = Math.floor(size / N);
  return (
    <View accessibilityLabel={`QR code of ${value}`}>
      {Array.from({ length: N }, (_, y) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid, never reordered
        <View key={y} style={{ flexDirection: "row" }}>
          {Array.from({ length: N }, (_, x) => {
            const dark = finder(x, y) ?? next() < 0.5;
            return (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid, never reordered
                key={x}
                style={{ width: cell, height: cell, backgroundColor: dark ? "#111111" : "#ffffff" }}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
}

const ticket = myTickets.items[0] as (typeof myTickets.items)[number];

export default function Preview() {
  return (
    <TicketScreen
      ticket={ticket}
      title={ticket.eventName ?? "Ticket"}
      detail={[ticket.ticketTypeName, eventTime(ticket), ticket.venue].filter(Boolean).join(" · ")}
      Qr={FakeQr}
    />
  );
}
