// What the person and organisation details cards share: a labelled value, the empty dash, the
// "Primary" radio on an email, phone or domain row, and the owner picker.
import { Label } from "@composable-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@composable-os/ui/components/select";
import type { ReactNode } from "react";
import { useUsers } from "#/lib/users-adapter";

export function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

export const Empty = () => <span className="text-muted-foreground">—</span>;

export function PrimaryToggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground">
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        aria-label={label}
        className="accent-primary"
      />
      Primary
    </label>
  );
}

const NO_OWNER = "__none__";

/** The owner field: any user, or none. A saved owner who is no longer listed stays choosable. */
export function OwnerField({
  id,
  saved,
  value,
  onChange,
}: {
  id: string;
  saved: string | null;
  value: string | null;
  onChange: (ownerId: string | null) => void;
}) {
  const owners = [...useUsers()];
  if (saved && !owners.some((u) => u.id === saved)) {
    owners.push({ id: saved, name: saved, email: "" });
  }
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Owner</Label>
      <Select
        value={value ?? NO_OWNER}
        onValueChange={(next) => onChange(next === NO_OWNER ? null : next)}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_OWNER}>No owner</SelectItem>
          {owners.map((user) => (
            <SelectItem key={user.id} value={user.id}>
              {user.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
