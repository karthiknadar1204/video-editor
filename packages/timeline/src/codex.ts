import { z } from "zod";
import { frame, id } from "./model";

export const editorContext = z.strictObject({
  tabId:z.uuid(), clipId:id.nullable(), frame, revision:frame,
  range:z.strictObject({from:frame,to:frame}).refine(r => r.to > r.from).nullable(),
});
export type EditorContext = z.infer<typeof editorContext>;
export const turnInput = z.strictObject({id:z.uuid(), prompt:z.string().trim().min(1).max(4000), context:editorContext});
export const editReceipt = z.object({requestId:z.uuid(), revision:frame, affected:z.object({from:frame,to:frame}).nullable()});
export const activity = z.object({time:z.string(), text:z.string()});
export type RunActivity = z.infer<typeof activity>;
export const runView = z.object({
  id:z.uuid(), prompt:z.string(), context:editorContext, status:z.enum(["running","completed","failed","stopped"]),
  events:z.array(activity), result:z.string().nullable(), receipt:editReceipt.nullable(), createdAt:z.string(),
});
export type RunView = z.infer<typeof runView>;
