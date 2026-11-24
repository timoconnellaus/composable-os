---
title: "Programs: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

It requires no other pack.

## Exercise (`programs.exercise`)

One exercise of the bank every program is built from.

|  |  |
| --- | --- |
| Plural | Exercises |
| Title field | `name` |
| Listed in | main |
| Behaviours | [`signedIn`](/reference/behaviours/#signedin) |
| Indexes | `theme`; `measure` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `video` | `url` | Demo video |   |   |   |
| `cues` | `longText` | Coaching cues |   |   |   |
| `theme` | `select` | Theme |   | one of `mobility`, `strength`, `handstands`, `skill`, `conditioning` |   |
| `level` | `select` | Level |   | one of `beginner`, `intermediate`, `advanced` |   |
| `equipment` | `multiSelect` | Equipment |   | one of `none`, `rings`, `bar`, `parallettes`, `kettlebell`, `dumbbell`, `barbell`, `band`, `box` |   |
| `bodyAreas` | `multiSelect` | Body areas |   | one of `shoulders`, `wrists`, `spine`, `hips`, `legs`, `core`, `upper` |   |
| `measure` | `select` | Measured by | yes | one of `weight_reps`, `reps`, `time`, `hold`; default `"reps"` | What one set of it records. |
| `easier` | `relation` | Easier versions |   | to `programs.exercise`, many |   |
| `harder` | `relation` | Harder versions |   | to `programs.exercise`, many |   |

### Relations

- `easier` → `programs.exercise` (many)
- `harder` → `programs.exercise` (many)

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "signedIn": {
    "read": [
      "name",
      "video",
      "cues",
      "theme",
      "level",
      "equipment",
      "bodyAreas",
      "measure",
      "easier",
      "harder"
    ]
  }
}
```

</details>

## Program (`programs.program`)

A plan of weeks of sessions, built from the bank: a class program, a client's own, or the sessions of an online course. Coaches edit the working copy; people are given a published version.

|  |  |
| --- | --- |
| Plural | Programs |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`publishable`](/reference/behaviours/#publishable), [`unique`](/reference/behaviours/#unique) |
| Indexes | `kind` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title | yes |   |   |
| `kind` | `select` | Kind | yes | one of `class`, `client`, `course`; default `"client"` |   |
| `theme` | `text` | Theme |   |   |   |
| `guidance` | `longText` | Guidance for coaches |   |   | For whoever runs it. Never shown to members. |
| `layout` | `document` | Layout | yes |   | Weeks of sessions of blocks of items, each item bank exercises with typed sets, or up to five levels; notes for coaches unless marked as shown to members. |
| `importKey` | `text` | Import key |   | read-only | The name its text had where it came from: one program per key. |
| `importedHash` | `text` | Imported content |   | read-only | What the text import last wrote, so a re-run never overwrites an edit. |

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "publishable": {
    "content": [
      "title",
      "kind",
      "theme",
      "guidance",
      "layout"
    ]
  },
  "unique": [
    {
      "fields": [
        "importKey"
      ]
    }
  ]
}
```

</details>

## Class type (`programs.classtype`)

A kind of class (Mobility, Handstands): what a class program is assigned to.

