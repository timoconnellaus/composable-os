---
title: "Content: screens"
sidebar:
  label: "Screens"
  order: 4
editUrl: false
---

Screens a shipped pack declares are built into the admin and shown to whoever could call every tool in `opens`. Blocks are the pack's screens for client apps, copied with `cos add`.

## Staff screens

This pack declares no staff screens.

## Blocks

| Block | Skin | What it shows |
| --- | --- | --- |
| [content-native-post](/reference/blocks/content-native-post/) | native | One post, for the mobile app (stage 28): its title, date, cover and body as the public reads it (`usePost`: the published version only). |
| [content-native-rich-text](/reference/blocks/content-native-rich-text/) | native | Rich text for the mobile app (stage 28, ADR 0440): a post's body drawn block by block with React Native's own components, from the same structured data the web block draws. |
| [content-post](/reference/blocks/content-post/) | web | One post, for a site's /blog/&lt;slug&gt; page (stage 28): its title, date, cover and body, as the public reads it (`usePost`: the published version only, ADR 0442). |
| [content-post-list](/reference/blocks/content-post-list/) | web | The published posts, newest first, for a site's /blog page (stage 28): each with its cover, title, date and excerpt, and a link to it. |
| [content-rich-text](/reference/blocks/content-rich-text/) | web | Rich text for the web (stage 28, ADR 0440): a post's body drawn block by block with React elements, never as HTML. |
