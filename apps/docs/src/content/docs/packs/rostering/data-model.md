---
title: "Rostering: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

It requires no other pack.

## Duty (`rostering.duty`)

A kind of work that is not a class: cleaning, opening up. Its shifts are made by duty series; who may do it is a qualification.

|  |  |
| --- | --- |
| Plural | Duties |
| Title field | `name` |
| Listed in | settings |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `colour` | `select` | Colour |   | one of `slate`, `red`, `orange`, `amber`, `green`, `teal`, `blue`, `violet`, `pink` |   |
| `lengthMinutes` | `number` | Usual length (minutes) |   | default `60`; min 5; max 1440 |   |
| `place` | `text` | Where |   |   |   |
| `instructions` | `longText` | What to do |   |   |   |
| `checklist` | `checklist` | Checklist |   | a person's to change | Ticked off on each of its shifts by whoever is on it. Empty: none. |
| `active` | `boolean` | Active |   | default `true` |   |

## Duty series (`rostering.dutyseries`)

A duty on chosen weekdays at a local time, from a date, with its regular person. The host makes its shifts ahead.

|  |  |
| --- | --- |
| Plural | Duty series |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`recurring`](/reference/behaviours/#recurring) |
| Indexes | `state`; `duty` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title |   |   |   |
| `duty` | `relation` | Duty | yes | to `rostering.duty` |   |
| `weekdays` | `multiSelect` | Weekdays | yes | one of `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun` |   |
| `time` | `text` | Starts at (local time) | yes |   | HH:MM in the series' time zone, e.g. 18:00. |
| `length` | `number` | Length (minutes) | yes | min 5; max 1440 |   |
| `firstDate` | `date` | First date | yes |   |   |
| `lastDate` | `date` | Last date |   |   | Empty: ongoing. |
| `timezone` | `timezone` | Time zone |   |   |   |
| `staff` | `user` | Regular person |   | a person's to change | Who works it every week. Empty: each shift is made with nobody on it. |
| `state` | `select` | State |   | one of `active`, `ended` |   |

### Relations

- `duty` → `rostering.duty`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "states": {
    "field": "state",
    "initial": "active",
    "moves": [
      {
        "from": "active",
        "to": "ended",
        "by": [
          "staff"
        ],
        "final": true
      }
    ]
  },
  "recurring": {
    "generates": "shift",
    "link": "series",
    "rule": {
      "weekdays": "weekdays",
      "time": "time",
      "length": "length",
      "from": "firstDate",
      "until": "lastDate",
      "zone": "timezone"
    },
    "into": {
      "starts": "startsAt",
      "ends": "endsAt",
      "zone": "timezone",
      "changed": "changed"
    },
    "copy": {
      "title": "title",
      "duty": "duty",
      "staff": "staff"
    },
    "cancel": "cancelled",
    "ended": {
      "field": "state",
      "in": [
        "ended"
      ]
    },
    "horizonDays": 56,
    "horizonSetting": "dutyHorizonDays"
  }
}
```

</details>

## Duty shift (`rostering.shift`)

One dated duty shift: made by a duty series, or a one-off. Its person works it; nobody is ever on two shifts at once.

|  |  |
| --- | --- |
| Plural | Duty shifts |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`staffed`](/reference/behaviours/#staffed), [`checklists`](/reference/behaviours/#checklists) |
| Indexes | `startsAt`; `staff`; `state, startsAt`; `series` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title |   |   |   |
| `duty` | `relation` | Duty | yes | to `rostering.duty`; a person's to change |   |
| `series` | `relation` | Duty series |   | to `rostering.dutyseries`; read-only | The series that made it. Empty for a one-off shift. |
| `startsAt` | `datetime` | Starts | yes |   |   |
| `endsAt` | `datetime` | Ends | yes |   |   |
| `timezone` | `timezone` | Time zone | yes |   |   |
| `staff` | `user` | Person |   | a person's to change |   |
| `notes` | `longText` | Notes |   |   |   |
| `state` | `select` | State |   | one of `scheduled`, `cancelled` |   |
| `changed` | `boolean` | Changed from its series |   | read-only | Moved, or its state changed, by hand: its series no longer changes it. A person changed by hand alone stays this shift's own, and later changes to its series still reach the rest. |

### Relations

- `duty` → `rostering.duty`
- `series` → `rostering.dutyseries`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "states": {
    "field": "state",
    "initial": "scheduled",
    "moves": [
      {
        "from": "scheduled",
        "to": "cancelled",
        "by": [
          "staff",
          "host"
        ]
      },
      {
        "from": "cancelled",
        "to": "scheduled",
        "by": [
          "staff"
        ]
      }
    ]
  },
  "staffed": {
    "who": {
      "field": "staff"
    },
    "starts": "startsAt",
    "ends": "endsAt",
    "zone": "timezone",
    "kind": "duty",
    "live": [
      "scheduled"
    ],
    "place": "duty.place",
    "pattern": {
      "link": "series",
      "who": "staff"
    }
  },
  "checklists": {
    "template": "duty.checklist",
    "who": "staff",
    "opens": "startsAt",
    "closes": "endsAt",
    "live": [
      "scheduled"
    ]
  }
}
```

</details>

## Views

| View | Object | Label |
| --- | --- | --- |
| `shifts` | `rostering.shift` | Duty shifts |
| `series` | `rostering.dutyseries` | Duty series |
