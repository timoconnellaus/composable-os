---
title: "Agreements"
description: "Documents a person agrees to or signs (terms, a waiver, health questions, a parent's consent), kept word for word for good, and enforced so nobody pays or books without what is due."
sidebar:
  label: "Overview"
  order: 0
editUrl: false
---

Documents a person agrees to or signs (terms, a waiver, health questions, a parent's consent), kept word for word for good, and enforced so nobody pays or books without what is due.


## What it is for

A business writes the documents its members must agree to: its membership terms, a waiver,
health questions before exercise, and a parent's consent for a child. It says where each is
needed (when someone buys a membership or a pass, before they book a class, when they buy a
ticket or a course). A person reads the document and agrees, by ticking a box and typing their
name or by drawing their signature, on the website, in the app, or on the business's tablet at the
desk. A parent agrees for their child. Staff record a paper form. Each agreement keeps the exact
words the person saw. The person gets a copy by email and the business can download a PDF. Nobody
pays, starts a membership or books without the agreements they need: not a member, not staff for
them, not the assistant, not an API call.

The platform ships no legal wording: the business writes its own documents.

Agreements is a core capability with its own tables, not a pack: tickets, courses, memberships
and bookings all need it, and its checks sit in the orders pipeline and the transition engine,
which a pack cannot hook.

## Concepts

- **Document**: one of the business's documents, of a kind (`terms`, `waiver`, `health`,
  `guardian`, `other`), with a working copy and **versions**. A published version is never changed
  or deleted by anyone; the database refuses it. Only a person with `agreements:manage` publishes,
  and an AI cannot even ask.
- **Small change or agree again**: publishing a new version either keeps earlier acceptances
  counting or asks everyone to agree again before their next booking or purchase.
- **Agreement point**: a place a pack marks where agreement may be needed, with the
  [`agreements`](/reference/behaviours/#agreements) behaviour on one of its objects (buying a
  membership or a pass, a booking, buying a ticket or a course). The business attaches its
  documents to points; nothing is needed anywhere until a person publishes a document and attaches
  it.
- **What is due**: the one question, "what must this Person still agree to for this point". It is
  asked by the orders pipeline when an order or a subscription starts and by the transition engine
  when a record enters a declared state, and guarded at commit.
- **Acceptance**: a row nobody can change: the version and the hash of what was shown, who it is
  for, who agreed (the person, a guardian, a guest with an order, or staff from paper), how (typed
  name, drawn signature as its strokes, paper, or in person at the desk) and when.
- **Health answers**: a health document's answers, in their own table that no `rec_*` view,
  search, export, dashboard or AI reads. A coach's class list shows only a yes or no "health note"
  ([`healthNotes`](/reference/behaviours/#healthnotes)); reading the answers needs a permission and
  is audited.
- **The minor mark**: who may agree for whom. A guardian agrees for a dependant over a live family
  link.
- **Signing at the desk**: a session a person on the staff starts for a member on the business's
  enrolled tablet, which has no sign-in of its own.
- **Cooling off**: a new member may end a membership within the business's cooling-off period, for
  a refund a person approves.

## How the pieces fit

- **Platform tables and operations** in `packages/core/src/agreements/`: documents, versions,
  acceptances, health answers, desk sessions and retention, reached through the
  [operations](/capabilities/agreements/operations/) named `agreement.*` (staff), `me.agreements.*`
  (a signed-in customer) and `desk.*` (the tablet).
- **Packs declare points**: Memberships (plans, pass types, passes), Bookings (a booking),
  Ticketing (ticket types) and Courses (courses, bundles and plans). See the
  [behaviour's reference](/reference/behaviours/#agreements) for each declaration.
- **Enforcement is in the host**: the orders pipeline, `startSubscription` and the transition
  engine ask what is due, and the write's batch carries a guard, so a document published or
  attached since the read fails the batch and the caller is asked to look again. A refusal names
  the documents, so a client app shows an inline step and tries again.
- **The copy and the PDF** are made from the stored version and acceptance: the host emails the
  copy as its own mail, with a PDF the email gatekeeper builds; the business downloads the same PDF
  on demand. No file is kept.
- **Erase, merge and retention**: erasing a Person deletes their health answers and keeps their
  acceptances, detached from them, for the business's retention period; merging re-points them.
- **Blocks** for client apps (web and native): agree to a document, what must be agreed before
  going on, and a person's own agreements. The admin has the document editor, the lists and the
  Person tab.

## Main flows

1. **Write and publish.** Staff draft a document (`agreement.create`, `agreement.draft.save`); a
   person with `agreements:manage` previews and publishes a version (`agreement.publishPreview`,
   `agreement.publish`), now or from a date, as a small change or "agree again".
2. **Attach.** A person attaches the document to points (`agreement.points`, `agreement.attach`,
   `agreement.detach`), or retires it (`agreement.retire`).
3. **Agree.** A signed-in member reads what is due (`me.agreements.due`) and agrees
   (`me.agreements.accept`), for themselves or a child; a guest agrees on the way to paying for an
   order.
4. **Be stopped.** A purchase, a subscription or a booking with something due is refused with the
   documents it needs; the client app shows them and tries again.
5. **Paper.** Staff record a paper form (`agreement.recordPaper`) and mark a minor
   (`agreement.setMinor`).
6. **At the desk.** Staff start a session for a member on an enrolled tablet
   (`agreement.desk.start`); the member claims it with a code and agrees there (`desk.claim`,
   `desk.documents`, `desk.accept`, `desk.finish`).
7. **Copies.** Each acceptance sends its copy (`agreement.copy.send`); the member and staff
   download PDFs (`me.agreements.pdf`, `agreement.acceptance.pdf`, `agreement.version.pdf`).
8. **Health notes.** A coach sees who has a health note on a class list; a person with the
   permission reads the answers (`agreement.answers.get`), audited.
9. **Cool off.** A new member ends a membership in the cooling-off period
   (`subscription.coolOff`); the refund waits for a person.
10. **Keep and purge.** After erase, acceptances are kept for the retention period
    (`agreement.retention`, `agreement.setRetention`), held when needed (`agreement.kept.hold`)
    and purged after it (`agreement.purgeKept`).

## What is built

Stage 44's steps 1 to 8, as the code has them:

- documents and versions, publishing by a person only, effective dates, small changes and "agree
  again", the `agreements` behaviour and attaching documents to points;
- acceptances on every path (the person, a guardian, a guest, paper), signatures as strokes, the
  minor mark, health answers and their isolation, the coach's health notes;
- enforcement in the orders pipeline, subscriptions and the transition engine, with the points on
  Memberships, Bookings, Ticketing and Courses;
- the copy by email and the signed PDF;
- the blocks and hooks for client apps (web and native);
- signing at the desk on an enrolled tablet;
- cooling off;
- erase, merge, the Trash and retention.

Not in the code: a practitioner's consent as an acceptance (step 9, with stage 43), a copy to a
member's previous address after an address change, and a QR code for the desk session.


## Reference

Generated from the code:

- [Operations](/capabilities/agreements/operations/)
- [Permissions](/capabilities/agreements/permissions/)
- [Behaviours](/capabilities/agreements/behaviours/)
- [Screens](/capabilities/agreements/screens/)
- [Decisions](/capabilities/agreements/decisions/)

The specification is stage 44's, [44-agreements.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/stages/44-agreements.md).

This page is [agreements/docs/overview.md](https://github.com/timoconnellaus/composable-os/blob/main/packages/core/src/agreements/docs/overview.md), written by hand beside the code.
