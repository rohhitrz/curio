CREATE TYPE "public"."source_origin" AS ENUM('USER', 'LEARNING_PATH');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('PENDING', 'PROCESSING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('PDF', 'WEBSITE', 'YOUTUBE', 'TEXT');--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notebook_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "source_type" NOT NULL,
	"origin" "source_origin" DEFAULT 'USER' NOT NULL,
	"title" text NOT NULL,
	"status" "source_status" DEFAULT 'PENDING' NOT NULL,
	"error_code" text,
	"error_message" text,
	"url" text,
	"storage_key" text,
	"content_hash" text NOT NULL,
	"extracted_text" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"embedding_model" text,
	"processing_started_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_notebook_id_content_hash_unique" UNIQUE("notebook_id","content_hash")
);
--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_notebook_id_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."notebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sources_notebook_id_created_at_idx" ON "sources" USING btree ("notebook_id","created_at");--> statement-breakpoint
CREATE INDEX "sources_processing_started_at_idx" ON "sources" USING btree ("processing_started_at") WHERE "sources"."status" = 'PROCESSING';