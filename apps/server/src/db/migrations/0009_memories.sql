CREATE TYPE "public"."level" AS ENUM('BEGINNER', 'INTERMEDIATE', 'ADVANCED');--> statement-breakpoint
CREATE TYPE "public"."memory_kind" AS ENUM('LEVEL', 'STYLE', 'GOAL', 'UNDERSTOOD', 'FACT');--> statement-breakpoint
CREATE TYPE "public"."memory_origin" AS ENUM('LEVEL_CONFIRMED', 'LESSON_COMPLETED', 'CHAT_EXTRACTED', 'USER_EDITED');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('GLOBAL', 'TOPIC');--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" "memory_scope" NOT NULL,
	"topic_id" uuid,
	"kind" "memory_kind" NOT NULL,
	"content" text NOT NULL,
	"level" "level",
	"concept_id" uuid,
	"origin" "memory_origin" NOT NULL,
	"origin_ref" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_topic_scope_check" CHECK (("memories"."scope" = 'TOPIC') = ("memories"."topic_id" IS NOT NULL)),
	CONSTRAINT "memories_level_check" CHECK ("memories"."kind" <> 'LEVEL' OR ("memories"."level" IS NOT NULL AND "memories"."scope" = 'TOPIC'))
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memories_one_level_per_topic" ON "memories" USING btree ("user_id","topic_id") WHERE "memories"."kind" = 'LEVEL';--> statement-breakpoint
CREATE UNIQUE INDEX "memories_one_understood_per_concept" ON "memories" USING btree ("user_id","concept_id") WHERE "memories"."kind" = 'UNDERSTOOD';--> statement-breakpoint
CREATE INDEX "memories_user_id_scope_topic_id_idx" ON "memories" USING btree ("user_id","scope","topic_id");