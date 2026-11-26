// The Worker the test suites' `ClientDb` lives in when they run on a client's database
// (`COS_TEST_DB=client-db`, testing/vitest.ts). The Worker under test binds to its class by name.
export { ClientDb } from "../src/client-db.ts";

export default { fetch: () => new Response("cos-client-db (tests)") };
