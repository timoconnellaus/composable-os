---
title: "Bookings: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

Requires [programs](/packs/programs/): the host refuses to install it while one is missing.

## Room (`bookings.room`)

Where classes are held.

|  |  |
| --- | --- |
| Plural | Rooms |
| Title field | `name` |
| Listed in | settings |
| Behaviours | [`public`](/reference/behaviours/#public) |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `places` | `number` | Places |   | min 0 | The most the room holds: a guide for staff, not a limit on a class. |
| `exclusive` | `boolean` | One booking at a time |   | default `false` | Nothing else can be booked in this room while a class is in it. Turning it on is refused while two classes still to come overlap in it. |
| `notes` | `longText` | Notes |   |   |   |

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "public": {
    "read": [
      "name"
    ]
  }
}
```

</details>

## Coach (`bookings.coach`)

Who teaches classes. Name, photo and bio are shown on the timetable.

|  |  |
| --- | --- |
| Plural | Coaches |
| Title field | `name` |
| Listed in | settings |
| Behaviours | [`unique`](/reference/behaviours/#unique), [`public`](/reference/behaviours/#public) |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `photo` | `url` | Photo |   |   |   |
| `bio` | `longText` | Short bio |   |   |   |
| `user` | `user` | Staff account |   |   | Their staff account, if they have one (a visiting coach may not). |
| `active` | `boolean` | Active |   | default `true` |   |

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "unique": [
    {
      "fields": [
        "user"
      ]
    }
  ],
  "public": {
    "read": [
      "name",
      "photo",
      "bio"
    ]
  }
}
```

</details>

## Series (`bookings.series`)

One line of the timetable: a class type on chosen weekdays at a local time, from a date. The host makes its classes ahead.

