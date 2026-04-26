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

export const SwarmTopology = z.enum([
  'concurrent',
  'debate-with-judge',
  'mixture-of-agents',
  'majority-voting',
  'sequential',
  'hierarchical',
  'planner-worker',
  'round-robin',
  'council-as-judge',
  'groupchat',
  'heavy-swarm',
  'agent-rearrange',
  'graph-workflow',
]);
export type SwarmTopology = z.infer<typeof SwarmTopology>;

export const GroupchatSpeakerStrategy = z.enum([
  'round-robin',     // every agent speaks in array order (shifted per loop)
  'random',          // ONE random agent per loop (mirrors kyegomez _process_random_speaker)
  'random-dynamic',  // first speaker random, subsequent picked from @mentions in prior contributions
]);
export type GroupchatSpeakerStrategy = z.infer<typeof GroupchatSpeakerStrategy>;

/**
 * Per-topology tuning. Each handler reads only the keys it cares about.
 * Adding a new topology means adding fields here, not changing this type's shape.
 */
export const TopologyOptionsSchema = z.object({
  // debate-with-judge
  debateRounds:               z.number().int().min(1).max(10).default(3),
  /** When true, debate handler uses built-in Pro/Con/Judge prompts and ignores coordinators[*].systemPromptTemplate. */
  debatePresetAgents:         z.boolean().default(false),

  // mixture-of-agents
  moaLayers:                  z.number().int().min(1).max(10).default(3),
  /** When true, the aggregator coordinator's systemPromptTemplate is replaced by the kyegomez AGGREGATOR_SYSTEM_PROMPT_MAIN. */
  moaPresetAggregator:        z.boolean().default(false),

  // majority-voting
  majorityLoops:              z.number().int().min(1).max(10).default(1),
  /** When true, the consensus coordinator's prompt is replaced by the kyegomez CONSENSUS_AGENT_PROMPT. */
  majorityPresetConsensus:    z.boolean().default(false),

  // sequential
  /** Run a separate semantic-alignment judge after the pipeline. Requires one extra coordinator with role substring "drift" or "judge". */
  sequentialDriftDetection:   z.boolean().default(false),

  // hierarchical
  maxDirectorLoops:           z.number().int().min(1).max(10).default(3),
  /** When true, director / worker / evaluation prompts are replaced by built-in role prompts. */
  hierarchicalPresetAgents:   z.boolean().default(false),

  // planner-worker
  /** When true, planner / worker / judge prompts are replaced by built-in role prompts. */
  plannerWorkerPresetAgents:  z.boolean().default(false),

  // round-robin
  /** Number of full passes over the (re-shuffled) coordinator list. */
  roundRobinLoops:            z.number().int().min(1).max(10).default(1),
  /** When true, every coordinator's prompt is replaced by the kyegomez collaborative round-robin prompt. */
  roundRobinPresetAgents:     z.boolean().default(false),

  // council-as-judge
  /** When true, dimension judges and the aggregator get the kyegomez CouncilAsAJudge preset prompts (dimension picked from role substring). */
  councilPresetAgents:        z.boolean().default(false),

  // groupchat
  /** Number of conversation loops. Per loop the speaker strategy decides who talks. */
  groupchatLoops:             z.number().int().min(1).max(10).default(1),
  /** Speaker selection strategy per loop. */
  groupchatSpeakerStrategy:   GroupchatSpeakerStrategy.default('round-robin'),
  /** When true, every coordinator's prompt is replaced by the kyegomez group-chat collaborative prompt with @mention instructions. */
  groupchatPresetAgents:      z.boolean().default(false),

  // heavy-swarm
  /** Number of full Captain → Specialists → Synthesis cycles. Subsequent loops see the prior synthesis as context. */
  heavyLoops:                 z.number().int().min(1).max(5).default(1),
  /** When true, captain / specialist / synthesis prompts are replaced by built-in role prompts (specialists matched by role substring: research, analysis, alternatives, verification, with generic fallback). */
  heavyPresetAgents:          z.boolean().default(false),

  // agent-rearrange
  /** Flow-DSL string mapping execution order. "->" denotes sequential steps, "," within a step denotes parallel agents. Example: "research -> writer, reviewer -> editor". Required when topology=agent-rearrange. */
  agentRearrangeFlow:         z.string().min(1).default(''),
  /** Number of times the entire flow is re-executed. Subsequent loops see prior step outputs accumulated in the conversation. */
  agentRearrangeLoops:        z.number().int().min(1).max(5).default(1),
  /** When true, the flow-aware collaborative prompt is applied to every coordinator (knows position, predecessors, successors). */
  agentRearrangePresetAgents: z.boolean().default(false),

  // graph-workflow
  /**
   * Directed edges as [from, to] coordinator-id pairs. The handler computes
   * topological layers (Kahn's algorithm); nodes within a layer run in
   * parallel, layers run sequentially. Cycles are rejected at validate time.
   * Empty edges = single-layer concurrent topology.
   */
  graphWorkflowEdges:         z.array(z.tuple([z.string(), z.string()])).default([]),
  /** Number of times the full DAG is re-executed. Subsequent loops feed end-node outputs back as context for entry nodes. */
  graphWorkflowLoops:         z.number().int().min(1).max(5).default(1),
  /** When true, every coordinator's prompt is replaced by the kyegomez DAG-aware prompt (knows predecessors and successors in the graph). */
  graphWorkflowPresetAgents:  z.boolean().default(false),
}).partial().default({});
export type TopologyOptions = z.infer<typeof TopologyOptionsSchema>;

export const SwarmConfigSchema = z.object({
  goal:               z.string().min(5),
  coordinators:       z.array(CoordinatorConfigSchema).min(1).max(10),
  topology:           SwarmTopology.default('concurrent'),
  topologyOptions:    TopologyOptionsSchema,
  globalTokenLimit:   z.number().int().positive().default(5_000_000),
  timeoutMs:          z.number().int().positive().default(8 * 60_000),
});
export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;
