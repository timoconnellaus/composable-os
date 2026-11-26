---
title: "Knowledge: screens"
sidebar:
  label: "Screens"
  order: 4
editUrl: false
---

Screens a shipped pack declares are built into the admin and shown to whoever could call every tool in `opens`. Blocks are the pack's screens for client apps, copied with `cos add`.

## Staff screens

| Screen | Label | Block | Navigation | Opens | On a record |
| --- | --- | --- | --- | --- | --- |
| `procedures` | Procedures | [knowledge-procedures](/reference/blocks/knowledge-procedures/) (`Procedures`) | Knowledge, 10 | [toRead](/packs/knowledge/tools/#toread), [confirm](/packs/knowledge/tools/#confirm) |   |
| `toRead` | To read | [knowledge-to-read](/reference/blocks/knowledge-to-read/) (`ToRead`) | Knowledge, 20 | [toRead](/packs/knowledge/tools/#toread), [confirm](/packs/knowledge/tools/#confirm) |   |
| `reader` | As published | [knowledge-procedures](/reference/blocks/knowledge-procedures/) (`ProcedureScreen`) |   | [toRead](/packs/knowledge/tools/#toread), [confirm](/packs/knowledge/tools/#confirm) | `knowledge.procedure` |
| `readStatus` | Read status | [knowledge-read-status](/reference/blocks/knowledge-read-status/) (`ReadStatus`) | Knowledge, 30 | [readStatus](/packs/knowledge/tools/#readstatus) |   |

## Blocks

Each drawn with dummy data.

### knowledge-help-centre

Web. The help centre (stage 38 step 6, ADR 0708), for a business's own website: a search box with results as the visitor types, and the help topics with their pages; a topic's own page. [The block](/reference/blocks/knowledge-help-centre/).

<img class="cos-screen" src="/screens/knowledge-help-centre.png" alt="knowledge-help-centre, drawn with dummy data" width="860" height="708" loading="lazy" decoding="async" />

### knowledge-help-page

Web. One help page (stage 38 step 6, ADR 0708), for a site's /help/&lt;address&gt; page: its title, summary and body as the public reads it (`useHelpPage`: the published version only, ADR 0442), and its related pages. [The block](/reference/blocks/knowledge-help-page/).

<img class="cos-screen" src="/screens/knowledge-help-page.png" alt="knowledge-help-page, drawn with dummy data" width="860" height="557" loading="lazy" decoding="async" />

### knowledge-native-help

Native. The help centre in the app (stage 38 step 6, ADR 0708), for members: the same as the web's, over the native base. [The block](/reference/blocks/knowledge-native-help/).

<img class="cos-screen cos-screen-native" src="/screens/knowledge-native-help.png" alt="knowledge-native-help, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### knowledge-native-procedures

Native. Procedures in the app, for staff (stage 38 step 6, ADR 0708): the same as the web's, over the native base. [The block](/reference/blocks/knowledge-native-procedures/).

<img class="cos-screen cos-screen-native" src="/screens/knowledge-native-procedures.png" alt="knowledge-native-procedures, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### knowledge-native-to-read

Native. To read in the app (stage 38 step 6, ADR 0708): the same as the web's, over the native base. [The block](/reference/blocks/knowledge-native-to-read/).

<img class="cos-screen cos-screen-native" src="/screens/knowledge-native-to-read.png" alt="knowledge-native-to-read, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### knowledge-procedures

Web. Procedures for staff (stage 38 step 6, ADR 0708): every published procedure, by section, with search, and the reader: one procedure in the wording last published ("Version 4, published 3 March 2026"), never the draft, with "I have read and understood this" at its end when it is the reader's to confirm. [The block](/reference/blocks/knowledge-procedures/).

<img class="cos-screen" src="/screens/knowledge-procedures.png" alt="knowledge-procedures, drawn with dummy data" width="860" height="718" loading="lazy" decoding="async" />

### knowledge-read-status

Web. Read status (stage 38 step 6, ADR 0708): for those who manage procedures, every published procedure staff must read with how many have confirmed its current version of how many must, and for one, everyone who must read it: who confirmed and when, who has not and since when; with an export as CSV. [The block](/reference/blocks/knowledge-read-status/).

<img class="cos-screen" src="/screens/knowledge-read-status.png" alt="knowledge-read-status, drawn with dummy data" width="760" height="505" loading="lazy" decoding="async" />

### knowledge-to-read

Web. To read (stage 38 step 6, ADR 0708): the procedures I must read and have not confirmed, oldest first, each with the version to read and since when, and what I have confirmed and when. [The block](/reference/blocks/knowledge-to-read/).

<img class="cos-screen" src="/screens/knowledge-to-read.png" alt="knowledge-to-read, drawn with dummy data" width="760" height="440" loading="lazy" decoding="async" />