|  |  |
| --- | --- |
| Plural | Series |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`recurring`](/reference/behaviours/#recurring) |
| Indexes | `state`; `classType` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title |   |   |   |
| `classType` | `relation` | Class type | yes | to `programs.classtype` |   |
| `weekdays` | `multiSelect` | Weekdays | yes | one of `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun` |   |
| `time` | `text` | Starts at (local time) | yes |   | HH:MM in the series' time zone, e.g. 06:00. |
| `length` | `number` | Length (minutes) | yes | min 5; max 1440 |   |
| `room` | `relation` | Room |   | to `bookings.room` |   |
| `coach` | `relation` | Coach |   | to `bookings.coach`; a person's to change |   |
| `places` | `number` | Places | yes | min 0 |   |
| `firstDate` | `date` | First date | yes |   |   |
| `lastDate` | `date` | Last date |   |   | Empty: ongoing. |
| `timezone` | `timezone` | Time zone |   |   |   |
| `state` | `select` | State |   | one of `active`, `ended` |   |

### Relations

- `classType` → `programs.classtype`
- `room` → `bookings.room`
- `coach` → `bookings.coach`

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
    "generates": "class",
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
      "classType": "classType",
      "room": "room",
      "coach": "coach",
      "places": "places"
    },
    "cancel": "cancelled",
    "ended": {
      "field": "state",
      "in": [
        "ended"
      ]
    },
    "closures": {
      "object": "closure",
      "from": "fromDate",
      "until": "untilDate"
    },
    "horizonDays": 57,
    "horizonAtLeast": {
      "object": "programs.classtype",
      "field": "opensDays"
    }
  }
}
```

</details>

## Class (`bookings.class`)

One dated class: made by a series, or a one-off. Members book its places; its record page is its list.

|  |  |
| --- | --- |
| Plural | Classes |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`capacity`](/reference/behaviours/#capacity), [`staffed`](/reference/behaviours/#staffed), [`occupies`](/reference/behaviours/#occupies), [`public`](/reference/behaviours/#public), [`customerVia`](/reference/behaviours/#customervia) |
| Indexes | `startsAt`; `state, startsAt`; `series`; `classType, startsAt`; `endsAt` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title |   |   |   |
| `series` | `relation` | Series |   | to `bookings.series`; read-only | The series that made it. Empty for a one-off class. |
| `classType` | `relation` | Class type | yes | to `programs.classtype` |   |
| `startsAt` | `datetime` | Starts | yes |   |   |
| `endsAt` | `datetime` | Ends | yes |   |   |
| `timezone` | `timezone` | Time zone | yes |   |   |
| `room` | `relation` | Room |   | to `bookings.room` |   |
| `coach` | `relation` | Coach |   | to `bookings.coach`; a person's to change |   |
| `places` | `number` | Places | yes | min 0 |   |
| `notes` | `longText` | Notes for members |   |   |   |
| `state` | `select` | State |   | one of `scheduled`, `cancelled`, `done` |   |
| `changed` | `boolean` | Changed from its series |   | read-only | Moved, or its state changed, by hand: its series no longer changes it. A field changed by hand alone (another coach that day) stays this class's own, and later changes to its series still reach the rest. |
| `cancelledReason` | `longText` | Why it was cancelled |   | read-only | The reason staff gave when they cancelled the class. |
| `closed` | `formula` | Closed to members |   |   |   |

### Relations

- `series` → `bookings.series`
- `classType` → `programs.classtype`
- `room` → `bookings.room`
- `coach` → `bookings.coach`

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
          "host"
        ],
        "tools": [
          "cancelClass"
        ],
        "window": {
          "until": "endsAt"
        },
        "bindsStaff": true,
        "final": true
      },
      {
        "from": "scheduled",
        "to": "done",
        "by": [
          "staff",
          "host"
        ],
        "final": true
      }
    ]
  },
  "capacity": {
    "places": "places",
    "show": "exact"
  },
  "staffed": {
    "who": {
      "field": "coach",
      "account": "user"
    },
    "starts": "startsAt",
    "ends": "endsAt",
    "zone": "timezone",
    "kind": "classType",
    "live": [
      "scheduled",
      "done"
    ],
    "place": "room.name",
    "pattern": {
      "link": "series",
      "who": "coach"
    },
    "payBefore": {
      "field": "classType.rosterBeforeMinutes"
    },
    "payAfter": {
      "field": "classType.rosterAfterMinutes"
    },
    "evidence": {
      "object": "booking",
      "link": "class",
      "by": "markedBy"
    }
  },
  "occupies": {
    "thing": "room",
    "starts": "startsAt",
    "ends": "endsAt",
    "live": [
      "scheduled",
      "done"
    ],
    "only": "exclusive",
    "title": "title"
  },
  "public": {
    "read": [
      "title",
      "classType",
      "startsAt",
      "endsAt",
      "timezone",
      "room",
      "coach",
      "notes",
      "state"
    ],
    "when": {
      "field": "state",
      "in": [
        "scheduled"
      ]
    }
  },
  "customerVia": {
    "from": "bookings.booking",
    "field": "class",
    "read": [
      "title",
      "classType",
      "startsAt",
      "endsAt",
      "timezone",
      "room",
      "coach",
      "notes",
      "state"
    ]
  }
}
```

</details>

## Closure (`bookings.closure`)

Dates the gym is closed (holidays): no classes are made on them, and classes already made are cancelled (a person confirms when any have bookings).

|  |  |
| --- | --- |
| Plural | Closures |
| Title field | `name` |
| Listed in | settings |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Reason | yes |   |   |
| `fromDate` | `date` | From | yes |   |   |
| `untilDate` | `date` | Until | yes |   |   |

## Booking (`bookings.booking`)

One person's place in one class.

