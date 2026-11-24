---
title: "Forms: settings"
sidebar:
  label: "Settings"
  order: 6
editUrl: false
---

Settings are typed, edited in Settings → Extensions. A setting that is a person's to change waits for a person when anyone else changes it.

| Setting | Type | Label | Default | Limits | Description |
| --- | --- | --- | --- | --- | --- |
| `hourlyCap` | `number` | Answers an hour, at most | `200` | min 1; max 10000; a person's to change | Across every form. Over it, new answers are turned away for the hour and the admins are told. Raise it for a busy day. |
