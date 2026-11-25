---
title: "Forms: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

It requires no other pack.

## Form (`forms.form`)

Questions the business asks, published as versions: an enquiry, a sign-up, a survey, feedback or a staff report. People answer the version last published.

|  |  |
| --- | --- |
| Plural | Forms |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`publishable`](/reference/behaviours/#publishable), [`intake`](/reference/behaviours/#intake) |
| Indexes | `status`; `kind` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title | yes |   |   |
| `slug` | `slug` | Address |   | a person's to change | How a link or a QR code names the form. Made from the title. Changed after publishing, the old address still finds the form. |
| `kind` | `select` | Kind |   | one of `enquiry`, `signup`, `survey`, `feedback`, `staff`; default `"enquiry"` | What the form is for. A staff form (an incident report) is answered by staff only: set who may answer to Staff. |
| `questions` | `document` | Questions |   |   | What the form asks. No health questions, signatures or waivers: those are agreements. |
| `thanks` | `longText` | Thank-you words |   |   | Shown once the answers are sent. |
| `answeredBy` | `select` | Who may answer |   | one of `public`, `customers`, `links`, `staff`; default `"public"` | Read from the version published: a change counts once it is published. |
| `anonymous` | `boolean` | Anonymous |   |   | Keeps no link to whoever answers: no person, no account, no receipt and no record made elsewhere. It cannot ask for an email that fills in a person. |
| `destination` | `text` | Also make |   |   | A record of another pack each answer also makes, named as &lt;pack&gt;.&lt;object&gt;. Only an installed pack whose record takes a form's answers can be named (none yet); never on an anonymous form. |
| `notify` | `user` | Who is told |   |   | Told of each answer. Left empty, the admins. |
| `receipt` | `boolean` | Send a receipt |   | default `true` | The sender gets a short email saying the answers arrived, with nothing they typed in it. Never on an anonymous form. |
| `lowRating` | `number` | Tell at a rating of |   | min 0; max 10 | A first rating answer at or under this tells the answers' owner (or the admins). Left empty, no notice. |
| `opensAt` | `datetime` | Open from |   | a person's to change |   |
| `closesAt` | `datetime` | Open until |   | a person's to change |   |
| `dailyCap` | `number` | Answers a day, at most |   | min 1; a person's to change | Left empty, no limit of its own. |
| `status` | `select` | Status |   | one of `draft`, `open`, `closed`; a person's to change |   |

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "states": {
    "field": "status",
    "initial": "draft",
    "moves": [
      {
        "from": "draft",
        "to": "open",
        "by": [
          "staff"
        ]
      },
      {
        "from": "open",
        "to": "closed",
        "by": [
          "staff"
        ]
      },
      {
        "from": "closed",
        "to": "open",
        "by": [
          "staff"
        ]
      }
    ]
  },
  "publishable": {
    "content": [
      "title",
      "questions",
      "thanks",
      "answeredBy",
      "anonymous",
      "destination"
    ],
    "slug": "slug"
  },
  "intake": {
    "role": "form",
    "questions": "questions",
    "answeredBy": "answeredBy",
    "openIn": [
      "open"
    ],
    "anonymous": "anonymous",
    "destination": "destination",
    "opensAt": "opensAt",
    "closesAt": "closesAt",
    "dailyCap": "dailyCap",
    "notify": "notify",
    "hourlyCap": "hourlyCap"
  }
}
```

</details>

## Submission (`forms.submission`)

One set of answers to one version of a form, made only by the answers someone sends (or staff enter). Read by staff only, never by the person who sent it.

|  |  |
| --- | --- |
| Plural | Submissions |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`intake`](/reference/behaviours/#intake) |
| Indexes | `form, createdAt`; `createdAt`; `status, createdAt`; `person`; `about` |
| Owner field | `owner` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title |   |   | Left empty, the form's title. |
| `form` | `relation` | Form | yes | to `forms.form` |   |
| `version` | `number` | Version |   |   | The version of the form answered: its questions and words. |
| `person` | `relation` | Person |   | to `person` | Who sent it. None on an anonymous form. |
| `certainty` | `select` | How sure |   | one of `account`, `link`, `staff`, `address` | How the host knows whose it is. Unconfirmed address: someone typed this address; nothing on the person's record was changed by it. |
| `answers` | `document` | Answers |   |   |   |
| `rating` | `number` | Rating |   |   | The first rating answered, for lists and dashboards. |
| `marketing` | `boolean` | Asked to hear from us |   |   | They ticked a “keep me updated” line. The words they saw are the version's. |
| `via` | `select` | Came in |   | one of `site`, `app`, `page`, `link`, `staff` |   |
| `about` | `text` | About |   |   | The record the personal link was about (a booking's id), set by the host. |
| `aboutObject` | `text` | About (kind) |   |   | What kind of record that is (bookings.booking), set by the host. |
| `owner` | `user` | Owner |   |   |   |
| `notes` | `longText` | Notes |   |   |   |
| `status` | `select` | Status |   | one of `new`, `inHand`, `done`, `spam` |   |

### Relations

- `form` → `forms.form`
- `person` → `person`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "states": {
    "field": "status",
    "initial": "new",
    "moves": [
      {
        "from": "new",
        "to": "inHand",
        "by": [
          "staff"
        ]
      },
      {
        "from": [
          "new",
          "inHand"
        ],
        "to": "done",
        "by": [
          "staff"
        ]
      },
      {
        "from": "done",
        "to": "inHand",
        "by": [
          "staff"
        ]
      },
      {
        "from": [
          "new",
          "inHand",
          "done"
        ],
        "to": "spam",
        "by": [
          "host"
        ],
        "tools": [
          "markSpam"
        ]
      },
      {
        "from": "spam",
        "to": "new",
        "by": [
          "host"
        ],
        "tools": [
          "notSpam"
        ]
      }
    ]
  },
  "intake": {
    "role": "submission",
    "form": "form",
    "version": "version",
    "answers": "answers",
    "person": "person",
    "certainty": "certainty",
    "spam": "spam",
    "via": "via",
    "rating": "rating",
    "marketing": "marketing",
    "about": "about",
    "aboutObject": "aboutObject"
  }
}
```

</details>

## Views

| View | Object | Label |
| --- | --- | --- |
| `newAnswers` | `forms.submission` | New answers |
| `inHand` | `forms.submission` | In hand |
| `spam` | `forms.submission` | Spam |
| `askedToHear` | `forms.submission` | Asked to hear from us |
| `openForms` | `forms.form` | Open forms |

## On other records' pages

| Kind | Key | On | Label |
| --- | --- | --- | --- |
| tab | `personAnswers` | `` | Form answers |
| tab | `formAnswers` | `` | Answers |
