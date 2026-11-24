---
title: "Booking system copy: operations"
sidebar:
  label: "Operations"
  order: 1
editUrl: false
---

The core operations that are this capability's (named `outside.`). Each links to its full reference, with its input and output.

| Operation | What it does | Audiences | Risk | Permission |
| --- | --- | --- | --- | --- |
| [`outside.settings.get`](/reference/operations/outside/#outsidesettingsget) | Read the booking-system settings: whether the copy is on, which outside membership and pass types make a Person a member (by default every membership, no pass), the business's links (where a member manages their membership, where to book a class) and the largest age a members list counts for; and the membership types the current members list holds, each marked whether it counts. Needs bookingSystem:manage. | `staff` | `read` | `bookingSystem:manage` |
| [`outside.settings.update`](/reference/operations/outside/#outsidesettingsupdate) | Change the booking-system settings: on or off, the outside types that make a Person a member (null for the default: every membership type, no pass), the two links (each an https address, or null), and the largest age a members list counts for (1 to 90 days). Leave a setting out to keep it. A human admin in the app only. | `staff` | `write` | `settings:manage` |
| [`outside.status`](/reference/operations/outside/#outsidestatus) | The state of the booking system's copy: the current members and timetable lists (each with the date its file was exported, its age, when and by whom it was loaded, rows read, refused and kept, and for a members list whether it is too old to count), how many outside people are kept and linked, and how many people and coaches wait in To match. With no list loaded every count is 0. Counts and dates only, no names. Needs bookingSystem:manage. | `staff` | `read` | `bookingSystem:manage` |
| [`outside.matches`](/reference/operations/outside/#outsidematches) | To match: the outside people and coaches the host could not link by address, each with why (several_people: more than one Person or staff account has the address; shared_address: several outside people share it, as a family on one mailbox; no_address: the list gives none) and the candidates (Persons, or staff accounts) to choose from. Nobody is linked until a person links them with outside.link. Paged by ref. Needs bookingSystem:manage. | `staff` | `read` | `bookingSystem:manage` |
| [`outside.link`](/reference/operations/outside/#outsidelink) | Link an outside person from the members list to a Person, or a coach from the timetable list to a staff account, by hand, with why. A link made by a person is kept across loads by ref, whatever the address. It changes nothing on the Person: no name, address or phone, no customer account, nothing sent. Removes them from To match. A person with bookingSystem:manage only, never an AI. | `staff` | `write` | `bookingSystem:manage` |
| [`outside.unlink`](/reference/operations/outside/#outsideunlink) | Unlink an outside person or coach, with why: they stay in the copy linked to nobody while they count (a member, a live pass, booked), and the host never links them by address again (the decision is kept by ref across loads) until a person links them with outside.link. Removes them from To match. A person with bookingSystem:manage only, never an AI. | `staff` | `write` | `bookingSystem:manage` |
