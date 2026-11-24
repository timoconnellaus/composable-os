---
title: "Memberships: messages"
sidebar:
  label: "Messages"
  order: 5
editUrl: false
---

Routine mail is email about this pack's records that the host sends without a person's approval; an admin can turn each kind off.

## Routine message kinds

This pack sends no routine mail.

## Journey signals

| Signal | Label | Object | State |
| --- | --- | --- | --- |
| `started` | Membership started | `membership` |   |
| `joined` | Joined after a trial | `membership` |   |
| `ended` | Membership ended | `membership` |   |
| `trialEnded` | Trial ended without joining | `membership` |   |
| `passStarted` | Pass started | `pass` |   |
