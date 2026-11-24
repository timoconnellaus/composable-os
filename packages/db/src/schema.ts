// Typed access to core tables. Keep in step with ../migrations: a migration that changes a core
// table updates the matching interface here in the same commit.
import type { ColumnType, Generated } from "kysely";

/** SQLite stores dates as ISO-8601 text; Better Auth writes them, we read them back as strings. */
type DateColumn = ColumnType<string, string | Date, string | Date>;
/** SQLite has no boolean type: 0 or 1. */
type BoolColumn = ColumnType<number, number | boolean, number | boolean>;

export interface CoreMetaTable {
  key: string;
  value: string;
}

export interface CoreMigrationsTable {
  id: Generated<number>;
  name: string;
  applied_at: Generated<string>;
}

export interface CoreUserTable {
  id: string;
  name: string;
  email: string;
  email_verified: BoolColumn;
  image: string | null;
  created_at: DateColumn;
  updated_at: DateColumn;
  /** CRM role (migration 0002). Defaults to member; the first user becomes admin. */
  role: ColumnType<UserRole, UserRole | undefined, UserRole>;
  /** `extension` rows are extension principals (migration 0020); they never sign in. */
  kind: ColumnType<UserKind, UserKind | undefined, UserKind>;
  /** Migration 0170: a deactivated person cannot sign in or act. */
  deactivated_at: ColumnType<string | null, string | null | undefined, string | null>;
  /** Migration 0221 (ADR 0212): set on a support user, the grant it was created for. */
  support_grant_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Migration 0451 (ADR 0436): a pack's fixed staff role (`ticketing.door`). While set, the
   * account may do only what the role lists.
   */
  pack_role: ColumnType<string | null, string | null | undefined, string | null>;
  /** JSON list of permissions a human admin granted (migration 0471, ADR 0449). */
  granted_permissions: ColumnType<string | null, string | null | undefined, string | null>;
}

export type UserKind = "human" | "extension";

export interface CoreSessionTable {
  id: string;
  user_id: string;
  token: string;
  expires_at: DateColumn;
  ip_address: string | null;
  user_agent: string | null;
  created_at: DateColumn;
  updated_at: DateColumn;
}

export interface CoreAccountTable {
  id: string;
  user_id: string;
  account_id: string;
  provider_id: string;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
  access_token_expires_at: DateColumn | null;
  refresh_token_expires_at: DateColumn | null;
  scope: string | null;
  password: string | null;
  created_at: DateColumn;
  updated_at: DateColumn;
}

export interface CoreVerificationTable {
  id: string;
  identifier: string;
  value: string;
  expires_at: DateColumn;
  created_at: DateColumn;
  updated_at: DateColumn;
}

// --- Stage 1 (migrations 0002-0007) ------------------------------------------------------------

export type UserRole = "admin" | "member" | "viewer";
export type ActivityType = "note" | "email" | "call" | "meeting" | "system";
export type ActivityAuthorActor = "human" | "assistant" | "mcp" | "automation" | "system";
export type TaskStatus = "open" | "done";
/** Who a staff-side call is made by: the actors the approval policy and the queue know. */
export type StaffActor = "human" | "assistant" | "mcp" | "automation" | "extension";
/** Every actor the audit log records: staff-side actors, customers and the public (migration 0400). */
export type AuditActor = StaffActor | "customer" | "public";
export type AuditRisk =
  | "read"
  | "write"
  | "bulk-write"
  | "destructive"
  | "schema"
  | "extension"
  | "outbound";
export type AuditGateDecision = "auto" | "review" | "deny";
export type AuditOutcome = "ok" | "forbidden" | "denied" | "review" | "error";
export type AuditChangeAction = "create" | "update" | "delete" | "restore" | "erase" | "merge";

/** ISO-8601 UTC timestamp text written by the operation layer. */
type Timestamp = string;
/** A JSON document stored as text. */
type JsonText = string;
/** A column with a database default (or nullable): optional on insert. */
type Defaulted<T> = ColumnType<T, T | undefined, T>;

export interface CoreSettingsTable {
  key: string;
  value: JsonText;
  updated_at: Timestamp;
  updated_by: string | null;
}

/** Columns every soft-deletable core record shares. */
interface RecordColumns {
  id: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: Defaulted<Timestamp | null>;
  deleted_by: Defaulted<string | null>;
}

export interface CorePersonTable extends RecordColumns {
  given_name: Defaulted<string | null>;
  family_name: Defaulted<string | null>;
  display_name: string;
  location: Defaulted<string | null>;
  timezone: Defaulted<string | null>;
  /** JSON array of `{ network, url, handle? }`. */
  social_profiles: Defaulted<JsonText>;
  avatar_key: Defaulted<string | null>;
  owner_id: Defaulted<string | null>;
  description: Defaulted<string | null>;
  created_by: Defaulted<string | null>;
  merged_into_id: Defaulted<string | null>;
  /**
   * Normalised display name for duplicate rules (stage 16, ADR 0247). Required on insert, so every
   * writer sets it; null for a name that has nothing to compare (an email standing in for one).
   */
  name_key: ColumnType<string | null, string | null, string | null>;
  /**
   * Migration 1171 (stage 53, ADR 0803): a birthday, day and month only (no year): both null or
   * both set, a day the month has. Set by `person.setBirthday` and `me.birthday.set` only.
   */
  birth_day: Defaulted<number | null>;
  birth_month: Defaulted<number | null>;
}

export interface CorePersonEmailsTable {
  id: string;
  person_id: string;
  email: string;
  label: Defaulted<string | null>;
  is_primary: Defaulted<number>;
  position: Defaulted<number>;
  /** Maintained by triggers from the person's deleted_at; never written by operations. */
  live: Defaulted<number>;
  created_at: Timestamp;
}

export interface CorePersonPhonesTable {
  id: string;
  person_id: string;
  number: string;
  number_normalised: string;
  label: Defaulted<string | null>;
  is_primary: Defaulted<number>;
  position: Defaulted<number>;
  created_at: Timestamp;
}

export interface CoreOrganisationTable extends RecordColumns {
  name: string;
  website: Defaulted<string | null>;
  industry: Defaulted<string | null>;
  parent_id: Defaulted<string | null>;
  avatar_key: Defaulted<string | null>;
  owner_id: Defaulted<string | null>;
  description: Defaulted<string | null>;
  created_by: Defaulted<string | null>;
  merged_into_id: Defaulted<string | null>;
  /** Normalised name for duplicate rules (stage 16, ADR 0247). Required on insert. */
  name_key: ColumnType<string | null, string | null, string | null>;
}

/** A likely duplicate pair found by the scan (stage 16, ADR 0247). a_id < b_id. */
export interface CoreDuplicatePairTable {
  object: "person" | "organisation";
  a_id: string;
  b_id: string;
  /** JSON array of rule ids. */
  rules: JsonText;
  /** JSON object: what each rule matched (organisation, domain, number). */
  details: Defaulted<JsonText>;
  status: Defaulted<"open" | "dismissed" | "merged">;
  created_at: Timestamp;
  updated_at: Timestamp;
  decided_at: Defaulted<Timestamp | null>;
  decided_by: Defaulted<string | null>;
}

export interface CoreOrganisationDomainsTable {
  id: string;
  organisation_id: string;
  domain: string;
  is_primary: Defaulted<number>;
  position: Defaulted<number>;
  /** Maintained by triggers from the organisation's deleted_at; never written by operations. */
  live: Defaulted<number>;
  created_at: Timestamp;
}

export interface CoreOrganisationAddressesTable {
  id: string;
  organisation_id: string;
  label: Defaulted<string | null>;
  line1: Defaulted<string | null>;
  line2: Defaulted<string | null>;
  city: Defaulted<string | null>;
  region: Defaulted<string | null>;
  postal_code: Defaulted<string | null>;
  country: Defaulted<string | null>;
  is_primary: Defaulted<number>;
  position: Defaulted<number>;
  created_at: Timestamp;
}

export interface CoreAffiliationTable extends RecordColumns {
  person_id: string;
  organisation_id: string;
  title: Defaulted<string | null>;
  role: Defaulted<string | null>;
  started_on: Defaulted<string | null>;
  ended_on: Defaulted<string | null>;
  is_current: Defaulted<number>;
  is_primary: Defaulted<number>;
  created_by: Defaulted<string | null>;
}

export interface CoreTagsTable {
  id: string;
  name: string;
  color: Defaulted<string | null>;
  created_at: Timestamp;
  created_by: Defaulted<string | null>;
}

export interface CoreRecordTagsTable {
  tag_id: string;
  object_type: string;
  record_id: string;
  created_at: Timestamp;
}

export interface CoreActivityTable extends RecordColumns {
  type: ActivityType;
  subject: Defaulted<string | null>;
  body: Defaulted<string | null>;
  payload: Defaulted<JsonText>;
  occurred_at: Timestamp;
  author_user_id: Defaulted<string | null>;
  author_actor: Defaulted<ActivityAuthorActor>;
  /** Migration 0111: 'email:<Message-ID>' or 'ical:<UID>' for synced activities (unique). */
  external_key: Defaulted<string | null>;
  /** Migration 0111: 'thread:<root Message-ID>' for synced email. */
  thread_key: Defaulted<string | null>;
  /** Migration 0111: set when marked private; only this user sees it. */
  private_to: Defaulted<string | null>;
  /** Migration 0111: R2 key of the full email body. */
  body_ref: Defaulted<string | null>;
  /** Migration 0111: what a synced activity discloses. */
  disclosure: Defaulted<"full" | "metadata" | null>;
  /** Migration 1230 (stage 56, ADR 0830): who may read a note. Only a note is not `staff`. */
  level: Defaulted<NoteLevel>;
  /** Migration 1230: the note's kind (core_note_kind, stage 56 step 2). */
  kind_id: Defaulted<string | null>;
  /** Migration 1230: when and by whom the note was shared with its client (stage 56 step 5). */
  shared_at: Defaulted<string | null>;
  shared_by: Defaulted<string | null>;
  /** Migration 1230: the customer account (cus_…) that sent it (stage 56 step 6). */
  from_customer: Defaulted<string | null>;
  /** Migration 1230: copied from its kind at write; never changed (stage 56 step 7). */
  evidence: Defaulted<0 | 1>;
  /** Migration 1230: the kind's template sections as filled in, JSON (stage 56 step 2). */
  sections: Defaulted<JsonText | null>;
}

/** Migration 1230 (stage 56, ADR 0830): who may read a note. */
export type NoteLevel = "staff" | "coaches" | "sensitive";

export interface CoreActivityLinksTable {
  activity_id: string;
  object_type: string;
  record_id: string;
}

export interface CoreTaskTable extends RecordColumns {
  title: string;
  notes: Defaulted<string | null>;
  due_at: Defaulted<string | null>;
  status: Defaulted<TaskStatus>;
  completed_at: Defaulted<Timestamp | null>;
  completed_by: Defaulted<string | null>;
  assignee_id: Defaulted<string | null>;
  created_by: Defaulted<string | null>;
}

export interface CoreTaskLinksTable {
  task_id: string;
  object_type: string;
  record_id: string;
}

