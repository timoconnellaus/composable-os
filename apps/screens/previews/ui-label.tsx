import { Input } from "../../../blocks/ui-input/input.tsx";
import { Label } from "../../../blocks/ui-label/label.tsx";

export const width = 480;

export default function Preview() {
  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="class">Class name</Label>
        <Input id="class" defaultValue="Morning HIIT" />
      </div>
      <div className="flex items-center gap-2">
        <input id="reminders" type="checkbox" className="size-4" defaultChecked />
        <Label htmlFor="reminders">Email me a reminder the day before</Label>
      </div>
      <div className="flex items-center gap-2">
        <input id="waitlist" type="checkbox" className="peer size-4" disabled />
        <Label htmlFor="waitlist">Join the waiting list (the class is not full)</Label>
      </div>
    </div>
  );
}
