// The booking-system contract (stage 65, ADR 0920) as the host and each booking-system gatekeeper
// import it: the types, the refusal codes, the input checks and the contract's shape, the fake
// booking system, the file source, the matching rules and the conformance suite. A gatekeeper's facet extends `BookingSystemGatekeeper`
// from `./session`.

export {
  CONFORMANCE_CHECKS,
  type ConformanceCheck,
  type ConformanceContext,
  type ConformanceControl,
  type ConformanceOptions,
  type ConformanceResult,
  type ConformanceTarget,
  prepareConformance,
  runCheck,
  runConformance,
} from "./conformance.js";
export { directSession } from "./direct.js";
export {
  FAKE_CALL_METHODS,
  type FakeAccess,
  FakeBookingSystem,
  type FakeBookingSystemState,
  type FakeCallMethod,
  type FakeFailMethod,
  type FakeKind,
  type FakeOptions,
  fakeBookingSystemState,
} from "./fake.js";
export {
  type CsvLimits,
  dryRunFiles,
  FILE_PAGE,
  FileBookingSystem,
  type FileDateFormat,
  type FileDryRun,
  type FileIssue,
  type FileLoad,
  type FileSourceInput,
  fitRef,
  formulaLike,
  loadFiles,
  MAX_CELL,
  MAX_COLUMNS,
  MAX_FILE_CHARS,
  MAX_FILE_CLASSES,
  MAX_ISSUES_SHOWN,
  MAX_NAMED,
  MAX_PEOPLE_ROWS,
  MAX_TIMETABLE_ROWS,
  type PeopleFileMapping,
  parseCsv,
  type TimetableFileMapping,
} from "./file-source.js";
export {
  type HeldLink,
  type MatchContext,
  type MatchOutcome,
  type MatchWhy,
  matchPeople,
} from "./match.js";
export { checkedReads, type ReadNote } from "./reads.js";
export {
  EXPIRING_REFUSALS,
  REFUSAL_CODES,
  refusalCode,
  refuse,
  TRANSIENT_REFUSALS,
} from "./refusal.js";
export type { BookingSystem } from "./system.js";
export type * from "./types.js";
export * from "./validate.js";
