---
title: "Forms: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.forms.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

### form

A form by its address, as the caller may answer it now: its version, title, questions and thank-you words, whether it is anonymous, whether a Turnstile token is needed, and the host's token of when it was shown (send it back with the answers). A form that is not open to the caller now (a draft, closed, not published, out of its dates, for signed-in customers only, or no such address) is not found, the same answer whatever the reason. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `customer`, `public` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `slug` | string | yes | min length 1, max length 200 | The form's address, e.g. ask-about-a-trial |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `version` | number | yes |   | The version shown: send it with the answers |
| `title` | string or null | yes |   |   |
| `questions` | object | yes |   | The questions, in the platform's question schema, in order |
| `questions.items` | array of map of any | yes |   |   |
| `thanks` | string or null | yes |   | The words to show once the answers are sent |
| `anonymous` | boolean | yes |   | Nothing kept says who answered |
| `turnstile` | boolean | yes |   | A Turnstile token must be sent with the answers |
| `shown` | string or null | yes |   | Send back as `shown` with the answers |

### submit

Send answers to a form the caller may answer (from `form`). The host checks the form is still open to them, a visitor's Turnstile token and when the form was shown, the caps and the answers against the version shown, then keeps them in the business's inbox, linked to the sender's person by the email answered. Answers that break the form are refused naming the question's key; a form published again since it was shown is refused with 'load it again'; too many answers just now is 'try again later'. Kept, kept as spam or dropped, the answer is the same.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `customer`, `public` |
| Kept from the audit log | `answers`, `turnstileToken`, `shown`, `honeypot` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The form (forms.form record id) |
| `version` | integer | yes | &gt; 0, ≤ 9007199254740991 | The version `form` showed |
| `answers` | map of any | yes |   | The answers by question key: text, email, phone and date as strings (a date YYYY-MM-DD), number and rating as numbers, a choice as a string or a list of strings, yes/no and a tick box as true or false. Leave out what was not answered. |
| `via` | `"site"`, `"app"`, `"page"` |   |   | Which way in: the business's website, its app, or the form's own page |
| `turnstileToken` | string |   | max length 4096 | A visitor's Turnstile token |
| `shown` | string |   | max length 200 | `form`'s shown token |
| `honeypot` | string |   | max length 1000 | The hidden field a person leaves empty |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `received` | `true` | yes |   | The answers were sent: shown the same whatever the host's spam checks decided |

### enter

Enter answers on someone's behalf (a phone call, a paper form) or fill in a staff form (an incident report), for any published form. The submission is marked as entered by staff, and the person is found or made from the email answered, filling only their empty fields. Staff cannot tick a 'keep me updated' line for someone: only the person can.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `forms:answer` |
| Kept from the audit log | `answers` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `formId` | string | yes | min length 1, max length 64 | The form (forms.form record id) |
| `answers` | map of any | yes |   | The answers by question key: text, email, phone and date as strings (a date YYYY-MM-DD), number and rating as numbers, a choice as a string or a list of strings, yes/no and a tick box as true or false. Leave out what was not answered. |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `received` | `true` | yes |   | The answers were sent: shown the same whatever the host's spam checks decided |

### move

Move a submission in the inbox: new, in hand or done. Refused when the move is not one the inbox has (a spam submission is taken out with notSpam first), or when someone moved it meanwhile.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `forms:answer` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `submissionId` | string | yes | min length 1, max length 64 | The submission (forms.submission id) |
| `to` | `"new"`, `"inHand"`, `"done"` | yes |   |   |
| `from` | `"new"`, `"inHand"`, `"done"`, `"spam"` |   |   | Only if it is still in this state: for a move two people may make at once |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `status` | string | yes |   |   |

### markSpam

Mark a submission as spam: it leaves the inbox and is kept in Spam. A person's act: the assistant may suggest it, and the suggestion waits for a person to approve it. Undo with notSpam.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `forms:answer` |
| Approval | a person approves anyone else's call (`personApproves`) |
| Button on | `forms.submission` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `submissionId` | string | yes | min length 1, max length 64 | The submission (forms.submission id) |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `status` | string | yes |   |   |

### notSpam

Take a submission out of Spam: it is back in the inbox as new. A person's act: the assistant may suggest it, and the suggestion waits for a person to approve it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `forms:answer` |
| Approval | a person approves anyone else's call (`personApproves`) |
| Button on | `forms.submission` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `submissionId` | string | yes | min length 1, max length 64 | The submission (forms.submission id) |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `status` | string | yes |   |   |

## Automations

### lowRating

**Tell of a low rating.** When answers arrive with a rating at or under the form's 'tell at a rating of', tells the answers' owner, or the admins when they have none. Answers kept as spam tell nobody.

|  |  |
| --- | --- |
| Trigger | record on forms.submission (created) |
| Steps | `tell` Tell the owner, or the admins |

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

- [`intake.open`](/reference/operations/intake/#intakeopen)
- [`intake.submit`](/reference/operations/intake/#intakesubmit)
- [`notification.send`](/reference/operations/notification/#notificationsend)

Host modules it asks for: `ops`.
