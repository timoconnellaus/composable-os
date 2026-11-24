-- Migration 1091: claim margins on the time claim (stage 49 step 1, ADR 0760).
--
-- A staffed object may declare minutes kept free before and after a shift (`staffed.claimBefore`,
-- `claimAfter`, read from its kind: a service's buffer). They enter the claim: `starts` and `ends`
-- here are the shift's own time widened by them, so the overlap checks of migration 0811 refuse a
-- shift inside another's buffer, unchanged. The two columns keep how much each claim was widened
-- by, in seconds, so a reader that wants the shift's own time (the feed, a leaver's future shifts,
-- whether someone is away over it) has it without reading the kind again. Zero for every claim
-- without margins (every claim made before this migration). Written only by the triggers the
-- schema reconciler builds; no x_* table is touched.
ALTER TABLE core_staff_time ADD COLUMN margin_before INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core_staff_time ADD COLUMN margin_after INTEGER NOT NULL DEFAULT 0;
