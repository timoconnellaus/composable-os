// The shipped packs' screens this build holds (stage 47, ADR 0660), handed to the host's
// `screens.mine`, which lists a pack's screens only when its installed manifest is the one the
// build was made from. Imported for its effect by every module that runs operations (the UI's
// server function, the HTTP surface), so it is set wherever the pipeline runs.

import { BUILT_SCREENS } from "virtual:cos-screens-built";
import { setBuiltScreens } from "@composable-os/core";

setBuiltScreens(BUILT_SCREENS);
