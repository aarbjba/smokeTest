/**
 * Groupchat topology — collaborative N-agent conversation with pluggable
 * speaker selection. Coordinator IDs serve as @mention addresses; agents
 * see the full conversation history via blackboard, can reference each
 * other with @id, and the speaker strategy decides who talks each loop.
 *
 * Ported from kyegomez/swarms `GroupChat` (Apache-2.0). The Python original
 * has four speaker functions: round-robin-speaker, random-speaker,
 * priority-speaker, random-dynamic-speaker. We expose three: priority is
 * dropped because per-coordinator priority weights would require a new
 * config field (priorities-by-id) and the use case (weighted random pick)
 * is already covered by `random` once you mark coordinators inactive by
 * leaving them out of the config.
 *
 * Mapping reference → werkbank:
 *   self.conversation                                   → blackboard "groupchat:conversation" (handler-owned)
 *   _extract_mentions(@regex r"@(\w+)")                 → MENTION_REGEX, applied to each contribution
 *   round_robin_speaker(agents, current_index)          → strategy "round-robin": iterate every agent, shift start per loop
 *   random_speaker(agents)                              → strategy "random": ONE random pick per loop
 *   random_dynamic_speaker(agents, response, strategy)  → strategy "random-dynamic": random first, then follow @mentions
 *   _update_agent_prompts (collaboration guidelines)    → GROUPCHAT_AGENT_PROMPT (preset, embedded below)
 *   _get_agent_response (collaborative_task)            → spawnCoordinator with conversation_so_far + peer_roster
 *   max_loops (=1 in Python __init__ but unused)        → topologyOptions.groupchatLoops (we DO loop)
 *
 * Loop semantics deviation:
 *   Python's GroupChat.run() doesn't actually loop on max_loops in the
 *   current ref code (it processes one round per call). We loop on
 *   groupchatLoops so the user can request a multi-round chat without
 *   re-invoking the swarm, which matches what the docstring promises.
 *
 * Source: D:/programme/swarms-concept/_reference/swarms/structs/groupchat.py
 */
import type { SwarmConfig, CoordinatorConfig, GroupchatSpeakerStrategy } from '../../swarm-schemas.js';
import {
  spawnCoordinator,
  emitTopologyEvent,
  type RunContext,
} from '../swarm-runtime.js';
import type { TopologyHandler, TopologyValidation } from './index.js';

// ─── Pre-built collaborative prompt (semantics from groupchat.py:get_*_prompt) ─

const GROUPCHAT_AGENT_PROMPT = `You are part of a collaborative group chat where you can interact with other agents using @mentions.

COLLABORATIVE RESPONSE PROTOCOL:
1. Read and understand all previous responses from other agents
2. Acknowledge what other agents have said before adding your own perspective
3. Build upon their insights rather than repeating information
4. Use @agent_id to mention another agent when their input is needed
5. Acknowledge when your part is done and what still needs to be done

HOW TO MENTION OTHER AGENTS:
- Write @id where "id" is one of the peer ids listed below.
- You can mention multiple agents: "@analyst @writer".
- Mentioned agents may be selected to speak next (depends on the speaker strategy).

AVOID:
- Ignoring other agents' responses
- Repeating what others have already said
- Responding in isolation without considering the group's collective knowledge

---
Werkbank protocol (you are coordinator {{id}}, loop {{loop}}/{{total_loops}}, speaker strategy "{{strategy}}"):

Original task: {{goal}}

Peer agents you may mention with @id:
{{peer_roster}}

Full conversation history so far:

{{conversation_so_far}}

---

YOUR TASK THIS TURN:
1. Review the full conversation above.
2. Respond as {{id}} per your assigned role: contribute your unique perspective, acknowledge others, and use @mentions where relevant.
3. Write your contribution as a STRING to blackboard key '{{contribution_key}}' (overwrite). The handler appends it to the canonical conversation, extracts @mentions, and may select your mentioned peers to speak next.
4. Call terminate() when done. Do not exceed {{max_turns_hint}} turns.`;

