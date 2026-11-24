// The booking-system session and facet every booking-system gatekeeper serves (ADR 0920), on the
// vendored gatekeeper interface unchanged. A gatekeeper names its system and its resource; this
// checks every input, records each read as an observation, and copies each answer into the
// contract's shape (reads.ts). There is no outbound action: no action kind is declared, nothing
// is journalled, and applying, rejecting or reverting an action is refused, because there is
// none to apply.

import { DurableObject, type RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionKind,
  AgentCatalog,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperUserVerifier,
  ResourceDescription,
} from "@composable-os/gatekeeper-interface/gatekeeper";
import { sanitizeTitle } from "@composable-os/gatekeeper-kit/action-description";
import { checkedReads } from "./reads.js";
import type { BookingSystem } from "./system.js";
import type {
  BookingSystemBooking,
  BookingSystemClass,
  BookingSystemClassType,
  BookingSystemHint,
  BookingSystemMembership,
  BookingSystemMembershipType,
  BookingSystemPage,
  BookingSystemPerson,
  BookingSystemSession,
  BookingSystemSite,
  BookingSystemStaff,
} from "./types.js";
import TYPES_CODE from "./types.txt";

export { TYPES_CODE };

/** Every method of the session: the contract has no other, and none of them writes. */
export const BOOKING_SYSTEM_SESSION_METHODS = [
  "describeSite",
  "listPeople",
  "listMembershipTypes",
  "listMemberships",
  "listClassTypes",
  "listClasses",
  "listBookings",
  "listStaff",
  "listVisits",
  "takeHints",
] as const satisfies readonly (keyof BookingSystemSession)[];

const NO_ACTIONS = "The booking-system contract is read only: it has no action to apply.";

class BookingSystemSessionImpl extends RpcTarget implements BookingSystemSession {
  readonly #reads: BookingSystemSession;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(site: string, system: () => BookingSystem, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#queue = queue;
    this.#reads = checkedReads(system, async ({ title, description }) => {
      await this.#queue.authorizeObservation({
        title: sanitizeTitle(title),
        description: `${description} (${site}).`,
      });
    });
  }

  describeSite(): Promise<BookingSystemSite> {
    return this.#reads.describeSite();
  }
  listPeople(query?: unknown): Promise<BookingSystemPage<BookingSystemPerson>> {
    return this.#reads.listPeople(query as never);
  }
  listMembershipTypes(): Promise<BookingSystemMembershipType[]> {
    return this.#reads.listMembershipTypes();
  }
  listMemberships(input: unknown): Promise<BookingSystemMembership[]> {
    return this.#reads.listMemberships(input as never);
  }
  listClassTypes(): Promise<BookingSystemClassType[]> {
    return this.#reads.listClassTypes();
  }
  listClasses(query: unknown): Promise<BookingSystemPage<BookingSystemClass>> {
    return this.#reads.listClasses(query as never);
  }
  listBookings(input: unknown): Promise<BookingSystemBooking[]> {
    return this.#reads.listBookings(input as never);
  }
  listStaff(): Promise<BookingSystemStaff[]> {
    return this.#reads.listStaff();
  }
  listVisits(query: unknown): Promise<BookingSystemPage<BookingSystemBooking>> {
    return this.#reads.listVisits(query as never);
  }
  takeHints(input: unknown): Promise<BookingSystemHint[]> {
    return this.#reads.takeHints(input as never);
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }
}

/**
 * The facet of one booking-system site. A gatekeeper extends it and says which system it talks to
 * (`system()`, which throws when the site is not set up) and how its resource is described.
 */
export abstract class BookingSystemGatekeeper<P extends object = object>
  extends DurableObject<Cloudflare.Env, P>
  implements Gatekeeper<BookingSystemSession>
{
  /** The system this site is kept in, from this Worker's own credentials. */
  protected abstract system(): BookingSystem;
  /** The resource URL this site is bound as. */
  protected abstract resourceUrl(): string;

  async describe(): Promise<ResourceDescription> {
    const system = this.system();
    return {
      url: this.resourceUrl(),
      title: system.title,
      snippet:
        `Read people, memberships and passes, classes, bookings and staff from ${system.title}. ` +
        "Read only: nothing is ever written to the booking system.",
      suggestedBindingName: "BOOKING_SYSTEM",
      tsType: "BookingSystemSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** None: the contract declares no outbound action. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<BookingSystemSession> {
    const system = this.system();
    // The queue is disposed when this call returns, so the session keeps its own copy.
    return new BookingSystemSessionImpl(system.title, () => this.system(), approvalQueue.dup());
  }

  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  /** Admits every collaborator: the connection belongs to the deployment, not to one person. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}

  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    _subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    return { allowedObserverIds: observers.map((observer) => observer.id) };
  }

  applyAction(_action: number): Promise<void> {
    throw new Error(NO_ACTIONS);
  }

  rejectAction(_action: number): Promise<void> {
    throw new Error(NO_ACTIONS);
  }

  revertAction(_action: number): Promise<void> {
    throw new Error(NO_ACTIONS);
  }
}
