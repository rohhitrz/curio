CREATE TYPE "public"."feedback" AS ENUM('UP', 'DOWN');--> statement-breakpoint
CREATE TYPE "public"."generation_status" AS ENUM('COMPLETE', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('USER', 'ASSISTANT');--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notebook_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"lesson_id" uuid,
	"title" text NOT NULL,
	"summary" text,
	"summarized_through_seq" integer DEFAULT 0 NOT NULL,
	"memory_extracted_through_seq" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "generation_status" DEFAULT 'COMPLETE' NOT NULL,
	"trace_id" text,
	"feedback" "feedback",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_conversation_id_seq_unique" UNIQUE("conversation_id","seq")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_notebook_id_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."notebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_notebook_id_last_message_at_idx" ON "conversations" USING btree ("notebook_id","last_message_at" DESC NULLS LAST);