---
title: "Consent to be contacted: operations"
sidebar:
  label: "Operations"
  order: 1
editUrl: false
---

The core operations that are this capability's (named `contact.`, `me.contact.`, `person.contact.`). Each links to its full reference, with its input and output.

| Operation | What it does | Audiences | Risk | Permission |
| --- | --- | --- | --- | --- |
| [`contact.stop`](/reference/operations/contact/#contactstop) | The one-tap stop in an email: turns off the one kind of message, on the one channel, that the link's token names, for the one Person it names. It can only turn something off. The answer is the same whether the token was good or not. | `customer`, `public` | `write` | `records:write` |
| [`me.contact.choices`](/reference/operations/me/#mecontactchoices) | Your contact preferences, as a signed-in customer, and those of each child you act for: each kind of message you may get, on each channel it goes by (email, text, push), with what is in force. Messages about something booked or paid for are always emailed (fixed); follow-ups and news and offers are per channel. Read-only. | `customer` | `read` | `records:read` |
| [`me.contact.setChoices`](/reference/operations/me/#mecontactsetchoices) | Changes your contact preferences, as a signed-in customer, or those of a child you act for (personId). Each choice is a kind of message, a channel and on or off (news_and_offers: yes or no, with the words you were shown). A booking's or a payment's email cannot be turned off. You may turn back on what you stopped by a link or a STOP reply. | `customer` | `write` | `records:write` |
| [`person.contact.record`](/reference/operations/person/#personcontactrecord) | Records a member's contact choice they gave by phone or on paper: a kind of message, a channel and on or off (news_and_offers: yes or no, with the words they agreed to). Says why. A person only, never an AI. It cannot turn back on what the member stopped themselves. | `staff` | `write` | `records:write` |
| [`contact.forPerson`](/reference/operations/contact/#contactforperson) | A Person's contact choices: each kind of message they may get on each channel with what is in force, and the history of every choice (when, how, by whom, why). Read-only. | `staff` | `read` | `records:read` |
