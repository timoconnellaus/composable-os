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

Each drawn with dummy data.

### content-native-post

Native. One post, for the mobile app (stage 28): its title, date, cover and body as the public reads it (`usePost`: the published version only). [The block](/reference/blocks/content-native-post/).

<img class="cos-screen cos-screen-native" src="/screens/content-native-post.png" alt="content-native-post, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### content-native-rich-text

Native. Rich text for the mobile app (stage 28, ADR 0440): a post's body drawn block by block with React Native's own components, from the same structured data the web block draws. [The block](/reference/blocks/content-native-rich-text/).

<img class="cos-screen cos-screen-native" src="/screens/content-native-rich-text.png" alt="content-native-rich-text, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### content-post

Web. One post, for a site's /blog/&lt;slug&gt; page (stage 28): its title, date, cover and body, as the public reads it (`usePost`: the published version only, ADR 0442). [The block](/reference/blocks/content-post/).

<img class="cos-screen" src="/screens/content-post.png" alt="content-post, drawn with dummy data" width="860" height="1417" loading="lazy" decoding="async" />

### content-post-list

Web. The published posts, newest first, for a site's /blog page (stage 28): each with its cover, title, date and excerpt, and a link to it. [The block](/reference/blocks/content-post-list/).

<img class="cos-screen" src="/screens/content-post-list.png" alt="content-post-list, drawn with dummy data" width="640" height="1871" loading="lazy" decoding="async" />

### content-rich-text

Web. Rich text for the web (stage 28, ADR 0440): a post's body drawn block by block with React elements, never as HTML. [The block](/reference/blocks/content-rich-text/).

<img class="cos-screen" src="/screens/content-rich-text.png" alt="content-rich-text, drawn with dummy data" width="760" height="943" loading="lazy" decoding="async" />
