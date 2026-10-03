CREATE TYPE "public"."concept_status" AS ENUM('INCLUDED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."goal" AS ENUM('EXAM', 'JOB', 'CURIOSITY');--> statement-breakpoint
CREATE TYPE "public"."path_status" AS ENUM('GATHERING', 'READING', 'MAPPING', 'AWAITING_BRANCH', 'BUILDING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."resource_role" AS ENUM('OFFICIAL', 'POPULAR');--> statement-breakpoint
CREATE TYPE "public"."resource_type" AS ENUM('DOCS', 'ARTICLE', 'VIDEO');--> statement-breakpoint
CREATE TABLE "concept_coverage" (
	"concept_id" uuid NOT NULL,
	"path_resource_id" uuid NOT NULL,
	CONSTRAINT "concept_coverage_concept_id_path_resource_id_pk" PRIMARY KEY("concept_id","path_resource_id")
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"consensus_score" numeric NOT NULL,
	"status" "concept_status" NOT NULL,
	"skip_reason" text,
	"module_id" uuid,
	"position" integer
);
--> statement-breakpoint
CREATE TABLE "learning_paths" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notebook_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"level" "level" NOT NULL,
	"goal" "goal" NOT NULL,
	"status" "path_status" DEFAULT 'GATHERING' NOT NULL,
	"branch_options" jsonb,
	"selected_branch" text,
	"hook" jsonb,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_paths_notebook_id_unique" UNIQUE("notebook_id")
);
--> statement-breakpoint
CREATE TABLE "modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "modules_path_id_position_unique" UNIQUE("path_id","position")
);
--> statement-breakpoint
CREATE TABLE "path_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path_id" uuid NOT NULL,
	"source_id" uuid,
	"role" "resource_role" NOT NULL,
	"resource_type" "resource_type" NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "concept_coverage" ADD CONSTRAINT "concept_coverage_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_coverage" ADD CONSTRAINT "concept_coverage_path_resource_id_path_resources_id_fk" FOREIGN KEY ("path_resource_id") REFERENCES "public"."path_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_path_id_learning_paths_id_fk" FOREIGN KEY ("path_id") REFERENCES "public"."learning_paths"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_paths" ADD CONSTRAINT "learning_paths_notebook_id_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."notebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_paths" ADD CONSTRAINT "learning_paths_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_path_id_learning_paths_id_fk" FOREIGN KEY ("path_id") REFERENCES "public"."learning_paths"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_resources" ADD CONSTRAINT "path_resources_path_id_learning_paths_id_fk" FOREIGN KEY ("path_id") REFERENCES "public"."learning_paths"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_resources" ADD CONSTRAINT "path_resources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "concepts_path_id_idx" ON "concepts" USING btree ("path_id");--> statement-breakpoint
CREATE INDEX "concepts_module_id_position_idx" ON "concepts" USING btree ("module_id","position");--> statement-breakpoint
CREATE INDEX "path_resources_path_id_idx" ON "path_resources" USING btree ("path_id");--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE set null ON UPDATE no action;