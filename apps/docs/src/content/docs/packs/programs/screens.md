---
title: "Programs: screens"
sidebar:
  label: "Screens"
  order: 4
editUrl: false
---

Screens a shipped pack declares are built into the admin and shown to whoever could call every tool in `opens`. Blocks are the pack's screens for client apps, copied with `cos add`.

## Staff screens

| Screen | Label | Block | Navigation | Opens | On a record |
| --- | --- | --- | --- | --- | --- |
| `bank` | Exercise bank | [programs-bank](/reference/blocks/programs-bank/) (`ExerciseBank`) | Programs, 10 |  writes `programs.exercise` |   |
| `builder` | Program builder | [programs-builder](/reference/blocks/programs-builder/) (`ProgramWorkspace`) | Programs, 20 | [importText](/packs/programs/tools/#importtext) writes `programs.program` |   |
| `client` | Programs | [programs-coach-client](/reference/blocks/programs-coach-client/) (`CoachClient`) |   | [logAdd](/packs/programs/tools/#logadd), [logRemove](/packs/programs/tools/#logremove), [sessionComplete](/packs/programs/tools/#sessioncomplete) | `person` |

## Blocks

Each drawn with dummy data.

### programs-bank

Web. The exercise bank (stage 41): browse and search the gym's exercises, add one, and edit one with its easier and harder versions. [The block](/reference/blocks/programs-bank/).

<img class="cos-screen" src="/screens/programs-bank.png" alt="programs-bank, drawn with dummy data" width="880" height="1498" loading="lazy" decoding="async" />

### programs-builder

Web. The coach's program builder (stage 41): weeks, sessions, blocks and items, by drag and by keyboard; exercises picked from the bank; typed sets; levels; notes, for coaches or shown to members; copying a week or a session; the working copy saved as the coach goes, with the host's faults shown where they are; versions, restoring one, publishing, and assigning. [The block](/reference/blocks/programs-builder/).

<img class="cos-screen" src="/screens/programs-builder.png" alt="programs-builder, drawn with dummy data" width="1024" height="2610" loading="lazy" decoding="async" />

### programs-class-today

Web. A class type's session for a day (stage 41): its plan with every level, for a member to choose the level they take and log their numbers, or for a coach running the class. [The block](/reference/blocks/programs-class-today/).

<img class="cos-screen" src="/screens/programs-class-today.png" alt="programs-class-today, drawn with dummy data" width="880" height="1230" loading="lazy" decoding="async" />

### programs-coach-client

Web. The coach's view of one client (stage 41): their sessions, newest first, each opened to see what was logged and to log on their behalf, and their progress. [The block](/reference/blocks/programs-coach-client/).

<img class="cos-screen" src="/screens/programs-coach-client.png" alt="programs-coach-client, drawn with dummy data" width="880" height="776" loading="lazy" decoding="async" />

### programs-history

Web. A person's past sessions (stage 41): newest first, each with its date, its name and how many of its sets were logged; one opened shows it set by set, read-only, with the target beside what was done, and a logged set can be corrected. [The block](/reference/blocks/programs-history/).

<img class="cos-screen" src="/screens/programs-history.png" alt="programs-history, drawn with dummy data" width="880" height="1267" loading="lazy" decoding="async" />

### programs-native-class-today

Native. A class type's sessions for a day, for the mobile app (stage 41): pick the class, open its session to choose the level taken and log (`onOpen`, the app's navigation, to the session screen). [The block](/reference/blocks/programs-native-class-today/).

<img class="cos-screen cos-screen-native" src="/screens/programs-native-class-today.png" alt="programs-native-class-today, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### programs-native-coach-client

Native. The coach's view of one client, for the staff app (stage 41): their sessions, newest first; pressing one opens it to log on their behalf (`onOpen`, to the session screen with `personId`). [The block](/reference/blocks/programs-native-coach-client/).

<img class="cos-screen cos-screen-native" src="/screens/programs-native-coach-client.png" alt="programs-native-coach-client, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### programs-native-history

Native. A person's past sessions, for the mobile app (stage 41): newest first, each with its date, its name and how many of its sets were logged; pressing one shows it set by set, read-only, and a logged set can be corrected. [The block](/reference/blocks/programs-native-history/).

<img class="cos-screen cos-screen-native" src="/screens/programs-native-history.png" alt="programs-native-history, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### programs-native-progress

Native. History and progress, for the mobile app (stage 41): sessions done per program, and per exercise the sets and bests the host worked out; pressing an exercise shows its sets. [The block](/reference/blocks/programs-native-progress/).

<img class="cos-screen cos-screen-native" src="/screens/programs-native-progress.png" alt="programs-native-progress, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### programs-native-session

Native. One session to do, for the mobile app (stage 41): the workout logger. [The block](/reference/blocks/programs-native-session/).

<img class="cos-screen cos-screen-native" src="/screens/programs-native-session.png" alt="programs-native-session, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### programs-native-today

Native. A member's day, for the mobile app (stage 41): their own sessions on a date; pressing one opens it (the app's navigation, `onOpen`). [The block](/reference/blocks/programs-native-today/).

<img class="cos-screen cos-screen-native" src="/screens/programs-native-today.png" alt="programs-native-today, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### programs-progress

Web. History and progress (stage 41): per exercise, a person's sets over time and their bests; per program, sessions done against planned. [The block](/reference/blocks/programs-progress/).

<img class="cos-screen" src="/screens/programs-progress.png" alt="programs-progress, drawn with dummy data" width="820" height="886" loading="lazy" decoding="async" />

### programs-session

Web. One session to do (stage 41): the workout logger, built on the web base layer. [The block](/reference/blocks/programs-session/).

<img class="cos-screen" src="/screens/programs-session.png" alt="programs-session, drawn with dummy data" width="820" height="1566" loading="lazy" decoding="async" />

### programs-today

Web. A member's day (stage 41): their own sessions on a date, each opened to do it. [The block](/reference/blocks/programs-today/).

<img class="cos-screen" src="/screens/programs-today.png" alt="programs-today, drawn with dummy data" width="880" height="1706" loading="lazy" decoding="async" />
