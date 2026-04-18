import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

export const rawItems = pgTable("raw_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  text: text("text").notNull(),
  source: text("source"),
  author: text("author"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    summary: text("summary"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    sourceItemId: uuid("source_item_id").references(() => rawItems.id, {
      onDelete: "set null",
    }),
    markdownPath: text("markdown_path"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,'') || ' ' || coalesce(summary,''))`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("notes_search_vector_idx").using("gin", t.searchVector),
    index("notes_type_idx").on(t.type),
    index("notes_source_item_idx").on(t.sourceItemId),
  ],
);

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("entities_type_name_idx").on(t.type, t.normalizedName)],
);

export const noteEntities = pgTable(
  "note_entities",
  {
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.noteId, t.entityId] }),
    index("note_entities_entity_idx").on(t.entityId),
  ],
);

export const noteLinks = pgTable(
  "note_links",
  {
    fromNoteId: uuid("from_note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    toNoteId: uuid("to_note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    relation: text("relation").notNull().default("related"),
  },
  (t) => [primaryKey({ columns: [t.fromNoteId, t.toNoteId, t.relation] })],
);

export type RawItem = typeof rawItems.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Entity = typeof entities.$inferSelect;

import { createInsertSchema } from "drizzle-zod";

export const insertRawItemSchema = createInsertSchema(rawItems);
export const insertNoteSchema = createInsertSchema(notes);
export const insertEntitySchema = createInsertSchema(entities);
export const insertNoteEntitySchema = createInsertSchema(noteEntities);
export const insertNoteLinkSchema = createInsertSchema(noteLinks);
