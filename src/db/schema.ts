import { pgTable, text, timestamp, jsonb, integer, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  title: text("title").notNull().default("New Chat"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // 'user' | 'assistant' | 'system'
  content: text("content").notNull(),
  reasoningContent: text("reasoning_content"),
  thinkingEffort: text("thinking_effort"), // 'none' | 'low' | 'high' | 'max' | 'auto'
  webSearchUsed: boolean("web_search_used").default(false),
  searchResults: jsonb("search_results"),
  pluginsUsed: jsonb("plugins_used"),
  tokenCount: integer("token_count"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const settings = pgTable("settings", {
  id: text("id").primaryKey().default(sql`'default'`),
  deepseekApiKey: text("deepseek_api_key"),
  tavilyApiKey: text("tavily_api_key"),
  defaultModel: text("default_model").default("deepseek-v4-pro"),
  defaultThinkingEffort: text("default_thinking_effort").default("auto"),
  enabledPlugins: jsonb("enabled_plugins").default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
