// The Worker the test suites' `ClientDb` lives in when they run on a client's database
// (`COS_TEST_DB=client-db`, testing/vitest.ts), shaped as `cos-client-db` is (apps/client-db): the
// class, and the query-only entrypoint the host's Workers bind (`ClientDbQueries`). The Worker
// under test binds to the class by name, or to the entrypoint as a service.
export { ClientDb } from "../src/client-db.ts";
export { ClientDbQueries } from "../src/client-db-service.ts";

export default { fetch: () => new Response("cos-client-db (tests)") };
