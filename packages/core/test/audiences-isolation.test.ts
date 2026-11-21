// Stage 22, acceptance criterion 4: isolation, generically, through `invoke()`. The suite is in
// isolation-suite.ts; http-isolation.test.ts runs it again over the HTTP surface (stage 23).
import { call } from "./customer-fixtures.ts";
import { isolationSuite } from "./isolation-suite.ts";

isolationSuite("through invoke()", call);
