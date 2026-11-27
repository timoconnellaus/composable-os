-- Migration 1505: a refresh whose answer was lost (ADR 0419, amended 2026-11-27; issue #540).
--
-- When a device refreshes, the host rotates its tokens. If the answer never reaches the device (the
-- app killed mid-request, the network lost), the device still holds the token it sent, and its next
-- refresh used to count as reuse and end the session. For a short time after a rotation
-- (`REFRESH_GRACE_MS`, 60 seconds) the token just rotated past is answered again with the same
-- tokens it was answered with, never a second rotation; after that, and for any older token, reuse
-- ends the session as before.
--
-- The tokens themselves are still never stored as given. `successor_sealed` is the answer
-- encrypted (AES-GCM) under a key derived (HKDF-SHA256) from the previous refresh token, which is
-- stored only as its hash: only someone presenting that token can open it, and a copy of the
-- database cannot. It is cleared by the next rotation and goes with the row when the session ends.
ALTER TABLE core_device_session ADD COLUMN previous_refresh_hash TEXT;
ALTER TABLE core_device_session ADD COLUMN previous_rotated_at TEXT;
ALTER TABLE core_device_session ADD COLUMN successor_sealed TEXT;
