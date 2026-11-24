---
title: "voice.* operations"
description: "The core operations named voice.*"
sidebar:
  label: "voice"
editUrl: false
---

## voice.prefs.get

Your voice settings: whether voice is on for this deployment, the voice and speed you chose, how this device talks, your devices, and the voices on offer. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `deviceId` | string |   | pattern `^[0-9A-Za-z_-]{8,64}$` | This browser's device id, kept in its local storage |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `available` | boolean | yes |   |   |
| `configured` | boolean | yes |   |   |
| `voiceId` | string or null | yes |   |   |
| `speed` | number | yes |   |   |
| `mode` | `"push_to_talk"`, `"hands_free"` | yes |   |   |
| `defaultMode` | `"push_to_talk"`, `"hands_free"` | yes |   |   |
| `readOut` | `"short"`, `"full"` | yes |   |   |
| `supportsSpeed` | boolean | yes |   |   |
| `voices` | array of object | yes |   |   |
| `voices[].id` | string | yes |   |   |
| `voices[].name` | string | yes |   |   |
| `voices[].description` | string | yes |   |   |
| `devices` | array of object | yes |   |   |
| `devices[].id` | string | yes |   |   |
| `devices[].label` | string | yes |   |   |
| `devices[].mode` | `"push_to_talk"`, `"hands_free"` | yes |   |   |
| `devices[].thisDevice` | boolean | yes |   |   |
| `devices[].lastSeenAt` | string | yes |   |   |

## voice.prefs.update

Changes your voice settings. The first call is first setup: it needs a voice and a mode, and that mode becomes the default for all your devices. After that, a mode applies to this device only. Also records this device in your device list; `forgetDeviceId` removes one.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `deviceId` | string | yes | pattern `^[0-9A-Za-z_-]{8,64}$` | This browser's device id, kept in its local storage |
| `deviceLabel` | string | yes | min length 1, max length 100 |   |
| `voiceId` | string |   | min length 1, max length 100 |   |
| `speed` | number |   | ≥ 0.5, ≤ 2 |   |
| `mode` | `"push_to_talk"`, `"hands_free"` |   |   |   |
| `readOut` | `"short"`, `"full"` |   |   |   |
| `forgetDeviceId` | string |   | pattern `^[0-9A-Za-z_-]{8,64}$` | This browser's device id, kept in its local storage |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `updated` | `true` | yes |   |   |

## voice.preview

A short spoken sample of a voice, for the voice picker. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `voiceId` | string | yes | min length 1, max length 100 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `audio` | string | yes |   | A WAV file, base64 |
