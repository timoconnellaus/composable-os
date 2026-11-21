# ADR 0450: A record's own time zone, and date triggers counted in it

Status: accepted, 2026-11-21 (stage 27 follow-up, from the first client's build). Builds on ADRs
[0023](0023-extension-contract.md) (the extension contract and its field types), [0130](0130-automation-runtime.md)
(date-relative triggers) and [0167](0167-first-run-setup-wizard.md) (the
organisation's time zone).

## Context
The first event the gym sells may be held in another country: a camp in Thailand sold by a gym in
New South Wales. A datetime field holds an instant (UTC) and nothing says where the event's clock
is, so a client showed its times in the site's own zone, and the date-relative triggers counted
days in the automation zone against the UTC date of the stored value. A camp starting at 06:30 on
2 March in Bangkok is 23:30 UTC on 1 March: its "day before" reminder fired on 28 February, a day
early, and "the day after it ends" could be a day off the other way.

## Decision
- **A `timezone` field type** (SDK `FIELD_TYPES`, the host's field-type registry): text, but only
  an IANA name the runtime knows (`Intl.supportedValuesOf("timeZone")`, or `UTC`), refused
  otherwise on every write, the import and seeds. It reads as text in formulas and filters.
- **Its default is the deployment's zone.** A `timezone` field left empty on a new record, with
  no default of its own, gets the organisation's zone (Settings → General, `timezone`, stage 8) in
  `record.create`, so an event created in Sydney is in Sydney until someone says otherwise.
- **A date-relative trigger may name a `zoneField`** (a `timezone` field of its object, checked by
  the automation check). Its days are then counted in each record's own zone: a record matches
  when its date field, as a day in its zone, is that zone's today minus `offsetDays`. Such
  triggers are scanned once an hour (`runZonedDateRelative`, from five past the hour UTC, marked
  per hour in `core_automation_counters`), so a record is matched in the first hour of its own
  local day; the idempotency key is the record and that local day, so each matches once a day.
  The rows read are those within two days of the target in UTC; the local day is worked out per
  row. A trigger without `zoneField` is unchanged (once a day, in the automation zone).
- **Ticketing:** an event has a required `timezone`, which the public and holders read; the tools
  (`eventsOnSale`, `myTickets`) return it as `timeZone` beside the start and end; the emails write
  the start in the event's zone and name the zone; the reminder (the day before) and "event ended"
  (the day after) triggers name `zoneField: "timezone"`. The hooks' `eventTime` formats in the
  event's zone and says the zone (`(Bangkok time)`) when the viewer's zone shows another time;
  `eventDay` is the event's local day.

## Why
- An instant plus the zone it belongs to is the least that says both "when" and "which day there";
  a field type, rather than a pack's text field, makes the zone checked and lets the platform's
  triggers rely on it.
- Hourly scans for zoned triggers are the least that fires on the record's own day everywhere;
  a once-a-day scan in one zone cannot, for zones a day apart.

## Proof
`apps/runner/test/ticketing.test.ts`, "an event's own time zone": with the deployment in
`Australia/Sydney`, an event created without a zone is in `Australia/Sydney`; a made-up zone is
refused; a camp in `Asia/Bangkok` starting 23:30 UTC on 1 March is shown as 2 March, 06:30, Bangkok
time, to a viewer in Sydney, and its emails say so; its reminder is due at 01:00 Bangkok time on 1
March and not on 28 February or 2 March; the real "event ended" automation leaves it on sale at
23:30 on 5 March Bangkok time and ends it at 00:30 on 6 March. `packages/sdk/test/automation.test.ts`:
a `zoneField` that is not a timezone field is refused.

## Consequences
- An event created before this change has no zone; its holders' outputs return `timeZone: null`,
  the hooks fall back to the viewer's zone and the zoned triggers to the automation zone. Staff set
  it on the record.
- Zoned triggers read their candidate rows once an hour instead of once a day.
- The admin edits a zone as text (the field's validation names the format); a picker is for later.
