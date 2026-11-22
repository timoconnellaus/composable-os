// A fixture spender for the Memberships pack's tests in the real host (apps/runner/test/
// memberships.test.ts): a class and a booking, under the id and names stage 31's Bookings pack
// gives them (`bookings.booking`, with `paidBy` listing this pack), so the pack's holders are
// spent exactly as they will be. It is not the Bookings pack: no timetable, windows, waitlist or
// family link. The fields a holder's conditions read are the ones the host fills from the class:
// its class type, and the local weekday and minute of its start in its zone.
import { defineExtension } from "@composable-os/sdk";

export default defineExtension({
  id: "bookings",
  version: "0.0.1",
  contractVersion: 1,
  label: "Bookings (test fixture)",
  description: "A class and a booking that spends a membership or a pass: a test fixture.",
  requires: ["programs"],
  objects: {
    class: {
      label: "Class",
      plural: "Classes",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        classType: { type: "relation", label: "Class type", to: "programs.classtype" },
        startsAt: { type: "datetime", label: "Starts" },
        zone: { type: "timezone", label: "Time zone" },
      },
    },
    booking: {
      label: "Booking",
      plural: "Bookings",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        person: { type: "relation", label: "Member", to: "person" },
        class: { type: "relation", label: "Class", to: "bookings.class" },
        holder: { type: "text", label: "Paid by" },
        classType: {
          type: "relation",
          label: "Class type",
          to: "programs.classtype",
          readOnly: true,
        },
        weekday: { type: "number", label: "Weekday", readOnly: true },
        minute: { type: "number", label: "Minute", readOnly: true },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "pending", label: "Pending" },
            { value: "booked", label: "Booked" },
            { value: "cancelled", label: "Cancelled" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "pending",
        moves: [
          { from: "pending", to: "booked", by: ["staff", "customer"] },
          { from: "booked", to: "cancelled", by: ["staff"], final: true },
        ],
      },
      allowance: {
        spends: {
          person: "person",
          holder: "holder",
          spendIn: ["booked"],
          returnIn: ["cancelled"],
          at: "class.startsAt",
          copy: { classType: "class.classType" },
          local: { weekday: "weekday", minute: "minute", zone: "class.zone" },
          paidBy: ["memberships"],
        },
      },
    },
  },
});
