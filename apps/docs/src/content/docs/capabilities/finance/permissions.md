---
title: "Finance: permissions"
sidebar:
  label: "Permissions"
  order: 2
editUrl: false
---

The permissions its operations need, and which of them only a person may call.

| Permission | Operations | A person only |
| --- | --- | --- |
| `finance:read` | [`finance.periods`](/reference/operations/finance/#financeperiods), [`finance.report`](/reference/operations/finance/#financereport), [`finance.entries`](/reference/operations/finance/#financeentries), [`finance.export`](/reference/operations/finance/#financeexport), [`finance.settings.get`](/reference/operations/finance/#financesettingsget) | `finance.export` |
| `finance:close` | [`finance.close`](/reference/operations/finance/#financeclose), [`finance.reopen`](/reference/operations/finance/#financereopen) | `finance.close`, `finance.reopen` |
| `settings:manage` | [`finance.settings.update`](/reference/operations/finance/#financesettingsupdate) | `finance.settings.update` |
