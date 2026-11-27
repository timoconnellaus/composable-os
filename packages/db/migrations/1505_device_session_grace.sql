-- Migration 1505: a refresh whose answer was lost (ADR 0419, amended 2026-11-27; issue #540).
--
-- When a device refreshes, the host rotates its tokens. If the answer never reaches the device
-- (the network lost, a request given up), the device still holds the token it sent, and its next
-- refresh counts as reuse and ends the session. Now that token may be answered again with the
-- same tokens, once in a session's life, only within `REFRESH_GRACE_MS` (60 seconds) of the
-- rotation and only while the answer is unused: the first use of its access token, or of its
-- refresh token, clears it. Every such answer is audited (`deviceSession.refreshReplayed`). Any
-- other presentation of a token rotated past ends the session as before.
--
-- The tokens are never stored as given. `successor_sealed` is the answer encrypted (AES-GCM, bound
-- to the session and the previous token's hash) under a key derived (HKDF-SHA256) from the
-- previous refresh token, which is stored only as its hash. A copy of the database alone opens
-- nothing. A copy of the database together with the previous refresh token could open it, until
-- it is cleared: at the answer's first use, at a grace answer, by the next rotation, and by the
-- daily maintenance run once the window has passed. `grace_answered_at` says the session has had
-- its one answer again.
ALTER TABLE core_device_session ADD COLUMN previous_refresh_hash TEXT;
ALTER TABLE core_device_session ADD COLUMN previous_rotated_at TEXT;
ALTER TABLE core_device_session ADD COLUMN successor_sealed TEXT;
ALTER TABLE core_device_session ADD COLUMN grace_answered_at TEXT;
