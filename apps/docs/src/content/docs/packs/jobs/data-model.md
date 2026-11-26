---
title: "Jobs: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

It requires no other pack.

## Pipeline (`jobs.pipeline`)

A kind of job: an ordered set of stages its jobs move through.

|  |  |
| --- | --- |
| Plural | Pipelines |
| Title field | `name` |
| Listed in | settings |
| Indexes | `position` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `position` | `number` | Order |   |   |   |
| `description` | `longText` | Description |   |   |   |

## Job stage (`jobs.stage`)

One step of a pipeline: its order, whether jobs in it are open, won or lost, and what a job needs to enter it. Stages that wait on a fact only the host sets (Accepted, Signed off, Invoiced) are changed by an admin in person.

|  |  |
| --- | --- |
| Plural | Job stages |
| Title field | `name` |
| Listed in | settings |
| Indexes | `pipeline, position` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `pipeline` | `relation` | Pipeline | yes | to `jobs.pipeline` |   |
| `position` | `number` | Order | yes |   |   |
| `type` | `select` | Type | yes | one of `open`, `won`, `lost` |   |
| `requiredFields` | `multiSelect` | Required to enter |   | one of `acceptedAt`, `signedOffAt`, `invoicedAt`, `customer`, `site`, `owner`, `description`, `lostReason` | What a job must have to enter this stage. |

### Relations

- `pipeline` → `jobs.pipeline`

## Job (`jobs.job`)

A piece of work for a customer, or an internal project, moving through the stages of its pipeline. Charged at a fixed price (the accepted estimate and approved variations) or by the time and materials used.

