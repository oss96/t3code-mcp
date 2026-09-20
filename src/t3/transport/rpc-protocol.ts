import * as z from "zod/v4";

const requestIdSchema = z.union([z.string(), z.number()]);
const failureSchema = z.object({
  _tag: z.literal("Failure"),
  cause: z.array(
    z.object({ _tag: z.string(), error: z.unknown().optional(), defect: z.unknown().optional() }),
  ),
});
export const rpcServerMessageSchema = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("Chunk"), requestId: requestIdSchema, values: z.array(z.unknown()) }),
  z.object({
    _tag: z.literal("Exit"),
    requestId: requestIdSchema,
    exit: z.discriminatedUnion("_tag", [
      z.object({ _tag: z.literal("Success"), value: z.unknown().optional() }),
      failureSchema,
    ]),
  }),
  z.object({ _tag: z.literal("Defect"), defect: z.unknown() }),
  z.object({ _tag: z.literal("ClientProtocolError"), error: z.unknown() }),
  z.object({ _tag: z.literal("Pong") }),
]);
export type RpcFailure = z.infer<typeof failureSchema>;
