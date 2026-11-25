---
title: "Bookings: settings"
sidebar:
  label: "Settings"
  order: 6
editUrl: false
---

Settings are typed, edited in Settings → Extensions. A setting that is a person's to change waits for a person when anyone else changes it.

| Setting | Type | Label | Default | Limits | Description |
| --- | --- | --- | --- | --- | --- |
| `opensDays` | `number` | Booking opens (days before) | `7` | min 0; max 56; a person's to change | Members may book a class this many days before it, at the same time of day. At most 56, the timetable's horizon; a class type may open further ahead. |
| `closesMinutes` | `number` | Booking closes (minutes before) | `0` | min 0; max 10080; a person's to change | Members may book until this many minutes before a class (0: until it starts). |
| `lateMinutes` | `number` | Late cancel from (minutes before) | `60` | min 0; max 10080; a person's to change | A cancel this close to the start is late: it keeps the class it used. |
| `promotionMinutes` | `number` | Waitlist stops (minutes before) | `120` | min 0; max 10080; a person's to change | Nobody is moved in from the waitlist after this: a place freed later goes to whoever books first. |
| `dropInPrice` | `number` | Drop-in price |   | min 0; max 100000; a person's to change | What one class costs someone paying for it on the website, in the organisation's currency, unless its class type sets its own. Empty: no drop-ins. |
| `dropInHoldPercent` | `number` | Places held for unpaid drop-ins (percent) | `50` | min 0; max 100; a person's to change | At most this share of a class's places (at least one) may be held at once for visitors who have not paid yet. More are told to try again shortly. |
| `reminderMinutes` | `number` | Reminder (minutes before) | `180` | min 0; max 2880; a person's to change | When members booked into a class are emailed a reminder, unless its class type sets its own: at most two days (2,880 minutes) before. |
| `appointmentOpensDays` | `number` | Appointments: booking opens (days before) | `28` | min 0; max 365; a person's to change | Clients may book a one-to-one session this many days ahead. |
| `appointmentClosesMinutes` | `number` | Appointments: booking closes (minutes before) | `720` | min 0; max 10080; a person's to change | Clients may book a session until this many minutes before it (720: 12 hours). |
| `appointmentLateMinutes` | `number` | Appointments: late cancel from (minutes before) | `1440` | min 0; max 10080; a person's to change | A cancel this close to a session's start is late: the session is used, with no fee (1,440: 24 hours). Staff can give it back. |
| `bookingsUrl` | `text` | Where members see their bookings |   | a person's to change | The page on your site where a signed-in member sees their bookings (https), linked from every booking email, when it is on your site (Settings → Routine email). Empty: the emails say to sign in. |
| `feedbackForm` | `text` | Feedback form (its address) |   | a person's to change | The address of a Forms form answered by personal link (open, published, Who may answer: By personal link) that members are asked to answer after a class they came to, with a link that works once and for a week; at most once a month each, a child's to their parent or guardian. Empty: nobody is asked. |
| `feedbackMinutes` | `number` | Feedback asked (minutes after the tick) | `180` | min 0; max 2880; a person's to change | How long after a member is ticked as come the feedback email goes. |
