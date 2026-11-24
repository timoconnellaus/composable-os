---
title: "Rostering: settings"
sidebar:
  label: "Settings"
  order: 6
editUrl: false
---

Settings are typed, edited in Settings → Extensions. A setting that is a person's to change waits for a person when anyone else changes it.

| Setting | Type | Label | Default | Limits | Description |
| --- | --- | --- | --- | --- | --- |
| `offerCutoffMinutes` | `number` | Offers close (minutes before a shift) | `60` | min 0; max 1440; a person's to change | A shift can be offered and taken in the app until this many minutes before it starts; then its offer lapses and whoever rosters reassigns it. |
| `uncoveredDays` | `number` | Warn about shifts with nobody on them (days ahead) | `14` | min 1; max 62; a person's to change | Whoever rosters hears of shifts with nobody on them this many days ahead, every morning and at once when one becomes uncovered. |
| `dutyHorizonDays` | `number` | Duty shifts are made (days ahead) | `56` | min 7; max 120; a person's to change | How far ahead each duty series' shifts are made: 56 days is eight weeks. |
| `payPeriod` | `select` | Pay period | `"fortnightly"` | one of weekly, fortnightly, monthly; a person's to change | How long each pay period is. Totals are made per period, for payroll. |
| `payPeriodStart` | `text` | A pay period starts on (weekly or fortnightly) |   | a person's to change | The date one pay period starts, YYYY-MM-DD (it fixes the weekday). Until it is set, nothing is totalled. |
| `payPeriodDay` | `number` | A monthly pay period starts on day | `1` | min 1; max 28; a person's to change | The day of the month each monthly pay period starts, 1 to 28. |
