CREATE TABLE "source_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"notebook_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"context_header" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce("source_chunks"."context_header", '') || ' ' || "source_chunks"."content")) STORED,
	"token_count" integer NOT NULL,
	"page_number" integer,
	"start_seconds" integer,
	"end_seconds" integer,
	"heading_path" text,
	"char_start" integer,
	"char_end" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_chunks_source_id_chunk_index_unique" UNIQUE("source_id","chunk_index")
);
--> statement-breakpoint
ALTER TABLE "source_chunks" ADD CONSTRAINT "source_chunks_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_chunks_embedding_idx" ON "source_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "source_chunks_search_vector_idx" ON "source_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "source_chunks_notebook_id_idx" ON "source_chunks" USING btree ("notebook_id");