CREATE TABLE "candidate_frame" (
	"project_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"frame" integer NOT NULL,
	"data" text,
	"failed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_frame_project_id_review_id_revision_frame_pk" PRIMARY KEY("project_id","review_id","revision","frame")
);
--> statement-breakpoint
ALTER TABLE "project_asset" ADD COLUMN "upload_attempt" uuid;--> statement-breakpoint
ALTER TABLE "project_asset" ADD COLUMN "upload_file_id" text;--> statement-breakpoint
ALTER TABLE "project_asset" ADD COLUMN "upload_error" jsonb;--> statement-breakpoint
ALTER TABLE "candidate_frame" ADD CONSTRAINT "candidate_frame_project_id_review_id_rough_cut_review_project_id_id_fk" FOREIGN KEY ("project_id","review_id") REFERENCES "public"."rough_cut_review"("project_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO candidate_frame (project_id, review_id, revision, frame, data)
SELECT project_id, id, base_revision, (preview_image->>'frame')::int, preview_image->>'data'
FROM rough_cut_review WHERE preview_image IS NOT NULL;
--> statement-breakpoint
UPDATE project_asset SET state = 'pending' WHERE state = 'processing' AND upload_attempt IS NULL;
