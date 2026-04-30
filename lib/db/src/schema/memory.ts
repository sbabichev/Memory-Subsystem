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
  real,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

export const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map(Number);
  },
});

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rawItems = pgTable(
  "raw_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    text: text("text").notNull(),
    source: text("source"),
    author: text("author"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("raw_items_tenant_idx").on(t.tenantId)],
);

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
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
    embedding: vector("embedding", { dimensions: 1024 }),
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
    index("notes_tenant_idx").on(t.tenantId),
    // NOTE: HNSW index on `embedding` (vector_cosine_ops) is intentionally
    // NOT declared here. Replit's deploy migration validator runs before the
    // build step, so it would try to create this index before pgvector is
    // enabled and fail. The index is created idempotently by
    // `lib/db/scripts/setup-pgvector.ts`, which runs after CREATE EXTENSION.
  ],
);

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    type: text("type").notNull(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("entities_type_name_idx").on(t.tenantId, t.type, t.normalizedName),
    index("entities_tenant_idx").on(t.tenantId),
  ],
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

export const entityRelations = pgTable(
  "entity_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    fromEntityId: uuid("from_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    toEntityId: uuid("to_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    relation: text("relation").notNull(),
    sourceNoteId: uuid("source_note_id").references(() => notes.id, {
      onDelete: "set null",
    }),
    confidence: real("confidence").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("entity_relations_unique_idx").on(
      t.tenantId,
      t.fromEntityId,
      t.toEntityId,
      t.relation,
    ),
    index("entity_relations_from_idx").on(t.tenantId, t.fromEntityId),
    index("entity_relations_to_idx").on(t.tenantId, t.toEntityId),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type RawItem = typeof rawItems.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Entity = typeof entities.$inferSelect;
export type EntityRelation = typeof entityRelations.$inferSelect;

import { createInsertSchema } from "drizzle-zod";

export const insertTenantSchema = createInsertSchema(tenants);
export const insertRawItemSchema = createInsertSchema(rawItems);
export const insertNoteSchema = createInsertSchema(notes);
export const insertEntitySchema = createInsertSchema(entities);
export const insertNoteEntitySchema = createInsertSchema(noteEntities);
export const insertNoteLinkSchema = createInsertSchema(noteLinks);
export const insertEntityRelationSchema = createInsertSchema(entityRelations);
