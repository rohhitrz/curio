CREATE TABLE "lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"module_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "generation_status" NOT NULL,
	"trace_id" text,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lessons_module_id_version_unique" UNIQUE("module_id","version")
);
--> statement-breakpoint
ALTER TABLE "modules" ADD COLUMN "why" text;--> statement-breakpoint
ALTER TABLE "modules" ADD COLUMN "difficulty" "level";--> statement-breakpoint
ALTER TABLE "path_resources" ADD COLUMN "mapped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_lesson_id_idx" ON "conversations" USING btree ("lesson_id");