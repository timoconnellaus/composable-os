---
title: Knowledge
summary: Staff procedures read in their published wording and confirmed as read and understood, with a review reminder, and help pages for customers on the business's website.
stage: 38
spec: docs/stages/38-knowledge-base.md
adrs: [0440, 0442, 0446, 0480, 0700, 0701, 0702, 0706]
---

## What it is for

Knowledge lets a business write down how it does things, once, in one place, and answer its
customers' common questions. A **procedure** ("how we open up", "what we do when someone is hurt")
is read by every staff account in the wording a person last published, never the draft being
edited. The people who must know it are asked to confirm "I have read and understood this" with
one tap each time it is published or changed in a way that matters, and those who manage see who
has and who has not. A **help page** ("how do I pause my membership", "where do I park") is read by
anyone on the business's website, as published.

The pack ships no procedures and no help pages: they are the business's, written in the admin, by
the assistant or by an MCP client, with a person publishing each. It requires no other pack.

## Concepts

- **Procedure** (`knowledge.procedure`): a title, an address (its slug), a summary, a body in rich
  text whose headings are its sections, a section, who keeps it right (its owner), who must read
  it, a review period in months (12 unless set, 0 for never) and its next review date (its last
  publish plus the period). Staff only: it is never public.
- **Section** (`knowledge.section`): a group of procedures, with an order. Staff only.
- **Must read**: everyone, or some staff roles (admin, member, viewer), pack roles (a coach, a
  cleaner, the door) and granted pack permissions (the front desk's `bookings:desk`). It decides
  who is asked to confirm, not who may read: every staff account reads every published procedure.
- **Confirmation**: a staff account saying it has read and understood one published version. Only
  the person makes it, for the current version, once; it is kept for good and never changed.
- **Read again** and **small fix**: what a person publishing a later version chooses. Read again
  asks everyone who must read it to confirm this version; a small fix keeps their confirmations.
  The first version always asks.
- **Help page** (`knowledge.helppage`): a title, an address, a summary, a body, a topic, an order
  in the topic, related pages, and what search engines are shown. Public as published.
- **Help topic** (`knowledge.helptopic`): a group of help pages, with an address, an order and an
  icon, public as it is.

## How the pieces fit

- **Both are [publishable](/reference/behaviours/#publishable)**: staff and the assistant edit a
  working copy, and a person with the publish permission publishes it. An AI's publish is a
  request a person approves (ADR 0480), and the person approving makes the read-again choice.
- **Staff read what was published.** A procedure declares staff read (ADR 0701): every staff
  account, pack roles included, reads its current published version with `content.staffGet`,
  `content.staffList` and `content.search` (each match with its section's anchor), and never the
  working copy. A pack-role account reads nothing else of the pack. Its pictures are served to
  staff with a full role; a pack-role account reads its words and not its pictures.
- **Read and understood is the host's** (ADR 0702): who must read, checked against each account's
  role, pack role and grants on the day; which confirmation counts; who may see who has confirmed
  (admins, and those granted `knowledge:manage`, never an AI or a pack-role account). Who must read
  and the review period are a person's to change, and once a procedure is published, only an
  admin's or a holder of `knowledge:manage` (ADR 0706).
- **The notices are the pack's words, sent by the host** (ADR 0706), which alone knows who must
  read and who has not: a version that asks tells everyone who must read it; someone who still has
  one to read 7 days later is reminded, once; each week the owner hears who has not confirmed (a
  count when the owner does not manage); a new staff account is sent its list.
- **Help pages are public in their published wording** (ADR 0442): `content.get` by address,
  `content.list` and `content.search` find only published pages, and never a procedure.
- **Writing is every member's**: a member or an admin writes procedures and help pages. A coach or
  a cleaner writes them through the draft tools when an admin grants `knowledge:write`. Viewers do
  not write.

## Main flows

1. **Write a procedure.** Staff, or the assistant through `draftProcedure` (notes become rich
   text: `#` headings, `-` bullets, `1.` steps), write the working copy; a person sets who must
   read it and publishes it. Everyone who must read it is told.
2. **Read and confirm.** A staff member opens `toRead` (their list, oldest first), reads the
   procedure as published and taps confirm (`confirm`, with the version read).
3. **Change it.** A person edits and publishes again, choosing read again (everyone confirms the
   new wording, and is told) or a small fix (confirmations still count).
4. **See who has read it.** Those who manage open `readStatus`: per procedure, who must read it,
   who confirmed it and when, who has not and since when; or every procedure's counts.
5. **Review it.** On its next review date the `reviewDue` automation tells its owner, or the
   admins when it has none, to check it is still right; publishing it again starts a new period.
6. **Answer customers.** Staff write a help page in a topic (or the assistant drafts one with
   `draftHelpPage`) and a person publishes it; the site reads it by address, lists a topic's pages,
   and searches as the visitor types. `helpTopics` lists the topics for the help centre's menu.

## What is built

The four objects, the tools above, the review reminder, the notices, the views (procedure drafts,
published procedures, procedures by next review, help page drafts, published help pages), the
procedures tab on a section and the pages tab on a help topic, and the client hooks
(`@composable-os/pack-knowledge/client`) over staff read, the tools and the public content reads.

Not in the code yet: the blocks and the admin screens (the help centre, the procedure reader, to
read, confirm and read status), the roster's warning for a procedure still to read, the
assistant's answers from published passages, a checklist's "how to", and training through
Courses.
