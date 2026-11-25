import { Input } from "../../../blocks/ui-input/input.tsx";
import { Label } from "../../../blocks/ui-label/label.tsx";

export const width = 480;

export default function Preview() {
  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="name">Full name</Label>
        <Input id="name" defaultValue="Jordan Lee" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" placeholder="you@example.com" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="phone">Phone</Label>
        <Input id="phone" aria-invalid defaultValue="0400 12" />
        <p className="text-destructive text-sm">Enter a full phone number.</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="member">Member number</Label>
        <Input id="member" disabled defaultValue="M-10428" />
      </div>
    </div>
  );
}