|  |  |
| --- | --- |
| Plural | Jobs |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`stages`](/reference/behaviours/#stages), [`unique`](/reference/behaviours/#unique) |
| Indexes | `stage`; `pipeline, status`; `status, updatedAt`; `customer`; `site`; `organisation`; `owner, status` |
| Owner field | `owner` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title | yes |   |   |
| `customer` | `relation` | Customer |   | to `person` | Who the work is for. Empty for an internal project. |
| `organisation` | `relation` | Organisation |   | to `organisation` |   |
| `site` | `relation` | Site |   | to `jobs.site` | Where the work is. Empty for a plain project. |
| `pipeline` | `relation` | Pipeline |   | to `jobs.pipeline` | Defaults to the Default pipeline setting (Trades). |
| `stage` | `relation` | Stage |   | to `jobs.stage` | Defaults to the pipeline's first stage. What a stage requires applies. |
| `status` | `select` | Status |   | one of `open`, `won`, `lost`; read-only | Open, won or lost: the type of the job's stage. |
| `billing` | `select` | Charged | yes | one of `fixed`, `time_and_materials`; default `"fixed"` | Fixed price: the accepted estimate plus approved variations, with time and materials as cost only. Time and materials: the labour and materials used. |
| `defaultRate` | `relation` | Default rate |   | to `jobs.rate` | The charge-out rate its labour is priced at unless changed. |
| `owner` | `user` | Owner |   |   |   |
| `description` | `longText` | Description |   |   |   |
| `lostReason` | `select` | Lost reason |   | one of `price`, `competitor`, `timing`, `noResponse`, `cancelledByCustomer`, `notForUs`, `other` | Required to move a job to a lost stage. |
| `closedAt` | `datetime` | Closed |   | read-only | Set when the job enters a won or lost stage; cleared when it reopens. |
| `acceptedAt` | `datetime` | Accepted at |   | read-only | When the customer accepted the work. Set by the office's record of it (recordAcceptance) until quotes are built; the Accepted stage needs it. |
| `acceptedBy` | `select` | Accepted by |   | one of `quote`, `office`; read-only | A quote the customer accepted, or the office on the customer's word. |
| `acceptedHow` | `text` | How it was accepted |   | read-only | What the office recorded (a signed paper estimate, a phone call). |
| `acceptedByName` | `text` | Acceptance recorded by |   | read-only |   |
| `signedOffAt` | `datetime` | Signed off at |   | read-only | When the customer signed the work off. The Signed off stage needs it. |
| `invoicedAt` | `datetime` | Invoiced at |   | read-only | When an invoice was issued for it. The Invoiced stage needs it. |
| `requestKey` | `text` | Request key |   | read-only | Set by enquire: the same enquiry sent again finds this job. |

### Relations

- `customer` → `person`
- `organisation` → `organisation`
- `site` → `jobs.site`
- `pipeline` → `jobs.pipeline`
- `stage` → `jobs.stage`
- `defaultRate` → `jobs.rate`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "stages": {
    "field": "stage",
    "stage": {
      "type": "type",
      "order": "position",
      "requiredFields": "requiredFields",
      "group": "pipeline"
    },
    "group": "pipeline",
    "closedDate": "closedAt",
    "status": "status",
    "requiredByType": {
      "lost": [
        "lostReason"
      ]
    },
    "defaultGroupSetting": "defaultPipeline"
  },
  "unique": [
    {
      "fields": [
        "requestKey"
      ]
    }
  ]
}
```

</details>

## Site (`jobs.site`)

Where work is done: a customer's home, a shop, a block of flats. Its address and any hazards the crew should know of.

|  |  |
| --- | --- |
| Plural | Sites |
| Title field | `name` |
| Listed in | main |
| Indexes | `customer`; `postcode` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   | How the office knows it: the street address, or a name. |
| `customer` | `relation` | Customer |   | to `person` |   |
| `line1` | `text` | Address |   |   |   |
| `line2` | `text` | Address line 2 |   |   |   |
| `suburb` | `text` | Suburb or town |   |   |   |
| `region` | `text` | State or region |   |   |   |
| `postcode` | `text` | Postcode |   |   |   |
| `country` | `text` | Country |   |   |   |
| `hazards` | `longText` | Hazards |   |   | What the crew must know to work safely (asbestos, a steep roof, a dog). No access codes: they are not kept here. |

### Relations

- `customer` → `person`

## Visit type (`jobs.visittype`)

A kind of visit (a site visit, electrical work, a clean): how long it usually takes, the checklist the crew ticks, and what a person must be qualified for to be on it.

|  |  |
| --- | --- |
| Plural | Visit types |
| Title field | `name` |
| Listed in | settings |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `defaultMinutes` | `number` | Usual length (minutes) |   | default `60`; min 15; max 1440 |   |
| `checklist` | `checklist` | Checklist |   | a person's to change | Ticked off by each person on a visit of this type (a safety check). |

## Visit (`jobs.visit`)

One booked time at a job's site, with its crew. Moving it moves everyone on it; it is marked on the way, on site and done by the crew, or cancelled by the office.

|  |  |
| --- | --- |
| Plural | Visits |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`unique`](/reference/behaviours/#unique), [`states`](/reference/behaviours/#states) |
| Indexes | `job, starts`; `state, starts`; `starts` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title |   |   |   |
| `job` | `relation` | Job |   | to `jobs.job`; read-only; a person's to change |   |
| `visitType` | `relation` | Visit type | yes | to `jobs.visittype`; a person's to change |   |
| `starts` | `datetime` | Starts | yes | a person's to change |   |
| `ends` | `datetime` | Ends | yes | a person's to change |   |
| `zone` | `timezone` | Time zone |   |   |   |
| `arrivalWindow` | `text` | Arrival window |   |   | What the customer is told (between 8 and 10). |
| `crewNotes` | `longText` | Notes for the crew |   |   |   |
| `state` | `select` | State |   | one of `booked`, `on_the_way`, `on_site`, `done`, `missed`, `cancelled`; default `"booked"` |   |
| `requestKey` | `text` | Request key |   | read-only | Set by bookVisit: the same booking sent again finds this visit. |

### Relations

- `job` → `jobs.job`
- `visitType` → `jobs.visittype`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "unique": [
    {
      "fields": [
        "requestKey"
      ],
      "states": [
        "booked",
        "on_the_way",
        "on_site"
      ]
    }
  ],
  "states": {
    "field": "state",
    "initial": "booked",
    "create": {
      "requires": [
        "job"
      ]
    },
    "moves": [
      {
        "from": "booked",
        "to": "on_the_way",
        "by": [
          "host"
        ],
        "tools": [
          "markOnTheWay"
        ]
      },
      {
        "from": [
          "booked",
          "on_the_way"
        ],
        "to": "on_site",
        "by": [
          "host"
        ],
        "tools": [
          "markOnSite"
        ]
      },
      {
        "from": [
          "booked",
          "on_the_way",
          "on_site"
        ],
        "to": "done",
        "by": [
          "host"
        ],
        "tools": [
          "markDone"
        ],
        "final": true
      },
      {
        "from": [
          "booked",
          "on_the_way"
        ],
        "to": "missed",
        "by": [
          "host"
        ],
        "tools": [
          "markMissed"
        ],
        "final": true
      },
      {
        "from": [
          "booked",
          "on_the_way",
          "on_site"
        ],
        "to": "cancelled",
        "by": [
          "host"
        ],
        "tools": [
          "cancelVisit",
          "bookVisit"
        ],
        "final": true
      }
    ]
  }
}
```

</details>

