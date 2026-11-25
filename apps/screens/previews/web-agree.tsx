import { Agree } from "../../../blocks/web-agree/agree.tsx";
import { waiver } from "./data/agreements.ts";

export const width = 720;

export default function Preview() {
  return (
    <Agree
      version={waiver}
      onAgree={() => {}}
      secondary={{ label: "Not now", onClick: () => {} }}
    />
  );
}

/** The member has typed their name; the signature is still to draw. */
export const fill = [["Your full name", "Jordan Lee"]] as const;
