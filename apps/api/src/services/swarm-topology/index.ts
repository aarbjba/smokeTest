/**
 * Swarm topology dispatcher.
 *
 * A topology decides HOW coordinators are scheduled relative to each other —
 * all-at-once, in a pipeline, in debate rounds, etc. Each handler hides that
 * scheduling logic behind a tiny interface so swarm-runtime stays unaware of
 * which topology is running.
 *
 * Adding a new topology: implement TopologyHandler, register in HANDLERS.
 */
import type { SwarmConfig, SwarmTopology } from '../../swarm-schemas.js';
import type { RunContext } from '../swarm-runtime.js';
import { concurrentHandler } from './concurrent.js';
import { debateWithJudgeHandler } from './debate-with-judge.js';
import { mixtureOfAgentsHandler } from './mixture-of-agents.js';
import { majorityVotingHandler } from './majority-voting.js';
import { sequentialHandler } from './sequential.js';
import { hierarchicalHandler } from './hierarchical.js';
import { plannerWorkerHandler } from './planner-worker.js';
import { roundRobinHandler } from './round-robin.js';
import { councilAsJudgeHandler } from './council-as-judge.js';
import { groupchatHandler } from './groupchat.js';

export interface TopologyValidation {
  valid:  boolean;
  errors: string[];
}

export interface TopologyHandler {
  topology: SwarmTopology;
  /** Topology-specific structural checks (role assignments, agent counts, etc.). */
  validate(config: SwarmConfig): TopologyValidation;
  /** Orchestrate the run. Resolves when all coordinators have finished or the run is aborted. */
  run(ctx: RunContext): Promise<void>;
}

const HANDLERS: Record<SwarmTopology, TopologyHandler> = {
  concurrent:          concurrentHandler,
  'debate-with-judge': debateWithJudgeHandler,
  'mixture-of-agents': mixtureOfAgentsHandler,
  'majority-voting':   majorityVotingHandler,
  sequential:          sequentialHandler,
  hierarchical:        hierarchicalHandler,
  'planner-worker':    plannerWorkerHandler,
  'round-robin':       roundRobinHandler,
  'council-as-judge':  councilAsJudgeHandler,
  groupchat:           groupchatHandler,
};

export function getTopologyHandler(topology: SwarmTopology): TopologyHandler {
  const handler = HANDLERS[topology];
  if (!handler) throw new Error(`Unknown topology: ${topology}`);
  return handler;
}