## Crew place (`jobs.assignment`)

One person's place on a visit: a shift at the visit's time, on the roster and in their calendar. Cancelled with its visit, or when the person is taken off it.

|  |  |
| --- | --- |
| Plural | Crew places |
| Title field | `title` |
| Listed in | none |
| Behaviours | [`unique`](/reference/behaviours/#unique), [`states`](/reference/behaviours/#states), [`staffed`](/reference/behaviours/#staffed), [`checklists`](/reference/behaviours/#checklists) |
| Indexes | `visit`; `staff, starts`; `state, starts` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title |   |   |   |
| `visit` | `relation` | Visit | yes | to `jobs.visit`; a person's to change |   |
| `staff` | `user` | Who | yes | a person's to change |   |
| `lead` | `boolean` | Leads the visit |   |   | The person the customer deals with on the day. |
| `visitType` | `relation` | Visit type |   | to `jobs.visittype`; read-only |   |
| `starts` | `datetime` | Starts |   | read-only; a person's to change |   |
| `ends` | `datetime` | Ends |   | read-only; a person's to change |   |
| `zone` | `timezone` | Time zone |   | read-only |   |
| `state` | `select` | State |   | one of `booked`, `cancelled`; default `"booked"`; a person's to change |   |

### Relations

- `visit` → `jobs.visit`
- `visitType` → `jobs.visittype`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "unique": [
    {
      "fields": [
        "visit",
        "staff"
      ],
      "states": [
        "booked"
      ]
    }
  ],
  "states": {
    "field": "state",
    "initial": "booked",
    "moves": [
      {
        "from": "booked",
        "to": "cancelled",
        "by": [
          "host"
        ],
        "tools": [
          "removeCrew"
        ],
        "final": true
      }
    ],
    "follows": {
      "relation": "visit",
      "when": {
        "cancelled": "cancelled"
      },
      "from": [
        "booked"
      ]
    }
  },
  "staffed": {
    "who": {
      "field": "staff"
    },
    "starts": "starts",
    "ends": "ends",
    "zone": "zone",
    "kind": "visitType",
    "live": [
      "booked"
    ],
    "private": true,
    "timesFrom": "visit"
  },
  "checklists": {
    "template": "visitType.checklist",
    "who": "staff",
    "opens": "starts",
    "closes": "ends",
    "live": [
      "booked"
    ]
  }
}
```

</details>

## Job line (`jobs.line`)

Something quoted, added, used or owed on a job: an estimate line, a variation's line, a material used or labour. Written by the pack's tools while a draft; approved, voided and billed only by its tools and the host.

|  |  |
| --- | --- |
| Plural | Job lines |
| Title field | `description` |
| Listed in | none |
| Behaviours | [`unique`](/reference/behaviours/#unique), [`states`](/reference/behaviours/#states) |
| Indexes | `job, kind, state`; `variation`; `state, kind` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `description` | `text` | Description |   | read-only |   |
| `job` | `relation` | Job |   | to `jobs.job`; read-only |   |
| `kind` | `select` | Kind |   | one of `estimate`, `variation`, `material`, `labour`; read-only |   |
| `variation` | `relation` | Variation |   | to `jobs.variation`; read-only | The variation a variation line belongs to. |
| `quantity` | `number` | Quantity |   | min 0; max 1000000; read-only |   |
| `unit` | `text` | Unit |   | read-only | What the quantity counts (m, each, hours). |
| `unitPrice` | `currency` | Unit price |   | min 0; max 10000000; read-only | In the base currency, before tax. Set by someone who sees prices. |
| `cost` | `currency` | Cost |   | min 0; max 10000000; read-only | What it cost the business, in total. |
| `itemCode` | `text` | Item |   | read-only | A catalogue or price-list item's code it names, if any. |
| `taxCode` | `text` | Tax code |   | read-only |   |
| `replaces` | `relation` | Replaces |   | to `jobs.line`; read-only | The draft this line corrected (a line's words and numbers never change). |
| `voidReason` | `select` | Why void |   | one of `voided`, `replaced`; read-only |   |
| `recordedBy` | `user` | Recorded by |   | read-only |   |
| `recordedByName` | `text` | Recorded by (name) |   | read-only |   |
| `requestKey` | `text` | Request key |   | read-only | Set by the tool that added it: the same request again finds this line. |
| `state` | `select` | State |   | one of `draft`, `approved`, `billed`, `void`; default `"draft"` |   |

### Relations

- `job` → `jobs.job`
- `variation` → `jobs.variation`
- `replaces` → `jobs.line`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "unique": [
    {
      "fields": [
        "requestKey"
      ]
    }
  ],
  "states": {
    "field": "state",
    "initial": "draft",
    "create": {
      "requires": [
        "description",
        "job",
        "kind",
        "quantity"
      ]
    },
    "moves": [
      {
        "from": "draft",
        "to": "approved",
        "by": [
          "host"
        ],
        "tools": [
          "approveLine",
          "recordAcceptance"
        ]
      },
      {
        "from": "approved",
        "to": "billed",
        "by": [
          "host"
        ]
      },
      {
        "from": "billed",
        "to": "approved",
        "by": [
          "host"
        ]
      },
      {
        "from": [
          "draft",
          "approved"
        ],
        "to": "void",
        "by": [
          "host"
        ],
        "tools": [
          "voidLine",
          "editLine"
        ],
        "final": true
      }
    ],
    "follows": {
      "relation": "variation",
      "when": {
        "approved": "approved",
        "declined": "void",
        "withdrawn": "void"
      },
      "from": [
        "draft"
      ]
    }
  }
}
```

