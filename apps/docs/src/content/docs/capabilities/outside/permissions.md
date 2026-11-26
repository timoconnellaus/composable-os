---
title: "Booking system copy: permissions"
sidebar:
  label: "Permissions"
  order: 2
editUrl: false
---

The permissions its operations need, and which of them only a person may call.

| Permission | Operations | A person only |
| --- | --- | --- |
| `bookingSystem:manage` | [`outside.settings.get`](/reference/operations/outside/#outsidesettingsget), [`outside.status`](/reference/operations/outside/#outsidestatus), [`outside.matches`](/reference/operations/outside/#outsidematches), [`outside.link`](/reference/operations/outside/#outsidelink), [`outside.unlink`](/reference/operations/outside/#outsideunlink), [`outside.lists.remove`](/reference/operations/outside/#outsidelistsremove), [`outside.suppression.lift`](/reference/operations/outside/#outsidesuppressionlift) | `outside.link`, `outside.unlink`, `outside.lists.remove`, `outside.suppression.lift` |
| `settings:manage` | [`outside.settings.update`](/reference/operations/outside/#outsidesettingsupdate) | `outside.settings.update` |
