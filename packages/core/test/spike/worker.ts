// SPIKE: the test Worker's entry, so the Durable Object class has a home.
export { ClientDb } from "./client-db.ts";
export default { fetch: () => new Response("spike") };
