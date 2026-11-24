---
title: "Client notes: permissions"
sidebar:
  label: "Permissions"
  order: 2
editUrl: false
---

The permissions its operations need, and which of them only a person may call.

| Permission | Operations | A person only |
| --- | --- | --- |
| `records:read` | [`note.open`](/reference/operations/note/#noteopen), [`note.kinds.list`](/reference/operations/note/#notekindslist), [`carer.list`](/reference/operations/carer/#carerlist) | `note.open` |
| `notes:manage` | [`note.kinds.save`](/reference/operations/note/#notekindssave), [`note.kinds.retire`](/reference/operations/note/#notekindsretire) | `note.kinds.retire` |
| `people:link` | [`carer.set`](/reference/operations/carer/#carerset), [`carer.end`](/reference/operations/carer/#carerend) | `carer.set`, `carer.end` |
