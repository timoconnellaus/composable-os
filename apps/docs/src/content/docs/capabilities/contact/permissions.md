---
title: "Consent to be contacted: permissions"
sidebar:
  label: "Permissions"
  order: 2
editUrl: false
---

The permissions its operations need, and which of them only a person may call.

| Permission | Operations | A person only |
| --- | --- | --- |
| `records:write` | [`contact.stop`](/reference/operations/contact/#contactstop), [`me.contact.setChoices`](/reference/operations/me/#mecontactsetchoices), [`person.contact.record`](/reference/operations/person/#personcontactrecord) | `person.contact.record` |
| `records:read` | [`me.contact.choices`](/reference/operations/me/#mecontactchoices), [`contact.forPerson`](/reference/operations/contact/#contactforperson) | `contact.forPerson` |
