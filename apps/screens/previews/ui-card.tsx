import { Button } from "../../../blocks/ui-button/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../../blocks/ui-card/card.tsx";

export const width = 520;

export default function Preview() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Unlimited monthly</CardTitle>
        <CardDescription>Every class, every day. Renews on 2 April.</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm">
            Change
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Classes this month</dt>
          <dd className="text-right font-medium">11</dd>
          <dt className="text-muted-foreground">Next payment</dt>
          <dd className="text-right font-medium">$129.00 on 2 Apr 2026</dd>
          <dt className="text-muted-foreground">Paused weeks left</dt>
          <dd className="text-right font-medium">8</dd>
        </dl>
      </CardContent>
      <CardFooter className="gap-2">
        <Button>Book a class</Button>
        <Button variant="ghost">Pause membership</Button>
      </CardFooter>
    </Card>
  );
}
