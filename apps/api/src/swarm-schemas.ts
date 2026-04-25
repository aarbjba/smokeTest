import { z } from 'zod';

export const ModelTier = z.enum(['opus', 'sonnet', 'haiku']);
export type ModelTier = z.infer<typeof ModelTier>;

export const MODEL_IDS: Record<ModelTier, string> = {
  opus:   'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
};

export const SubagentConfigSchema = z.object({
  name:        z.string().regex(/^[a-z][a-z0-9-]{2,40}$/),
  description: z.string().min(10),
  prompt:      z.string().min(20),
  model:       ModelTier.default('sonnet'),
  tools:       z.array(z.string()).default([]),
});
export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

export const ToolPermissionsSchema = z.object({
  sendToPeer:      z.boolean().default(true),
  checkInbox:      z.boolean().default(true),
  readBlackboard:  z.boolean().default(true),
  writeBlackboard: z.boolean().default(true),
  listBlackboard:  z.boolean().default(true),
  reportProgress:  z.boolean().default(true),
  terminate:       z.boolean().default(true),
  spawnSubagents:  z.boolean().default(true),
}).default({});
export type ToolPermissions = z.infer<typeof ToolPermissionsSchema>;

export const CoordinatorConfigSchema = z.object({
  id:                   z.string().regex(/^[a-z][a-z0-9-]{2,30}$/),
  role:                 z.string().default(''),
  model:                ModelTier.default('sonnet'),
  maxTurns:             z.number().int().positive().default(25),
  systemPromptTemplate: z.string().min(20),
  toolPermissions:      ToolPermissionsSchema,
  subagents:            z.array(SubagentConfigSchema).default([]),
});
export type CoordinatorConfig = z.infer<typeof CoordinatorConfigSchema>;

export const SwarmConfigSchema = z.object({
  goal:               z.string().min(5),
  coordinators:       z.array(CoordinatorConfigSchema).min(1).max(10),
  globalTokenLimit:   z.number().int().positive().default(5_000_000),
  timeoutMs:          z.number().int().positive().default(8 * 60_000),
});
export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;