|  |  |
| --- | --- |
| Plural | Bookings |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`healthNotes`](/reference/behaviours/#healthnotes), [`agreements`](/reference/behaviours/#agreements), [`claims`](/reference/behaviours/#claims), [`unique`](/reference/behaviours/#unique), [`sellable`](/reference/behaviours/#sellable), [`allowance`](/reference/behaviours/#allowance), [`customer`](/reference/behaviours/#customer) |
| Indexes | `class, state`; `person, state`; `state` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title |   |   |   |
| `class` | `relation` | Class | yes | to `bookings.class` |   |
| `person` | `relation` | Person |   | to `person` |   |
| `state` | `select` | State |   | one of `booked`, `pending`, `waiting`, `left`, `cancelled`, `late_cancelled`, `excused`, `attended`, `no_show`, `cancelled_by_us`, `moved`, `expired` |   |
| `holder` | `text` | Paid from |   |   | The membership or pass the booking spent a use of (its id). Left empty, the host chooses the one whose use would lapse first. |
| `classType` | `relation` | Class type |   | to `programs.classtype`; read-only | The class's type, copied by the host: what a membership's limits read. |
| `weekday` | `number` | Weekday |   | read-only | The class's local weekday (1 Monday to 7 Sunday), set by the host. |
| `minute` | `number` | Local minute |   | read-only | The class's local start, in minutes after midnight, set by the host. |
| `paidOtherwise` | `boolean` | Paid another way |   | read-only | Paid at the desk (a walk-in staff booked) or as a drop-in on the website: it spends no use. Set when it is made. |
| `dropInPrice` | `number` | Drop-in paid |   | read-only | What the drop-in cost, set by the host when it was bought. |
| `dropInOrder` | `text` | Drop-in order |   | read-only | The order that pays for this drop-in, set by the host. |
| `bookedBy` | `user` | Booked by |   | read-only | The staff account that booked it. Empty when the member booked. |
| `madeBy` | `relation` | Booked by (member) |   | to `person`; read-only | The member who made it, set by the host: the person themselves, or the parent or guardian who booked for them. Empty when staff booked. Nobody edits it. |
| `movedFrom` | `relation` | Moved from |   | to `bookings.booking`; read-only | The booking this one replaced when staff moved it to this class. |
| `note` | `longText` | Staff note |   |   |   |
| `markedAt` | `datetime` | Attendance marked |   | read-only | When a coach ticked them as come, or marked them as not come. |
| `markedBy` | `user` | Marked by |   | read-only | The staff account that marked their attendance. |
| `markedByName` | `text` | Marked by (name) |   | read-only | That staff member's name as it was then. |
| `promotedAt` | `datetime` | Moved in from the waitlist |   | read-only | When the host moved them in from the waitlist. |
| `passedOverAt` | `datetime` | Passed over |   | read-only | When a place was free but nothing they hold could pay for it: they stay waiting. |
| `passedOverReason` | `text` | Why passed over |   | read-only | The host's reason (no_uses_left, ended, not_live, not_covered…). |

### Relations

- `class` → `bookings.class`
- `person` → `person`
- `classType` → `programs.classtype`
- `madeBy` → `person`
- `movedFrom` → `bookings.booking`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "states": {
    "field": "state",
    "initial": "booked",
    "create": {
      "in": {
        "waiting": [
          "staff",
          "customer",
          "host"
        ],
        "pending": [
          "host"
        ]
      },
      "window": {
        "from": {
          "at": "class.startsAt",
          "daysBefore": {
            "field": "class.classType.opensDays",
            "setting": "opensDays"
          },
          "zone": "class.timezone"
        },
        "until": {
          "at": "class.startsAt",
          "minutesBefore": {
            "field": "class.classType.closesMinutes",
            "setting": "closesMinutes"
          }
        }
      },
      "staffOnly": "class.classType.staffOnly",
      "closed": "class.closed"
    },
    "follows": {
      "relation": "class",
      "when": {
        "cancelled": "cancelled_by_us"
      },
      "from": [
        "booked",
        "waiting",
        "pending",
        "attended",
        "no_show",
        "late_cancelled"
      ]
    },
    "requests": {
      "cancel": [
        "cancelled",
        "late_cancelled"
      ]
    },
    "moves": [
      {
        "from": "pending",
        "to": "booked",
        "by": [
          "host"
        ]
      },
      {
        "from": "pending",
        "to": "expired",
        "by": [
          "host"
        ],
        "final": true
      },
      {
        "from": "waiting",
        "to": "booked",
        "by": [
          "host",
          "customer"
        ],
        "window": {
          "from": {
            "at": "class.startsAt",
            "daysBefore": {
              "field": "class.classType.opensDays",
              "setting": "opensDays"
            },
            "zone": "class.timezone"
          },
          "until": {
            "at": "class.startsAt",
            "minutesBefore": {
              "field": "class.classType.closesMinutes",
              "setting": "closesMinutes"
            }
          }
        },
        "staffOnly": "class.classType.staffOnly"
      },
      {
        "from": "waiting",
        "to": "left",
        "by": [
          "staff",
          "customer"
        ],
        "final": true
      },
      {
        "from": "booked",
        "to": "cancelled",
        "by": [
          "staff",
          "customer"
        ],
        "final": true,
        "window": {
          "until": {
            "at": "class.startsAt",
            "minutesBefore": {
              "field": "class.classType.lateMinutes",
              "setting": "lateMinutes"
            }
          }
        },
        "bindsStaff": true
      },
      {
        "from": "booked",
        "to": "late_cancelled",
        "by": [
          "staff",
          "customer"
        ],
        "window": {
          "from": {
            "at": "class.startsAt",
            "minutesBefore": {
              "field": "class.classType.lateMinutes",
              "setting": "lateMinutes"
            }
          },
          "until": "class.startsAt"
        }
      },
      {
        "from": "booked",
        "to": "excused",
        "by": [
          "host"
        ],
        "tools": [
          "returnUse"
        ],
        "final": true
      },
      {
        "from": "booked",
        "to": "attended",
        "by": [
          "staff"
        ],
        "window": {
          "from": {
            "at": "class.startsAt",
            "minutesBefore": 60
          }
        },
        "bindsStaff": true
      },
      {
        "from": "attended",
        "to": "booked",
        "by": [
          "staff"
        ]
      },
      {
        "from": "booked",
        "to": "no_show",
        "by": [
          "staff",
          "host"
        ],
        "window": {
          "from": "class.startsAt"
        },
        "bindsStaff": true
      },
      {
        "from": "no_show",
        "to": "attended",
        "by": [
          "staff"
        ]
      },
      {
        "from": [
          "booked",
          "waiting",
          "pending",
          "attended",
          "no_show",
          "late_cancelled"
        ],
        "to": "cancelled_by_us",
        "by": [
          "host"
        ],
        "final": true
      },
      {
        "from": "booked",
        "to": "moved",
        "by": [
          "staff"
        ],
        "final": true,
        "window": {
          "until": "class.startsAt"
        },
        "bindsStaff": true
      }
    ],
    "after": [
      {
        "from": "booked",
        "to": "no_show",
        "at": "class.endsAt",
        "minutesAfter": 30,
        "ifAnyIn": [
          "attended",
          "no_show"
        ]
      }
    ]
  },
  "healthNotes": {
    "list": "class",
    "person": "person"
  },
  "agreements": {
    "point": "booking",
    "label": "Before a booking",
    "suggests": [
      "waiver",
      "health",
      "guardian"
    ],
    "enter": [
      "booked",
      "waiting"
    ],
    "person": "person",
    "inlineStep": true
  },
  "claims": {
    "on": "class",
    "held": [
      "pending"
    ],
    "confirmed": [
      "booked",
      "attended",
      "no_show"
    ],
    "waitlist": {
      "state": "waiting",
      "promote": "booked",
      "until": {
        "at": "class.startsAt",
        "minutesBefore": {
          "field": "class.classType.promotionMinutes",
          "setting": "promotionMinutes"
        }
      },
      "promotedAt": "promotedAt",
      "passedOverAt": "passedOverAt",
      "passedOverReason": "passedOverReason"
    }
  },
  "unique": [
    {
      "fields": [
        "person",
        "class"
      ],
      "states": [
        "pending",
        "booked",
        "waiting",
        "attended",
        "no_show"
      ]
    }
  ],
  "sellable": {
    "price": "dropInPrice",
    "tax": {
      "code": "txcd_50021003"
    },
    "moves": {
      "held": "pending",
      "paid": "booked",
      "expired": "expired",
      "refund": [
        "cancelled",
        "excused",
        "cancelled_by_us"
      ],
      "price": {
        "field": "class.classType.dropInPrice",
        "setting": "dropInPrice"
      },
      "title": "class.title",
      "order": "dropInOrder",
      "guest": true,
      "holdCap": {
        "setting": "dropInHoldPercent"
      }
    },
    "finance": {
      "category": {
        "key": "drop_ins",
        "label": "Drop-ins"
      },
      "earned": "at_date",
      "at": "class.startsAt"
    }
  },
  "allowance": {
    "spends": {
      "person": "person",
      "holder": "holder",
      "spendIn": [
        "booked"
      ],
      "returnIn": [
        "cancelled",
        "excused",
        "cancelled_by_us",
        "moved"
      ],
      "at": "class.startsAt",
      "copy": {
        "classType": "class.classType"
      },
      "local": {
        "weekday": "weekday",
        "minute": "minute",
        "zone": "class.timezone"
      },
      "movedFrom": {
        "field": "movedFrom",
        "state": "moved"
      },
      "paidBy": [
        "memberships.membership",
        "memberships.pass"
      ],
      "waived": "paidOtherwise",
      "released": "cancelled_by_us"
    }
  },
  "customer": {
    "field": "person",
    "read": [
      "person",
      "class",
      "state",
      "holder",
      "classType",
      "promotedAt",
      "passedOverAt",
      "passedOverReason",
      "paidOtherwise",
      "dropInPrice",
      "dropInOrder"
    ],
    "write": [
      "class",
      "state",
      "holder"
    ],
    "createOnly": [
      "class",
      "holder"
    ],
    "guardians": {
      "write": true,
      "madeBy": "madeBy"
    }
  }
}
```

</details>

## Service (`bookings.service`)

A kind of one-to-one session the business offers (personal training, 60 minutes): its length, buffers, the rooms it may use and its booking rules. Who gives it is a qualification, not a list here.

|  |  |
| --- | --- |
| Plural | Services |
| Title field | `title` |
| Listed in | settings |
| Indexes | `active` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title | yes |   |   |
| `description` | `longText` | Description |   |   |   |
| `length` | `number` | Length (minutes) | yes | min 5; max 480 |   |
| `bufferBefore` | `number` | Buffer before (minutes) |   | min 0; max 240 | Minutes kept free before each session, for the coach and the room. |
| `bufferAfter` | `number` | Buffer after (minutes) |   | min 0; max 240 | Minutes kept free after each session, for the coach and the room. |
| `price` | `currency` | Price per session |   | a person's to change | What one session costs when paid for on its own. Empty: not sold per session. |
| `rooms` | `relation` | Rooms it may use |   | to `bookings.room`, many | In the order they are offered: an appointment takes the first one free. Empty: it needs no room. |
| `step` | `number` | Start times every (minutes) |   | min 15; max 60 | 15, 30 or 60: start times on the hour and every this many minutes. Empty: 30. |
| `opensDays` | `number` | Booking opens (days before) |   | min 0; max 365; a person's to change | Clients may book this many days ahead. Empty: the organisation's setting. |
| `closesMinutes` | `number` | Booking closes (minutes before) |   | min 0; max 10080; a person's to change | Clients may book until this many minutes before a session. Empty: the organisation's setting. |
| `lateMinutes` | `number` | Late cancel from (minutes before) |   | min 0; max 10080; a person's to change | A cancel this close to the start or closer is late and keeps the session it used. Empty: the organisation's setting. |
| `whoBooks` | `select` | Who books it |   | one of `members_visitors`, `members`, `staff`; default `"members_visitors"`; a person's to change |   |
| `active` | `boolean` | Offered |   | default `true` |   |
| `staffOnly` | `formula` | Booked by staff only |   |   |   |
| `closed` | `formula` | Not offered |   |   |   |

### Relations

- `rooms` → `bookings.room` (many)

## Appointment (`bookings.appointment`)

One booked one-to-one session: a client, a coach, a service, a start and an end, and the room it takes.

|  |  |
| --- | --- |
| Plural | Appointments |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`staffed`](/reference/behaviours/#staffed), [`occupies`](/reference/behaviours/#occupies), [`allowance`](/reference/behaviours/#allowance), [`agreements`](/reference/behaviours/#agreements) |
| Indexes | `startsAt`; `coach, startsAt`; `person, startsAt`; `state, startsAt`; `service`; `endsAt` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title |   |   |   |
| `service` | `relation` | Service | yes | to `bookings.service` |   |
| `person` | `relation` | Client | yes | to `person` |   |
| `coach` | `relation` | Coach |   | to `bookings.coach` |   |
| `room` | `relation` | Room |   | to `bookings.room` | Left empty, the host gives it the first of the service's rooms free then. |
| `startsAt` | `datetime` | Starts | yes |   |   |
| `endsAt` | `datetime` | Ends | yes |   |   |
| `timezone` | `timezone` | Time zone | yes |   |   |
| `state` | `select` | State |   | one of `booked`, `pending`, `unpaid`, `cancelled`, `late_cancelled`, `excused`, `attended`, `no_show`, `cancelled_by_us`, `moved`, `expired` |   |
| `holder` | `text` | Paid from |   |   | The pass or membership the appointment spent a session of (its id). Left empty, the host chooses the one whose session would lapse first. |
| `serviceId` | `text` | Service (for passes) |   | read-only | The service, copied by the host: what a pass's services are compared with. |
| `weekday` | `number` | Weekday |   | read-only | The local weekday (1 Monday to 7 Sunday), set by the host. |
| `minute` | `number` | Local minute |   | read-only | The local start, in minutes after midnight, set by the host. |
| `paidOtherwise` | `boolean` | Paid at the desk |   | read-only | Paid at the desk or another way: it spends no session. Set when it is made. |
| `bookedBy` | `user` | Booked by |   | read-only | The staff account that booked it. |
| `movedFrom` | `relation` | Moved from |   | to `bookings.appointment`; read-only | The appointment this one replaced when it was moved to another time. |
| `note` | `longText` | Staff note |   |   |   |
| `markedAt` | `datetime` | Attendance marked |   | read-only | When it was marked attended or not come. |
| `markedBy` | `user` | Marked by |   | read-only | The staff account that marked it. Empty when the host marked it attended. |
| `markedByName` | `text` | Marked by (name) |   | read-only | That staff member's name as it was then. |
| `cancelledReason` | `longText` | Why it was cancelled or given back |   | read-only |   |

### Relations

- `service` → `bookings.service`
- `person` → `person`
- `coach` → `bookings.coach`
- `room` → `bookings.room`
- `movedFrom` → `bookings.appointment`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "states": {
    "field": "state",
    "initial": "booked",
    "create": {
      "in": {
        "pending": [
          "host"
        ],
        "unpaid": [
          "host"
        ]
      },
      "window": {
        "from": {
          "at": "startsAt",
          "daysBefore": {
            "field": "service.opensDays",
            "setting": "appointmentOpensDays"
          },
          "zone": "timezone"
        },
        "until": {
          "at": "startsAt",
          "minutesBefore": {
            "field": "service.closesMinutes",
            "setting": "appointmentClosesMinutes"
          }
        }
      },
      "staffOnly": "service.staffOnly",
      "closed": "service.closed"
    },
    "requests": {
      "cancel": [
        "cancelled",
        "late_cancelled"
      ]
    },
    "moves": [
      {
        "from": "pending",
        "to": "booked",
        "by": [
          "host"
        ]
      },
      {
        "from": "pending",
        "to": "expired",
        "by": [
          "host"
        ],
        "final": true
      },
      {
        "from": "unpaid",
        "to": "booked",
        "by": [
          "staff"
        ]
      },
      {
        "from": "booked",
        "to": "cancelled",
        "by": [
          "staff",
          "customer"
        ],
        "final": true,
        "window": {
          "until": {
            "at": "startsAt",
            "minutesBefore": {
              "field": "service.lateMinutes",
              "setting": "appointmentLateMinutes"
            }
          }
        },
        "bindsStaff": true
      },
      {
        "from": "booked",
        "to": "late_cancelled",
        "by": [
          "staff",
          "customer"
        ],
        "window": {
          "from": {
            "at": "startsAt",
            "minutesBefore": {
              "field": "service.lateMinutes",
              "setting": "appointmentLateMinutes"
            }
          },
          "until": "startsAt"
        }
      },
      {
        "from": "booked",
        "to": "moved",
        "by": [
          "staff"
        ],
        "final": true,
        "window": {
          "until": "startsAt"
        },
        "bindsStaff": true
      },
      {
        "from": "booked",
        "to": "attended",
        "by": [
          "staff",
          "host"
        ],
        "window": {
          "from": "startsAt"
        },
        "bindsStaff": true
      },
      {
        "from": "booked",
        "to": "no_show",
        "by": [
          "staff",
          "host"
        ],
        "window": {
          "from": "startsAt"
        },
        "bindsStaff": true
      },
      {
        "from": "attended",
        "to": "no_show",
        "by": [
          "staff"
        ],
        "window": {
          "until": {
            "at": "endsAt",
            "minutesBefore": -10080
          }
        },
        "bindsStaff": true
      },
      {
        "from": "no_show",
        "to": "attended",
        "by": [
          "staff"
        ],
        "window": {
          "until": {
            "at": "endsAt",
            "minutesBefore": -10080
          }
        },
        "bindsStaff": true
      },
      {
        "from": [
          "late_cancelled",
          "no_show"
        ],
        "to": "excused",
        "by": [
          "host"
        ],
        "tools": [
          "excuseAppointment"
        ],
        "final": true
      },
      {
        "from": [
          "pending",
          "unpaid",
          "booked"
        ],
        "to": "cancelled_by_us",
        "by": [
          "host"
        ],
        "tools": [
          "cancelAppointmentByUs"
        ],
        "final": true
      }
    ],
    "after": [
      {
        "from": "booked",
        "to": "attended",
        "at": "endsAt",
        "minutesAfter": 30
      }
    ]
  },
  "staffed": {
    "who": {
      "field": "coach",
      "account": "user"
    },
    "starts": "startsAt",
    "ends": "endsAt",
    "zone": "timezone",
    "kind": "service",
    "live": [
      "pending",
      "unpaid",
      "booked",
      "attended",
      "no_show"
    ],
    "place": "room.name",
    "claimBefore": {
      "field": "service.bufferBefore"
    },
    "claimAfter": {
      "field": "service.bufferAfter"
    },
    "account": "required",
    "private": true,
    "open": {
      "length": {
        "field": "service.length"
      },
      "step": {
        "field": "service.step"
      },
      "rooms": {
        "field": "service.rooms"
      },
      "client": "person",
      "closedBy": {
        "object": "closure",
        "from": "fromDate",
        "until": "untilDate"
      },
      "customer": true
    }
  },
  "occupies": {
    "thing": "room",
    "starts": "startsAt",
    "ends": "endsAt",
    "live": [
      "pending",
      "unpaid",
      "booked",
      "attended",
      "no_show"
    ],
    "before": {
      "field": "service.bufferBefore"
    },
    "after": {
      "field": "service.bufferAfter"
    },
    "only": "exclusive"
  },
  "allowance": {
    "spends": {
      "person": "person",
      "holder": "holder",
      "spendIn": [
        "booked"
      ],
      "returnIn": [
        "cancelled",
        "excused",
        "cancelled_by_us",
        "moved"
      ],
      "at": "startsAt",
      "copy": {
        "serviceId": "service.id"
      },
      "local": {
        "weekday": "weekday",
        "minute": "minute",
        "zone": "timezone"
      },
      "movedFrom": {
        "field": "movedFrom",
        "state": "moved"
      },
      "paidBy": [
        "memberships.membership",
        "memberships.pass"
      ],
      "waived": "paidOtherwise",
      "released": "cancelled_by_us"
    }
  },
  "agreements": {
    "point": "appointment",
    "label": "Before an appointment",
    "suggests": [
      "waiver",
      "health",
      "guardian"
    ],
    "enter": [
      "booked"
    ],
    "person": "person",
    "inlineStep": true
  }
}
```

