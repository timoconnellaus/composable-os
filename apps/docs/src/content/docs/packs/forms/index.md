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

## What is built

The forms and submissions, the tools above, the views (new answers, in hand, spam, asked to hear
from us, open forms), the answers tab on a Person and on a form, the hourly cap setting and the
low-rating notice.

Not in the code yet: the hosted page and the web and native form blocks, personal links, the
receipt email, a record of another pack (a lead) as a destination, deleting a person's
submissions when they are erased (erase clears the Person and the answers it recognises, not free
text) and retention, the builder and inbox screens and the dashboard, and file uploads.


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
