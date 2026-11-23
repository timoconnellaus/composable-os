// The timetable in the gym's app (stage 31a, decision 9): book and cancel with the membership or
// pass a member already holds. Nothing is bought here: a member with nothing to spend is told so
// by the host, and buys on the website. Whether booking is open, the places left and whether a
// cancel is in time are the host's answers, shown as they come. A parent the gym linked to a child
// picks who they are booking for (ADR 0540); the child's own membership or pass pays.
//
// What must be agreed to first (stage 44) is the host's answer too: when "Book" is refused with
// it, the documents are shown in the class's place (the native-agree block's step), agreed to one
// by one, and "Book" is tried again.
import {
  type AgreementsHooks,
  type AgreementsOutcome,
  purchaseErrorWords,
  type RefusedDocument,
  withAgreements,
} from "@composable-os/client";
import type {
  BookingsHooks,
  BookResult,
  TimetableClass,
} from "@composable-os/pack-bookings/client";
import {
  bookingFor,
  classTime,
  placesLabel,
  refusalMessage,
} from "@composable-os/pack-bookings/client";
import { useState } from "react";
import { Text, View } from "react-native";
import { AgreementStepModal } from "../native-agree/agreement-step.tsx";
import { Button } from "../native-base/button.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";

type Hooks = Pick<
  BookingsHooks,
  "useTimetable" | "useMyBookings" | "useBook" | "useCancel" | "useFamily"
>;

/** The agreements hooks the inline step uses. */
export type TimetableAgreements = Pick<AgreementsHooks, "useDue" | "useAccept">;

export function TimetableScreen({
  bookings,
  agreements,
}: {
  bookings: Hooks;
  /** For what must be agreed to first, shown inline. Without it, the refusal is only named. */
  agreements?: TimetableAgreements;
}) {
  const timetable = bookings.useTimetable({});
  const family = bookings.useFamily();
  const people = family.data?.people ?? [];
  const [personId, setPersonId] = useState<string | null>(null);
  const chosen = people.find((p) => p.personId === personId && !p.self);
  const mine = bookings.useMyBookings(chosen ? { personId: chosen.personId } : {});
  const [message, setMessage] = useState<string | null>(null);
  const done = (text: string) => {
    setMessage(text);
    timetable.refetch?.();
    mine.refetch?.();
  };
  return (
    <Screen title="Timetable">
      {people.length > 1 ? (
        <View>
          <Text>Booking for</Text>
          {people.map((person) => (
            <Button
              key={person.personId}
              label={person.self ? "Me" : person.name}
              quiet={(chosen?.personId ?? null) !== (person.self ? null : person.personId)}
              onPress={() => {
                setPersonId(person.self ? null : person.personId);
                setMessage(null);
              }}
            />
          ))}
        </View>
      ) : null}
      {message ? <Text accessibilityRole="alert">{message}</Text> : null}
      {timetable.isPending ? (
        <Text accessibilityRole="progressbar">Loading the timetable…</Text>
      ) : null}
      {timetable.error ? (
        <Text accessibilityRole="alert">We could not load the timetable.</Text>
      ) : null}
      {timetable.data ? (
        <List empty="No classes in these days.">
          {timetable.data.classes.map((klass) => (
            <ClassItem
              key={klass.id}
              klass={klass}
              booking={bookingFor(klass.id, mine.data?.bookings)}
              forPerson={chosen ? { id: chosen.personId, name: chosen.name } : null}
              bookings={bookings}
              agreements={agreements}
              onDone={done}
            />
          ))}
        </List>
      ) : null}
    </Screen>
  );
}

function ClassItem({
  klass,
  booking,
  forPerson,
  bookings,
  agreements,
  onDone,
}: {
  klass: TimetableClass;
  booking: { id: string } | undefined;
  /** A child the member is booking for, or null for themselves. */
  forPerson: { id: string; name: string } | null;
  bookings: Pick<BookingsHooks, "useBook" | "useCancel">;
  agreements: TimetableAgreements | undefined;
  onDone: (message: string) => void;
}) {
  const book = bookings.useBook();
  const cancel = bookings.useCancel();
  const [preview, setPreview] = useState<{
    state: "cancelled" | "late_cancelled";
    message: string;
  } | null>(null);
  // What the host said must be agreed to first.
  const [due, setDue] = useState<RefusedDocument[] | null>(null);
  const name = klass.title ?? "Class";

  /** Books; `said` is what agreeing just now told them (where the copy went), said first. */
  async function bookIt(said: string | null = null) {
    const first = said ? `${said} ` : "";
    let outcome: AgreementsOutcome<BookResult>;
    try {
      outcome = await withAgreements(() =>
        book.mutateAsync({
          classId: klass.id,
          ...(forPerson ? { forPersonId: forPerson.id } : {}),
        }),
      );
    } catch (error) {
      onDone(
        `${first}${purchaseErrorWords(error) ?? "We could not book that just now. Try again soon."}`,
      );
      return;
    }
    if (outcome.kind === "due") {
      if (agreements) setDue(outcome.documents);
      else {
        onDone(
          `Something must be agreed to first: ${outcome.documents.map((d) => d.title).join(", ")}.`,
        );
      }
      return;
    }
    if (outcome.kind === "minor_payer") {
      onDone(outcome.message);
      return;
    }
    const result = outcome.value;
    onDone(
      first +
        (result.result === "booked"
          ? `Booked${forPerson ? ` for ${forPerson.name}` : ""}: ${name}, ${classTime(klass)}.`
          : result.result === "waiting"
            ? `${name}: ${result.message}`
            : refusalMessage(result, klass.timeZone)),
    );
  }

  return (
    <View>
      {due && agreements ? (
        // On a screen of its own, over the list: a signature is never drawn inside a scroll.
        <AgreementStepModal
          agreements={agreements}
          documents={due}
          continueLabel="Agree and book"
          onCancel={() => setDue(null)}
          onAgreed={(said) => {
            setDue(null);
            void bookIt(said);
          }}
        />
      ) : null}
      <Row
        title={name}
        detail={[classTime(klass), klass.coach?.name, placesLabel(klass.places)]
          .filter(Boolean)
          .join(" · ")}
      />
      {booking && preview ? (
        <View>
          <Text>{preview.message}</Text>
          <Button
            label="Confirm cancel"
            busy={cancel.isPending}
            onPress={async () => {
              const result = await cancel.mutateAsync({
                bookingId: booking.id,
                confirm: true,
                expect: preview.state,
              });
              setPreview(null);
              onDone(
                result.result === "refused"
                  ? refusalMessage(result, klass.timeZone)
                  : `${name}: ${result.message}`,
              );
            }}
          />
          <Button label="Keep it" quiet onPress={() => setPreview(null)} />
        </View>
      ) : booking ? (
        <Button
          label="Cancel"
          quiet
          busy={cancel.isPending}
          onPress={async () => {
            const asked = await cancel.mutateAsync({ bookingId: booking.id });
            if (asked.result === "refused") onDone(refusalMessage(asked, klass.timeZone));
            else setPreview({ state: asked.state, message: asked.message });
          }}
        />
      ) : (
        <Button label="Book" busy={book.isPending} onPress={() => void bookIt()} />
      )}
    </View>
  );
}
