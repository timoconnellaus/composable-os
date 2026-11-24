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

| Block | Skin | What it shows |
| --- | --- | --- |
| [programs-bank](/reference/blocks/programs-bank/) | web | The exercise bank (stage 41): browse and search the gym's exercises, add one, and edit one with its easier and harder versions. |
| [programs-builder](/reference/blocks/programs-builder/) | web | The coach's program builder (stage 41): weeks, sessions, blocks and items, by drag and by keyboard; exercises picked from the bank; typed sets; levels; notes, for coaches or shown to members; copying a week or a session; the working copy saved as the coach goes, with the host's faults shown where they are; versions, restoring one, publishing, and assigning. |
| [programs-class-today](/reference/blocks/programs-class-today/) | web | A class type's session for a day (stage 41): its plan with every level, for a member to choose the level they take and log their numbers, or for a coach running the class. |
| [programs-coach-client](/reference/blocks/programs-coach-client/) | web | The coach's view of one client (stage 41): their sessions, newest first, each opened to see what was logged and to log on their behalf, and their progress. |
| [programs-history](/reference/blocks/programs-history/) | web | A person's past sessions (stage 41): newest first, each with its date, its name and how many of its sets were logged; one opened shows it set by set, read-only, with the target beside what was done, and a logged set can be corrected. |
| [programs-native-class-today](/reference/blocks/programs-native-class-today/) | native | A class type's sessions for a day, for the mobile app (stage 41): pick the class, open its session to choose the level taken and log (`onOpen`, the app's navigation, to the session screen). |
| [programs-native-coach-client](/reference/blocks/programs-native-coach-client/) | native | The coach's view of one client, for the staff app (stage 41): their sessions, newest first; pressing one opens it to log on their behalf (`onOpen`, to the session screen with `personId`). |
| [programs-native-history](/reference/blocks/programs-native-history/) | native | A person's past sessions, for the mobile app (stage 41): newest first, each with its date, its name and how many of its sets were logged; pressing one shows it set by set, read-only, and a logged set can be corrected. |
| [programs-native-progress](/reference/blocks/programs-native-progress/) | native | History and progress, for the mobile app (stage 41): sessions done per program, and per exercise the sets and bests the host worked out; pressing an exercise shows its sets. |
| [programs-native-session](/reference/blocks/programs-native-session/) | native | One session to do, for the mobile app (stage 41): the workout logger. |
| [programs-native-today](/reference/blocks/programs-native-today/) | native | A member's day, for the mobile app (stage 41): their own sessions on a date; pressing one opens it (the app's navigation, `onOpen`). |
| [programs-progress](/reference/blocks/programs-progress/) | web | History and progress (stage 41): per exercise, a person's sets over time and their bests; per program, sessions done against planned. |
| [programs-session](/reference/blocks/programs-session/) | web | One session to do (stage 41): the workout logger, built on the web base layer. |
| [programs-today](/reference/blocks/programs-today/) | web | A member's day (stage 41): their own sessions on a date, each opened to do it. |
