import { Agree } from "../../../blocks/native-agree/agree-screen.tsx";
import { Screen } from "../../../blocks/native-base/screen.tsx";
import { waiver } from "./data/agreements.ts";

export default function Preview() {
  return (
    <Screen>
      <Agree
        version={waiver}
        onAgree={() => {}}
        secondary={{ label: "Not now", onPress: () => {} }}
      />
    </Screen>
  );
}

/** The member has typed their name; the signature is still to draw. */
export const fill = [["Your full name", "Jordan Lee"]] as const;