// ─── Blackboard helpers (handler-owned, mirrors round-robin/majority-voting) ─

function readKey(ctx: RunContext, key: string): string {
  const row = ctx.runDb
    .prepare('SELECT value FROM blackboard WHERE key = ? AND is_current = 1')
    .get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

function writeKey(ctx: RunContext, key: string, value: string): void {
  ctx.runDb.transaction(() => {
    ctx.runDb.prepare('UPDATE blackboard SET is_current = 0 WHERE key = ? AND is_current = 1').run(key);
    const vRow = ctx.runDb
      .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM blackboard WHERE key = ?')
      .get(key) as { v: number };
    ctx.runDb.prepare(
      'INSERT INTO blackboard (key, value, version, written_by, written_at, is_current) VALUES (?, ?, ?, ?, ?, 1)',
    ).run(key, value, vRow.v, 'swarm', Date.now());
  })();
}

function withPresetPrompt(coord: CoordinatorConfig): CoordinatorConfig {
  return { ...coord, systemPromptTemplate: GROUPCHAT_AGENT_PROMPT };
}

const MENTION_REGEX = /@([a-z][a-z0-9-]{2,30})/gi;

/**
 * Extract @id mentions from a contribution. Mirrors the Python
 * `re.findall(r"@(\w+)", response)`, then filters to ids that exist among
 * the swarm's coordinators. Returns ids in first-occurrence order.
 */
function extractMentions(text: string, knownIds: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION_REGEX)) {
    const id = match[1]!.toLowerCase();
    if (knownIds.has(id) && !seen.has(id)) {
      seen.add(id);
      found.push(id);
    }
  }
  return found;
}

// ─── Speaker spawn (one turn) ───────────────────────────────────────────────

interface SpawnArgs {
  ctx:        RunContext;
  coord:      CoordinatorConfig;
  loop:       number;
  totalLoops: number;
  strategy:   GroupchatSpeakerStrategy;
  roster:     string;
}

/**
 * Run one coordinator's turn in the group chat. Reads the canonical
 * conversation, runs the agent, then appends their contribution to the
 * conversation. Returns the contribution text so callers (dynamic
 * strategy) can extract @mentions from it.
 */
async function runOneTurn(args: SpawnArgs): Promise<string> {
  const { ctx, coord, loop, totalLoops, strategy, roster } = args;
  const contributionKey       = `groupchat:contribution_loop_${loop}:${coord.id}`;
  const conversationSnapshot  = readKey(ctx, 'groupchat:conversation');

  await spawnCoordinator(coord, ctx, {
    loop:                String(loop),
    total_loops:         String(totalLoops),
    strategy,
    peer_roster:         roster,
    conversation_so_far: conversationSnapshot,
    contribution_key:    contributionKey,
    max_turns_hint:      String(coord.maxTurns ?? 8),
  });

  const contribution = readKey(ctx, contributionKey);
  if (contribution) {
    const updated = `${conversationSnapshot}\n## ${coord.id} (${coord.role || 'agent'}):\n${contribution}\n`;
    writeKey(ctx, 'groupchat:conversation', updated);
  }
  return contribution;
}

// ─── Per-strategy loop runners ──────────────────────────────────────────────

interface LoopArgs {
  ctx:        RunContext;
  loop:       number;
  totalLoops: number;
  agents:     CoordinatorConfig[];   // already preset-applied if requested
  strategy:   GroupchatSpeakerStrategy;
  roster:     string;
  knownIds:   ReadonlySet<string>;
}

async function runRoundRobinLoop(args: LoopArgs): Promise<void> {
  const { ctx, loop, totalLoops, agents, strategy, roster } = args;
  // Shift the starting position per loop so the conversation feels less mechanical.
  const start = (loop - 1) % agents.length;
  for (let i = 0; i < agents.length; i++) {
    if (ctx.abort.signal.aborted) break;
    const coord = agents[(start + i) % agents.length]!;
    await runOneTurn({ ctx, coord, loop, totalLoops, strategy, roster });
  }
}