</details>

## Fields on other objects

### On `programs.classtype`

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `colour` | `text` | Colour |   |   | How its classes show on the timetable, e.g. #2f6fed. |
| `opensDays` | `number` | Booking opens (days before) |   | min 0; max 365; a person's to change | Members may book this many days before a class, at the same time of day. Empty: the organisation's setting. |
| `closesMinutes` | `number` | Booking closes (minutes before) |   | min 0; max 10080; a person's to change | Members may book until this many minutes before a class starts (0: until it starts). Empty: the organisation's setting. |
| `lateMinutes` | `number` | Late cancel from (minutes before) |   | min 0; max 10080; a person's to change | A cancel this close to the start or closer is late and keeps the class it used. Empty: the organisation's setting. |
| `promotionMinutes` | `number` | Waitlist stops (minutes before) |   | min 0; max 10080; a person's to change | Nobody is moved in from the waitlist after this: a place freed later goes to whoever books first. Empty: the organisation's setting. |
| `reminderMinutes` | `number` | Reminder (minutes before) |   | min 0; max 2880; a person's to change | When members booked into a class are emailed a reminder, at most two days before. Empty: the organisation's setting. |
| `dropInPrice` | `number` | Drop-in price |   | min 0; max 100000; a person's to change | What one class costs someone paying for it on the website, in the organisation's currency. Empty: the organisation's setting; empty there too, no drop-ins. |
| `staffOnly` | `boolean` | Booked by staff only |   | a person's to change | Members cannot book its classes themselves; staff book them in. |
| `rosterBeforeMinutes` | `number` | Set-up minutes (pay) |   | min 0; max 240; a person's to change | Minutes before each class counted in its coach's pay hours (set-up). Empty: none. They never stop a coach taking the class before. |
| `rosterAfterMinutes` | `number` | Pack-down minutes (pay) |   | min 0; max 240; a person's to change | Minutes after each class counted in its coach's pay hours (pack-down). Empty: none. They never stop a coach taking the class after. |

## Views

| View | Object | Label |
| --- | --- | --- |
| `todaysClasses` | `bookings.class` | Today's classes |
| `thisWeeksClasses` | `bookings.class` | This week's classes |
| `activeSeries` | `bookings.series` | Timetable |
| `waitlists` | `bookings.booking` | Waiting |
| `lateCancels` | `bookings.booking` | Late cancels |
| `noShowsThisMonth` | `bookings.booking` | No-shows this month |
| `lateCancelsThisMonth` | `bookings.booking` | Late cancels this month |

## On other records' pages

| Kind | Key | On | Label |
| --- | --- | --- | --- |
| tab | `classBookings` | `` | Bookings |
| tab | `seriesClasses` | `` | Classes |
| tab | `personBookings` | `` | Bookings |
| tab | `personAppointments` | `` | Appointments |
| tab | `serviceAppointments` | `` | Appointments |
