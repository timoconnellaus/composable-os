// Your details (stage 48), for the web: the signed-in customer's name and phone, to change, and
// the address they sign in with. What is saved, and what the business sees, is the host's
// (me.get, me.update): only what changed is sent, and the host checks it again.
import {
  type AccountHooks,
  accountErrorWords,
  type DetailsForm,
  detailsForm,
  detailsInput,
  detailsProblems,
} from "@composable-os/client";
import { type FormEvent, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

type Hooks = Pick<AccountHooks, "useMe" | "useUpdateMe">;

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

  return (
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
  );
}
