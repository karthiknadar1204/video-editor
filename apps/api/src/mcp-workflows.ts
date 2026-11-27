import { createHash } from "node:crypto";
import { EditError, roughCutOptionsSchema } from "@editor/timeline";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { authorizeProjectAccess, type ProjectAccess } from "./codex-access";
import { startExport, getExport } from "./export-jobs";
import {
  previewRoughCut,
  reviewFrame,
  commitRoughCut,
  restoreRoughPassage,
  listRoughCuts,
  getRoughCut,
} from "./rough-cuts";

export function stableRequestId(parts: unknown[]) {
  const bytes = createHash("sha256").update(JSON.stringify(parts)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x80;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

const number = z.int().nonnegative();
const packet = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
type Call = (
  name: string,
  action: () => Promise<{ result: CallToolResult; detail: string }>,
) => Promise<CallToolResult>;
type Review = Awaited<ReturnType<typeof previewRoughCut>>;

function reviewSummary(review: Review, offset = 0) {
  const { pauseCount, repeatCount, removedFrames, captionCount, cuts, flags, previewFrames } = review.receipt;
  return {
    reviewId: review.id,
    baseRevision: review.baseRevision,
    status: review.status,
    pauseCount,
    repeatCount,
    removedFrames,
    captionCount,
    cutCount: cuts.length,
    cuts: cuts.slice(offset, offset + 30),
    flagCount: flags.length,
    flags: flags.slice(offset, offset + 30),
    nextOffset: offset + 30 < Math.max(cuts.length, flags.length) ? offset + 30 : null,
    previewFrames: previewFrames.slice(0, 12),
  };
}

export function registerWorkflows(server: McpServer, access: ProjectAccess, call: Call) {
  const privateScope = access.kind === "run" ? access.id : access.hash;
  async function candidate(review: Review, requestedFrame?: number, rebased = false) {
    const frame = requestedFrame ?? review.receipt.previewFrames[0] ?? 0;
    const image = await reviewFrame(access, review.id, frame);
    if (image.baseRevision !== review.baseRevision)
      throw new EditError("The candidate changed during rendering. Inspect the updated review before committing.");
    const result = packet({ ...reviewSummary(review), kind: image.kind, frame: image.frame, rebased });
    result.content.push({ type: "image", mimeType: "image/jpeg", data: image.data });
    return {
      result,
      detail: rebased ? "Recalculated and inspected the latest candidate" : "Inspected a rough-cut candidate",
    };
  }
  server.registerTool(
    "rough_cut",
    {
      description:
        "Prepare, inspect or commit one grouped rough cut. Preview with revision and options containing an explicit target clip or range, pause and repetition preferences and caption styling. Preview returns an image and stable reviewId. Inspect without an ID to list reviews, with a reviewId to read its cuts, or with reviewId and frame to see candidate pixels. Follow nextOffset for more cuts or flagged takes. To adjust captions, preview with the revised options. Commit the inspected reviewId at its base revision. A rebased result is another candidate; inspect before committing again. Restore one cut by its cutId at the current project revision.",
      inputSchema: {
        action: z.enum(["preview", "inspect", "commit", "restore"]),
        revision: number.optional(),
        options: roughCutOptionsSchema.optional(),
        reviewId: z.uuid().optional(),
        cutId: z.string().min(1).max(200).optional(),
        frame: number.optional(),
        offset: number.optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      call("rough_cut", async () => {
        if (args.action === "preview") {
          if (!args.options || args.revision === undefined)
            throw new EditError("Choose the target, rough-cut settings and saved revision.");
          const requestId = stableRequestId([access.projectId, privateScope, "preview", args.revision, args.options]);
          const review = await previewRoughCut(access, args.options, requestId);
          return candidate(review, args.frame, review.baseRevision !== args.revision);
        }
        if (args.action === "inspect" && !args.reviewId) {
          const page = await listRoughCuts(access, args.offset ?? 0);
          const reviews = page.reviews.map((r) => ({
              reviewId: r.id,
              baseRevision: r.baseRevision,
              committedRevision: r.committedRevision,
              status: r.status,
              removedFrames: r.receipt.removedFrames,
            }));
          return {
            result: packet({ reviews, nextOffset: page.nextOffset }),
            detail: "Read the rough-cut review list",
          };
        }
        if (!args.reviewId) throw new EditError("Supply the review ID returned by preview.");
        if (args.action === "inspect") {
          if (args.frame === undefined) {
            const review = await getRoughCut(access, args.reviewId);
            return {
              result: packet({ ...reviewSummary(review, args.offset), restoredIds: review.restoredIds }),
              detail: "Read the rough-cut receipt",
            };
          }
          const { data, mimeType, ...meta } = await reviewFrame(access, args.reviewId, args.frame);
          const result = packet(meta);
          result.content.push({ type: "image", mimeType, data });
          return { result, detail: "Inspected a rough-cut candidate frame" };
        }
        if (args.revision === undefined) throw new EditError("Choose the revision to change.");
        if (args.action === "commit") {
          const commit = await commitRoughCut(access, args.reviewId, args.revision);
          if (commit.rebased || !commit.receipt) return candidate(commit.review, undefined, true);
          return {
            result: packet({ ...reviewSummary(commit.review), kind: "committed_rough_cut", edit: commit.receipt }),
            detail: "Committed the rough cut at revision " + commit.receipt.revision,
          };
        }
        if (!args.cutId) throw new EditError("Choose a cut ID from the review.");
        const requestId = stableRequestId([
          access.projectId,
          privateScope,
          "restore",
          args.reviewId,
          args.cutId,
          args.revision,
        ]);
        const edit = await restoreRoughPassage(access, args.reviewId, args.cutId, args.revision, requestId);
        return {
          result: packet({ kind: "restored_passage", reviewId: args.reviewId, cutId: args.cutId, edit }),
          detail: "Restored a passage at revision " + edit.revision,
        };
      }),
  );
  function exportReceipt(job: Awaited<ReturnType<typeof startExport>>) {
    const { id, revision, status, progress, attempt, error } = job;
    return packet({ exportId: id, revision, status, progress, attempt, error });
  }
  server.registerTool(
    "start_export",
    {
      description:
        "Start or reconnect to an MP4 export of one explicit saved timeline revision. Use export_status to check progress.",
      inputSchema: { revision: number },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ revision }) =>
      call("start_export", async () => {
        const job = await startExport({ ownerId: access.ownerId, projectId: access.projectId, revision }, (tx) =>
          authorizeProjectAccess(tx, access).then(() => {}),
        );
        return { result: exportReceipt(job), detail: "Requested an export of revision " + job.revision };
      }),
  );
  server.registerTool(
    "export_status",
    {
      description: "Get the current state, attempt and progress of an export in this project.",
      inputSchema: { exportId: z.uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ exportId }) =>
      call("export_status", async () => {
        const job = await getExport({ ownerId: access.ownerId, projectId: access.projectId, exportId });
        return { result: exportReceipt(job), detail: "Checked export status · " + job.status };
      }),
  );
}
