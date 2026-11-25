import {
  createFormsHooks,
  FORMS_HOOKS_CALL,
  type FormsOperations,
} from "@composable-os/pack-forms/client";
import { LinkedFormScreen } from "../../../packs/forms/blocks/forms-native-form/form-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { feedbackForm } from "./data/forms.ts";

const forms = createFormsHooks(
  react,
  fakeClient<FormsOperations>(FORMS_HOOKS_CALL, { "x.forms.linkedForm": feedbackForm }),
);

/** A member's feedback after a class, opened from Needs your attention. */
export default function Preview() {
  return <LinkedFormScreen forms={forms} linkId="ilk_preview" />;
}

/** Four stars chosen. */
export const click = [{ role: "radio", name: "4 stars" }];
