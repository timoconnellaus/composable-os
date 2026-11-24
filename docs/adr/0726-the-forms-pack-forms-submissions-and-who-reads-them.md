# ADR 0726: The Forms pack: forms, submissions, and who reads them

Status: accepted, 2026-11-24 (stage 29, build step 3). Builds on ADRs
[0720](0720-the-intake-door-one-public-write.md) (the intake door), [0721](0721-the-submitters-person-and-certainty.md),
[0722](0722-abuse-checks-turnstile-honeypot-fill-time-caps.md) (the caps),
[0725](0725-anonymous-submissions.md), [0446](0446-publishable-without-its-public-half.md),
[0480](0480-an-ai-asks-to-publish-a-person-approves.md), [0552](0552-a-tool-a-person-approves.md)
and [0625](0625-restricted-pack-permissions.md). Amends ADR 0720 (two keys of the `intake`
behaviour and a form found by its address) and ADR 0722 (the hourly cap is a pack's setting).

## Context
Steps 1 and 2 built the question schema and the door. Stage 29 needs the records a business works
with: forms it builds and publishes with no developer, and every answer in one inbox, linked to the
right Person, worked by staff and never read by anyone outside the org (decision 5). The spec gave
the form a public scope ("title, questions, thank-you, while open and published"), a "keep me
updated" list, an hourly cap and spam retention as settings, and a low-rating notice.

## Decision
- **A pack, `packs/forms`** (`forms`, optional), with two objects:
  - `forms.form`: title, an address (`slug`), kind (`enquiry`, `signup`, `survey`, `feedback`,
    `staff`), questions (`QUESTIONS_SCHEMA`), thank-you words, who may answer (`public`,
    `customers`, `links`, `staff`), anonymous, a destination (a select of objects that may declare
    `intake` as a destination: `leads.lead` for now; the host refuses one not installed), who is
    told, receipt on or off (on by default), a low-rating level (0 to 10), open from and until, a
    daily cap. `publishable` with title, questions, thank-you, who may answer, anonymous and
    destination as content, and the slug as its address; states draft, open and closed.
  - `forms.submission`: the form, version, Person, certainty, answers (`ANSWERS_SCHEMA`), rating,
    "asked to hear from us", way in, owner (assignment rules, `owner: "owner"`), notes, and a title
    taken from the form (`titleDefault`). States new, in hand, done and spam.
- **No public scope on a form.** A public declaration's `when` reads one state field: it cannot say
  "published, open, within its dates and answered by anyone", so `content.get` and `content.list`
  would show a members-only or link-only form's questions to anyone. The public reads a form only
  through the door: **`intake.open` takes the form's `slug`** as well as its id, when the form
  object declares `publishable.slug`, and a form that does not take the caller's answers is not
  found, naming the address the caller gave and never the id. The pack's `form` tool calls it.
- **Two new keys of `intake`** (ADR 0720, amended):
  - `hourlyCap` on a form: a number setting of the pack, which must be `personApproves`, read by
    the door as the deployment's hourly cap (left empty or out, the platform's 200). Forms names its
    `hourlyCap` setting (default 200, 1 to 10,000). It is an abuse setting, so an AI's change waits
    for a person (ADR 0722, amended: the cap is the pack's setting, no longer only the platform's).
  - `marketing` on a submission: a boolean the host sets when a `marketing` consent line of the
    version answered was ticked. It is one of the submission's host-only fields, as its answers
    are: staff and the assistant cannot set it, and the door already refuses a staff-entered tick.
    The evidence is the submission (who, when) and the version it points at (the words).
- **The inbox is the submission's states.** Staff move new, in hand and done (`x.forms.move`, with
  `from` for two people at once). The moves into and out of spam are `by: ["host"]` with `tools:
  ["markSpam"]` and `["notSpam"]`, both `personApproves` (ADR 0552): the door keeps a flood as
  spam, a person marks one, and the assistant only suggests it. No plain `record.update` moves a
  submission into or out of spam.
- **Opening and closing a form are a person's**: the form's status field is `personApproves`, so an
  AI's write of it waits for a person, as publishing does (ADR 0480).
- **Tools**: `form` and `submit` (customers and the public; read and write), which pass straight to
  `intake.open` and `intake.submit` with the pack's own form object; `enter` (staff enter a phone
  or paper enquiry or a staff form; the host sets certainty and way in to `staff`); `move`,
  `markSpam` and `notSpam`. The staff tools name `forms:answer`, which every member holds; no role
  lists it and it is not grantable, so no pack-role account reaches them.
- **Who reads it.** Staff accounts (admins, members, viewers) read forms and submissions as any
  pack record. A pack-role account (a coach, the door, a team member) reads neither: the pack
  declares no role, and a pack role reaches only its own pack's objects. Nobody outside the org
  reads a submission: no customer, public or signed-in declaration (ADR 0720's rule).
- **The low-rating notice** is an automation (`lowRating`): when a submission with a rating that
  is not spam is created, it reads its form and, at or under the form's level, tells the form's
  "who is told", else the admins. The notice of each submission stays the door's.
- **Views**: new answers, in hand, spam, "Asked to hear from us" (ticked, not spam: Person, form,
  version, time) and open forms; a "Form answers" tab on a Person and an "Answers" tab on a form.

## Considered
- **The spec's public scope on a form**: rejected above. A later website builder that lists forms
  reads them through the same door.
- **The low-rating notice in the door**: one more key on `intake` for something that is a notice,
  not a rule on a write; an automation reacting after the write is the contract's way.
- **Spam retention and "keep done submissions for" settings now**: they would do nothing until the
  purge exists (step 7, erase and retention), so they are added there.
- **Turnstile off as a setting**: decided at step 2 (ADR 0722): a testing host uses Cloudflare's
  test keys.
- **`x.forms.ask`** (send a form by personal link) is step 5's, with personal links; `forms:manage`
  arrives with it.

## Consequences
- The pack is carried by every release (every `packs/<id>`), installed by an admin or by a product
  that lists it. The CRM product does not list it, as it lists no gym or trades pack.
- The receipt field is stored now and read by step 5, which sends receipts; until then none is
  sent.
- The builder, inbox and dashboard screens are step 8 (after stage 47), the hosted page and blocks
  step 4. Until then forms are built through the host's generic record pages and the tools.
- Not yet tried on a live host.

## Proof
`packs/forms/test/forms.test.ts` (the manifest and every tool and the automation, on the test host);
`packages/core/test/intake-forms-pack.test.ts` (the real manifest on the door with real D1: by
address, the not-found words, the marketing mark host-only, the hourly cap setting);
`apps/runner/test/forms.test.ts` (the pack installed as shipped, its tools in the sandbox: a member
answers, a visitor with no Turnstile secret is refused and admins told, staff enter, the inbox and
spam moves, the assistant's spam and opening queued, a door-role account reads none of it).
