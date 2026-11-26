// Settings → Inbox and a conversation's category (stage 36 step 3, ADR 0749). Staff only (none is
// open to customers or the public, ADR 0402):
//
//   inbox.settings.get       staff (inbox:manage, a person, not on MCP)   the inbox's settings
//   inbox.settings.update    staff (inbox:manage, a person, not on MCP)   change them, audited
//   inbox.categories         staff (inbox:read)                           the categories offered
//   conversation.setCategory staff (inbox:work)                           file a conversation
//
// Step 3's settings are the categories. The other settings (addresses, the reopen window and the
// auto-acknowledgement; chat on or off; reply targets and opening hours) join with steps 2, 4 and
// 5, which read them (inbox/settings.ts).
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { conversationSchema, toConversation } from "../inbox/index.ts";
import {
  categorySchema,
  distinctCategories,
  INBOX_SETTING,
  inboxSettingsSchema,
  loadInboxSettings,
  MAX_CATEGORIES,
} from "../inbox/settings.ts";
import { defineOperation } from "../operation.ts";
import { checkVersion, readBack, requireConversation } from "./inbox.ts";

const settingsOutput = inboxSettingsSchema.extend({
  categories: z.array(z.string()).describe("The categories offered, in order"),
});

export const inboxSettingsGet = defineOperation({
  name: "inbox.settings.get",
  description:
    "Read the shared inbox's settings: the categories conversations are filed under, in the " +
    "order they are offered. A human admin in the app only.",
  input: z.object({}),
  output: settingsOutput,
  permission: "inbox:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    return loadInboxSettings(ctx.db);
  },
});

export const inboxSettingsUpdate = defineOperation({
  name: "inbox.settings.update",
  description:
    "Change the shared inbox's settings: the categories conversations are filed under (the " +
    `whole list, in order, at most ${MAX_CATEGORIES}; a name given twice is kept once). A ` +
    "conversation filed under a category taken off the list keeps it until someone changes it. " +
    "Only what you pass changes. A human admin in the app only: AI assistants, MCP clients, " +
    "automations and extensions are refused.",
  input: z.object({
    categories: z.array(categorySchema).max(MAX_CATEGORIES).optional(),
  }),
  output: settingsOutput.extend({ previous: settingsOutput }),
  permission: "inbox:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (Object.values(input).every((value) => value === undefined)) {
      throw new ValidationError("Pass what to change: categories");
    }
    const previous = await loadInboxSettings(ctx.db);
    const next = {
      ...previous,
      ...(input.categories ? { categories: distinctCategories(input.categories) } : {}),
    };
    const value = JSON.stringify(next);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({ key: INBOX_SETTING, value, updated_at: ctx.now, updated_by: ctx.user.id })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    ctx.recordChange({
      object: "settings",
      id: INBOX_SETTING,
      action: "update",
      before: previous,
      after: next,
    });
    return { ...next, previous };
  },
});

export const inboxCategories = defineOperation({
  name: "inbox.categories",
  description:
    "The categories an admin set for the shared inbox, in the order they are offered: what " +
    "conversation.setCategory accepts and what inbox.list filters by. Read-only.",
  input: z.object({}),
  output: z.object({ categories: z.array(z.string()) }),
  permission: "inbox:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    const settings = await loadInboxSettings(ctx.db);
    return { categories: settings.categories };
  },
});

export const conversationSetCategory = defineOperation({
  name: "conversation.setCategory",
  description:
    "File a conversation under one of the inbox's categories (inbox.categories lists them), or " +
    "under none (category null). Returns the conversation.",
  input: z.object({
    id: z.string().startsWith("cnv_").max(64).describe("Conversation id (cnv_…)"),
    category: categorySchema.nullable(),
    version: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("The version you read: the write is refused if the conversation changed since"),
  }),
  output: conversationSchema,
  permission: "inbox:work",
  risk: "write",
  async handler(input, ctx) {
    const row = await requireConversation(ctx, input.id);
    checkVersion(row, input.version);
    let category: string | null = null;
    if (input.category !== null) {
      const { categories } = await loadInboxSettings(ctx.db);
      const wanted = input.category.toLowerCase();
      // The admin's spelling, whatever case the caller wrote it in.
      category = categories.find((c) => c.toLowerCase() === wanted) ?? null;
      if (!category) {
        throw new ValidationError(
          categories.length
            ? `"${input.category}" is not one of the inbox's categories: ${categories.join(", ")}`
            : "The inbox has no categories yet: an admin adds them in Settings → Inbox",
          { field: "category", category: input.category },
        );
      }
    }
    if (row.category === category) return toConversation(row);
    ctx.write(
      ctx.db
        .updateTable("core_conversation")
        .set({ category, updated_at: ctx.now, version: row.version + 1 })
        .where("id", "=", row.id),
    );
    ctx.recordChange({
      object: "conversation",
      id: row.id,
      action: "update",
      before: { category: row.category },
      after: { category },
    });
    return ctx.afterCommit(() => readBack(ctx, row.id));
  },
});

export const inboxSettingsOperations = [
  inboxSettingsGet,
  inboxSettingsUpdate,
  inboxCategories,
  conversationSetCategory,
] as const;
