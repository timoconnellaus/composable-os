// Your details (stage 48), for the web: the signed-in customer's name and phone, to change, and
// the address they sign in with. What is saved, and what the business sees, is the host's
// (me.get, me.update): only what changed is sent, and the host checks it again. Their birthday,
// day and month only (stage 53: me.birthday.get, me.birthday.set), where the client holds them.
import {
  type AccountHooks,
  accountErrorWords,
  type BirthdayForm,
  birthdayDays,
  birthdayForm,
  birthdayInput,
  birthdayMonths,
  birthdayProblem,
  type DetailsForm,
  detailsForm,
  detailsInput,
  detailsProblems,
} from "@composable-os/client";
import { type FormEvent, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

type Hooks = Pick<AccountHooks, "useMe" | "useUpdateMe"> &
  Partial<Pick<AccountHooks, "useBirthday" | "useSetBirthday">>;

const FIELDS: { key: keyof DetailsForm; label: string; autoComplete: string }[] = [
  { key: "displayName", label: "Name", autoComplete: "name" },
  { key: "givenName", label: "First name", autoComplete: "given-name" },
  { key: "familyName", label: "Last name", autoComplete: "family-name" },
  { key: "primaryPhone", label: "Phone", autoComplete: "tel" },
];

export function YourDetails({ account }: { account: Hooks }) {
  const me = account.useMe();
  const update = account.useUpdateMe();
  const [form, setForm] = useState<DetailsForm | null>(null);
  const [problems, setProblems] = useState<Partial<Record<keyof DetailsForm, string>>>({});
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (me.isPending) return <p aria-busy="true">Loading your details…</p>;
  if (me.error || !me.data) return <p role="alert">We could not load your details.</p>;
  const person = me.data;
  const shown = form ?? detailsForm(person);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaid(null);
    setError(null);
    const found = detailsProblems(shown);
    setProblems(Object.fromEntries(found.map((p) => [p.field, p.message])));
    if (found.length) return;
    const input = detailsInput(person, shown);
    if (!input) {
      setSaid("Nothing to save.");
      return;
    }
    try {
      await update.mutateAsync(input);
      me.refetch?.();
      setForm(null);
      setSaid("Saved.");
    } catch (e) {
      setError(accountErrorWords(e));
    }
  }

  const birthday =
    account.useBirthday && account.useSetBirthday ? (
      <YourBirthday
        account={{ useBirthday: account.useBirthday, useSetBirthday: account.useSetBirthday }}
      />
    ) : null;

  return (
    <div className="grid gap-8">
      <form className="grid gap-4" onSubmit={submit} noValidate aria-label="Your details">
        {FIELDS.map((field) => (
          <div key={field.key} className="grid gap-1">
            <Label htmlFor={`account-${field.key}`}>{field.label}</Label>
            <Input
              id={`account-${field.key}`}
              autoComplete={field.autoComplete}
              value={shown[field.key]}
              aria-invalid={problems[field.key] ? true : undefined}
              onChange={(e) => setForm({ ...shown, [field.key]: e.target.value })}
            />
            {problems[field.key] ? (
              <span className="text-destructive text-sm">{problems[field.key]}</span>
            ) : null}
          </div>
        ))}
        <div className="grid gap-1">
          <span className="text-sm font-medium">You sign in with</span>
          <span data-testid="sign-in-email">{person.signInEmail}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={update.isPending}>
            Save
          </Button>
          {said ? <span role="status">{said}</span> : null}
          {error ? <span role="alert">{error}</span> : null}
        </div>
      </form>
      {birthday}
    </div>
  );
}

const SELECT =
  "h-9 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none md:text-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive";

/** Their birthday: a day and a month, never a year. Choosing neither removes it. */
function YourBirthday({
  account,
}: {
  account: Pick<AccountHooks, "useBirthday" | "useSetBirthday">;
}) {
  const current = account.useBirthday();
  const set = account.useSetBirthday();
  const [form, setForm] = useState<BirthdayForm | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  if (current.isPending) return <p aria-busy="true">Loading your birthday…</p>;
  if (current.error || !current.data) return <p role="alert">We could not load your birthday.</p>;
  const saved = current.data.birthday;
  const shown = form ?? birthdayForm(saved);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaid(null);
    const found = birthdayProblem(shown);
    setProblem(found);
    if (found) return;
    const input = birthdayInput(saved, shown);
    if (!input) {
      setSaid("Nothing to save.");
      return;
    }
    try {
      await set.mutateAsync(input);
      current.refetch?.();
      setForm(null);
      setSaid("Saved.");
    } catch (e) {
      setSaid(accountErrorWords(e));
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit} noValidate aria-label="Your birthday">
      <fieldset className="grid gap-1">
        <legend className="text-sm font-medium">Birthday (optional)</legend>
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Day"
            className={SELECT}
            value={shown.day}
            aria-invalid={problem ? true : undefined}
            onChange={(e) => setForm({ ...shown, day: e.target.value })}
          >
            <option value="">Day</option>
            {birthdayDays(shown.month).map((day) => (
              <option key={day} value={String(day)}>
                {day}
              </option>
            ))}
          </select>
          <select
            aria-label="Month"
            className={SELECT}
            value={shown.month}
            aria-invalid={problem ? true : undefined}
            onChange={(e) => setForm({ ...shown, month: e.target.value })}
          >
            <option value="">Month</option>
            {birthdayMonths().map((month) => (
              <option key={month.value} value={month.value}>
                {month.label}
              </option>
            ))}
          </select>
        </div>
        <span className="text-muted-foreground text-sm">
          Day and month only. The business may send you a message on the day.
        </span>
        {problem ? <span className="text-destructive text-sm">{problem}</span> : null}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={set.isPending}>
          Save birthday
        </Button>
        {said ? <span role="status">{said}</span> : null}
      </div>
    </form>
  );
}
