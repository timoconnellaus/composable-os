# ADR 0453: A pack's hooks give a client the hooks it can back

Status: accepted, 2026-11-21 (`fix/role-hooks-and-host-module-upgrade`, the first client). Builds on
[ADR 0418](0418-the-typed-client-as-built.md), [ADR 0436](0436-pack-roles-and-the-door-role.md)
and [ADR 0451](0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md).

## Context
A pack's headless entry took a client of every operation its hooks call (`TicketingClient`), so
only the staff client fitted it. The door role's client (`roles/ticketing.door.ts`, ADR 0451) holds
four operations, and `createTicketingHooks(react, staff.client(createTicketingDoorClient))` did not
type-check: the door scanner block could be wired only with a cast. Programs had the same problem
with a member's customer client, which holds no staff operation (`person.list`, `record.create`).
Two ways out: hooks grouped per role (`createTicketingDoorHooks`), or hooks generic over the
operations the client holds.

## Decision
**Hooks are generic over the client's operations.** Grouping per role makes a pack author write
and keep a group for every role and audience (and for every set of grants, ADR 0449), and a role
that gains a tool needs its group edited too. Being generic needs one thing from the author, which
the type checker enforces: each hook says which operations it calls.
- **Every generated client says what it holds:** `createClient` returns `operations` (its specs),
  so a client's type carries its operation names and the value carries them at run time.
- **`@composable-os/client` has the mechanism:** `PackClient<T>` (the client of a pack's
  operations, which the hooks are written against), `ClientHolding`, `OperationsOf<C>`,
  `HooksFor<H, Calls, Names>` and `packHooks(client, calls, make)`.
- **A pack writes its hooks once**, over `PackClient<ItsOperations>`, in an `all<Pack>Hooks`
  function, with a `<PACK>_HOOKS_CALL` map listing the operations each hook calls (an empty list
  for one that calls none). The map must name every hook: the type says so.
- **`create<Pack>Hooks<C extends ClientHolding>(react, client: C)`** returns, through
  `packHooks`, the hooks whose operations `client` holds: absent from the object and from its
  type, so calling one the client cannot back is a compile error at the call site, never a runtime
  surprise. `<Pack>Hooks` stays the full set (`ReturnType<typeof all<Pack>Hooks>`).
- **A block takes only the hooks it calls:** `ticketing: Pick<TicketingHooks, "useCheckIn">`. Any
  client that backs those hooks wires it with no cast.
- Applied to Ticketing (the door role's client gets `useCheckIn`, `useUndoCheckIn` and
  `useTicketPicker`) and Programs (a member's client gets the training hooks; the staff client gets
  all), and to every block of both packs.

## Consequences
- What a hook may do is still the host's. The types say which operations a client holds, not what
  an account is granted (ADR 0449): a coach without a grant still gets the hook and is refused by
  the host, and a screen that offers an action asks the host what the account holds (Programs'
  `usePublishOffered`).
- `packHooks` checks names, not shapes: a client whose operation of the same name had different
  types would pass. Every client is generated from the release's contract, from the same tool
  schemas the pack types its operations with.
- Inline React stand-ins written as lambdas in a call to a generic `create<Pack>Hooks` can lose
  their contextual types; a test declares them first
  (`const react: Parameters<typeof createTicketingHooks>[0] = …`).
- Deals' entry has one hook over one staff operation and is unchanged.
- The skills (`add-automations-tools-dashboards`, `add-block`) state the rule.

## Tests
`packages/client-gen/test/generate.test.ts`: the template's mobile host module and the generated
door role client wire the native door scanner block's hooks with no cast, and a hook outside the
role (`useEventsOnSale`, `useStartOrder`) fails to compile (`@ts-expect-error`, which is itself an
error when unused). Checked not vacuous: with the block taking the full `TicketingHooks`, the test
fails. `packs/ticketing/test/client.test.ts`: a client of the door's operations gets exactly those
three hooks at run time.

## Amendment, 2026-11-24 (ADR 0881): a hook that reads each audience's way
A hook's entry in `*_HOOKS_CALL` may be `{ anyOf: [["record.list"], ["my.list"]] }`: the hook is
there for a client holding all of one of the lists, and the pack's `make` is given `holds(name)`
to pick the read (the first held list wins). Programs' `useClassTypes` uses it, so a member's client
reads the class types with `my.list` and staff's with `record.list`. `hookOperations` and
`hooksOperations` (`@composable-os/client`) list every operation a hook or a pack's hooks may call,
for a client that holds them all (the admin's screen client).
