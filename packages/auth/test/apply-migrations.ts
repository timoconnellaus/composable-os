import { env } from "cloudflare:workers";
import { applyMigrations } from "@composable-os/db";

await applyMigrations(env.DB, env.TEST_MIGRATIONS);
