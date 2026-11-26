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
| `records:read` | [`note.open`](/reference/operations/note/#noteopen), [`note.kinds.list`](/reference/operations/note/#notekindslist), [`file.serve`](/reference/operations/file/#fileserve), [`carer.list`](/reference/operations/carer/#carerlist) | `note.open`, `file.serve` |
| `notes:manage` | [`note.kinds.save`](/reference/operations/note/#notekindssave), [`note.kinds.retire`](/reference/operations/note/#notekindsretire), [`file.storage.get`](/reference/operations/file/#filestorageget) | `note.kinds.retire`, `file.storage.get` |
| `records:write` | [`file.checkUpload`](/reference/operations/file/#filecheckupload), [`file.upload`](/reference/operations/file/#fileupload), [`file.delete`](/reference/operations/file/#filedelete) | `file.checkUpload`, `file.upload`, `file.delete` |
| `settings:manage` | [`file.storage.setCap`](/reference/operations/file/#filestoragesetcap) | `file.storage.setCap` |
| `people:link` | [`carer.set`](/reference/operations/carer/#carerset), [`carer.end`](/reference/operations/carer/#carerend) | `carer.set`, `carer.end` |
