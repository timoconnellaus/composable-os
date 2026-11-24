// Matching an outside person to a Person by address, never merged (stage 65, "Matching"; ADR 0920).
// The rules are one pure function so the host's pass and a file's dry run decide alike. The host
// supplies what only it knows: which live Persons have an address among their live addresses
// (`checkPerson`), whether an address is on the erased-address list, whether a ref is suppressed,
// the links it already holds, and its own address normaliser (`normaliseCustomerEmail`). Nothing
// here writes: a link by address changes nothing on the Person and sends nothing.

/** A link the host already holds. One made by staff is kept whatever the address. */
export interface HeldLink {
  person: string;
  how: "address" | "staff";
}

export interface MatchContext {
  /** The host's normaliser; `null` for what is not an address. */
  normalise(address: string): string | null;
  /** The live Persons with this (normalised) address among their live addresses. */
  personsWith(address: string): readonly string[];
  /** The address is on the erased-address list. */
  isErased(address: string): boolean;
  /** The ref belongs to an erased Person's outside person. */
  isSuppressed(ref: string): boolean;
  /** The link held for this ref, if any. */
  linkOf(ref: string): HeldLink | null;
}

export type MatchWhy = "several_people" | "shared_address" | "no_address";

export type MatchOutcome =
  /** Keep nothing of them: suppressed, or an erased address. */
  | { ref: string; outcome: "dropped"; why: "suppressed" | "erased_address" }
  /** A link already held stays. */
  | { ref: string; outcome: "kept"; person: string; how: "address" | "staff" }
  /** Exactly one Person has the address and nobody else kept shares it: linked, how `address`. */
  | { ref: string; outcome: "linked"; person: string }
  /** Nobody is linked; staff choose among the candidates. */
  | { ref: string; outcome: "waiting"; why: MatchWhy; candidates: string[] }
  /** No Person has the address: stays in the copy, unlinked, and links on a later pass. */
  | { ref: string; outcome: "unlinked" };

/** The outcome for each outside person, in the order given, by the spec's rules 1 to 6. */
export function matchPeople(
  people: readonly { ref: string; email: string | null }[],
  ctx: MatchContext,
): MatchOutcome[] {
  const addressOf = new Map<string, string | null>();
  for (const p of people) addressOf.set(p.ref, p.email === null ? null : ctx.normalise(p.email));
  const dropped = new Map<string, MatchOutcome>();
  for (const p of people) {
    const address = addressOf.get(p.ref) ?? null;
    if (ctx.isSuppressed(p.ref)) {
      dropped.set(p.ref, { ref: p.ref, outcome: "dropped", why: "suppressed" });
    } else if (address !== null && ctx.isErased(address)) {
      dropped.set(p.ref, { ref: p.ref, outcome: "dropped", why: "erased_address" });
    }
  }
  // How many kept outside people share each address: a family on one mailbox links nobody.
  const sharing = new Map<string, number>();
  for (const p of people) {
    const address = addressOf.get(p.ref) ?? null;
    if (address === null || dropped.has(p.ref)) continue;
    sharing.set(address, (sharing.get(address) ?? 0) + 1);
  }
  return people.map((p): MatchOutcome => {
    const gone = dropped.get(p.ref);
    if (gone) return gone;
    const address = addressOf.get(p.ref) ?? null;
    const held = ctx.linkOf(p.ref);
    if (held?.how === "staff") return { ref: p.ref, outcome: "kept", ...held };
    const persons = address === null ? [] : [...new Set(ctx.personsWith(address))];
    // A link by address holds while its Person still has the address; otherwise it is matched again.
    if (held?.how === "address" && persons.includes(held.person)) {
      return { ref: p.ref, outcome: "kept", ...held };
    }
    if (address === null)
      return { ref: p.ref, outcome: "waiting", why: "no_address", candidates: [] };
    if ((sharing.get(address) ?? 0) > 1) {
      return { ref: p.ref, outcome: "waiting", why: "shared_address", candidates: persons };
    }
    if (persons.length > 1) {
      return { ref: p.ref, outcome: "waiting", why: "several_people", candidates: persons };
    }
    const [person] = persons;
    return person === undefined
      ? { ref: p.ref, outcome: "unlinked" }
      : { ref: p.ref, outcome: "linked", person };
  });
}