|  |  |
| --- | --- |
| Plural | Class types |
| Title field | `name` |
| Listed in | settings |
| Behaviours | [`signedIn`](/reference/behaviours/#signedin) |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `order` | `number` | Order |   |   |   |

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "signedIn": {
    "read": [
      "name",
      "order"
    ]
  }
}
```

</details>

## Assignment (`programs.assignment`)

A published version of a program given to a person or to a class type from a start date: its dated sessions are made from that version and keep it.

|  |  |
| --- | --- |
| Plural | Assignments |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`team`](/reference/behaviours/#team), [`states`](/reference/behaviours/#states), [`customer`](/reference/behaviours/#customer), [`signedIn`](/reference/behaviours/#signedin) |
| Indexes | `person, state`; `kind, state`; `classType, state`; `program`; `coach, state` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title | yes |   |   |
| `program` | `relation` | Program | yes | to `programs.program` |   |
| `programVersion` | `number` | Version |   | read-only | The program's published version this follows. |
| `kind` | `select` | For |   | one of `personal`, `class`; read-only | A person's own, or a class type's (read by every signed-in member). |
| `person` | `relation` | Person |   | to `person` |   |
| `classType` | `relation` | Class type |   | to `programs.classtype` |   |
| `startDate` | `date` | Starts | yes |   |   |
| `endDate` | `date` | Ends |   |   |   |
| `sessionCount` | `number` | Sessions |   | min 0; read-only |   |
| `state` | `select` | State |   | one of `generating`, `active`, `ended`, `cancelled` |   |
| `assignedBy` | `user` | Assigned by |   |   |   |
| `assignedByName` | `text` | Assigned by (name) |   |   |   |
| `coach` | `user` | Coach |   | a person's to change | Who looks after this client on it. With the coach role, they see and log this person's training while it is active, and no one else's. A person chooses it: anyone else's change waits for a person. |

### Relations

- `program` → `programs.program`
- `person` → `person`
- `classType` → `programs.classtype`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "team": {
    "person": "person",
    "staff": [
      "coach"
    ],
    "live": [
      "generating",
      "active"
    ]
  },
  "states": {
    "field": "state",
    "initial": "generating",
    "moves": [
      {
        "from": "generating",
        "to": "active",
        "by": [
          "staff"
        ]
      },
      {
        "from": "active",
        "to": "ended",
        "by": [
          "staff"
        ],
        "final": true
      },
      {
        "from": [
          "generating",
          "active"
        ],
        "to": "cancelled",
        "by": [
          "staff"
        ],
        "final": true
      }
    ]
  },
  "customer": {
    "field": "person",
    "read": [
      "title",
      "programVersion",
      "kind",
      "classType",
      "startDate",
      "endDate",
      "state"
    ],
    "write": []
  },
  "signedIn": {
    "read": [
      "title",
      "programVersion",
      "kind",
      "classType",
      "startDate",
      "endDate",
      "state"
    ],
    "when": {
      "field": "kind",
      "in": [
        "class"
      ]
    }
  }
}
```

</details>

## Session (`programs.session`)

One dated session of an assignment: its plan as the assigned version had it, and whether it was done. Or one done before the platform, brought in by an import.

