import {
  createFormsHooks,
  FORMS_HOOKS_CALL,
  type FormsOperations,
} from "@composable-os/pack-forms/client";
import { FormBlock } from "../../../packs/forms/blocks/forms-form/form.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { trialForm } from "./data/forms.ts";

const forms = createFormsHooks(
  react,
  fakeClient<FormsOperations>(FORMS_HOOKS_CALL, { "x.forms.form": trialForm }),
);

/** The app's Turnstile widget, drawn as the box Cloudflare's managed widget shows. */
function Turnstile() {
  return (
    <div className="flex h-16 w-72 items-center gap-3 rounded border border-input px-4 text-sm">
      <span className="size-5 rounded-full border-2 border-primary" />
      Success!
    </div>
  );
}

export const width = 640;

export default function Preview() {
  return <FormBlock forms={forms} slug="ask-about-a-trial" Turnstile={Turnstile} />;
}

/** The visitor has started: their name and email typed. */
export const fill = [
  ["Your name", "Jordan Lee"],
  ["Email", "jordan@example.com"],
] as const;
