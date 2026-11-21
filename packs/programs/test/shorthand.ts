// A class program in the shorthand coaches type (the shape of Ghetto Movement's prototype format,
// written for these tests): levels with "+" and "|", tempos, links, rounds, notes for coaches and
// notes shown to members, a warm-up line the bank has and one it does not, and lines no import
// can read. `SHORTHAND_BANK` is the bank it is read against.
export const SHORTHAND = `Title: Strength block
Guidance: Reps and tempo are followed literally; rounds are a guide.
  Harder levels need longer rest.

Session: Monday
Warm-up: Wrists, shoulders and a light forward fold
- Scap push ups x 10
- Wrist circles

Block A: Approx 4-7 rounds
A1: L sit to planche
  1: L sit x 8-12 sec (legs as straight as possible) + Planche lean x 3 reps with a 5 sec hold each rep <https://youtu.be/example1>
  3: Pike push throughs x 3 (32X3) <https://youtu.be/example2> | L-sit walk ups x 3
    * if this is too hard they can do L-sit walk ups
  5: Tuck planche x 3, (32X3)
* level 3 needs hips at shoulder height
TV: Breathe out on the press
A2: Ring rows x 5 (5050)
  * elevate the feet to make it harder

Block B: 3 rounds
B1: Ring push ups x 8
B2: Dragon flag x 5
B3: Hollow hold x 30 sec

Session: Thursday
Block A: 2 rounds
A1: Pike push throughs x 5
A2: Muscle up x lots
Something nobody wrote a rule for
`;

export const SHORTHAND_BANK = [
  { name: "L sit", measure: "time" },
  { name: "Planche lean", measure: "reps" },
  { name: "Pike push throughs", measure: "reps" },
  { name: "L-sit walk ups", measure: "reps" },
  { name: "Tuck planche", measure: "reps" },
  { name: "Ring rows", measure: "weight_reps" },
  { name: "Ring push ups", measure: "reps" },
  { name: "Hollow hold", measure: "hold" },
  { name: "Scap push ups", measure: "reps" },
  { name: "Muscle up", measure: "reps" },
] as const;