|  |  |
| --- | --- |
| Plural | Sessions |
| Title field | `name` |
| Listed in | none |
| Behaviours | [`states`](/reference/behaviours/#states), [`customer`](/reference/behaviours/#customer), [`signedIn`](/reference/behaviours/#signedin) |
| Indexes | `person, date`; `kind, date`; `classType, date`; `assignment, week`; `key` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `assignment` | `relation` | Assignment |   | to `programs.assignment` | Every session but an imported one is an assignment's. |
| `program` | `relation` | Program |   | to `programs.program` |   |
| `programVersion` | `number` | Version |   | read-only |   |
| `kind` | `select` | For |   | one of `personal`, `class`; read-only | A person's own, or a class type's (read by every signed-in member). |
| `person` | `relation` | Person |   | to `person` |   |
| `classType` | `relation` | Class type |   | to `programs.classtype` |   |
| `programTitle` | `text` | Program |   | read-only | The program's title in the assigned version, so a member reads it with the session. |
| `classTypeName` | `text` | Class type (name) |   | read-only |   |
| `date` | `date` | Date | yes |   |   |
| `week` | `number` | Week |   | min 1; max 52; read-only |   |
| `day` | `number` | Day of the week |   | min 1; max 7; read-only |   |
| `position` | `number` | Place in its week |   | read-only | The session's index in its week of the layout, from 0. |
| `key` | `text` | Key |   | read-only | Assignment, week and place: one session per place. |
| `focus` | `text` | Focus |   |   |   |
| `plan` | `document` | Plan |   | read-only | The session of the layout, as the assigned version had it. |
| `state` | `select` | State |   | one of `planned`, `done`, `skipped` |   |
| `completedAt` | `datetime` | Marked at |   |   |   |
| `completedBy` | `user` | Marked by |   |   |   |
| `completedByName` | `text` | Marked by (name) |   |   |   |
| `source` | `select` | Where it came from |   | one of `import` | Imported: brought in from before the platform; it started nothing when it was. |
| `imported` | `formula` | Imported |   |   |   |

### Relations

- `assignment` → `programs.assignment`
- `program` → `programs.program`
- `person` → `person`
- `classType` → `programs.classtype`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "states": {
    "field": "state",
    "initial": "planned",
    "moves": [
      {
        "from": "planned",
        "to": "done",
        "by": [
          "staff",
          "customer"
        ]
      },
      {
        "from": "planned",
        "to": "skipped",
        "by": [
          "staff",
          "customer"
        ]
      },
      {
        "from": [
          "done",
          "skipped"
        ],
        "to": "planned",
        "by": [
          "staff",
          "customer"
        ],
        "staffOnly": "imported"
      }
    ]
  },
  "customer": {
    "field": "person",
    "read": [
      "name",
      "assignment",
      "program",
      "programVersion",
      "kind",
      "classType",
      "programTitle",
      "classTypeName",
      "date",
      "week",
      "day",
      "position",
      "focus",
      "plan",
      "state",
      "completedAt",
      "source"
    ],
    "write": []
  },
  "signedIn": {
    "read": [
      "name",
      "assignment",
      "programVersion",
      "kind",
      "classType",
      "programTitle",
      "classTypeName",
      "date",
      "week",
      "day",
      "position",
      "focus",
      "plan"
    ],
    "when": {
      "field": "kind",
      "in": [
        "class"
      ]
    }
  }
}
```

</details>

## Logged set (`programs.log`)

One set someone did: the exercise, the target and what was done, how hard it felt, the level taken, and who recorded it. The table training data comes from.

|  |  |
| --- | --- |
| Plural | Logged sets |
| Title field | `label` |
| Listed in | main |
| Behaviours | [`unique`](/reference/behaviours/#unique), [`customer`](/reference/behaviours/#customer) |
| Indexes | `person, exercise, date`; `session`; `exercise, date`; `person, date` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `label` | `text` | Set | yes |   |   |
| `person` | `relation` | Person | yes | to `person` |   |
| `session` | `relation` | Session | yes | to `programs.session` |   |
| `assignment` | `relation` | Assignment |   | to `programs.assignment` |   |
| `exercise` | `relation` | Exercise | yes | to `programs.exercise` |   |
| `exerciseName` | `text` | Exercise (name) |   |   | The exercise's name when the set was logged, so a member reads it with the set. |
| `item` | `text` | Item |   |   | The item's label: A1. |
| `setNumber` | `number` | Set number |   | min 1; max 30 |   |
| `level` | `number` | Level taken |   | min 1; max 5 |   |
| `date` | `date` | Date | yes |   |   |
| `targetReps` | `number` | Target reps |   | min 0; max 999 |   |
| `targetSeconds` | `number` | Target seconds |   | min 0; max 7200 |   |
| `targetLoad` | `number` | Target load (kg) |   | min 0; max 1000 |   |
| `actualReps` | `number` | Reps |   | min 0; max 999 |   |
| `actualSeconds` | `number` | Seconds |   | min 0; max 7200 |   |
| `actualLoad` | `number` | Load (kg) |   | min 0; max 1000 |   |
| `rpe` | `number` | Effort (RPE) |   | min 1; max 10 | 1 to 10, in halves. |
| `note` | `text` | Note |   |   |   |
| `recordedAs` | `select` | Recorded by |   | one of `self`, `staff` |   |
| `recordedBy` | `user` | Recorded by (coach) |   |   |   |
| `recordedByName` | `text` | Recorded by (name) |   |   |   |
| `setKey` | `text` | Set key |   |   | Session, item, exercise and set number: one row per set and person, however many saves of it arrive. |
| `source` | `select` | Where it came from |   | one of `import` | Imported: brought in from before the platform; it started nothing when it was. |

### Relations

- `person` → `person`
- `session` → `programs.session`
- `assignment` → `programs.assignment`
- `exercise` → `programs.exercise`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "unique": [
    {
      "fields": [
        "person",
        "setKey"
      ]
    }
  ],
  "customer": {
    "field": "person",
    "read": [
      "label",
      "session",
      "assignment",
      "exercise",
      "exerciseName",
      "item",
      "setNumber",
      "level",
      "date",
      "targetReps",
      "targetSeconds",
      "targetLoad",
      "actualReps",
      "actualSeconds",
      "actualLoad",
      "rpe",
      "note",
      "recordedAs",
      "recordedByName",
      "source"
    ],
    "write": [
      "actualReps",
      "actualSeconds",
      "actualLoad",
      "rpe",
      "note"
    ],
    "delete": true
  }
}
```

</details>

## Views

| View | Object | Label |
| --- | --- | --- |
| `bankByTheme` | `programs.exercise` | Bank by theme |
| `programsPublished` | `programs.program` | Published programs |
| `activeAssignments` | `programs.assignment` | Active assignments |
| `sessionsThisWeek` | `programs.session` | Sessions this week |
| `sessionsCalendar` | `programs.session` | Sessions calendar |
| `setsThisWeek` | `programs.log` | Sets logged this week |

## On other records' pages

| Kind | Key | On | Label |
| --- | --- | --- | --- |
| tab | `personTraining` | `` | Training |
| panel | `personAssignments` | `` | Programs |
| panel | `personSessions` | `` | Sessions |
