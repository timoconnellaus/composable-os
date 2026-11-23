// The admin's "not found" (stage 47): the same page for a URL that is no page, a screen that is
// not the viewer's, and a page a fixed-role account may not open. It makes no call.
import { Button } from "@composable-os/ui/components/button";
import { Link } from "@tanstack/react-router";
import { FileQuestionIcon } from "lucide-react";
import { EmptyState } from "./empty-state.tsx";

export function NotFoundPage() {
  return (
    <div data-testid="not-found">
      <EmptyState
        icon={FileQuestionIcon}
        title="Page not found"
        description="There is nothing here, or it is not yours to open."
        action={
          <Button asChild variant="outline">
            <Link to="/">Go home</Link>
          </Button>
        }
        className="mx-4 my-6 sm:mx-auto sm:max-w-xl"
      />
    </div>
  );
}