async function runRandomLoop(args: LoopArgs): Promise<void> {
  const { ctx, loop, totalLoops, agents, strategy, roster } = args;
  const coord = agents[Math.floor(Math.random() * agents.length)]!;
  await runOneTurn({ ctx, coord, loop, totalLoops, strategy, roster });
}

/**
 * Random-dynamic: pick a random first speaker, then keep selecting next
 * speaker(s) from @mentions found in the prior contribution. The loop
 * stops when no new mentions appear OR every agent has spoken once OR
 * we hit a hard cap (3× agent count, mirrors Python's max_loops cap).
 */
async function runRandomDynamicLoop(args: LoopArgs): Promise<void> {
  const { ctx, loop, totalLoops, agents, strategy, roster, knownIds } = args;
  const cap = agents.length * 3;
  const spoken = new Set<string>();
  const byId = new Map(agents.map(a => [a.id, a] as const));

  // First speaker: random pick.
  let next: CoordinatorConfig | undefined = agents[Math.floor(Math.random() * agents.length)];

  for (let iter = 0; iter < cap && spoken.size < agents.length; iter++) {
    if (ctx.abort.signal.aborted) break;
    if (!next) break;

    let coord: CoordinatorConfig = next;
    if (spoken.has(coord.id)) {
      // The mentioned agent already spoke — fall back to any agent that hasn't.
      const remaining = agents.find(a => !spoken.has(a.id));
      if (!remaining) break;
      coord = remaining;
    }

    const contribution = await runOneTurn({ ctx, coord, loop, totalLoops, strategy, roster });
    spoken.add(coord.id);

    // Pick the next speaker from @mentions in this contribution.
    const mentions = extractMentions(contribution, knownIds).filter(id => !spoken.has(id));
    if (mentions.length === 0) break;
    next = byId.get(mentions[0]!);
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const groupchatHandler: TopologyHandler = {
  topology: 'groupchat',

  validate(config: SwarmConfig): TopologyValidation {
    const errors: string[] = [];
    if (config.coordinators.length < 2) {
      errors.push(`groupchat requires at least 2 coordinators (got ${config.coordinators.length})`);
    }
    // The IDs are the @mention surface — they're already validated by CoordinatorConfigSchema's
    // regex `^[a-z][a-z0-9-]{2,30}$`, so no extra check is required here.
    return { valid: errors.length === 0, errors };
  },

  async run(ctx: RunContext): Promise<void> {
    const totalLoops = ctx.config.topologyOptions?.groupchatLoops           ?? 1;
    const strategy   = ctx.config.topologyOptions?.groupchatSpeakerStrategy ?? 'round-robin';
    const usePreset  = ctx.config.topologyOptions?.groupchatPresetAgents    ?? false;

    const agents = usePreset
      ? ctx.config.coordinators.map(withPresetPrompt)
      : [...ctx.config.coordinators];

    const knownIds = new Set(agents.map(a => a.id));
    const roster = agents
      .map(a => `- @${a.id} (${a.role || 'agent'})`)
      .join('\n');

    // Seed conversation with the task (matches Python `Conversation.add(role="User", content=task)`).
    writeKey(
      ctx,
      'groupchat:conversation',
      `# Task\n${ctx.config.goal}\n`,
    );

    for (let loop = 1; loop <= totalLoops; loop++) {
      if (ctx.abort.signal.aborted) break;

      emitTopologyEvent(ctx, 'topology:phase_change', {
        topology:   'groupchat',
        phase:      'loop_start',
        loop,
        totalLoops,
        strategy,
      });

      const loopArgs: LoopArgs = { ctx, loop, totalLoops, agents, strategy, roster, knownIds };

      switch (strategy) {
        case 'round-robin':    await runRoundRobinLoop(loopArgs); break;
        case 'random':         await runRandomLoop(loopArgs); break;
        case 'random-dynamic': await runRandomDynamicLoop(loopArgs); break;
      }
    }
  },
};
