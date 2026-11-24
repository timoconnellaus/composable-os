// Field registry for Location (stage 64, ADR 0910): one place the business works from, inside the
// one organisation. A base record in core with its own location.* operations, because Bookings,
// Rostering and Memberships relate to it whether or not the others are installed.
//
// The public reads a location's name, short name, address and zone, only while it is shown to the
// public and open (ADR 0916): `listed`, the view's own column, is that condition, so the seam's one
// `when` holds both. Its price, notes and state are staff only.
import { defineObject } from "./types.ts";

export const LOCATION_STATES = ["open", "closed"] as const;
export type LocationState = (typeof LOCATION_STATES)[number];

/** The main location's name on a host whose organisation has no name yet (migration 1390). */
export const MAIN_LOCATION_FALLBACK = "Main location";

/** The main location's id (migration 1390): a ULID of time zero, so it sorts first. */
export const MAIN_LOCATION_ID = "loc_00000000000000000000000001";

export const locationObject = defineObject({
  name: "location",
  label: "Location",
  plural: "Locations",
  source: "rec_location",
  titleField: "name",
  defaultSort: { field: "name", direction: "asc" },
  public: {
    read: ["name", "shortName", "address", "timezone"],
    when: { field: "listed", in: ["yes"] },
  },
  fields: [
    { name: "id", label: "ID", type: "id", column: "id", filterable: true, sortable: true },
    {
      name: "name",
      label: "Name",
      type: "text",
      column: "name",
      filterable: true,
      sortable: true,
      required: true,
    },
    {
      name: "shortName",
      label: "Short name",
      type: "text",
      column: "short_name",
      filterable: true,
      sortable: true,
    },
    {
      name: "address",
      label: "Address",
      type: "text",
      column: "address",
      filterable: true,
      sortable: false,
    },
    {
      name: "timezone",
      label: "Time zone",
      type: "text",
      column: "timezone",
      filterable: true,
      sortable: true,
      required: true,
    },
    {
      name: "public",
      label: "Shown to the public",
      type: "boolean",
      column: "public",
      filterable: true,
      sortable: true,
    },
    {
      name: "dropInPrice",
      label: "Drop-in price",
      type: "number",
      column: "drop_in_price",
      filterable: true,
      sortable: true,
    },
    {
      name: "state",
      label: "State",
      type: "enum",
      enumValues: LOCATION_STATES,
      column: "state",
      filterable: true,
      sortable: true,
    },
    {
      name: "notes",
      label: "Notes",
      type: "text",
      column: "notes",
      filterable: true,
      sortable: false,
    },
    {
      name: "main",
      label: "Main location",
      type: "boolean",
      column: "main",
      filterable: true,
      sortable: true,
      readOnly: true,
    },
    {
      // Shown to the public and open: the condition of the public declaration (ADR 0916).
      name: "listed",
      label: "Listed",
      type: "enum",
      enumValues: ["yes", "no"],
      fieldType: "select",
      options: {
        choices: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      },
      column: "listed",
      filterable: true,
      sortable: false,
      readOnly: true,
    },
    {
      name: "createdAt",
      label: "Created",
      type: "datetime",
      column: "created_at",
      filterable: true,
      sortable: true,
    },
    {
      name: "updatedAt",
      label: "Updated",
      type: "datetime",
      column: "updated_at",
      filterable: true,
      sortable: true,
    },
  ],
});
