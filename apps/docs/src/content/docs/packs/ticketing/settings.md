---
title: "Ticketing: settings"
sidebar:
  label: "Settings"
  order: 6
editUrl: false
---

Settings are typed, edited in Settings → Extensions. A setting that is a person's to change waits for a person when anyone else changes it.

| Setting | Type | Label | Default | Limits | Description |
| --- | --- | --- | --- | --- | --- |
| `ticketsUrl` | `text` | Where buyers see their tickets |   | a person's to change | The page on your site or app where a signed-in buyer sees their tickets. Linked from the tickets email, with ?order=&lt;id&gt;, when it is on your site (Settings → Routine email). |
| `payUrl` | `text` | Where buyers pay a balance |   | a person's to change | The page where a signed-in buyer pays what is owed on an order. Linked from the balance reminders, with ?order=&lt;id&gt;, when it is on your site (Settings → Routine email). |
