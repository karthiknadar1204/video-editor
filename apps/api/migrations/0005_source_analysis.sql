CREATE TABLE "source_analysis" (
	"project_id" uuid NOT NULL,
	"asset_id" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"lease_id" uuid,
	"lease_until" timestamp with time zone,
	"original_words" jsonb,
	"sheet" text,
	"timestamps_ms" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_analysis_project_id_asset_id_version_pk" PRIMARY KEY("project_id","asset_id","version")
);
--> statement-breakpoint
CREATE TABLE "source_transcript" (
	"project_id" uuid NOT NULL,
	"asset_id" text NOT NULL,
	"revision" integer NOT NULL,
	"imported" jsonb,
	"reviewed" jsonb,
	CONSTRAINT "source_transcript_project_id_asset_id_pk" PRIMARY KEY("project_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "source_analysis" ADD CONSTRAINT "source_analysis_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_transcript" ADD CONSTRAINT "source_transcript_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_analysis_version_status_created_at_index" ON "source_analysis" USING btree ("version","status","created_at");