export interface CoreViewsTable {
  id: string;
  user_id: string;
  object: string;
  name: string;
  /** JSON `{ type: "table", object, filter, sort, columns }`. */
  spec: JsonText;
  position: Defaulted<number>;
  /** 1: shared with the org (members view it; admins and the owner edit it). */
  shared: Defaulted<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Dashboards (migration 0080, ADR 0056): a dashboard spec owned by a user, optionally shared. */
export interface CoreDashboardsTable {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  shared: Defaulted<number>;
  /** JSON dashboard spec: filters, widgets and their layout. */
  spec: JsonText;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Each user's Home dashboard (migration 0080). No row: the shipped Overview. */
export interface CoreUserHomeTable {
  user_id: string;
  dashboard_id: string;
  updated_at: Timestamp;
}

/** Typed extension settings (migration 0080, ADR 0058). */
export interface CoreExtensionSettingsTable {
  extension_id: string;
  value: JsonText;
  updated_at: Timestamp;
  updated_by: string | null;
}

export interface CoreAuditTable {
  id: string;
  at: Timestamp;
  operation: string;
  risk: AuditRisk;
  actor: AuditActor;
  user_id: string | null;
  origin: JsonText;
  input: JsonText;
  result: JsonText | null;
  gate_decision: AuditGateDecision;
  outcome: AuditOutcome;
  error: JsonText | null;
  /** The pending action this row queued (outcome review) or applied (migration 0010). */
  pending_action_id: Defaulted<string | null>;
}

export interface CoreAuditChangesTable {
  id: Generated<number>;
  audit_id: string;
  object_type: string;
  record_id: string;
  action: AuditChangeAction;
  /** JSON `{ "<field>": { before, after } }`. */
  diff: JsonText;
  at: Timestamp;
}

/**
 * A sanctioned redaction of one audit row or field-change row (migration 0008, ADR 0019).
 * Append-only. Inserting one applies the canonical "[erased]" redaction to its target by trigger.
 */
export interface CoreAuditRedactionsTable {
  id: Generated<number>;
  audit_id: string | null;
  change_id: number | null;
  object_type: string;
  record_id: string;
  operation: string;
  user_id: string | null;
  at: Timestamp;
}

export interface CoreSearchDocsTable {
  id: Generated<number>;
  object_type: string;
  record_id: string;
  title: string;
  body: string;
}

/** The FTS5 index over core_search_docs. Query with `MATCH`; join back on `rowid = docs.id`. */
export interface CoreSearchTable {
  rowid: number;
  title: string;
  body: string;
  rank: number;
}

// --- rec_* read views (migration 0007). Read-only: never write to these. ----------------------

export interface CrmUsersView {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  pack_role: string | null;
  granted_permissions: string | null;
  image: string | null;
  created_at: string;
}

export interface CrmPeopleView {
  id: string;
  display_name: string;
  given_name: string | null;
  family_name: string | null;
  primary_email: string | null;
  /** JSON array of strings. */
  emails: JsonText;
  primary_phone: string | null;
  primary_affiliation_id: string | null;
  job_title: string | null;
  organisation_id: string | null;
  organisation_name: string | null;
  location: string | null;
  timezone: string | null;
  owner_id: string | null;
  avatar_key: string | null;
  /** JSON array of tag names. */
  tags: JsonText;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CrmOrganisationsView {
  id: string;
  name: string;
  primary_domain: string | null;
  /** JSON array of strings. */
  domains: JsonText;
  website: string | null;
  industry: string | null;
  parent_id: string | null;
  parent_name: string | null;
  owner_id: string | null;
  avatar_key: string | null;
  current_people_count: number;
  /** JSON array of tag names. */
  tags: JsonText;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CrmAffiliationsView {
  id: string;
  person_id: string;
  organisation_id: string;
  title: string | null;
  role: string | null;
  started_on: string | null;
  ended_on: string | null;
  is_current: number;
  is_primary: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CrmActivitiesView {
  id: string;
  type: ActivityType;
  subject: string | null;
  body: string | null;
  payload: JsonText;
  occurred_at: Timestamp;
  author_user_id: string | null;
  author_actor: ActivityAuthorActor;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CrmActivityLinksView {
  activity_id: string;
  object_type: string;
  record_id: string;
}

export interface CrmTasksView {
  id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  status: TaskStatus;
  completed_at: Timestamp | null;
  assignee_id: string | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CrmTaskLinksView {
  task_id: string;
  object_type: string;
  record_id: string;
}

export interface CrmRecordTagsView {
  object_type: string;
  record_id: string;
  tag_id: string;
  tag: string;
}

export type ExtensionSource = "shipped" | "runtime";
export type ExtensionStatus = "active" | "disabled" | "quarantined";

/** Installed extensions (migration 0020). */
export interface CoreExtensionsTable {
  id: string;
  source: ExtensionSource;
  status: ExtensionStatus;
  status_reason: string | null;
  version: string;
  commit_oid: string;
  last_good_commit: string | null;
  manifest: string;
  failure_count: ColumnType<number, number | undefined, number>;
  user_id: string;
  installed_at: string;
  installed_by: string | null;
  updated_at: string;
}

export interface CoreExtensionVersionsTable {
  extension_id: string;
  commit_oid: string;
  version: string;
  manifest: string;
  installed_at: string;
  installed_by: string | null;
}

export interface CoreExtensionRunsTable {
  id: string;
  extension_id: string;
  commit_oid: string | null;
  kind: "tool" | "manifest" | "automation";
  name: string | null;
  actor: string | null;
  user_id: string | null;
  started_at: string;
  duration_ms: number;
  outcome: "ok" | "error" | "timeout";
  error: string | null;
  logs: ColumnType<string, string | undefined, string>;
  operations: ColumnType<string, string | undefined, string>;
}

/** Migration 0130 (ADR 0130): an installed extension's automation. */
export interface CoreAutomationsTable {
  id: string;
  extension_id: string;
  key: string;
  label: string;
  trigger_type: string;
  trigger_object: string | null;
  spec: string;
  commit_oid: string | null;
  enabled: ColumnType<number, number | undefined, number>;
  paused_reason: string | null;
  paused_at: string | null;
  removed_at: string | null;
  /** A routine's owner (ADR 0343); null for an extension's automation. */
  owner_user_id: ColumnType<string | null, string | null | undefined, string | null>;
  scope: ColumnType<"org" | "personal", "org" | "personal" | undefined, "org" | "personal">;
  created_at: string;
  updated_at: string;
}

/** A personal routine (ADR 0343): what its core_automations row does not hold. */
export interface CoreRoutineTable {
  id: string;
  automation_id: string;
  owner_user_id: string;
  name: string;
  what: string;
  asked: string | null;
  asked_at: string | null;
  definition: string;
  draft_id: string | null;
  paused_until: string | null;
  last_delivered_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type AutomationRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "review"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "skipped";

/** Migration 0130: one automation run (or test run). */
export interface CoreAutomationRunsTable {
  id: string;
  automation_id: string;
  extension_id: string;
  commit_oid: string | null;
  workflow_id: string | null;
  trigger: string;
  record_object: string | null;
  record_id: string | null;
  status: AutomationRunStatus;
  status_reason: string | null;
  test: ColumnType<number, number | undefined, number>;
  depth: ColumnType<number, number | undefined, number>;
  root_event_id: string | null;
  steps: ColumnType<string, string | undefined, string>;
  writes: ColumnType<number, number | undefined, number>;
  change_set_id: string | null;
  wait_until: string | null;
  retry_of: string | null;
  replay_of: string | null;
  report: string | null;
  error: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** Migration 0130: records an automation run touched. */
export interface CoreAutomationRunRecordsTable {
  object_type: string;
  record_id: string;
  run_id: string;
  role: string;
  at: string;
}

/** Migration 0130: per-automation run and write counts per UTC hour (rails). */
export interface CoreAutomationCountersTable {
  automation_id: string;
  hour: string;
  runs: ColumnType<number, number | undefined, number>;
  writes: ColumnType<number, number | undefined, number>;
}

/** Migration 0131 (ADR 0132): the in-app notification centre. */
export interface CoreNotificationsTable {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  source: ColumnType<string, string | undefined, string>;
  dedupe_key: string | null;
  read_at: string | null;
  created_at: string;
  /** Migration 0851 (stage 44): shown to the person only, never to an AI acting for them. */
  human_only: ColumnType<number, number | undefined, number>;
}

/** Migration 0170 (ADR 0170): a person's consent that an automation uses a connection. */
export interface CoreAutomationBindingTable {
  automation_id: string;
  slot: string;
  gatekeeper: string;
  purpose: string;
  connection_id: string;
  bound_by: string;
  bound_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

/** Migration 0171 (ADR 0171): automation events written with the change, sent after commit. */
export interface CoreAutomationOutboxTable {
  id: string;
  messages: string;
  attempts: ColumnType<number, number | undefined, number>;
  next_at: string;
  last_error: string | null;
  created_at: string;
}

/** Migration 0172 (ADR 0172): a person's notification channels per type and the digest. */
export interface CoreNotificationPreferenceTable {
  user_id: string;
  channels: ColumnType<string, string | undefined, string>;
  digest: ColumnType<number, number | undefined, number>;
  /** Migration 0210 (ADR 0206): the in-app daily digest, on by default. */
  digest_in_app: ColumnType<number, number | undefined, number>;
  updated_at: string;
}

/** Migration 0200: the in-app assistant's conversation list (ADR 0200). */
export interface CoreAssistantConversationTable {
  id: string;
  user_id: string;
  title: string;
  context: string | null;
  turns: ColumnType<number, number | undefined, number>;
  preview: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: ColumnType<string | null, string | null | undefined, string | null>;
}

/**
 * Migration 0270 (ADR 0019 / ADR 0200 amendments): the people and organisations (`per_…`,
 * `org_…`) and email addresses (`email:<sha256>`) an assistant conversation referenced, so an
 * erase can find the conversations to scrub.
 */
export interface CoreAssistantConversationRefsTable {
  conversation_id: string;
  ref: string;
}

/**
 * Migration 0350 (ADR 0340): one assistant thread per user. The thread itself lives in the
 * user's AssistantAgent Durable Object; this row is its bookkeeping (turns, unread, preview).
 */
export interface CoreAssistantThreadTable {
  id: string;
  user_id: string;
  turns: ColumnType<number, number | undefined, number>;
  unread: ColumnType<number, number | undefined, number>;
  preview: string | null;
  compaction: string | null;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Migration 0350 (ADR 0340, ADR 0019 amendment): the people, organisations and email hashes a
 * thread referenced, so an erase can find the threads to scrub.
 */
export interface CoreAssistantThreadRefsTable {
  thread_id: string;
  ref: string;
}

/** Migration 0352 (ADR 0342): what each person's assistant remembers, and team lines. */
export interface CoreMemoryTable {
  id: string;
  /** The owner; null for team lines. */
  user_id: string | null;
  kind: "personal" | "shortcut" | "style" | "conditional" | "team";
  text: string;
  /** JSON `{ object, filter }` for conditional lines. */
  condition: string | null;
  condition_label: string | null;
  status: "active" | "proposed" | "paused";
  source_thread_id: string | null;
  source_message_seq: number | null;
  /** JSON: what checked the line before it was saved. */
  checked: string | null;
  author_id: string | null;
  /** JSON: team lines' changes, oldest first. */
  history: string | null;
  active_since: string | null;
  created_at: string;
  updated_at: string;
}

export type AgentJobState =
  | "awaiting_confirm"
  | "refused"
  | "queued"
  | "running"
  | "paused"
  | "done"
  | "stopped"
  | "failed"
  | "cancelled";

/** Migration 0371 (ADR 0344): one agent (a job, in code) and what stays when it is done. */
export interface CoreAgentJobTable {
  id: string;
  user_id: string;
  starter_kind: "user" | "routine" | "plugin";
  starter_id: string;
  profile: string | null;
  role: string;
  title: string;
  brief: string;
  records: JsonText;
  access: JsonText;
  budget: JsonText;
  mode: "awaited" | "background";
  review_everything: Defaulted<number>;
  state: AgentJobState;
  judged: Defaulted<JsonText | null>;
  justification: Defaulted<string | null>;
  progress: Defaulted<JsonText | null>;
  steps: Defaulted<number>;
  spent_microusd: Defaulted<number>;
  fields_filled: Defaulted<number>;
  result: Defaulted<string | null>;
  error: Defaulted<string | null>;
  started_at: Defaulted<Timestamp | null>;
  finished_at: Defaulted<Timestamp | null>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Migration 0371: the people, organisations and email hashes a job names. */
export interface CoreAgentJobRefsTable {
  job_id: string;
  ref: string;
}

/** Migration 0352 (ADR 0342): the people, organisations and email hashes a memory line names. */
export interface CoreMemoryRefsTable {
  memory_id: string;
  ref: string;
}

/** Migration 0352 (ADR 0342): memory paused per person (no row: on). */
export interface CoreMemorySettingsTable {
  user_id: string;
  paused: ColumnType<number, number | undefined, number>;
  updated_at: string;
}

/**
 * Migration 0330 (ADR 0320): erased people's addresses, as `sha256:<hex>` of the lower-cased
 * address (never the address), so sync does not collect them again.
 */
export interface CoreErasedAddressTable {
  hash: string;
  object_type: "person" | "organisation";
  erased_at: string;
  erased_by: string | null;
}

/**
 * Migration 0401 (stage 22, ADR 0402): a customer account, a Person who can sign in. Never a
 * core_user. Better Auth's user model for customers (packages/auth/src/customer-auth.ts).
 */
export interface CoreCustomerTable {
  id: string;
  /** Null until the first sign-in links it, and while link_state is `needs_merge`. */
  person_id: Defaulted<string | null>;
  email: string;
  email_verified: Defaulted<number>;
  status: Defaulted<CustomerStatus>;
  link_state: Defaulted<CustomerLinkState>;
  created_at: DateColumn;
  updated_at: DateColumn;
  last_sign_in_at: Defaulted<string | null>;
}
export type CustomerStatus = "active" | "disabled";
export type CustomerLinkState = "linked" | "needs_merge";

/** Migration 0401: a customer's session. No client address and no user agent, by design. */
export interface CoreCustomerSessionTable {
  id: string;
  customer_id: string;
  token: string;
  expires_at: DateColumn;
  created_at: DateColumn;
  updated_at: DateColumn;
}

/** Migration 0401: a customer's one-time sign-in code (hashed). */
export interface CoreCustomerVerificationTable {
  id: string;
  identifier: string;
  value: string;
  expires_at: DateColumn;
  created_at: DateColumn;
  updated_at: DateColumn;
}

/** Migration 0401: an address staff invited to sign up. */
export interface CoreCustomerInviteTable {
  email: string;
  invited_by: string;
  invited_at: string;
}

/**
 * Migration 0410 (stage 23, ADR 0416): a write over the HTTP surface that committed, by its
 * Idempotency-Key. Inserted in the write's own batch.
 */
export interface CoreIdempotencyKeyTable {
  scope: string;
  idempotency_key: string;
  operation: string;
  input_hash: string;
  claim: string;
  status: number | null;
  response: string | null;
  created_at: string;
}

/** Migration 0410: a key whose call is running, so a second call with it waits. */
/** Migration 0411 (stage 23, ADR 0419): a native app's session. Token hashes only. */
export interface CoreDeviceSessionTable {
  id: string;
  audience: "staff" | "customer";
  user_id: string | null;
  customer_id: string | null;
  device_name: string;
  access_hash: string;
  access_expires_at: string;
  refresh_hash: string;
  used_refresh_hashes: Defaulted<string>;
  created_at: string;
  last_used_at: string;
}

/** A staff invite (migration 0490, ADR 0455). */
export interface CoreUserInviteTable {
  id: string;
  /** Lower case. */
  email: string;
  role: UserRole;
  pack_role: string | null;
  /** JSON list of permission names, or null. */
  granted_permissions: string | null;
  invited_by: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_user_id: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

/** A pending confirmation of a staff account's own address (migration 0492, ADR 0457). */
export interface CoreEmailConfirmationTable {
  user_id: string;
  email: string;
  code_hash: string;
  attempts: ColumnType<number, number | undefined, number>;
  created_at: string;
  expires_at: string;
}

/** The one-time token of /native/staff-sign-in's confirm page (migration 0492, ADR 0457). */
export interface CoreNativeSignInConfirmTable {
  token_hash: string;
  user_id: string;
  redirect_uri: string;
  challenge: string;
  state: string;
  created_at: string;
  expires_at: string;
}

/** A one-time code for native staff sign-in through the system browser (migration 0490). */
export interface CoreNativeHandoffTable {
  code_hash: string;
  user_id: string;
  challenge: string;
  redirect_uri: string;
  created_at: string;
  expires_at: string;
}

export interface CoreIdempotencyClaimTable {
  scope: string;
  idempotency_key: string;
  operation: string;
  input_hash: string;
  claim: string;
  claimed_at: string;
}

/**
 * Migration 0402 (stage 22, ADR 0402): a request to erase a Person, made when a customer deletes
 * their account. Staff erase the person (status `erased`) or decline with a reason.
 */
export interface CoreEraseRequestTable {
  id: string;
  person_id: string;
  customer_id: Defaulted<string | null>;
  requested_at: string;
  due_at: string;
  status: Defaulted<EraseRequestStatus>;
  decline_reason: Defaulted<string | null>;
  closed_at: Defaulted<string | null>;
  closed_by: Defaulted<string | null>;
  last_notified_at: Defaulted<string | null>;
}
export type EraseRequestStatus = "open" | "erased" | "declined";

/** Migration 0440 (stage 26, ADR 0430): a record's capacity counter. */
export interface CoreCapacityTable {
  object_type: string;
  record_id: string;
  /** Null: unlimited. */
  places: Defaulted<number | null>;
  held: Defaulted<number>;
  taken: Defaulted<number>;
  pool_object_type: Defaulted<string | null>;
  pool_record_id: Defaulted<string | null>;
  updated_at: string;
}

/** Migration 0440: places claimed from a counter (and its pool) for an order line or booking. */
export interface CoreCapacityClaimTable {
  id: string;
  object_type: string;
  record_id: string;
  pool_object_type: Defaulted<string | null>;
  pool_record_id: Defaulted<string | null>;
  quantity: number;
  state: Defaulted<CapacityClaimState>;
  for_type: string;
  for_id: string;
  created_at: string;
  updated_at: string;
  confirmed_at: Defaulted<string | null>;
  released_at: Defaulted<string | null>;
}
export type CapacityClaimState = "held" | "confirmed" | "released";

/**
 * Migration 0930 (stage 37, ADR 0680): the stock ledger. Every change of a stock record's count,
 * append-only (no update, delete or replace), each at a place ('default' until several).
 */
export interface CoreStockMovementTable {
  id: string;
  object_type: string;
  record_id: string;
  place: Defaulted<string>;
  /** Signed: in is positive, out negative. */
  quantity: number;
  kind: StockMovementKind;
  source_type: string;
  source_id: string;
  /** The staff account; null when the host made it (a paid order's sale). */
  by_user: string | null;
  at: string;
  note: string | null;
  /** Minor units, for what was received. */
  unit_cost: number | null;
}
export type StockMovementKind =
  | "opening"
  | "received"
  | "sold"
  | "returned"
  | "written_off"
  | "counted"
  | "adjusted"
  | "used";

/**
 * Migration 0650 (ADR 0540): a family link. While live (`ended_at` null) the guardian, signed in
 * as a customer, reads and acts for the dependant where an object's customer declaration opts in.
 */
export interface CorePersonLinkTable {
  id: string;
  kind: Defaulted<"guardian">;
  guardian_id: string;
  dependant_id: string;
  note: Defaulted<string | null>;
  created_by: string;
  created_at: string;
  ended_at: Defaulted<string | null>;
  ended_by: Defaulted<string | null>;
  end_reason: Defaulted<string | null>;
}

/** Migration 1231 (stage 56, ADR 0831): a staff account that looks after a Person. */
export interface CorePersonCarerTable {
  id: string;
  person_id: string;
  user_id: string;
  set_by: string;
  started_at: string;
  ended_at: Defaulted<string | null>;
  ended_by: Defaulted<string | null>;
}

/** Migration 1170 (stage 53 step 3, ADR 0800): a journey and its working copy. */
export interface CoreJourneyTable {
  id: string;
  name: string;
  kind: "service" | "promotional";
  status: Defaulted<"draft" | "live" | "paused" | "archived">;
  owner_id: Defaulted<string | null>;
  /** The working copy: JSON, checked by the host (`journeys/definition.ts`). */
  draft: string;
  draft_rev: Defaulted<number>;
  draft_updated_at: string;
  draft_updated_by: string;
  draft_updated_via: Defaulted<string>;
  draft_ai: Defaulted<number>;
  current_version_id: Defaulted<string | null>;
  starter: Defaulted<string | null>;
  created_at: string;
  created_by: string;
  status_at: Defaulted<string | null>;
  status_by: Defaulted<string | null>;
}

/** Migration 1170 (ADR 0800): a published version; the database refuses any update or delete. */
export interface CoreJourneyVersionTable {
  id: string;
  journey_id: string;
  number: number;
  definition: string;
  summary: string;
  hash: string;
  draft_rev: number;
  drafted_by: "person" | "assistant";
  published_at: string;
  published_by: string;
  requested_by: Defaulted<string | null>;
  requested_via: Defaulted<string | null>;
}

/** Migration 1170 (ADR 0800): one Person on one journey. */
export interface CoreJourneyEntryTable {
  id: string;
  journey_id: string;
  version_id: string;
  person_id: string;
  state: Defaulted<"active" | "waiting" | "held" | "finished" | "stopped">;
  step: string;
  next_at: Defaulted<string | null>;
  entered_at: string;
  entered_by: "signal" | "scan" | "birthday" | "person";
  entered_by_user: Defaulted<string | null>;
  cause_standing: "person" | "host" | "ai";
  cause_record: Defaulted<string | null>;
  ended_at: Defaulted<string | null>;
  stopped_by: Defaulted<string | null>;
  stop_reason: Defaulted<string | null>;
}

/** Migration 1170 (ADR 0800): what happened at a step of an entry; never words. */
export interface CoreJourneyStepLogTable {
  id: string;
  entry_id: string;
  step: string;
  at: string;
  what:
    | "entered"
    | "sent"
    | "held"
    | "skipped"
    | "waited"
    | "branch"
    | "task"
    | "finished"
    | "stopped"
    | "moved";
  detail: Defaulted<string | null>;
}

/** Migration 0850 (stage 44, ADR 0640): an agreement document and its working copy. */
export interface CoreAgreementDocumentTable {
  id: string;
  kind: "terms" | "waiver" | "health" | "guardian" | "other";
  state: Defaulted<"draft" | "live" | "retired">;
  draft_title: string;
  draft_body: Defaulted<string | null>;
  draft_tick_label: Defaulted<string | null>;
  draft_questions: Defaulted<string | null>;
  draft_how: Defaulted<"typed" | "drawn">;
  draft_who: Defaulted<"participant" | "payer">;
  draft_for: Defaulted<"everyone" | "dependants">;
  draft_ask_again_months: Defaulted<number | null>;
  draft_rev: Defaulted<number>;
  draft_updated_at: string;
  draft_updated_by: string;
  draft_updated_via: Defaulted<string>;
  current_version_id: Defaulted<string | null>;
  agree_from: Defaulted<number>;
  created_at: string;
  created_by: string;
  retired_at: Defaulted<string | null>;
  retired_by: Defaulted<string | null>;
}

/** Migration 0850 (ADR 0640): a published version; the database refuses any update or delete. */
export interface CoreAgreementVersionTable {
  id: string;
  document_id: string;
  number: number;
  title: string;
  body: string;
  tick_label: string;
  questions: string | null;
  how: "typed" | "drawn";
  who: "participant" | "payer";
  for_whom: "everyone" | "dependants";
  ask_again_months: number | null;
  change: "first" | "small" | "agree_again";
  effective_from: string;
  published_at: string;
  published_by: string;
  draft_rev: number;
  hash: string;
}

/** Migration 0850 (ADR 0641): a document attached to an agreement point. */
export interface CoreAgreementPointTable {
  document_id: string;
  point: string;
  attached_at: string;
  attached_by: string;
}

/** Migration 0850 (ADR 0640): the one counter every change to what is due bumps. */
export interface CoreAgreementRevTable {
  id: number;
  rev: Defaulted<number>;
}

/**
 * Migration 0851 (stage 44 step 2, ADR 0642): one record that a person agreed to one version. The
 * database refuses any change but setting its Person (settlement, merge) and clearing who it
 * names (erase).
 */
export interface CoreAgreementAcceptanceTable {
  id: string;
  document_id: string;
  version_id: string;
  shown_hash: string;
  context: Defaulted<string | null>;
  person_id: string | null;
  by: "self" | "guardian" | "guest" | "paper";
  agent_person_id: Defaulted<string | null>;
  account_id: Defaulted<string | null>;
  order_id: Defaulted<string | null>;
  subscription_checkout: Defaulted<string | null>;
  email: Defaulted<string | null>;
  how: "typed" | "drawn" | "paper";
  typed_name: string | null;
  channel: "web" | "app" | "paper" | "desk";
  desk_session_id: Defaulted<string | null>;
  accepted_at: string;
  signed_on: Defaulted<string | null>;
  recorded_by: Defaulted<string | null>;
  signed_by: Defaulted<string | null>;
  note: Defaulted<string | null>;
  erased_at: Defaulted<string | null>;
}

/** Migration 0851 (ADR 0642): a drawn signature's strokes, beside its acceptance. */
export interface CoreAgreementSignatureTable {
  acceptance_id: string;
  strokes: string;
}

/** Migration 0851 (ADR 0643): a health form's answers. Health information. */
export interface CoreAgreementAnswerTable {
  acceptance_id: string;
  answers: string;
  any_yes: 0 | 1;
  entered_by: Defaulted<string | null>;
}

/**
 * Migration 1190 (ADR 0811): a restricted field's value, apart from its record. In no view; read
 * by its author and through `record.readRestricted` only.
 */
export interface CoreRestrictedValueTable {
  object_type: string;
  record_id: string;
  field: string;
  value: string;
  written_at: string;
}

/** Migration 0851 (ADR 0642): a Person staff marked as a minor. */
export interface CoreAgreementMinorTable {
  person_id: string;
  set_by: string;
  set_at: string;
}

/**
 * Migration 0858 (stage 44 step 6, ADR 0649): one Person signing on the business's enrolled
 * tablet, in a session a person on the staff started. The code and the token as HMACs only.
 */
export interface CoreAgreementDeskSessionTable {
  id: string;
  person_id: string | null;
  /** A JSON list of the live dependants' Person ids the signer agrees for. */
  dependant_ids: Defaulted<string>;
  device_id: string;
  claimed_device_id: Defaulted<string | null>;
  started_by: string;
  started_at: string;
  email: string | null;
  code_hash: string | null;
  code_expires_at: string;
  token_hash: Defaulted<string | null>;
  claimed_at: Defaulted<string | null>;
  last_activity_at: Defaulted<string | null>;
  last_heartbeat_at: Defaulted<string | null>;
  ended_at: Defaulted<string | null>;
  end_reason: Defaulted<
    | "finished"
    | "staff"
    | "unclaimed"
    | "idle"
    | "limit"
    | "replaced"
    | "wrong_device"
    | "failed_claim"
    | "revoked"
    | "device_changed"
    | "erased"
    | null
  >;
  erased_at: Defaulted<string | null>;
}

/**
 * Migration 1130 (stage 51 step 1, ADR 0780): a device a human admin enrolled as the business's
 * own, for one use. Its enrolment code and credentials as HMACs only.
 */
export interface CoreDeviceTable {
  id: string;
  name: string;
  use: "signing" | "role" | "till";
  role: string | null;
  enrolled_by: string;
  enrolled_at: string;
  enrol_code_hash: string | null;
  enrol_expires_at: string;
  claimed_at: Defaulted<string | null>;
  credential_hash: Defaulted<string | null>;
  pending_credential_hash: Defaulted<string | null>;
  previous_credential_hash: Defaulted<string | null>;
  rotated_at: Defaulted<string | null>;
  last_seen_at: Defaulted<string | null>;
  claim_user_agent: Defaulted<string | null>;
  claim_address: Defaulted<string | null>;
  last_user_agent: Defaulted<string | null>;
  last_address: Defaulted<string | null>;
  /** A JSON list of { kind: "browser" | "network", at }. */
  flags: Defaulted<string>;
  bad_codes: Defaulted<number>;
  bad_codes_since: Defaulted<string | null>;
  locked_until: Defaulted<string | null>;
  revoked_at: Defaulted<string | null>;
  revoked_by: Defaulted<string | null>;
  revoke_reason: Defaulted<"admin" | "clone" | "lapsed" | null>;
}

/**
 * Migration 0854 (stage 44 step 4, ADR 0645): the copy of one acceptance, the host's own mail,
 * kept beside it so the acceptance itself never changes. Made by trigger when a person agrees (and
 * when a guest's acceptance settles), or by `agreement.copy.send` for paper. Who it goes to never
 * changes once written.
 */
export interface CoreAgreementCopyTable {
  acceptance_id: string;
  to_address: string | null;
  state: "queued" | "sending" | "sent" | "waiting" | "failed" | "cancelled";
  /** The idempotency key of the current try (`agreement-copy:<acceptance id>` first). */
  send_key: string;
  attempts: number;
  queued_at: string;
  next_at: string | null;
  claimed_at: string | null;
  sent_at: string | null;
  pending_action_id: string | null;
  error: string | null;
  /** Paper: the staff user who pressed "Email a copy". */
  requested_by: string | null;
  /**
   * Migration 0855 (stage 44 step 8, ADR 0646): the email gatekeeper still holds something of an
   * erased acceptance's copy (a waiting send, its history line): the host asks it to scrub them.
   */
  scrub_due_at: Defaulted<string | null>;
  /** When a scrub was first owed (never changes): after 30 days the purge may go ahead. */
  scrub_owed_since: Defaulted<string | null>;
  /**
   * Why the last scrub was not done: every gatekeeper left is gone (`unreachable`), one exists
   * but needs re-authorising (`inactive`), or one failed.
   */
  scrub_error: Defaulted<"unreachable" | "inactive" | "failed" | null>;
  /** The gatekeepers (as `via` names them) the last scrub finished on, as a JSON list. */
  scrub_done: Defaulted<string | null>;
  /** Since when every gatekeeper left has been gone: the purge's 30 days count from here. */
  scrub_gone_since: Defaulted<string | null>;
  /** When the gatekeeper confirmed the scrub. */
  scrubbed_at: Defaulted<string | null>;
  /** The gatekeepers a send reached, as a JSON list of `<connection id> <resource key>`. */
  via: Defaulted<string | null>;
  /**
   * Migration 0857 (ADR 0648): a child's paper form, sent to the parent or guardian staff picked
   * (a live guardian of the child at the insert; the address is theirs). Null for every other
   * copy, and once that guardian is erased.
   */
  guardian_id: Defaulted<string | null>;
  /** When that guardian was erased: their address left the row then. */
  guardian_erased_at: Defaulted<string | null>;
  /**
   * When the guardian's link to the child stopped being live before the copy went (ended, or
   * either Person to the Trash): it was cancelled and its address cleared then.
   */
  guardian_ended_at: Defaulted<string | null>;
}

/**
 * Migration 0855 (stage 44 step 8, ADR 0646): a kept acceptance a person on the staff holds for a
 * dispute or a claim; the retention purge passes it by until the hold is released.
 */
export interface CoreAgreementHoldTable {
  acceptance_id: string;
  held_by: string;
  held_at: string;
}

/**
 * Migration 0690 (ADR 0560): a refund the host owes on a record bought through `sellable.moves`
 * (a drop-in booking cancelled in time, or its class cancelled). The minute cron asks for it.
 */
export interface CoreSellableRefundDueTable {
  id: string;
  order_id: string;
  object_type: string;
  record_id: string;
  payment_ref: Defaulted<string | null>;
  amount: Defaulted<number | null>;
  entered: string;
  reason: string;
  state: Defaulted<"due" | "asking" | "asked" | "done" | "lapsed" | "skipped">;
  attempt: Defaulted<number>;
  note: Defaulted<string | null>;
  created_at: string;
  updated_at: string;
}

/** Migration 0750 (ADR 0590): one routine email the host was asked to send. */
export interface CoreRoutineMailTable {
  id: string;
  kind: string;
  message: string;
  extension_id: string;
  record_object: string;
  record_id: string;
  /** Migration 0910 (ADR 0670): the channel this row goes on. */
  channel: Defaulted<"email" | "text" | "push">;
  recipient: string;
  recipient_rule: "person" | "guardian" | "order";
  recipient_person_id: Defaulted<string | null>;
  recipient_key: string;
  about_person_id: Defaulted<string | null>;
  /** Null for a host kind's row (migration 0910): host code asked for it, not an automation. */
  automation_id: string | null;
  run_id: string | null;
  trigger_type: string;
  triggered_by: Defaulted<string | null>;
  idempotency_key: string;
  routine: number;
  ordinary: Defaulted<number>;
  claimed_at: Defaulted<string | null>;
  held_reason: Defaulted<string | null>;
  status:
    | "off"
    | "ready"
    | "sending"
    | "sent"
    | "delivered"
    | "waiting"
    | "held"
    | "denied"
    | "failed"
    | "stopped"
    | "expired"
    | "over_limit"
    | "no_channel";
  connection_id: Defaulted<string | null>;
  subject: Defaulted<string | null>;
  body: Defaulted<string | null>;
  calendar: Defaulted<string | null>;
  related: Defaulted<string | null>;
  sources: Defaulted<string | null>;
  pending_action_id: Defaulted<string | null>;
  error: Defaulted<string | null>;
  /** A text's segments and cost (migration 0910). */
  segments: Defaulted<number | null>;
  cost_minor: Defaulted<number | null>;
  provider_ref: Defaulted<string | null>;
  delivered_at: Defaulted<string | null>;
  /** Quiet hours (ADR 0676): a waiting text or push goes at this moment. */
  wait_until: Defaulted<string | null>;
  /** The kind's moment for the record: a text or push not sent by then is `expired`. */
  until_at: Defaulted<string | null>;
  created_at: string;
  updated_at: string;
}

/** Migration 0750 (ADR 0590): who stands behind a record field's current value. */
export interface CoreValueMarkTable {
  object_type: string;
  record_id: string;
  field: string;
  value_hash: string;
  standing: "person" | "customer" | "public" | "default" | "host" | "ai";
  by_id: string | null;
  at: string;
}

/**
 * Migration 1175 (stage 53, ADR 0802): the last time a Person had a journey signal, one row per
 * Person and signal, written by the host in the write's batch.
 */
export interface CorePersonSignalTable {
  person_id: string;
  signal: string;
  last_at: string;
  object_type: string;
  record_id: string;
  standing: "person" | "customer" | "public" | "default" | "host" | "ai";
  bulk: number;
}

/** Migration 0650: a guardian's write's guard; its trigger stores nothing. */
export interface CorePersonLinkGuardTable {
  guardian_id: string;
  dependant_id: string;
}

/** Migration 0560 (ADR 0500): a series of the `recurring` behaviour, and when it next runs. */
export interface CoreRecurrenceSeriesTable {
  object_type: string;
  record_id: string;
  next_run_at: string;
  generated_until: Defaulted<string | null>;
  version: Defaulted<number>;
  updated_at: string;
}

/** Migration 0560: a guard on what a batch was planned from (never holds a row). */
export interface CoreWriteGuardTable {
  kind: "claimed" | "claimant" | "series" | "full" | "unmoved" | "held_cap" | "agreements";
  object_type: string;
  record_id: string;
  expected: number;
}

/** Migration 0560: one record a series made, keyed on the series and its local date. */
export interface CoreRecurrenceOccurrenceTable {
  series_object: string;
  series_id: string;
  local_date: string;
  object_type: string;
  record_id: string;
  edited_at: Defaulted<string | null>;
  created_at: string;
  /** Migration 0810: bumped by a hand write to the record and by a change of its series. */
  version: Defaulted<number>;
}

/** Migration 0810: guards on occurrences' versions (stores nothing; its trigger checks). */
export interface CoreRecurrenceGuardTable {
  kind: "occurrence" | "occurrences";
  object_type: string;
  record_id: string;
  from_date: string | null;
  expected: number;
}

/**
 * Migration 0810 (stage 45 step 1, ADR 0620): a copied field a generated record keeps as its own.
 * The series writes the record's other fields and never this one, until it is cleared.
 */
export interface CoreRecurrenceExceptionTable {
  object_type: string;
  record_id: string;
  field: string;
  set_by: string;
  set_at: string;
}

/**
 * Migration 0811 (stage 45, ADR 0621): a live, covered shift's time claim, kept by triggers on the
 * staffed object's table. The database refuses two overlapping claims of one account.
 */
export interface CoreStaffTimeTable {
  object_type: string;
  record_id: string;
  account_id: string;
  /** Unix seconds, half-open, widened by the margins. */
  starts: number;
  ends: number;
  /** Migration 1091 (ADR 0760): seconds the claim was widened by before and after the shift. */
  margin_before: Generated<number>;
  margin_after: Generated<number>;
}

/**
 * Migration 1095 (stage 49, ADR 0765): a live occupant's claim on a thing (a room), kept by
 * triggers on the declaring object's table. The database refuses two overlapping claims of one
 * thing, whatever objects hold them.
 */
export interface CoreThingTimeTable {
  object_type: string;
  record_id: string;
  thing_object: string;
  thing_record: string;
  /** Unix seconds with the margins, half-open. */
  starts: number;
  ends: number;
}

/** Migration 0811 (stage 45, ADR 0622): who may do which kind of work. */
export interface CoreStaffQualificationTable {
  account_id: string;
  kind_object: string;
  kind_record: string;
  set_by: string;
  set_at: string;
}

/** Migration 0811 (stage 45, ADR 0622): when someone said they cannot work. */
export interface CoreStaffAwayTable {
  id: string;
  account_id: string;
  kind: "leave" | "regular" | "other";
  note: string | null;
  starts_at: string | null;
  ends_at: string | null;
  weekdays: string | null;
  start_time: string | null;
  end_time: string | null;
  from_date: string | null;
  until_date: string | null;
  zone: string;
  set_by: string;
  set_at: string;
  /** Migration 1271 (stage 58, ADR 0853): the leave request whose approval wrote it, or null. */
  leave_request: ColumnType<string | null, string | null | undefined, string | null>;
}

/** Migration 1271 (stage 58 step 4, ADR 0853): a kind of leave the business offers. */
export interface CoreLeaveTypeTable {
  id: string;
  name: string;
  unit: "hours" | "days";
  keeps_balance: number;
  below_zero: "warn" | "refuse";
  paid: number;
  active: Generated<number>;
  position: Generated<number>;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

/** Migration 1271 (stage 58 step 4, ADR 0853): one ask for time off. */
export interface CoreLeaveRequestTable {
  id: string;
  account_id: string;
  type_id: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  zone: string;
  starts_at: string;
  ends_at: string;
  state: "requested" | "approved" | "declined" | "cancelled";
  note: string | null;
  asked_by: string;
  asked_at: string;
  decided_by: string | null;
  decided_at: string | null;
  why: string | null;
  updated_at: string;
}

/** Migration 1271 (stage 58 step 4, ADR 0853): a date of a leave request and its amounts. */
export interface CoreLeaveDayTable {
  request_id: string;
  date: string;
  asked: number;
  approved: number | null;
}

/** Migration 1271 (stage 58 step 4, ADR 0853): one entry of the balance ledger (insert only). */
export interface CoreLeaveBalanceEntryTable {
  id: string;
  account_id: string;
  type_id: string;
  amount: number;
  why: "set" | "adjust" | "approved" | "cancelled";
  request_id: string | null;
  note: string | null;
  made_by: string;
  made_at: string;
}

/**
 * Migration 1090 (stage 49 step 3, ADR 0762): when someone takes appointments. A weekly rule in
 * local time (overnight when the end is at or before the start), or extra hours as a range of
 * instants; optionally only for some kinds of work (`only_for`, a JSON list of `{object, id}`).
 * In no rec_* view.
 */
export interface CoreStaffHoursTable {
  id: string;
  account_id: string;
  kind: "weekly" | "extra";
  weekdays: string | null;
  start_time: string | null;
  end_time: string | null;
  from_date: string | null;
  until_date: string | null;
  starts_at: string | null;
  ends_at: string | null;
  zone: string;
  only_for: string | null;
  set_by: string;
  set_at: string;
}

/**
 * Migration 1270 (stage 58 step 1, ADR 0850): one stretch of time a staff member worked, the one
 * record of time worked. Times are unix seconds; `ends` is null while open. The database refuses
 * two overlapping entries of one account and a second open one.
 */
export interface CoreTimeEntryTable {
  id: string;
  account_id: string;
  starts: number;
  ends: number | null;
  break_minutes: Generated<number>;
  zone: string;
  local_date: string;
  against_object: string | null;
  against_record: string | null;
  how: "clocked" | "entered" | "by_approver";
  how_why: string | null;
  state: "open" | "waiting" | "approved" | "rejected";
  finish_missing: Generated<number>;
  recorded_starts: number | null;
  recorded_ends: number | null;
  recorded_break_minutes: number | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_why: string | null;
  note: string | null;
  start_key: string | null;
  made_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * Migration 0812 (stage 45, ADR 0623): a shift offered for someone else to take. It leaves `open`
 * once; the database refuses every later move, so exactly one take wins.
 */
export interface CoreStaffOfferTable {
  id: string;
  object_type: string;
  record_id: string;
  from_account: string | null;
  made_by: string;
  to_account: string | null;
  /** The shift's start, unix seconds, kept current while open. */
  starts: number;
  /** The shift's kind (object and record), kept current while open. */
  kind_object: string | null;
  kind_record: string | null;
  state: "open" | "taken" | "withdrawn" | "cancelled" | "lapsed";
  made_at: string;
  taken_by: string | null;
  taken_at: string | null;
  ended_at: string | null;
  ended_by: string | null;
  why: string | null;
}

/**
 * Migration 0814 (stage 45 step 5, ADR 0628): a staff account's private calendar feed, by the
 * SHA-256 of its token (never the token), and the tool that made it.
 */
export interface CoreStaffFeedTable {
  account_id: string;
  token_hash: string;
  tool: string;
  created_at: string;
}

/**
 * Migration 1135 (stage 51 step 3, ADR 0783): what identifies a Person at a check-in tablet. An
 * `app` code's secret (encrypted, for one sign-in) or a `card`'s code (an HMAC only). Never in a
 * rec_* view.
 */
export interface CorePersonCodeTable {
  id: string;
  person_id: string;
  kind: "app" | "card";
  code_hmac: string | null;
  label: string | null;
  issued_by: string | null;
  secret_enc: string | null;
  device_session_id: string | null;
  customer_session_id: string | null;
  guardian_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

/** Migration 1135: a Person's PIN, as a slow hash, and its wrong tries over a day. */
export interface CorePersonPinTable {
  person_id: string;
  hash: string;
  salt: string;
  iterations: number;
  set_at: string;
  failed_count: Generated<number>;
  failed_since: string | null;
  disabled_at: string | null;
}

/** Migration 1135: a device's failed identifications this minute, per entry. No Person. */
export interface CoreIdentifyLockoutTable {
  device_id: string;
  entry: "name" | "code";
  window_started_at: string;
  failures: number;
  locked_until: string | null;
}

/** Migration 0815 (stage 45 step 4b, ADR 0650): a checklist template. Not personal. */
export interface CoreChecklistTable {
  id: string;
  name: string;
  purpose: string | null;
  active: number;
  version: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  /**
   * Migration 0816 (ADR 0651): its standing schedule, if it has one: the ISO weekdays it is due
   * (JSON, 1 Monday … 7 Sunday), the local time it is due by (HH:MM), and who may do it.
   */
  days: ColumnType<string | null, string | null | undefined, string | null>;
  due_by: ColumnType<string | null, string | null | undefined, string | null>;
  doers_kind: ColumnType<
    "staff" | "role" | "grant" | null,
    "staff" | "role" | "grant" | null | undefined,
    "staff" | "role" | "grant" | null
  >;
  doers_value: ColumnType<string | null, string | null | undefined, string | null>;
}

/** Migration 0815: a template's steps as they are now (position from 0). */
export interface CoreChecklistStepTable {
  checklist_id: string;
  position: number;
  text: string;
  required: number;
  asks_note: number;
}

/**
 * Migration 0815: a run of a template on one record, its steps copied as they were (JSON). The
 * database refuses every change of a closed run, and of its ticks.
 */
export interface CoreChecklistRunTable {
  id: string;
  object_type: string;
  record_id: string;
  checklist_id: string;
  version: number;
  name: string;
  steps: string;
  account_id: string | null;
  /** Unix seconds, kept current while open. */
  opens: number;
  closes: number;
  state: "open" | "done" | "missed" | "cancelled";
  made_at: string;
  /** The record left its live states after the run opened: when, and by a rosterer or the host. */
  ended_at: string | null;
  ended_by: string | null;
  closed_at: string | null;
  closed_by: string | null;
  closed_why: string | null;
  missed_steps: string | null;
  /** Migration 0816 (ADR 0651): a day run's copy of who may do it; null on a record's run. */
  doers_kind: ColumnType<
    "staff" | "role" | "grant" | null,
    "staff" | "role" | "grant" | null | undefined,
    "staff" | "role" | "grant" | null
  >;
  doers_value: ColumnType<string | null, string | null | undefined, string | null>;
  /** A day run's due-by time (unix seconds), or null. */
  due_at: ColumnType<number | null, number | null | undefined, number | null>;
}

/**
 * Migration 0815: one tick of a run's step, keeping who ticked it and for whom. Never changed or
 * removed: a later tick of the step is a new row, and the latest counts.
 */
export interface CoreChecklistTickTable {
  id: string;
  run_id: string;
  position: number;
  state: "done" | "not_done" | "cleared";
  why: string | null;
  note: string | null;
  ticked_by: string;
  ticked_for: string;
  on_behalf: number;
  on_behalf_why: string | null;
  ticked_at: string;
}

/** Migration 0815: a correction someone who rosters added beside a closed run. */
export interface CoreChecklistNoteTable {
  id: string;
  run_id: string;
  text: string;
  written_by: string;
  written_at: string;
}

/** Migration 0812 (stage 45, ADR 0624): a batch's count guard; nothing is stored. */
export interface CoreStaffGuardTable {
  expected: number;
  actual: number;
}

/** Migration 0813 (stage 45 step 6, ADR 0627): who is counted for pay, from a local date. */
export interface CoreStaffPayBasisTable {
  account_id: string;
  from_date: string;
  basis: "by_time" | "by_class" | "not_counted";
  set_by: string;
  set_at: string;
}

/** Migration 0813 (stage 45 step 6, ADR 0627): a shift marked not worked, with why. */
export interface CoreStaffNotWorkedTable {
  object_type: string;
  record_id: string;
  /** The shift's start when marked, unix seconds. */
  starts: number;
  reason: string;
  marked_by: string;
  marked_at: string;
}

/** Migration 0813 (stage 45 step 6, ADR 0627): one version of one locked pay period. */
export interface CorePayPeriodTable {
  id: string;
  start_date: string;
  end_date: string;
  zone: string;
  /** Local midnights as unix seconds, half-open. */
  starts: number;
  ends: number;
  version: number;
  state: "locking" | "locked" | "reopened";
  locked_by: string;
  locked_at: string;
  reopened_by: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
}

/** Migration 0813 (stage 45 step 6, ADR 0627): one shift counted in a locked pay period. */
export interface CorePayLineTable {
  period_id: string;
  n: number;
  account_id: string;
  name: string;
  email: string;
  basis: "by_time" | "by_class";
  object_type: string;
  record_id: string;
  kind_object: string | null;
  kind_record: string | null;
  kind_name: string;
  title: string;
  place: string | null;
  starts: number;
  ends: number;
  local_date: string;
  local_start: string;
  local_end: string;
  shift_minutes: number;
  before_minutes: number;
  after_minutes: number;
  counted_minutes: number;
  counted: number;
  not_worked_reason: string | null;
  list_taken: number | null;
  marked_by: string | null;
  flagged: number;
}

/** Migration 1150 (stage 52 step 1, ADR 0790): one version of one closed month. */
export interface CoreFinancePeriodTable {
  id: string;
  /** `YYYY-MM`. */
  month: string;
  start_date: string;
  end_date: string;
  zone: string;
  /** Local midnights as unix seconds, half-open. */
  starts: number;
  ends: number;
  version: number;
  state: "closing" | "closed" | "reopened";
  closed_by: string;
  closed_at: string;
  entry_count: number;
  line_count: number;
  row_count: number;
  reopened_by: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
}

/** Migration 1150 (stage 52 step 1, ADR 0791): one book entry of a closed version. */
export interface CoreFinanceEntryTable {
  period_id: string;
  entry_key: string;
  n: number;
  kind: "day" | "payout" | "held" | "late";
  date: string;
  belongs_to: string | null;
  fingerprint: string;
}

/** Migration 1150 (stage 52 step 1, ADR 0791): one line of a book entry. */
export interface CoreFinanceEntryLineTable {
  period_id: string;
  entry_key: string;
  n: number;
  heading: string;
  side: "debit" | "credit";
  amount: number;
  tax_code: string | null;
  tax_country: string | null;
  method: string | null;
  category: string | null;
}

/** Migration 1150 (stage 52 step 1, ADR 0790): a report's row as a version closed it. */
export interface CoreFinanceRowTable {
  period_id: string;
  report: "sales" | "tax" | "refunds" | "payouts" | "owed" | "held" | "unearned" | "members";
  n: number;
  person_id: string | null;
  name: string | null;
  email: string | null;
  /** JSON: the row's amounts, dates and order ids, never a name. */
  data: string;
}

/** Migration 1150 (stage 52 step 1, ADR 0790): a source a version counted. */
export interface CoreFinanceCountedTable {
  source_kind: string;
  source_id: string;
  period_id: string;
  month: string;
}

/** Migration 1150 (stage 52 step 1, ADR 0790): the close's guard; nothing is stored. */
export interface CoreFinanceGuardTable {
  expected: number;
  actual: number;
}

/** Migration 0812 (stage 45, ADR 0624): the local date the roster's daily work last ran. */
export interface CoreStaffRunTable {
  name: string;
  last_date: string;
}

/** Migration 0533 (stage 32b, ADR 0493): an allowance holder's terms, kept from its record. */
export interface CoreAllowanceTable {
  object_type: string;
  record_id: string;
  person_id: string | null;
  /** Null: unlimited. */
  uses: number | null;
  per: AllowancePer;
  zone: string;
  valid_from: string | null;
  valid_until: string | null;
  from_date: Defaulted<string | null>;
  until_date: Defaulted<string | null>;
  live: number;
  trashed: Defaulted<number>;
  prev_per: Defaulted<AllowancePer | null>;
  prev_zone: Defaulted<string | null>;
  applies_from: Defaulted<string | null>;
  updated_at: string;
}
export type AllowancePer = "total" | "week" | "month";

/** Migration 0533: a holder's count of uses in one period, refused past its limit. */
export interface CoreAllowancePeriodTable {
  object_type: string;
  record_id: string;
  period: string;
  per: AllowancePer;
  zone: string;
  starts_at: string;
  ends_at: string;
  uses: number | null;
  used: Defaulted<number>;
  rekeyed: Defaulted<number>;
  updated_at: string;
}

/** Migration 0533: one use a spender spent from a holder, and when it was given back. */
export interface CoreAllowanceUseTable {
  id: string;
  object_type: string;
  record_id: string;
  period: string;
  zone: string;
  spender_type: string;
  spender_id: string;
  person_id: string;
  at: string;
  at_date: string;
  spent_at: string;
  spent_by: "staff" | "customer" | "host";
  returned_at: Defaulted<string | null>;
  returned_by: Defaulted<"staff" | "customer" | "host" | null>;
  moved_from: Defaulted<string | null>;
}

/** Migration 0310 (ADR 0246): an assignment rule, ordered per object. */
export interface CoreAssignmentRuleTable {
  id: string;
  object_type: string;
  name: string;
  position: number;
  enabled: number;
  /** JSON array of { field, op, value?, via? }. */
  conditions: string;
  method: "roundRobin" | "user";
  /** JSON array of user ids. */
  user_ids: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

/** Migration 0310: a round-robin rule's rotation index (CHECK next_index >= 0 guards it). */
export interface CoreAssignmentStateTable {
  rule_id: string;
  next_index: number;
  updated_at: string | null;
}

/** Migration 0310: the owner used when no rule matches, per object. */
export interface CoreAssignmentFallbackTable {
  object_type: string;
  user_id: string | null;
  updated_at: string;
  updated_by: string;
}

/** Migration 0310: admin-edited options of an extension select field (`editableOptions`). */
export interface CoreFieldOptionsTable {
  object_type: string;
  field: string;
  /** JSON array of { value, label, color? }. */
  options: string;
  updated_at: string;
  updated_by: string;
}

/** Migration 0330 (ADR 0320): R2 objects to delete after a commit, drained with retries. */
export interface CoreBlobDeletionTable {
  key: string;
  queued_at: string;
  attempts: ColumnType<number, number | undefined, number>;
  last_error: string | null;
}

/**
 * Migration 0172: one external delivery (email / Slack), keyed for exactly-once sending. Migration
 * 0210 (ADR 0206) adds `inApp` for a daily digest that went to the app only.
 */
export interface CoreNotificationDeliveryTable {
  key: string;
  kind: "notification" | "escalation" | "digest" | "route";
  channel: "email" | "slack" | "inApp";
  user_id: string | null;
  status: "sending" | "sent" | "pending" | "failed" | "skipped";
  detail: string | null;
  created_at: string;
}

export interface CoreExtensionKvTable {
  extension_id: string;
  key: string;
  value: string;
  updated_at: string;
}

/** Migration 0030: what a reviewer sees for an extension proposal (ADR 0041). */
export interface CoreExtensionProposalsTable {
  action_id: string;
  extension_id: string;
  commit_oid: string;
  base_commit: string | null;
  source: "shipped" | "runtime";
  version: string;
  message: string;
  diff: string;
  impact: string;
  check_result: string;
  ai_summary: string | null;
  ai_model: string | null;
  /** Migration 0250 (ADR 0230): the authoring.intent check, JSON, or null when none ran. */
  intent_check: string | null;
  created_by: string;
  created_at: string;
}

export type ExtensionSchemaStatus = "active" | "hidden";

export interface CoreExtensionObjectsTable {
  name: string;
  extension_id: string;
  local_name: string;
  table_name: string;
  status: ExtensionSchemaStatus;
  hidden_at: string | null;
  definition: string;
  created_at: string;
  updated_at: string;
}

export interface CoreExtensionFieldsTable {
  id: Generated<number>;
  extension_id: string;
  object: string;
  local_name: string;
  name: string;
  table_name: string;
  column_name: string | null;
  type: string;
  definition: string;
  status: ExtensionSchemaStatus;
  hidden_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Every core table and rec_* view, keyed by name. Extension (`x_*`) tables are never listed here.
 */
export type ChangeSetState = "open" | "committed" | "closed";
export type PendingActionStatus =
  | "pending"
  | "applied"
  | "failed"
  | "skipped"
  | "rejected"
  | "expired";

/** A group of pending actions reviewed together (migration 0010, ADR 0022). */
export interface CoreChangeSetTable {
  id: string;
  title: string | null;
  session_id: string | null;
  client_id: string | null;
  client_name: string | null;
  user_id: string;
  actor: StaffActor;
  origin: JsonText;
  explicit: Defaulted<number>;
  state: Defaulted<ChangeSetState>;
  created_at: Timestamp;
  updated_at: Timestamp;
  committed_at: Defaulted<Timestamp | null>;
  closed_at: Defaulted<Timestamp | null>;
}

/** One queued operation call (migration 0010). */
export interface CorePendingActionTable {
  id: string;
  change_set_id: string;
  operation: string;
  risk: AuditRisk;
  input: JsonText;
  reason: string;
  actor: StaffActor;
  user_id: string;
  origin: JsonText;
  granted_permissions: JsonText | null;
  bulk_size: Defaulted<number>;
  preview: JsonText;
  simulated: JsonText;
  provisional: Defaulted<JsonText>;
  depends_on: Defaulted<JsonText>;
  status: Defaulted<PendingActionStatus>;
  status_reason: Defaulted<string | null>;
  error: Defaulted<JsonText | null>;
  bindings: Defaulted<JsonText | null>;
  result: Defaulted<JsonText | null>;
  request_audit_id: Defaulted<string | null>;
  applied_audit_id: Defaulted<string | null>;
  decided_by: Defaulted<string | null>;
  decided_at: Defaulted<Timestamp | null>;
  created_at: Timestamp;
  expires_at: Timestamp;
  /** Migration 0063: set when input, preview and simulated were dropped for `summary`. */
  compacted_at: Defaulted<Timestamp | null>;
  summary: Defaulted<JsonText | null>;
  /** Migration 0110: outbound items (ADR 0051): the connection, facet and gatekeeper action. */
  connection_id: Defaulted<string | null>;
  facet_key: Defaulted<string | null>;
  gk_action: Defaulted<number | null>;
  action_kind: Defaulted<string | null>;
  /** Migration 0205 (ADR 0204): why the gate routed it to review; null: never auto-approved. */
  review_source: Defaulted<ReviewSource | null>;
  /** Migration 0256 (ADR 0238): the judge's check of an outbound message (outbound.message). */
  outbound_check: Defaulted<string | null>;
  /** Migration 0370 (ADR 0345): which approval claimed it, so it applies once. */
  execution_id: Defaulted<string | null>;
  execution_at: Defaulted<Timestamp | null>;
  /** Migration 0370: how the person decided. */
  decided_via: Defaulted<ApprovalVia | null>;
}

/** How a person gave an approval (ADR 0345). */
export type ApprovalVia = "tap" | "typed" | "spoken";

export interface CorePendingActionRecordsTable {
  action_id: string;
  object_type: string;
  record_id: string;
  action: string;
}

/** An OAuth authorization a user gave an MCP client (migration 0011). */
export interface CoreConnectedAppTable {
  id: string;
  user_id: string;
  client_id: string;
  client_name: string;
  client_uri: Defaulted<string | null>;
  redirect_host: Defaulted<string | null>;
  /** JSON array of scopes. */
  scopes: JsonText;
  grant_id: Defaulted<string | null>;
  created_at: Timestamp;
  last_used_at: Defaulted<Timestamp | null>;
  revoked_at: Defaulted<Timestamp | null>;
  revoked_by: Defaulted<string | null>;
  revoke_reason: Defaulted<string | null>;
}

/** Hourly counts of successful non-human reads (migration 0060, ADR 0090). */
export interface CoreAuditReadCountsTable {
  hour: string;
  actor: AuditActor;
  user_id: string;
  caller: Defaulted<string>;
  operation: string;
  count: Defaulted<number>;
  simulated: Defaulted<number>;
  first_at: Timestamp;
  last_at: Timestamp;
}

/** Append-only markers that authorise an audit retention purge (migration 0061, ADR 0090). */
export interface CoreAuditPurgesTable {
  id: Generated<number>;
  cutoff: Timestamp;
  retention_years: number;
  audit_id: string | null;
  user_id: string | null;
  at: Timestamp;
}

/** The storage gauge's cached measurement, one row (migration 0065). */
export interface CoreStorageStatsTable {
  id: number;
  size_bytes: number | null;
  tables: JsonText;
  measured_at: Timestamp;
}

// --- Stage 6a: integrations (migrations 0110-0112) -----------------------------------------------

export type ConnectionScope = "personal" | "org";
export type SharingLevel = "full" | "metadata" | "none";
export type ConnectionStatus = "connecting" | "active" | "expired" | "error" | "disconnected";

/** Gatekeepers an admin enabled (migration 0110). */
export interface CoreIntegrationVendorTable {
  vendor: string;
  enabled: Defaulted<number>;
  mode: Defaulted<"off" | "optional" | "on" | null>;
  updated_at: Timestamp;
  updated_by: Defaulted<string | null>;
}

/** The UI's mirror of a connection; its integration host DO is the authority (migration 0110). */
export interface CoreIntegrationConnectionTable {
  id: string;
  vendor: string;
  scope: ConnectionScope;
  owner_user_id: string;
  title: string;
  account_label: Defaulted<string | null>;
  sharing_level: Defaulted<SharingLevel>;
  status: Defaulted<ConnectionStatus>;
  error: Defaulted<string | null>;
  resources: Defaulted<JsonText>;
  sync: Defaulted<JsonText>;
  created_at: Timestamp;
  updated_at: Timestamp;
  connected_at: Defaulted<Timestamp | null>;
  disconnected_at: Defaulted<Timestamp | null>;
  last_sync_at: Defaulted<Timestamp | null>;
}

/** Outbound action kinds and their auto-approval (migration 0110, ADR 0051). */
export interface CoreOutboundKindTable {
  tag: string;
  vendor: string;
  label: string;
  auto_approvable: Defaulted<number>;
  auto_approve: Defaulted<number>;
  first_seen_at: Timestamp;
  updated_at: Timestamp;
  updated_by: Defaulted<string | null>;
}

/** Inbound webhook and sync events for stage 5 (migration 0110). */
export interface CoreIntegrationEventTable {
  id: string;
  source: "webhook" | "sync";
  connection_id: Defaulted<string | null>;
  type: string;
  external_id: Defaulted<string | null>;
  payload: JsonText;
  occurred_at: Timestamp;
  created_at: Timestamp;
  consumed_at: Defaulted<Timestamp | null>;
}

/** A message or event seen in one mailbox or calendar (migration 0111). */
export interface CoreSyncItemTable {
  connection_id: string;
  provider_id: string;
  external_key: string;
  kind: "email" | "meeting";
  activity_id: Defaulted<string | null>;
  /** Migration 0112: when the message was sent or the event starts (delete reconciliation). */
  occurred_at: Defaulted<Timestamp | null>;
  updated_at: Timestamp;
}

/** Suggested contacts (migration 0111, ADR 0052). */
export interface CoreSuggestedContactTable {
  email: string;
  domain: string;
  name: Defaulted<string | null>;
  message_count: Defaulted<number>;
  first_seen_at: Timestamp;
  last_seen_at: Timestamp;
  status: Defaulted<"open" | "added" | "dismissed">;
  person_id: Defaulted<string | null>;
  decided_by: Defaulted<string | null>;
  decided_at: Defaulted<Timestamp | null>;
}

/** Job-change suggestions from mail signals (migration 0111). */
export interface CoreJobChangeSuggestionTable {
  id: string;
  person_id: string;
  signal: "bounce" | "signature" | "domain";
  dedupe_key: string;
  evidence: JsonText;
  proposal: JsonText;
  status: Defaulted<"open" | "applied" | "dismissed">;
  created_at: Timestamp;
  decided_by: Defaulted<string | null>;
  decided_at: Defaulted<Timestamp | null>;
}

/** The last signature seen from a known person (migration 0111). */
export interface CorePersonSignatureTable {
  person_id: string;
  email: string;
  signature_hash: string;
  company: Defaulted<string | null>;
  title: Defaulted<string | null>;
  seen_at: Timestamp;
}

/**
 * The transition engine's history (migration 0420, ADR 0425; `core_stage_history` before it): one
 * position a record has been in. `left_at` is null for the current one. A stage row holds the
 * stage record's id and open, won or lost; a state row holds the state's value, no group, and
 * `open` or `final`.
 */
export interface CoreTransitionHistoryTable {
  id: string;
  object_type: string;
  record_id: string;
  form: Generated<"stages" | "states">;
  position_id: string;
  group_id: string | null;
  position_type: "open" | "won" | "lost" | "final";
  entered_at: Timestamp;
  left_at: Timestamp | null;
  entered_by: string | null;
  /** Who made the move: staff, a customer, or platform code. */
  entered_as: Generated<"staff" | "customer" | "host">;
}

/** Migration 0421 (ADR 0426): an order. Amounts are integers in the currency's minor unit. */
export type OrderState = "pending" | "part_paid" | "paid" | "cancelled" | "expired" | "refunded";
export interface CoreOrderTable {
  id: string;
  /** Null when the address matched several people, and after the person is erased. */
  person_id: string | null;
  email: string | null;
  currency: string;
  total: number;
  /** The sum of the verified payments applied. */
  paid: Generated<number>;
  state: Generated<OrderState>;
  pay: Generated<"full" | "deposit">;
  deposit: Defaulted<number | null>;
  balance_due_at: Defaulted<Timestamp | null>;
  expires_at: Defaulted<Timestamp | null>;
  placed_as: "customer" | "public" | "staff";
  provider: Defaulted<string | null>;
  provider_ref: Defaulted<string | null>;
  /** SHA-256 of a guest's token for this one order. */
  access_hash: Defaulted<string | null>;
  access_until: Defaulted<Timestamp | null>;
  paid_at: Defaulted<Timestamp | null>;
  cancelled_at: Defaulted<Timestamp | null>;
  refunded_at: Defaulted<Timestamp | null>;
  created_at: Timestamp;
  updated_at: Timestamp;
  /** Counts updates; a write from a stale read fails (trigger core_order_stale). */
  version: Generated<number>;
  /** Migration 0422: what has gone back to the buyer, the sum of the confirmed refunds. */
  refunded: Generated<number>;
  /** Migration 0422: SHA-256 of the confirmation email's token for this one order. */
  email_link_hash: Defaulted<string | null>;
  /** Migration 0516: the provider's tax on the applied payments (ADR 0479). */
  tax_amount: Generated<number>;
  /** Migration 0516: the tax the provider said went back with refunds. */
  tax_refunded: Generated<number>;
  /** Migration 0516: the country the latest taxed payment was charged for. */
  tax_country: Defaulted<string | null>;
  /** Migration 0530: a subscription period's order (ADR 0486): its subscription, period, invoice. */
  subscription_id: Defaulted<string | null>;
  period_start: Defaulted<Timestamp | null>;
  period_end: Defaulted<Timestamp | null>;
  invoice_ref: Defaulted<string | null>;
  /** Migration 0530: a period paid other than as agreed, recorded for what was paid. */
  period_flag: Defaulted<"paid_less" | "paid_more" | "not_as_agreed" | null>;
  /**
   * Migration 0856 (ADR 0647): when the provider took a period's payment (its verified event's
   * time), as against `paid_at` (when the host processed it). Null: not a period's order.
   */
  provider_paid_at: Defaulted<Timestamp | null>;
  /** Migration 0950: the sum of the order's adjustments; `total` is after them (ADR 0690). */
  discount: Generated<number>;
}

export interface CoreOrderLineTable {
  id: string;
  order_id: string;
  position: number;
  /** What is bought: a sellable object's registry name and the record's id. */
  object_type: string;
  record_id: string;
  title: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  created_at: Timestamp;
  /** Migration 0516: the provider's tax on this line's share of each payment. */
  tax_amount: Generated<number>;
  /** Migration 0516: the product tax code it was last charged at. */
  tax_code: Defaulted<string | null>;
  /** Migration 0950: the line's share of the order's adjustments; its net is the difference. */
  line_discount: Generated<number>;
}

/**
 * Money off an order (stage 34, ADR 0690, migration 0950): on a line, or on the whole order and
 * spread over its lines. Never changed, except marked removed once and a reason blanked by erase.
 */
export interface CoreOrderAdjustmentTable {
  id: string;
  order_id: string;
  /** Null: the whole order, spread over its lines in proportion. */
  line_id: string | null;
  kind: "code" | "automatic" | "staff" | "referral";
  source_object: Defaulted<string | null>;
  source_id: Defaulted<string | null>;
  /** A staff adjustment: the user who gave it. */
  given_by: Defaulted<string | null>;
  reason: Defaulted<string | null>;
  /** Asked as a percentage, when it was. */
  percent: Defaulted<number | null>;
  /** Positive minor units. */
  amount: number;
  /** The pending action it waited in, when it did. */
  approval: Defaulted<string | null>;
  created_at: Timestamp;
  removed_at: Defaulted<Timestamp | null>;
  removed_by: Defaulted<string | null>;
}

/** A record a paid order line granted (stage 27, ADR 0435, migration 0450). */
export interface CoreOrderGrantTable {
  /** The granted record: its object's registry name and its id. */
  object_type: string;
  record_id: string;
  order_id: string;
  line_id: string;
  /** The host's unguessable code, when the grant declares one. Unique. */
  code: string | null;
  created_at: Timestamp;
}

/** A verified payment the provider reported, once per provider event. */
export interface CoreOrderPaymentTable {
  provider: string;
  event_id: string;
  order_id: string;
  amount: number;
  currency: string;
  outcome: "applied" | "mismatch" | "late";
  payment_ref: Defaulted<string | null>;
  received_at: Timestamp;
  /** Migration 0422: a late payment staff honoured, or that was refunded. */
  resolved: Defaulted<"honoured" | "refunded" | null>;
  resolved_at: Defaulted<Timestamp | null>;
  /** Migration 0516: the provider's tax on this payment, and its country. Null: not taxed. */
  tax_amount: Defaulted<number | null>;
  tax_country: Defaulted<string | null>;
  /** Migration 0530: the subscription invoice this payment paid. */
  invoice_ref: Defaulted<string | null>;
}

/** Migration 0422: a checkout the host opened on the provider's page for an order. */
export interface CoreOrderCheckoutTable {
  provider: string;
  ref: string;
  order_id: string;
  amount: number;
  currency: string;
  kind: "full" | "deposit" | "balance" | "part";
  created_at: Timestamp;
  /** Migration 0516: the taxed lines sent to the provider (JSON). Null: not taxed. */
  tax_lines: Defaulted<string | null>;
}

/** Migration 0422: a verified payment or refund event the gatekeeper delivered. */
export interface CorePaymentEventTable {
  provider: string;
  event_id: string;
  kind: "payment" | "refund" | "subscription";
  connection_id: Defaulted<string | null>;
  /** The event as JSON: ids, amounts and the currency. */
  payload: string;
  received_at: Timestamp;
  applied_at: Defaulted<Timestamp | null>;
  outcome: Defaulted<string | null>;
  attempts: Generated<number>;
}

/** Migration 0422: a refund staff asked for, or the provider confirmed. */
export interface CoreOrderRefundTable {
  id: string;
  order_id: string;
  provider: string;
  payment_ref: Defaulted<string | null>;
  amount: number;
  currency: string;
  reason: Defaulted<string | null>;
  status: "requested" | "confirmed";
  pending_action_id: Defaulted<string | null>;
  requested_by: Defaulted<string | null>;
  requested_at: Defaulted<Timestamp | null>;
  provider_refund_ref: Defaulted<string | null>;
  event_id: Defaulted<string | null>;
  confirmed_at: Defaulted<Timestamp | null>;
  created_at: Timestamp;
  /** Migration 0516: the tax this refund gave back, when the provider said. */
  tax_amount: Defaulted<number | null>;
  /** Migration 0530: a credit note's tax that arrived before the refund's confirmation. */
  reported_tax: Defaulted<number | null>;
}

/** Migration 0530 (ADR 0485): a subscription's state, mirrored from the provider's. */
export type SubscriptionState =
  | "incomplete"
  | "expired"
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "paused"
  | "ended";
export type SubscriptionInterval = "week" | "month" | "year";

/** Migration 0530: a subscription checkout the host opened. */
export interface CoreSubscriptionCheckoutTable {
  id: string;
  provider: string;
  ref: string;
  payer_person_id: string | null;
  holder_person_id: string | null;
  email: string | null;
  placed_as: "customer" | "public" | "staff";
  plan_object: string;
  plan_id: string;
  plan_title: string;
  amount: number;
  currency: string;
  interval: SubscriptionInterval;
  trial_days: Defaulted<number | null>;
  trial_end: Defaulted<Timestamp | null>;
  tax_code: Defaulted<string | null>;
  subscription_ref: Defaulted<string | null>;
  created_at: Timestamp;
  /** Migration 0532: the continuation offer this checkout was opened from, if any. */
  offer_id: Defaulted<string | null>;
  /**
   * Migration 0855 (ADR 0646): its Person or address was erased before the provider confirmed
   * it. A later confirmation makes no subscription.
   */
  erased_at: Defaulted<string | null>;
  /**
   * Migration 0856 (stage 44 step 7, ADR 0647): the cooling-off days in force when it was started
   * (the plan's pack's setting): the subscription's days for good, whatever the setting later.
   * Null: no cooling off on the plan, or started before it was built (0 days).
   */
  cooling_off_days: Defaulted<number | null>;
}

/** Migration 0530: a subscription the provider runs and the host mirrors. */
export interface CoreSubscriptionTable {
  id: string;
  payer_person_id: string | null;
  holder_person_id: string | null;
  email: string | null;
  placed_as: "customer" | "public" | "staff";
  plan_object: string;
  plan_id: string;
  plan_title: string;
  amount: number;
  currency: string;
  interval: SubscriptionInterval;
  tax_code: Defaulted<string | null>;
  state: Generated<SubscriptionState>;
  provider: string;
  provider_ref: string;
  customer_ref: Defaulted<string | null>;
  trial_end: Defaulted<Timestamp | null>;
  current_period_start: Defaulted<Timestamp | null>;
  current_period_end: Defaulted<Timestamp | null>;
  cancel_at_period_end: Generated<number>;
  /** A date it ends on that was set at the provider another way; resume does not undo it. */
  cancel_at: Defaulted<Timestamp | null>;
  canceled_at: Defaulted<Timestamp | null>;
  ended_at: Defaulted<Timestamp | null>;
  end_reason: Defaulted<string | null>;
  action_url: Defaulted<string | null>;
  failing_since: Defaulted<Timestamp | null>;
  observed_at: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: Generated<number>;
}

/**
 * Migration 0531: one free trial per holder per plan object (ADR 0489). A checkout opened with a
 * trial holds it until `held_until`; the provider's confirmation uses it (`used_at`).
 */
export interface CoreSubscriptionTrialTable {
  checkout_id: string;
  holder_person_id: string;
  plan_object: string;
  plan_id: string;
  url: string;
  checkout_ref: string;
  /** `customer:<id>` or `staff:<user id>`: the page goes back only to whoever opened it. */
  opened_by: string;
  amount: number;
  trial_days: number;
  held_until: Timestamp;
  used_at: Defaulted<Timestamp | null>;
  /** A lapsed hold released once the provider said its page expired uncompleted. */
  released_at: Defaulted<Timestamp | null>;
  created_at: Timestamp;
}

/** Migration 0580 (stage 32b, ADR 0510): the record a subscription granted (a membership). */
export interface CoreSubscriptionGrantTable {
  subscription_id: string;
  object_type: string;
  record_id: string;
  created_at: Timestamp;
}

/**
 * Migration 0630 (stage 32b, ADRs 0530 and 0531): a plan change or a pause the host asked the
 * provider for, and how far it has got.
 */
export interface CoreSubscriptionChangeTable {
  id: string;
  subscription_id: string;
  kind: "upgrade" | "downgrade" | "pause";
  state: "requested" | "waiting" | "applied" | "lapsed" | "withdrawn";
  from_plan_id: string;
  from_plan_title: string;
  from_amount: number;
  to_plan_id: string | null;
  to_plan_title: string | null;
  to_amount: number | null;
  pause_from: Timestamp | null;
  pause_until: Timestamp | null;
  effective_at: Timestamp | null;
  expires_at: Timestamp;
  call_outcome: "sent" | "pending" | "unknown" | "refused" | null;
  call_error: string | null;
  action_url: string | null;
  end_outcome: "sent" | "pending" | "unknown" | "refused" | null;
  end_error: string | null;
  end_at: Timestamp | null;
  reason: string;
  requested_by: string;
  requested_at: Timestamp;
  applied_at: Timestamp | null;
  updated_at: Timestamp;
}

/**
 * Migration 0856 (stage 44 step 7, ADR 0647): a cooling off asked for, one per subscription. Its
 * refunds are owed (core_sellable_refund_due) in the batch of the provider's event that shows the
 * subscription ended.
 */
export interface CoreSubscriptionCoolOffTable {
  subscription_id: string;
  holder_person_id: string | null;
  asked_by: "payer" | "staff";
  asked_by_user: string | null;
  days: number;
  window_ends_at: Timestamp;
  state: "asked" | "ended" | "lapsed";
  call_outcome: "sent" | "pending" | "unknown" | "refused" | null;
  asked_at: Timestamp;
  deadline_at: Timestamp;
  last_asked_at: Timestamp;
  ask_count: Defaulted<number>;
  ended_at: Timestamp | null;
  finished: Defaulted<number>;
  /** Staff asked to finish a lapsed one, and what came of ending it at the provider. */
  finish_state: Defaulted<"asked" | "sent" | "pending" | "unknown" | "stuck" | null>;
  finish_asked_at: Defaulted<Timestamp | null>;
  owed_from: Defaulted<Timestamp | null>;
  owed_to: Defaulted<Timestamp | null>;
  lapsed_because: Defaulted<"deadline" | "action" | "end_time" | "used" | null>;
  told_at: Defaulted<Timestamp | null>;
  release_left: Defaulted<number>;
  released_count: Defaulted<number>;
  release_stopped: Defaulted<number>;
  release_failures: Defaulted<number>;
  mail_state: Defaulted<"due" | "sending" | "sent" | "pending" | "failed" | null>;
  mail_claimed_at: Defaulted<Timestamp | null>;
  mail_tries: Defaulted<number>;
  updated_at: Timestamp;
}

/**
 * Migration 0856 (ADR 0647): every cancel of a cooling off that waited for a person at the
 * gatekeeper, kept for good; `ask` is the ask it was made by.
 */
export interface CoreSubscriptionCoolOffActionTable {
  subscription_id: string;
  action_id: string;
  ask: number;
  created_at: Timestamp;
}

/**
 * Migration 0581 (stage 32b, ADR 0512): a Person's one purchase of something sold once per Person
 * (an intro offer), held from the order's start, used when it is paid, released when it expires.
 */
export interface CoreSellableOnceTable {
  id: string;
  person_id: string;
  object_type: string;
  record_id: string;
  /** Null when given by hand (ADR 0513). */
  order_id: string | null;
  state: "held" | "used" | "released";
  source: Defaulted<"order" | "by_hand">;
  given_by: Defaulted<string | null>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * Migration 0532 (stage 32a, ADRs 0491 and 0492): a continuation offer. An address, its Person,
 * a plan and the date the person has paid up to elsewhere; taken once, by the person signed in as
 * the address, through a provider page it holds while that page can be completed.
 */
export interface CoreSubscriptionOfferTable {
  id: string;
  plan_object: string;
  plan_id: string;
  email: string;
  person_id: string | null;
  free_until: Timestamp;
  reference: Defaulted<string | null>;
  imported_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  checkout_id: Defaulted<string | null>;
  checkout_ref: Defaulted<string | null>;
  checkout_url: Defaulted<string | null>;
  held_until: Defaulted<Timestamp | null>;
  subscription_id: Defaulted<string | null>;
  taken_at: Defaulted<Timestamp | null>;
  charged_from_start: Defaulted<number>;
  withdrawn_at: Defaulted<Timestamp | null>;
  withdrawn_by: Defaulted<string | null>;
  withdraw_reason: Defaulted<string | null>;
  reissued_as: Defaulted<string | null>;
  /** Bumped by exactly one on every change; a write from an older read fails (migration 0532). */
  version: Defaulted<number>;
}

export interface CrmOrderView {
  id: string;
  person_id: string | null;
  email: string | null;
  currency: string;
  total: number;
  paid: number;
  balance: number;
  refunded: number;
  state: OrderState;
  pay: "full" | "deposit";
  deposit: number | null;
  balance_due_at: Timestamp | null;
  expires_at: Timestamp | null;
  placed_as: "customer" | "public" | "staff";
  paid_at: Timestamp | null;
  cancelled_at: Timestamp | null;
  refunded_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  tax_amount: number;
  tax_refunded: number;
  tax_country: string | null;
  /** Paid less refunded, less the tax still held. */
  net: number;
  /** Migration 0950: the sum of the order's adjustments (ADR 0690). */
  discount: number;
}

export interface CrmOrderLineView {
  id: string;
  order_id: string;
  person_id: string | null;
  position: number;
  object_type: string;
  record_id: string;
  title: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  created_at: Timestamp;
  tax_amount: number;
  tax_code: string | null;
  /** Migration 0950: the line's share of the adjustments, and its total after them. */
  line_discount: number;
  line_net: number;
}

/** Migration 0950: an order's adjustments, for reports (ADR 0690). */
export interface CrmOrderAdjustmentView {
  id: string;
  order_id: string;
  person_id: string | null;
  line_id: string | null;
  kind: "code" | "automatic" | "staff" | "referral";
  source_object: string | null;
  source_id: string | null;
  given_by: string | null;
  reason: string | null;
  percent: number | null;
  amount: number;
  approval: string | null;
  created_at: Timestamp;
  removed_at: Timestamp | null;
  removed_by: string | null;
  order_state: OrderState;
  currency: string;
}

export interface CrmStageHistoryView {
  id: string;
  object_type: string;
  record_id: string;
  stage_id: string;
  group_id: string | null;
  stage_type: "open" | "won" | "lost";
  entered_at: Timestamp;
  left_at: Timestamp | null;
  is_current: number;
  days_in_stage: number;
  entered_by: string | null;
}

/** `rec_state_history` (migration 0420): the history of state-driven objects. */
export interface RecStateHistoryView {
  id: string;
  object_type: string;
  record_id: string;
  state: string;
  is_final: number;
  entered_at: Timestamp;
  left_at: Timestamp | null;
  is_current: number;
  days_in_state: number;
  entered_by: string | null;
  entered_as: "staff" | "customer" | "host";
}

/** Stage 8 (migration 0160): installer choices, JSON under key 'deployment' (no secrets). */
export interface CoreInstallTable {
  key: string;
  value: JsonText;
  updated_at: Timestamp;
}

/** Stage 8 (migration 0160): every update and rollback, with its Time Travel bookmark. */
export interface CoreUpdateRunsTable {
  id: string;
  kind: "update" | "rollback";
  from_version: string | null;
  to_version: string;
  status: "running" | "succeeded" | "rolled_back" | "failed";
  step: string | null;
  bookmark: string | null;
  bundle_digest: string | null;
  preflight: JsonText | null;
  error: string | null;
  started_by: string | null;
  surface: "ui" | "cli";
  started_at: Timestamp;
  finished_at: Timestamp | null;
}

/** Stage 8 (migration 0160): public GitHub Releases per channel, cached. */
export interface CoreReleaseCacheTable {
  channel: "stable" | "beta";
  releases: JsonText;
  fetched_at: Timestamp;
}

/** Stage 8 (migration 0161): the first-run setup wizard, one row. */
export interface CoreSetupTable {
  id: number;
  status: "pending" | "in_progress" | "completed" | "skipped";
  step: string;
  data: JsonText;
  updated_at: Timestamp;
  updated_by: string | null;
  completed_at: Timestamp | null;
}

/** Stage 8 (migration 0161): records "Install sample data" created. */
export interface CoreSampleRecordsTable {
  object_type: string;
  record_id: string;
  created_at: Timestamp;
}

/** Why the gate routed a pending action to review (migration 0205, ADR 0204). */
export type ReviewSource = "policy" | "floor" | "always" | "dependency";

/** The written policy, one row per version (migration 0205, ADR 0204). */
export interface CoreWrittenPolicyTable {
  version: number;
  text: string;
  hash: string;
  created_at: Timestamp;
  created_by: string;
}

export type AdjudicationMode = "shadow" | "active";
export type AdjudicationVerdict = "approve" | "deny" | "escalate";
export type AdjudicationOutcome = "recorded" | "approved" | "apply_failed" | "escalated";

/** One policy adjudicator verdict per pending action (migration 0205, ADR 0204). */
export interface CoreAdjudicationTable {
  id: string;
  action_id: string;
  judged_at: Timestamp;
  mode: AdjudicationMode;
  verdict: AdjudicationVerdict;
  confidence: number;
  reason: string;
  outcome: AdjudicationOutcome;
  acted: Defaulted<number>;
  note: Defaulted<string | null>;
  provider: Defaulted<string | null>;
  model: Defaulted<string | null>;
  policy_version: Defaulted<number | null>;
  policy_hash: Defaulted<string | null>;
  threshold: number;
  error: Defaulted<JsonText | null>;
  audit_id: string;
  /** Migration 0251 (ADR 0233): the Jev reviewer's raw answer; NULL for the LLM reviewer. */
  judgement: Defaulted<JsonText | null>;
}

/** Cached `summarise` output (migration 0150, ADR 0153). */
export interface CoreAiSummaryTable {
  kind: "record" | "meeting" | "activity" | "changeset";
  subject_type: string;
  subject_id: string;
  input_hash: string;
  text: string;
  model: string;
  /** JSON array of the record ids the input was built from. */
  sources: string;
  created_at: string;
  created_by: string | null;
  /** Migration 0255 (ADR 0237): the judge's check of the summary (summary.statements), JSON. */
  checks: Defaulted<string | null>;
}

/** One embedded record: the hash of the embedded text (migration 0150, ADR 0154). */
export interface CoreEmbeddingTable {
  object_type: string;
  record_id: string;
  vector_id: string;
  text_hash: string;
  model: string;
  embedded_at: string;
}

/** Records whose embedding may be stale, drained in batches (migration 0150, ADR 0154). */
export interface CoreEmbeddingQueueTable {
  object_type: string;
  record_id: string;
  queued_at: string;
  attempts: Generated<number>;
}

/** Migration 0220 (ADR 0211): plan entitlements, written only by the hosted control plane. */
export interface CoreEntitlementsTable {
  key: string;
  value: string;
  updated_at: string;
}

export type SupportGrantStatus = "requested" | "approved" | "denied" | "revoked";

/** Migration 0221 (ADR 0212): a customer-approved, time-limited support grant. */
export interface CoreSupportGrantsTable {
  id: string;
  staff_email: string;
  reason: string;
  role: UserRole;
  requested_minutes: number;
  status: SupportGrantStatus;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  expires_at: string | null;
  user_id: string | null;
}

/**
 * Migration 0260 (ADR 0213 amendment): model usage counted in a hosted workspace, per day, role
 * and provider. `billed` is 1 for Platform AI, 0 for the customer's own key.
 */
/** Voice settings per person (ADR 0349). */
export interface CoreVoicePrefsTable {
  user_id: string;
  voice_id: string;
  speed: number;
  default_mode: string;
  read_out: string;
  created_at: string;
  updated_at: string;
}

/** A device someone has used voice on; `mode` is set once it differs from their default. */
export interface CoreVoiceDeviceTable {
  user_id: string;
  device_id: string;
  label: string;
  mode: string | null;
  last_seen_at: string;
}

/** Speech usage per day, person, role and provider (ADR 0349's amendment). */
export interface CoreVoiceUsageTable {
  day: string;
  user_id: string;
  role: string;
  provider: string;
  requests: number;
  audio_seconds: number;
  characters: number;
}

export interface CoreAiUsageTable {
  day: string;
  role: string;
  provider: string;
  billed: number;
  requests: number;
  tokens_in: number;
  tokens_out: number;
}

/** Migration 0358 (ADR 0341): one row per assistant model response, for review. Kept 180 days. */
export interface CoreAiCacheObservationTable {
  id: Generated<number>;
  at: string;
  provider: string;
  model: string;
  role: string;
  gap_seconds: number;
  prefix_unchanged: number;
  cached_tokens: number;
  prompt_tokens: number;
  prefix_tokens: number | null;
}

/** Migration 0359 (ADR 0341): one row per compaction planner run, actual cost filled in later. */
export interface CoreAiCompactionDecisionTable {
  id: string;
  at: string;
  provider: string;
  model: string;
  role: string;
  decision: "compact" | "continue";
  rule: string;
  /** JSON: the planner's input, verbatim. */
  input: string;
  /** JSON: the planner's result. */
  result: string;
  actual_turns: number | null;
  actual_cost: number | null;
  actual_at: string | null;
}

/** Migration 0360 (ADR 0341): the learned cache lifetime per provider and model. */
export interface CoreAiCacheEstimateTable {
  provider: string;
  model: string;
  /** JSON: the learner's state. */
  state: string;
  learned_seconds: number | null;
  published_seconds: number | null;
  confidence: number | null;
  sample_size: number;
  version: number;
  updated_at: string;
}

/** Migration 0360: each change of a learned estimate. */
export interface CoreAiCacheEstimateHistoryTable {
  id: Generated<number>;
  provider: string;
  model: string;
  at: string;
  from_seconds: number | null;
  to_seconds: number | null;
  reason: "rise" | "fall";
  sample_size: number;
}

/**
 * Migration 0252 (ADR 0234): judge calls and input tokens per day and placement, counted by a
 * statement in the batch a placement already writes.
 */
export interface CoreJudgeUsageTable {
  day: string;
  placement: string;
  calls: number;
  input_tokens: number;
}

/** A published version of a record's content (migration 0470, ADR 0446). */
export interface CorePublishVersionTable {
  object_type: string;
  record_id: string;
  version: number;
  /** JSON: the content fields' values when it was published. */
  content: string;
  bytes: number;
  /** 1 for the version readers are given; at most one per record. */
  current: number;
  published_at: Timestamp;
  /** The person who published it: for an approved request (ADR 0480), the approver. */
  published_by: string | null;
  note: string | null;
  /** Migration 0520: for an approved request, the staff user the AI actor acted for. */
  requested_by: string | null;
  /** Migration 0520: for an approved request, the actor that asked (`mcp`, `assistant`, ...). */
  requested_via: string | null;
  /**
   * Migration 0971 (ADR 0702): on an acknowledged object, 1 when this version asks everyone who
   * must read it to confirm again, 0 for a small fix; NULL on other objects.
   */
  read_again: ColumnType<number | null, number | null | undefined, never>;
}

/** `core_publish_schedule` (migration 0460): a publish a person scheduled (ADR 0441). */
export interface CorePublishScheduleTable {
  object_type: string;
  record_id: string;
  publish_at: Timestamp;
  /** JSON: the content fields' values when it was scheduled. */
  content: string;
  bytes: number;
  note: string | null;
  /** The person who scheduled it: for an approved request (ADR 0480), the approver. */
  scheduled_by: string;
  scheduled_at: Timestamp;
  /** Migration 0520: for an approved request, the staff user the AI actor acted for. */
  requested_by: string | null;
  /** Migration 0520: for an approved request, the actor that asked. */
  requested_via: string | null;
  /** Migration 0971 (ADR 0702): the version's read-again choice, carried to it on publish. */
  read_again: ColumnType<number | null, number | null | undefined, number | null>;
}

/**
 * `core_published_text` (migration 0970, ADR 0700): one section of a record's current published
 * version, as `content.search` finds it. Written only by content/published-text.ts.
 */
export interface CorePublishedTextTable {
  id: Generated<number>;
  object_type: string;
  record_id: string;
  version: number;
  field: string;
  section: number;
  anchor: string | null;
  heading: string;
  body: string;
}

/**
 * `core_publish_ack` (migration 0971, ADR 0702): a staff account confirmed it read and understood
 * one published version. Insert only; a trigger refuses any change.
 */
export interface CorePublishAckTable {
  object_type: string;
  record_id: string;
  version: number;
  account_id: string;
  confirmed_at: string;
  how: ColumnType<"self", "self" | undefined, never>;
}

/** `core_slug_redirect` (migration 0460): an old slug of a published record (ADR 0442). */
export interface CoreSlugRedirectTable {
  object_type: string;
  slug: string;
  record_id: string;
  created_at: Timestamp;
}

/** `core_preview_link` (migration 0460): a link to one record's working copy (ADR 0443). */
export interface CorePreviewLinkTable {
  /** SHA-256 of the token, hex. The token itself is never stored. */
  token_hash: string;
  object_type: string;
  record_id: string;
  expires_at: Timestamp;
  created_by: string;
  created_at: Timestamp;
}

/** `core_content_generation` (migration 0460): bumped by every change the public reads (ADR 0442). */
export interface CoreContentGenerationTable {
  object_type: string;
  generation: Generated<number>;
  epoch: string;
  changed_at: Timestamp;
}

/**
 * `core_media` (migration 0461, rebuilt by 0510): one item of the media library. A picture or a
 * file is an original in R2 (`key`); a video is held in Cloudflare Stream (`stream_uid`, its
 * `state`), with nothing in R2 (stage 42, ADR 0475).
 */
export interface CoreMediaTable {
  id: string;
  kind: Generated<"image" | "video" | "file">;
  key: string | null;
  name: string;
  type:
    | "image/jpeg"
    | "image/png"
    | "image/gif"
    | "image/webp"
    | "image/avif"
    | "application/pdf"
    | "video/stream";
  bytes: number;
  /** A video: Stream's id for it. */
  stream_uid: Generated<string | null>;
  /** A video: uploading, processing, ready or failed. */
  state: Generated<"uploading" | "processing" | "ready" | "failed" | null>;
  /** A failed video: Stream's reason code. */
  state_reason: Generated<string | null>;
  /** A video: its length in seconds, once Stream knows it. */
  duration: Generated<number | null>;
  width: number | null;
  height: number | null;
  alt: string | null;
  created_at: Timestamp;
  created_by: string | null;
  updated_at: Timestamp;
  updated_by: string | null;
  deleted_at: Timestamp | null;
  deleted_by: string | null;
  /** SHA-256 of the file, hex (migration 0501): an upload of the same file returns this item. */
  sha256: string | null;
}

/** `core_media_caption` (migration 0510): a video's caption track in one language. */
export interface CoreMediaCaptionTable {
  media_id: string;
  language: string;
  label: string;
  generated: Generated<number>;
  state: "processing" | "ready" | "failed";
  created_at: Timestamp;
  created_by: string | null;
}

/** `rec_media` (migration 0461): the live media items. */
export type RecMediaView = Omit<CoreMediaTable, "deleted_at" | "deleted_by" | "sha256">;

/** `core_import_key` (migration 0501): what an import made, and the values it last wrote. */
export interface CoreImportKeyTable {
  object_type: string;
  import_key: string;
  record_id: string;
  /** JSON: field name → the value the import wrote. */
  written: string;
  imported_at: Timestamp;
  imported_by: string;
}

/** `core_published_media` (migration 0461): media a record's current version references. */
export interface CorePublishedMediaTable {
  media_id: string;
  object_type: string;
  record_id: string;
  /** The field of the version that shows it (migration 0500). */
  field: string;
  /**
   * Who outside the org reads the part of the field it is in (migration 0510, ADR 0477): all
   * who read the field, only holders of access to the record, or no one (a private part).
   */
  reach: Generated<"all" | "holders" | "private">;
}

/** `rec_publish_version` (migrations 0470, 0520): every version, without its content. */
export interface RecPublishVersionView {
  object_type: string;
  record_id: string;
  version: number;
  current: number;
  bytes: number;
  published_at: string;
  published_by: string | null;
  note: string | null;
  requested_by: string | null;
  requested_via: string | null;
}

export interface CoreDatabase {
  core_ai_usage: CoreAiUsageTable;
  core_ai_cache_observation: CoreAiCacheObservationTable;
  core_ai_compaction_decision: CoreAiCompactionDecisionTable;
  core_ai_cache_estimate: CoreAiCacheEstimateTable;
  core_ai_cache_estimate_history: CoreAiCacheEstimateHistoryTable;
  core_voice_prefs: CoreVoicePrefsTable;
  core_voice_device: CoreVoiceDeviceTable;
  core_voice_usage: CoreVoiceUsageTable;
  core_judge_usage: CoreJudgeUsageTable;
  core_entitlements: CoreEntitlementsTable;
  core_support_grants: CoreSupportGrantsTable;
  core_install: CoreInstallTable;
  core_update_runs: CoreUpdateRunsTable;
  core_release_cache: CoreReleaseCacheTable;
  core_setup: CoreSetupTable;
  core_sample_records: CoreSampleRecordsTable;
  core_ai_summary: CoreAiSummaryTable;
  core_written_policy: CoreWrittenPolicyTable;
  core_adjudication: CoreAdjudicationTable;
  core_embedding: CoreEmbeddingTable;
  core_embedding_queue: CoreEmbeddingQueueTable;
  core_meta: CoreMetaTable;
  core_migrations: CoreMigrationsTable;
  core_user: CoreUserTable;
  core_session: CoreSessionTable;
  core_account: CoreAccountTable;
  core_verification: CoreVerificationTable;
  core_settings: CoreSettingsTable;
  core_person: CorePersonTable;
  core_person_emails: CorePersonEmailsTable;
  core_person_phones: CorePersonPhonesTable;
  core_organisation: CoreOrganisationTable;
  core_duplicate_pair: CoreDuplicatePairTable;
  core_organisation_domains: CoreOrganisationDomainsTable;
  core_organisation_addresses: CoreOrganisationAddressesTable;
  core_affiliation: CoreAffiliationTable;
  core_tags: CoreTagsTable;
  core_record_tags: CoreRecordTagsTable;
  core_activity: CoreActivityTable;
  core_activity_links: CoreActivityLinksTable;
  core_task: CoreTaskTable;
  core_task_links: CoreTaskLinksTable;
  core_views: CoreViewsTable;
  core_dashboards: CoreDashboardsTable;
  core_user_home: CoreUserHomeTable;
  core_extension_settings: CoreExtensionSettingsTable;
  core_audit: CoreAuditTable;
  core_audit_changes: CoreAuditChangesTable;
  core_audit_redactions: CoreAuditRedactionsTable;
  core_change_set: CoreChangeSetTable;
  core_pending_action: CorePendingActionTable;
  core_pending_action_records: CorePendingActionRecordsTable;
  core_connected_app: CoreConnectedAppTable;
  core_audit_read_counts: CoreAuditReadCountsTable;
  core_audit_purges: CoreAuditPurgesTable;
  core_storage_stats: CoreStorageStatsTable;
  core_integration_vendor: CoreIntegrationVendorTable;
  core_integration_connection: CoreIntegrationConnectionTable;
  core_outbound_kind: CoreOutboundKindTable;
  core_integration_event: CoreIntegrationEventTable;
  core_sync_item: CoreSyncItemTable;
  core_suggested_contact: CoreSuggestedContactTable;
  core_job_change_suggestion: CoreJobChangeSuggestionTable;
  core_person_signature: CorePersonSignatureTable;
  core_search_docs: CoreSearchDocsTable;
  core_search: CoreSearchTable;
  core_extensions: CoreExtensionsTable;
  core_extension_versions: CoreExtensionVersionsTable;
  core_extension_runs: CoreExtensionRunsTable;
  core_extension_kv: CoreExtensionKvTable;
  core_extension_proposals: CoreExtensionProposalsTable;
  core_extension_objects: CoreExtensionObjectsTable;
  core_extension_fields: CoreExtensionFieldsTable;
  core_transition_history: CoreTransitionHistoryTable;
  core_order: CoreOrderTable;
  core_order_line: CoreOrderLineTable;
  core_order_adjustment: CoreOrderAdjustmentTable;
  core_order_grant: CoreOrderGrantTable;
  core_order_payment: CoreOrderPaymentTable;
  core_order_checkout: CoreOrderCheckoutTable;
  core_payment_event: CorePaymentEventTable;
  core_subscription: CoreSubscriptionTable;
  core_subscription_checkout: CoreSubscriptionCheckoutTable;
  core_subscription_trial: CoreSubscriptionTrialTable;
  core_subscription_offer: CoreSubscriptionOfferTable;
  core_subscription_grant: CoreSubscriptionGrantTable;
  core_subscription_change: CoreSubscriptionChangeTable;
  core_subscription_cool_off: CoreSubscriptionCoolOffTable;
  core_subscription_cool_off_action: CoreSubscriptionCoolOffActionTable;
  core_sellable_once: CoreSellableOnceTable;
  core_order_refund: CoreOrderRefundTable;
  core_automations: CoreAutomationsTable;
  core_routine: CoreRoutineTable;
  core_automation_runs: CoreAutomationRunsTable;
  core_automation_run_records: CoreAutomationRunRecordsTable;
  core_automation_counters: CoreAutomationCountersTable;
  core_notifications: CoreNotificationsTable;
  core_automation_binding: CoreAutomationBindingTable;
  core_automation_outbox: CoreAutomationOutboxTable;
  core_notification_preference: CoreNotificationPreferenceTable;
  core_notification_delivery: CoreNotificationDeliveryTable;
  core_assistant_conversation: CoreAssistantConversationTable;
  core_assistant_conversation_refs: CoreAssistantConversationRefsTable;
  core_assistant_thread: CoreAssistantThreadTable;
  core_assistant_thread_refs: CoreAssistantThreadRefsTable;
  core_memory: CoreMemoryTable;
  core_memory_refs: CoreMemoryRefsTable;
  core_memory_settings: CoreMemorySettingsTable;
  core_agent_job: CoreAgentJobTable;
  core_agent_job_refs: CoreAgentJobRefsTable;
  core_erased_address: CoreErasedAddressTable;
  core_blob_deletion: CoreBlobDeletionTable;
  core_assignment_rule: CoreAssignmentRuleTable;
  core_assignment_state: CoreAssignmentStateTable;
  core_assignment_fallback: CoreAssignmentFallbackTable;
  core_field_options: CoreFieldOptionsTable;
  core_customer: CoreCustomerTable;
  core_customer_session: CoreCustomerSessionTable;
  core_customer_verification: CoreCustomerVerificationTable;
  core_customer_invite: CoreCustomerInviteTable;
  core_erase_request: CoreEraseRequestTable;
  core_idempotency_key: CoreIdempotencyKeyTable;
  core_idempotency_claim: CoreIdempotencyClaimTable;
  core_device_session: CoreDeviceSessionTable;
  core_user_invite: CoreUserInviteTable;
  core_native_handoff: CoreNativeHandoffTable;
  core_email_confirmation: CoreEmailConfirmationTable;
  core_native_sign_in_confirm: CoreNativeSignInConfirmTable;
  core_capacity: CoreCapacityTable;
  core_capacity_claim: CoreCapacityClaimTable;
  core_stock_movement: CoreStockMovementTable;
  core_person_link: CorePersonLinkTable;
  core_person_carer: CorePersonCarerTable;
  core_agreement_document: CoreAgreementDocumentTable;
  core_agreement_version: CoreAgreementVersionTable;
  core_agreement_point: CoreAgreementPointTable;
  core_agreement_rev: CoreAgreementRevTable;
  core_agreement_acceptance: CoreAgreementAcceptanceTable;
  core_agreement_signature: CoreAgreementSignatureTable;
  core_agreement_answer: CoreAgreementAnswerTable;
  core_agreement_minor: CoreAgreementMinorTable;
  core_restricted_value: CoreRestrictedValueTable;
  core_agreement_desk_session: CoreAgreementDeskSessionTable;
  core_device: CoreDeviceTable;
  core_device_guard: { device_id: string; credential_hash: string };
  core_agreement_desk_guard: { session_id: string; device_id: string };
  core_agreement_copy: CoreAgreementCopyTable;
  core_agreement_hold: CoreAgreementHoldTable;
  core_person_link_guard: CorePersonLinkGuardTable;
  core_sellable_refund_due: CoreSellableRefundDueTable;
  core_routine_mail: CoreRoutineMailTable;
  core_value_mark: CoreValueMarkTable;
  core_person_signal: CorePersonSignalTable;
  core_recurrence_series: CoreRecurrenceSeriesTable;
  core_recurrence_occurrence: CoreRecurrenceOccurrenceTable;
  core_recurrence_exception: CoreRecurrenceExceptionTable;
  core_recurrence_guard: CoreRecurrenceGuardTable;
  core_staff_time: CoreStaffTimeTable;
  core_thing_time: CoreThingTimeTable;
  core_staff_qualification: CoreStaffQualificationTable;
  core_staff_away: CoreStaffAwayTable;
  core_leave_type: CoreLeaveTypeTable;
  core_leave_request: CoreLeaveRequestTable;
  core_leave_day: CoreLeaveDayTable;
  core_leave_balance_entry: CoreLeaveBalanceEntryTable;
  core_staff_hours: CoreStaffHoursTable;
  core_time_entry: CoreTimeEntryTable;
  core_staff_feed: CoreStaffFeedTable;
  core_person_code: CorePersonCodeTable;
  core_person_pin: CorePersonPinTable;
  core_identify_lockout: CoreIdentifyLockoutTable;
  core_checklist: CoreChecklistTable;
  core_checklist_step: CoreChecklistStepTable;
  core_checklist_run: CoreChecklistRunTable;
  core_checklist_tick: CoreChecklistTickTable;
  core_checklist_note: CoreChecklistNoteTable;
  core_staff_offer: CoreStaffOfferTable;
  core_staff_run: CoreStaffRunTable;
  core_staff_guard: CoreStaffGuardTable;
  /** Migration 1230 (stage 56): a note's change fails whole when its level moved meanwhile. */
  core_note_guard: CoreStaffGuardTable;
  core_staff_pay_basis: CoreStaffPayBasisTable;
  core_staff_not_worked: CoreStaffNotWorkedTable;
  core_pay_period: CorePayPeriodTable;
  core_pay_line: CorePayLineTable;
  core_finance_period: CoreFinancePeriodTable;
  core_finance_entry: CoreFinanceEntryTable;
  core_finance_entry_line: CoreFinanceEntryLineTable;
  core_finance_row: CoreFinanceRowTable;
  core_finance_counted: CoreFinanceCountedTable;
  core_finance_guard: CoreFinanceGuardTable;
  core_write_guard: CoreWriteGuardTable;
  core_allowance: CoreAllowanceTable;
  core_allowance_period: CoreAllowancePeriodTable;
  core_allowance_use: CoreAllowanceUseTable;
  core_publish_version: CorePublishVersionTable;
  core_publish_schedule: CorePublishScheduleTable;
  core_published_text: CorePublishedTextTable;
  core_publish_ack: CorePublishAckTable;
  core_slug_redirect: CoreSlugRedirectTable;
  core_preview_link: CorePreviewLinkTable;
  core_content_generation: CoreContentGenerationTable;
  core_media: CoreMediaTable;
  core_published_media: CorePublishedMediaTable;
  core_media_caption: CoreMediaCaptionTable;
  core_import_key: CoreImportKeyTable;
  core_journey: CoreJourneyTable;
  core_journey_version: CoreJourneyVersionTable;
  core_journey_entry: CoreJourneyEntryTable;
  core_journey_step_log: CoreJourneyStepLogTable;
  rec_media: RecMediaView;
  rec_publish_version: RecPublishVersionView;
  rec_stage_history: CrmStageHistoryView;
  rec_state_history: RecStateHistoryView;
  rec_user: CrmUsersView;
  rec_person: CrmPeopleView;
  rec_organisation: CrmOrganisationsView;
  rec_affiliation: CrmAffiliationsView;
  rec_activity: CrmActivitiesView;
  rec_activity_link: CrmActivityLinksView;
  rec_task: CrmTasksView;
  rec_order: CrmOrderView;
  rec_order_line: CrmOrderLineView;
  rec_order_adjustment: CrmOrderAdjustmentView;
  rec_task_link: CrmTaskLinksView;
  rec_record_tag: CrmRecordTagsView;
}