</details>

## Variation (`jobs.variation`)

A change to agreed work: why, who asked, and its lines. Approved before the work is done, by the customer or by the office on the customer's word (recorded as which).

|  |  |
| --- | --- |
| Plural | Variations |
| Title field | `title` |
| Listed in | none |
| Behaviours | [`unique`](/reference/behaviours/#unique), [`states`](/reference/behaviours/#states) |
| Indexes | `job, state` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title | yes |   |   |
| `job` | `relation` | Job |   | to `jobs.job`; read-only |   |
| `why` | `longText` | Why | yes |   |   |
| `askedBy` | `select` | Asked by |   | one of `customer`, `crew`, `office` |   |
| `proposedBy` | `user` | Proposed by |   | read-only |   |
| `proposedByName` | `text` | Proposed by (name) |   | read-only |   |
| `decidedBy` | `select` | Decided by |   | one of `customer`, `office`; read-only |   |
| `decidedAt` | `datetime` | Decided at |   | read-only |   |
| `decidedByName` | `text` | Recorded by |   | read-only |   |
| `decisionNote` | `text` | Decision note |   | read-only | What the office recorded: how the customer agreed or declined. |
| `requestKey` | `text` | Request key |   | read-only |   |
| `state` | `select` | State |   | one of `proposed`, `approved`, `declined`, `withdrawn`; default `"proposed"` |   |

### Relations

- `job` → `jobs.job`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "unique": [
    {
      "fields": [
        "requestKey"
      ]
    }
  ],
  "states": {
    "field": "state",
    "initial": "proposed",
    "create": {
      "requires": [
        "job"
      ]
    },
    "moves": [
      {
        "from": "proposed",
        "to": "approved",
        "by": [
          "host"
        ],
        "tools": [
          "approveVariation"
        ],
        "requires": [
          "decidedBy",
          "decidedAt"
        ],
        "final": true
      },
      {
        "from": "proposed",
        "to": "declined",
        "by": [
          "host"
        ],
        "tools": [
          "declineVariation"
        ],
        "requires": [
          "decidedBy",
          "decidedAt"
        ],
        "final": true
      },
      {
        "from": "proposed",
        "to": "withdrawn",
        "by": [
          "host"
        ],
        "tools": [
          "withdrawVariation"
        ],
        "final": true
      }
    ]
  }
}
```

</details>

## Rate (`jobs.rate`)

A charge-out rate for labour (standard, after hours, an apprentice's).

|  |  |
| --- | --- |
| Plural | Rates |
| Title field | `name` |
| Listed in | settings |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `perHour` | `currency` | Per hour |   | min 0; max 100000 | In the base currency, before tax. |
| `active` | `boolean` | In use |   | default `true` |   |

## Views

| View | Object | Label |
| --- | --- | --- |
| `jobsBoard` | `jobs.job` | Jobs board |
| `openJobs` | `jobs.job` | Open jobs |
| `myJobs` | `jobs.job` | My jobs |
| `schedule` | `jobs.visit` | Schedule |
| `upcomingVisits` | `jobs.visit` | Upcoming visits |
| `variationsWaiting` | `jobs.variation` | Variations waiting |

## On other records' pages

| Kind | Key | On | Label |
| --- | --- | --- | --- |
| tab | `jobVisits` | `` | Visits |
| tab | `jobLines` | `` | Lines |
| tab | `jobVariations` | `` | Variations |
| tab | `visitCrew` | `` | Crew |
| tab | `siteJobs` | `` | Jobs |
| tab | `personJobs` | `` | Jobs |
| tab | `organisationJobs` | `` | Jobs |
