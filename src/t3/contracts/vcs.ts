import * as z from "zod/v4";

export const vcsRefSchema = z.object({
  name: z.string(),
  isRemote: z.boolean().optional(),
  current: z.boolean(),
  isDefault: z.boolean(),
  worktreePath: z.string().nullable(),
});
export const vcsListRefsResultSchema = z.object({
  refs: z.array(vcsRefSchema),
  isRepo: z.boolean(),
  nextCursor: z.number().nullable(),
});
export type VcsRef = z.infer<typeof vcsRefSchema>;
export type VcsListRefsResult = z.infer<typeof vcsListRefsResultSchema>;
