-- Registry migration 0791: which of a client's hostnames is its address on each surface (stage 66
-- step 6, ADR 0616).
--
-- A client's addresses (the staff address its sign-in, links and MCP resource name, the web
-- address its customer sign-in names, the desk hostname) come from its verified hostnames, never
-- from a request's Host header. A client may have more than one verified hostname on a surface
-- (its hostname on the fleet's domain and its own domain, while it moves), so one of them is
-- marked as the surface's address. With none marked, a surface with exactly one verified hostname
-- has that one as its address; with several and none marked, the surface has no address and the
-- registry reports it (`RegistrySnapshot.problems`). Only a verified hostname may be marked (the
-- column's check: unmark a hostname before unverifying it), and the code reads only verified ones.
--
-- The operator sets it (`cos`, stage 66 step 7); the version stamp moves with it through the
-- table's existing update trigger.

ALTER TABLE registry_hostnames
  ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0
    CHECK (is_primary IN (0, 1) AND (is_primary = 0 OR verified = 1));

-- At most one marked hostname per client and surface.
CREATE UNIQUE INDEX registry_hostnames_primary
  ON registry_hostnames (client, surface) WHERE is_primary = 1;
