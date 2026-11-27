ALTER TABLE "project" ADD COLUMN "format_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;