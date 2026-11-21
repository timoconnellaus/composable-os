// Stage 23, acceptance criterion 2: the stage 22 isolation suite again, over HTTP. Every call is a
// request to POST /api/v1/op/<name>, its caller given by the request's credential (a customer's)
// or by none (the public), and its answer read back from the response's envelope.
import { httpCaller } from "./http-helpers.ts";
import { isolationSuite } from "./isolation-suite.ts";

isolationSuite("over HTTP", httpCaller());
