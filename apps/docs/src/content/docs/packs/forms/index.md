---
title: "Forms"
description: "Forms a business builds and publishes (enquiries, sign-ups, surveys, feedback, staff reports), and every answer in one inbox, linked to the person who sent it."
sidebar:
  label: "Overview"
  order: 0
editUrl: false
---

Forms a business builds and publishes (enquiries, sign-ups, surveys, feedback, staff reports), and every answer in one inbox, linked to the person who sent it.


## What it is for

Forms lets a business build its own forms in the admin, with no developer: an enquiry ("ask about
a trial"), a sign-up ("tell me when kids' classes start"), a survey of its members, feedback after
a class, or a report its staff fill in. A visitor answers with no account and a member answers
signed in. Every answer lands in one inbox, linked to the right Person, where staff work it: new,
in hand, done, or spam. Nobody outside the business reads an answer, not even the person who sent
it. A "keep me updated" tick is kept with the exact words the person saw.

It requires no other pack.

## Concepts

- **Form** (`forms.form`): questions in the platform's question schema, with a title, an address
  (its slug), thank-you words, who may answer (anyone, signed-in customers, a personal link, or
  staff only), whether it is anonymous, and when it is open. Published as versions: people answer
  the version last published.
- **Kind**: enquiry, sign-up, survey, feedback or staff. A staff form (an incident report) is
  answered by staff only.
- **Submission** (`forms.submission`): one set of answers to one version of a form, made only by
  the host's door. It points at the form and the version answered, the Person and how sure the
  host is of them (signed in, personal link, entered by staff, or an unconfirmed address), and
  keeps the answers and the first rating.
- **Inbox**: the submission's states, new, in hand, done and spam.
- **Asked to hear from us**: a submission whose "keep me updated" line was ticked. The host marks
  it; the words are the version's.
- **Personal link**: a link the host emails one Person to answer one form once, without signing
  in, often about one record (the class they came to: the submission's `about`). It works for a
  week, is spent by its first answer, and is shown in the member's app under Needs your attention.
- **Receipt**: the short email whoever sent answers gets, naming the business and the form and
  nothing they typed.
- **Form page**: a form drawn as a plain web page by the host, which works with no JavaScript: a
  form's own page, `/f/<slug>`, for a link or a QR code, and a personal link's, `/form?t=…`. Served
  on the host's address and, through the web app's binding, on the business's own site.
- **Form block**: the same form in a client app's own screens: `forms-form` on the website,
  `forms-native-form` in the app, over the pack's headless entry.

## How the pieces fit

- **A form takes answers only through the host's one door**, the
  [`intake`](/reference/behaviours/#intake) behaviour. The pack's `submit` tool hands the answers
  to `intake.submit`, which checks the form is published, open and open to the caller, a
  visitor's Turnstile token, how soon the form was sent after it was shown, the caps and every
  answer, then makes the submission, links or makes the Person (filling only empty fields) and
  tells staff, in one batch. The pack writes no submission itself.
- **The public reads a form only through the door** (`intake.open`, by the form's address): a form
  that is a draft, closed, out of its dates or for signed-in customers only is not found. The form
  has no public scope.
- **Who may answer, anonymity and the destination are published** with the questions: an edit
  counts once a person publishes it. Publishing, opening or closing a form, its dates, its daily
  cap and its address are a person's; an AI may ask. A form's old address, after a change, still
  finds it.
- **Who reads it**: staff accounts read forms and submissions as any record. No pack-role account
  (a coach, the door, a team member) reads either, and no customer or visitor reads a submission.
- **Spam**: the door keeps a flood from one address as spam. Moving a submission into or out of
  spam is `markSpam`'s and `notSpam`'s only, and an AI's call of either waits for a person.
- **The hourly cap** across every form is the pack's setting, a person's to change.
- **Personal links are the host's.** Only routine mail's form-link slot makes one, for a pack
  that declares it (Bookings' feedback after a class), and only when the email that carries it is
  sent on its own: one link per Person, form and record, a token of its own for each email, only
  the token's hash kept, never the token itself (not in an approval, a log or the email's row). An
  email with a link that would wait for a person is not sent. `form` and `submit` take the token
  as `link` (anyone holding it, no Turnstile token); a signed-in member's own link from Needs
  your attention (or a child's) is `linkedForm` and `submitLinked`, by its id. The answers are the
  link's Person's (certainty personal link), to that form only; a used, expired or unknown link
  is one refusal, opening one uses nothing, and of two answers at once by one link the database
  keeps one. A child's link answered by a guardian fills none of the child's fields. A form a link
  opens is any but a staff form or an anonymous one; a form sent by a pack's link is a `links`
  form.
- **The receipt is routine mail** (`receipt`), sent by the host once the pack's routine email is
  turned on, naming the business (the name in Settings → Routine email): to the signed-in member's
  own address, whoever answered a personal link (a child's goes to the guardian who answered), or
  the address a visitor typed; never for answers entered by staff, kept as spam or sent
  anonymously, at most three a day to one address and 200 a day for the organisation (Settings →
  Routine email). The form's "Send a receipt" turns it off.

- **The page and the blocks hold no rule.** They draw every question kind, show a question that
  waits on an earlier answer only once it holds, check the answers first with the host's own
  check (so what to fix is said beside each question) and show the host's answer: a refusal stays
  on the screen with the answers as typed. The spam checks travel with the send: a field a person
  never sees (the honeypot), the host's token of when the form was shown (kept through a redraw, so a
  quick correction is not taken for a bot), and on a public form a visitor's Turnstile token (the page draws Cloudflare's widget with the host's site key; a block
  is given the app's widget). What a person typed is kept nowhere but their screen.
- **A personal link's page** is sent with no referrer, loads nothing from anywhere else (no
  Turnstile: the host skips it for a link), and takes the token out of the address bar once
  loaded, keeping it only in the page for the send. Opening it uses nothing; the send uses it, once,
  and a reload of the thanks is answered from the host's store. A site that shows a link's form
  with the web block instead keeps the same three rules on its own page: no referrer, no
  third-party script (analytics would read the address before the token is out), and the token
  taken out at once with `takeLinkToken`.
- **Every page** is never cached or framed and sets no cookie. Each send carries the page's own
  idempotency key, so a reload or a second press is one answer. A send posted from another site is
  refused. On the business's site the web app forwards the page's two paths to the host
  (`formPageRoute` in the template's host module), with the customer's cookie and the form's
  fields only, and the visitor's address. A send is taken only from the page's own origin
  (`Sec-Fetch-Site: same-origin`, else its own or a `null` Origin): another site's form, or a page on
  a sibling subdomain, is refused.

## Main flows

1. **Build and publish a form.** Staff create a form, write its questions, open it and publish
   it; the assistant may draft one and ask to publish it.
2. **Answer it.** A website or app asks `form` for the form by its address, draws its questions,
   and sends the answers with `submit`. The answer is the same whether the host kept them, kept
   them as spam or dropped them.
3. **Enter answers for someone.** Staff take a phone or paper enquiry, or fill in a staff form,
   with `enter`; the submission is marked as entered by staff, and staff cannot tick "keep me
   updated" for anyone.
4. **Work the inbox.** Staff move a submission with `move` (new, in hand, done), and mark spam
   with `markSpam` or take it back with `notSpam`.
5. **A low rating.** When answers arrive with a rating at or under the form's level, the
   `lowRating` automation tells the answers' owner, or the admins when they have none.
6. **A receipt.** When answers arrive to a form whose receipt is on, the `receipt` automation asks
   the host for the receipt; the host decides who it goes to, or that none does. A person binds
   the email connection it sends from, and turns the pack's routine email on.
7. **Answer by a personal link.** A member opens the link from their email on the business's
   site; the page asks `form` with the link (using nothing) and sends the answers with `submit`
   and the same link; the submission is the member's, tied to what the link was about. In the app,
   the Needs your attention item opens `forms-native-form`'s `LinkedFormScreen`, by the link's id.
8. **A form's own page.** A link or a QR code opens `/f/<slug>`; the visitor answers with no
   account, and the page sends the answers with `submit` (`via` page).
9. **A form on the website or in the app.** The client app draws `forms-form`'s `FormBlock` (or
   `forms-native-form`'s `FormScreen`) with the form's address and its hooks
   (`createFormsHooks` from `@composable-os/pack-forms/client`), and passes its Turnstile widget
   for a public form.

## What is built

The forms and submissions, the tools above, the views (new answers, in hand, spam, asked to hear
from us, open forms), the answers tab on a Person and on a form, the hourly cap setting, the
low-rating notice, personal links (answered with `link`, or signed in with `linkedForm` and
`submitLinked`), the receipt, the form page (`/f/<slug>` and `/form`, on the host's address and
the business's site), the `forms-form` and `forms-native-form` blocks and the headless entry.

Not in the code yet: sending a form by personal link by hand, a record of another pack (a
lead) as a destination, deleting a person's submissions when they are erased (erase deletes their
personal links, and clears the Person and the answers it recognises, not free text) and
retention, the builder and inbox screens and the dashboard, and file uploads.


## Reference

Generated from the code:

- [Data model](/packs/forms/data-model/)
- [Operations and tools](/packs/forms/tools/)
- [Permissions and roles](/packs/forms/permissions/)
- [Screens](/packs/forms/screens/)
- [Messages](/packs/forms/messages/)
- [Settings](/packs/forms/settings/)
- [Decisions](/packs/forms/decisions/)

The specification is stage 29's, [29-forms.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/stages/29-forms.md).

This page is [forms/docs/overview.md](https://github.com/timoconnellaus/composable-os/blob/main/packs/forms/docs/overview.md), written by hand beside the code.
