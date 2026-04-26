/**
 * Per-topology metadata for the frontend playground:
 *   - human description
 *   - ASCII art diagram
 *   - role conventions (which role substrings the handler matches)
 *   - per-topology options (zod-derived shape, with default + description)
 *   - a sample minimal config the user can run as a smoke test
 *
 * This is the single source of truth the frontend reads via
 * GET /api/swarm/topologies. The handlers themselves don't need this — it
 * exists so the frontend can render explanatory + editable forms without
 * hard-coding what each topology requires.
 *
 * Sample configs intentionally use haiku and minimal turns so the user can
 * test all seven topologies without burning through their token budget.
 */
import type { SwarmTopology, SwarmConfig } from '../../swarm-schemas.js';

export interface TopologyOptionMeta {
  key:         string;
  type:        'number' | 'boolean';
  default:     number | boolean;
  min?:        number;
  max?:        number;
  description: string;
}

export interface TopologyMetadata {
  topology:        SwarmTopology;
  name:            string;
  description:     string;
  diagram:         string;          // ASCII art, render in <pre>
  roleConventions: string[];        // human-readable rules
  options:         TopologyOptionMeta[];
  sampleConfig:    SwarmConfig;
}

const HAIKU = 'haiku' as const;

const SAMPLE_TOOL_PERMISSIONS = {
  sendToPeer:      true,
  checkInbox:      true,
  readBlackboard:  true,
  writeBlackboard: true,
  listBlackboard:  true,
  reportProgress:  true,
  terminate:       true,
  spawnSubagents:  false,
};

/**
 * Build a coordinator entry. The systemPromptTemplate is a placeholder — when
 * the topology's preset prompts are enabled (via topologyOptions) the handler
 * overrides it. For topologies without presets the user is expected to edit
 * the JSON before running.
 */
function coord(id: string, role: string, model = HAIKU, maxTurns = 4) {
  return {
    id,
    role,
    model,
    maxTurns,
    systemPromptTemplate:
      `Goal: {{goal}}. Your id: {{id}}. Peer ids: {{peer_ids}}. ` +
      `Read the blackboard if context is needed, contribute, terminate.`,
    toolPermissions: SAMPLE_TOOL_PERMISSIONS,
    subagents:       [],
  };
}

export const TOPOLOGY_METADATA: Record<SwarmTopology, TopologyMetadata> = {
  concurrent: {
    topology:    'concurrent',
    name:        'Concurrent',
    description: 'Alle Coordinators starten parallel mit derselben Aufgabe. Kein Aggregator. Standard-Topologie für Hub-and-Spoke und parallele Recherche.',
    diagram: `
   ┌────────────────────┐
   │      Goal          │
   └────────────────────┘
            │
   ┌────────┼────────┐
   ▼        ▼        ▼
 ┌───┐    ┌───┐    ┌───┐
 │ A │    │ B │    │ C │   (parallel, unabhängig)
 └───┘    └───┘    └───┘
`.trim(),
    roleConventions: ['Beliebige Rollen, mindestens 1 Coordinator.'],
    options:         [],
    sampleConfig: {
      goal:             'Sammle drei verschiedene Perspektiven zu: TypeScript vs JavaScript für neue Projekte',
      topology:         'concurrent',
      coordinators:     [
        coord('perspective-a', 'Tech-Pragmatiker'),
        coord('perspective-b', 'Type-Safety-Verfechter'),
        coord('perspective-c', 'Velocity-Optimierer'),
      ],
      topologyOptions:  {},
      timeoutMs:        300_000,
      globalTokenLimit: 5_000_000,
    },
  },

  'debate-with-judge': {
    topology:    'debate-with-judge',
    name:        'Debate with Judge',
    description: 'Pro/Con/Judge debattieren in N Runden. Judge-Synthese seedet die nächste Runde (Refinement-Loop). Gut für Architektur-Entscheidungen.',
    diagram: `
 Round 1:
 ┌──────────┐    ┌──────────┐    ┌──────────┐
 │   PRO    │ -> │   CON    │ -> │  JUDGE   │
 └──────────┘    └──────────┘    └──────────┘
                                       │
                          (Synthese seedet Round 2)
                                       │
 Round 2:                              ▼
 ┌──────────┐    ┌──────────┐    ┌──────────┐
 │   PRO    │ -> │   CON    │ -> │  JUDGE   │
 └──────────┘    └──────────┘    └──────────┘
`.trim(),
    roleConventions: [
      'Genau 3 Coordinators.',
      'Eine Rolle muss "pro" enthalten, eine "con", eine "judge" (case-insensitive Substring-Match).',
    ],
    options: [
      { key: 'debateRounds',       type: 'number',  default: 1,    min: 1, max: 10, description: 'Anzahl der Pro→Con→Judge-Runden.' },
      { key: 'debatePresetAgents', type: 'boolean', default: true,                  description: 'Eingebaute kyegomez Pro/Con/Judge-Prompts statt eigene benutzen.' },
    ],
    sampleConfig: {
      goal:             'Sollten wir auf Microservices umsteigen?',
      topology:         'debate-with-judge',
      coordinators:     [
        coord('pro',   'Pro-Argumentator'),
        coord('con',   'Con-Position'),
        coord('judge', 'Judge'),
      ],
      topologyOptions:  { debateRounds: 1, debatePresetAgents: true },
      timeoutMs:        300_000,
      globalTokenLimit: 5_000_000,
    },
  },

  'mixture-of-agents': {
    topology:    'mixture-of-agents',
    name:        'Mixture of Agents',
    description: 'L Layers paralleler Experten + finaler Aggregator. Jeder Layer sieht alle Outputs der vorherigen Layer.',
    diagram: `
 Layer 1: ┌────┐ ┌────┐ ┌────┐    (parallel)
          │ E1 │ │ E2 │ │ E3 │
          └────┘ └────┘ └────┘
                   │
                   ▼  (Conversation wächst)
 Layer 2: ┌────┐ ┌────┐ ┌────┐    (sieht Layer 1)
          │ E1 │ │ E2 │ │ E3 │
          └────┘ └────┘ └────┘
                   │
                   ▼
              ┌────────────┐
              │ Aggregator │
              └────────────┘
`.trim(),
    roleConventions: [
      'Mindestens 2 Coordinators (≥1 Experte + 1 Aggregator).',
      'Genau eine Rolle muss "aggregator" enthalten.',
    ],
    options: [
      { key: 'moaLayers',           type: 'number',  default: 2,    min: 1, max: 10, description: 'Anzahl der parallelen Experten-Runden vor der Aggregation.' },
      { key: 'moaPresetAggregator', type: 'boolean', default: true,                  description: 'Eingebauten kyegomez-Aggregator-Prompt benutzen.' },
    ],
    sampleConfig: {
      goal:             'Bewerte das Risiko einer KI-First-Strategie für ein 10-Mann-Startup aus drei Blickwinkeln (Tech, Markt, Finanzen)',
      topology:         'mixture-of-agents',
      coordinators:     [
        coord('expert-tech',    'Tech-Risikoanalyst'),
        coord('expert-market',  'Markt-Analyst'),
        coord('expert-finance', 'Finanz-Analyst'),
        coord('aggregator',     'Aggregator'),
      ],
      topologyOptions:  { moaLayers: 2, moaPresetAggregator: true },
      timeoutMs:        420_000,
      globalTokenLimit: 5_000_000,
    },
  },

  'majority-voting': {
    topology:    'majority-voting',
    name:        'Majority Voting',
    description: 'N Loops × (alle Experten parallel → Consensus-Coordinator synthesiert). Consensus seedet die nächste Loop. Gut für hochstakes Entscheidungen.',
    diagram: `
 Loop 1: ┌────┐ ┌────┐ ┌────┐   (parallel votes)
         │ E1 │ │ E2 │ │ E3 │
         └────┘ └────┘ └────┘
                  │
                  ▼
            ┌──────────┐
            │ Consensus│
            └──────────┘
                  │
 Loop 2:          ▼  (seedet)
         ┌────┐ ┌────┐ ┌────┐
         │ E1 │ │ E2 │ │ E3 │
         └────┘ └────┘ └────┘
                  ↓
            ┌──────────┐
            │ Consensus│  → majority:final
            └──────────┘
`.trim(),
    roleConventions: [
      'Mindestens 3 Coordinators (≥2 Experten + 1 Consensus).',
      'Genau eine Rolle muss "consensus" enthalten.',
    ],
    options: [
      { key: 'majorityLoops',           type: 'number',  default: 1,    min: 1, max: 10, description: 'Anzahl der (Vote → Consensus)-Loops.' },
      { key: 'majorityPresetConsensus', type: 'boolean', default: true,                  description: 'Eingebauten kyegomez Consensus-Prompt benutzen.' },
    ],
    sampleConfig: {
      goal:             'Empfiehlt sich für ein neues Web-Backend Node.js, Go oder Rust? Stimme mit Begründung ab.',
      topology:         'majority-voting',
      coordinators:     [
        coord('voter-node',  'Node-Befürworter'),
        coord('voter-go',    'Go-Befürworter'),
        coord('voter-rust',  'Rust-Befürworter'),
        coord('consensus',   'Consensus'),
      ],
      topologyOptions:  { majorityLoops: 1, majorityPresetConsensus: true },
      timeoutMs:        420_000,
      globalTokenLimit: 5_000_000,
    },
  },

  sequential: {
    topology:    'sequential',
    name:        'Sequential Pipeline',
    description: 'Lineare Pipeline A → B → C → … in Array-Reihenfolge. Jeder Stage bekommt Output des vorherigen als Input.',
    diagram: `
 ┌────────┐    ┌────────┐    ┌────────┐    ┌────────┐
 │ Stage1 │ -> │ Stage2 │ -> │ Stage3 │ -> │ Stage4 │
 └────────┘    └────────┘    └────────┘    └────────┘
   schreibt       liest+         …             …
   stage_1        stage_1
                  schreibt
                  stage_2
`.trim(),
    roleConventions: [
      'Mindestens 2 Coordinators in gewünschter Pipeline-Reihenfolge.',
      'Wenn sequentialDriftDetection=true: ein zusätzlicher Coordinator mit Rolle "drift" oder "judge" wird aus der Pipeline gezogen und bewertet das Ergebnis am Ende.',
    ],
    options: [
      { key: 'sequentialDriftDetection', type: 'boolean', default: false,                description: 'Nach der Pipeline einen Drift-Judge laufen lassen (Score 0-1, semantische Alignment).' },
      { key: 'sequentialLoops',          type: 'number',  default: 1,    min: 1, max: 5, description: 'Anzahl der Pipeline-Durchläufe. Loop N+1 bekommt Loop N\'s finalen Output als Input für Stage 1 (iterative Verfeinerung).' },
    ],
    sampleConfig: {
      goal:             'Schreibe einen kurzen LinkedIn-Post zu "Warum TypeScript-Types in 2026 wichtiger sind als je"',
      topology:         'sequential',
      coordinators:     [
        coord('writer',  'Writer'),
        coord('editor',  'Editor'),
        coord('polish',  'Final-Polish'),
      ],
      topologyOptions:  { sequentialDriftDetection: false },
      timeoutMs:        300_000,
      globalTokenLimit: 5_000_000,
    },
  },

  hierarchical: {
    topology:    'hierarchical',
    name:        'Hierarchical (Director + Workers)',
    description: 'Director plant + delegiert + bewertet, Workers führen aus. Bis zu maxDirectorLoops Iterationen mit Verdict-basiertem Abbruch.',
    diagram: `
       ┌──────────┐
       │ Director │  (plant JSON-Tasks → blackboard)
       └──────────┘
        ↙   ↓   ↘
  ┌──────┐┌──────┐┌──────┐
  │  W1  ││  W2  ││  W3  │  (parallel, eigene Assignments)
  └──────┘└──────┘└──────┘
        ↘   ↓   ↙
       ┌──────────┐
       │ Director │  (Eval-Phase, schreibt verdict)
       └──────────┘
            │
       continue? ─── ja ──► nächste Loop
            │
            nein
            ▼
          fertig
`.trim(),
    roleConventions: [
      'Mindestens 2 Coordinators.',
      'Genau eine Rolle muss "director" enthalten, der Rest sind Workers.',
    ],
    options: [
      { key: 'maxDirectorLoops',         type: 'number',  default: 2,    min: 1, max: 10, description: 'Maximale Anzahl Director-Plan/Eval-Loops.' },
      { key: 'hierarchicalPresetAgents', type: 'boolean', default: true,                  description: 'Eingebaute Director/Worker/Evaluation-Prompts benutzen.' },
    ],
    sampleConfig: {
      goal:             'Plane einen 30-Sekunden-Blogpost-Trailer für ein Tech-Buch über Multi-Agent-Systems. Liefere am Ende den fertigen Trailer-Text.',
      topology:         'hierarchical',
      coordinators:     [
        coord('director', 'Director'),
        coord('worker-research', 'Research-Worker'),
        coord('worker-writer',   'Writer-Worker'),
      ],
      topologyOptions:  { maxDirectorLoops: 2, hierarchicalPresetAgents: true },
      timeoutMs:        600_000,
      globalTokenLimit: 5_000_000,
    },
  },

  'round-robin': {
    topology:    'round-robin',
    name:        'Round-Robin (AutoGen-style)',
    description: 'N Loops × (alle Coordinators reihum, Reihenfolge pro Loop neu zufällig). Jeder sieht die volle Conversation-History und baut auf den Beiträgen der anderen auf.',
    diagram: `
 Loop 1 (random order): A → B → C
   A schreibt loop_1:A
   B sieht Conversation+A
   C sieht Conversation+A+B

 Loop 2 (re-shuffled): C → A → B
   C sieht alles aus Loop 1
   A sieht alles aus Loop 1 + Loop 2:C
   B sieht alles aus Loop 1 + Loop 2:C+A

   round_robin:conversation
   wächst monoton — jeder Beitrag wird angehängt
`.trim(),
    roleConventions: [
      'Mindestens 2 Coordinators.',
      'Keine speziellen Rollen — alle Agents sind gleichberechtigt.',
    ],
    options: [
      { key: 'roundRobinLoops',        type: 'number',  default: 1,    min: 1, max: 10, description: 'Anzahl der Voll-Durchläufe über alle Coordinators (jeweils mit neuer zufälliger Reihenfolge).' },
      { key: 'roundRobinPresetAgents', type: 'boolean', default: true,                  description: 'Eingebauten kyegomez-Round-Robin-Prompt benutzen (jeder baut auf vorherigen Beiträgen auf).' },
    ],
    sampleConfig: {
      goal:             'Brainstormt iterativ Produktnamen für eine neue KI-Werkbank-App. Jede Runde baut auf vorherigen Vorschlägen auf — Kombinationen, Verfeinerungen, neue Winkel.',
      topology:         'round-robin',
      coordinators:     [
        coord('alpha', 'Tech-Marken-Spezialist'),
        coord('beta',  'Storytelling-Profi'),
        coord('gamma', 'Linguist'),
      ],
      topologyOptions:  { roundRobinLoops: 2, roundRobinPresetAgents: true },
      timeoutMs:        420_000,
      globalTokenLimit: 5_000_000,
    },
  },

  groupchat: {
    topology:    'groupchat',
    name:        'GroupChat (collaborative)',
    description: 'Kollaborative N-Agent-Konversation. Coordinator-IDs sind @mention-Adressen — Agents referenzieren sich gegenseitig in ihren Beiträgen. Drei Speaker-Strategien: "round-robin" (alle reihum), "random" (ein zufälliger Agent pro Loop), "random-dynamic" (erster zufällig, danach folgt @mentions).',
    diagram: `
 Loop 1 (round-robin):
   @alpha → @beta → @gamma   (alle in Reihenfolge)

 Loop 1 (random-dynamic):
   @alpha (zufällig)
        ↓ "...maybe @gamma should weigh in..."
   @gamma
        ↓ "...let's hear from @beta on this..."
   @beta
        ↓ (keine @mentions mehr → Loop endet)

   groupchat:conversation wächst monoton —
   jeder Beitrag wird angehängt; Handler scannt
   ihn auf @mentions für die nächste Sprecherwahl.
`.trim(),
    roleConventions: [
      'Mindestens 2 Coordinators.',
      'Keine speziellen Rollen — alle Agents sind gleichberechtigt.',
      'Coordinator-IDs werden als @mention-Adressen verwendet.',
    ],
    options: [
      { key: 'groupchatLoops',          type: 'number',  default: 2,    min: 1, max: 10, description: 'Anzahl der Voll-Konversations-Loops.' },
      { key: 'groupchatPresetAgents',   type: 'boolean', default: true,                  description: 'Eingebauten kyegomez Group-Chat-Prompt mit @mention-Anleitung benutzen.' },
      // groupchatSpeakerStrategy is a 3-valued enum; the frontend doesn't yet support enum option meta,
      // so it isn't editable here — the sample config below sets it explicitly. Edit JSON to change.
    ],
    sampleConfig: {
      goal:             'Diskutiert kollaborativ: "Was sind die drei wichtigsten Eigenschaften für ein 2026er KI-Werkzeug?" — baut aufeinander auf, mentioniert euch via @id für gezielte Rückfragen.',
      topology:         'groupchat',
      coordinators:     [
        coord('alpha', 'UX-Designerin'),
        coord('beta',  'ML-Engineer'),
        coord('gamma', 'Produktstrategin'),
      ],
      topologyOptions:  { groupchatLoops: 2, groupchatPresetAgents: true, groupchatSpeakerStrategy: 'round-robin' },
      timeoutMs:        420_000,
      globalTokenLimit: 5_000_000,
    },
  },

  'council-as-judge': {
    topology:    'council-as-judge',
    name:        'Council as a Judge',
    description: 'N parallele Dimensionen-Judges (z.B. Accuracy, Helpfulness, Coherence) + 1 Aggregator. Quality-Gate-Pattern aus kyegomez CouncilAsAJudge.',
    diagram: `
 Phase 1 (parallel):
 ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
 │ Accuracy     │ │ Helpfulness  │ │ Coherence    │
 │ Judge        │ │ Judge        │ │ Judge        │
 └──────────────┘ └──────────────┘ └──────────────┘
        │               │               │
        ▼               ▼               ▼
   council:judgment:<id>  (jeder schreibt eigenes Rationale)
        │               │               │
        └───────┬───────┘───────┬───────┘
                ▼
 Phase 2:  ┌──────────────┐
           │  Aggregator  │  (synthesisiert alle Rationales)
           └──────────────┘
                │
                ▼
       council:final_report
`.trim(),
    roleConventions: [
      'Mindestens 2 Coordinators (>=1 Judge + 1 Aggregator).',
      'Genau eine Rolle muss "aggregator" enthalten.',
      'Judge-Rollen lösen mit councilPresetAgents=true die kyegomez-Dimension auf, wenn der Rollen-String "accuracy", "helpfulness", "harmlessness", "coherence", "conciseness" oder "instruction-adherence" enthält. Sonst wird die Rolle als generisches Dimensions-Label benutzt.',
    ],
    options: [
      { key: 'councilPresetAgents', type: 'boolean', default: true, description: 'Eingebaute kyegomez Judge/Aggregator-Prompts benutzen (Dimension wird aus Rollen-Substring gewählt).' },
    ],
    sampleConfig: {
      goal:             'Bewerte folgenden Vorschlag aus mehreren Qualitätsdimensionen: "Wir migrieren das gesamte Backend von TypeScript nach Rust, um eine 10x Performance-Steigerung zu erreichen, in 6 Wochen mit 2 Devs."',
      topology:         'council-as-judge',
      coordinators:     [
        coord('judge-accuracy',     'Accuracy-Judge'),
        coord('judge-helpfulness',  'Helpfulness-Judge'),
        coord('judge-coherence',    'Coherence-Judge'),
        coord('judge-instruction',  'Instruction-Adherence-Judge'),
        coord('aggregator',         'Aggregator'),
      ],
      topologyOptions:  { councilPresetAgents: true },
      timeoutMs:        480_000,
      globalTokenLimit: 5_000_000,
    },
  },

  'agent-rearrange': {
    topology:    'agent-rearrange',
    name:        'Agent Rearrange (Flow-DSL)',
    description: 'Schedulet Coordinators per Flow-String: "->" trennt sequenzielle Steps, "," trennt parallele Agents im selben Step. Beispiel: "research -> writer, reviewer -> editor". Aus kyegomez AgentRearrange portiert (ohne Human-in-the-Loop "H" und Memory-System — Werkbank-fremd).',
    diagram: `
 Flow: "research -> writer, reviewer -> editor"

 Step 1:        ┌──────────┐
                │ research │   sequential
                └──────────┘
                     │
                     ▼
 Step 2:   ┌────────┐    ┌──────────┐
           │ writer │    │ reviewer │   parallel (",")
           └────────┘    └──────────┘
                 └──────┬──────┘
                        ▼
 Step 3:           ┌────────┐
                   │ editor │   sequential
                   └────────┘

 Conversation wächst monoton; jeder Agent sieht
 vorhergehende Step-Outputs als Kontext.
`.trim(),
    roleConventions: [
      'Mindestens 2 Coordinators.',
      'agentRearrangeFlow muss alle referenzierten IDs enthalten und mindestens ein "->" haben.',
      '"H" (Human-in-the-Loop) wird abgelehnt — Werkbank hat keinen REPL-Channel.',
      'Eine ID darf mehrfach im Flow auftauchen ("writer -> reviewer -> writer"); jeder Aufruf ist ein eigener Step-Output.',
    ],
    options: [
      { key: 'agentRearrangeLoops',        type: 'number',  default: 1,    min: 1, max: 5, description: 'Anzahl der vollen Flow-Durchläufe. Folge-Loops sehen die akkumulierte Conversation als Kontext.' },
      { key: 'agentRearrangePresetAgents', type: 'boolean', default: true,                 description: 'Eingebauten flow-aware kyegomez Prompt benutzen (Position, Vorgänger, Nachfolger im Flow).' },
      // agentRearrangeFlow is a string and the frontend doesn't yet support string option meta;
      // it is set via the sample config. Edit JSON to change the flow.
    ],
    sampleConfig: {
      goal:             'Schreibe einen kurzen TIL-Post zu "TypeScript satisfies-Operator". Recherche zuerst, dann parallel Erst-Draft + Reviewer, danach finaler Polish.',
      topology:         'agent-rearrange',
      coordinators:     [
        coord('research', 'Researcher'),
        coord('writer',   'Writer'),
        coord('reviewer', 'Reviewer'),
        coord('editor',   'Editor'),
      ],
      topologyOptions:  {
        agentRearrangeFlow:         'research -> writer, reviewer -> editor',
        agentRearrangeLoops:        1,
        agentRearrangePresetAgents: true,
      },
      timeoutMs:        540_000,
      globalTokenLimit: 5_000_000,
    },
  },

  'graph-workflow': {
    topology:    'graph-workflow',
    name:        'Graph Workflow (DAG)',
    description: 'Coordinators als Knoten in einem gerichteten azyklischen Graph (DAG). Edges definieren Abhängigkeiten. Handler berechnet topologische Layers (Kahn) und führt jeden Layer parallel aus, Layers sequenziell. Aus kyegomez GraphWorkflow portiert (Phase-4 Roadmap-Item) — ohne Checkpointing/networkx.',
    diagram: `
 Edges: [["a","c"], ["b","c"], ["c","d"], ["c","e"]]

   ┌───┐    ┌───┐
   │ a │    │ b │   Layer 0 (Entry, parallel)
   └───┘    └───┘
       \\    /
        ▼  ▼
        ┌───┐         Layer 1
        │ c │
        └───┘
        /    \\
       ▼      ▼
   ┌───┐    ┌───┐
   │ d │    │ e │   Layer 2 (End, parallel)
   └───┘    └───┘

 Jede Node sieht ihre Predecessor-Outputs als Kontext.
 Multi-Loop: End-Node Outputs seedet nächsten Loop-Eingang.
`.trim(),
    roleConventions: [
      'Mindestens 2 Coordinators.',
      'graphWorkflowEdges referenziert nur bekannte Coordinator-IDs.',
      'Keine Self-Loops, keine Zyklen — sonst schlägt validate fehl.',
      'Eine Node kann mehrere Predecessors haben (sieht alle deren Outputs); Empty-Edges = single-layer concurrent topology.',
    ],
    options: [
      { key: 'graphWorkflowLoops',        type: 'number',  default: 1,    min: 1, max: 5, description: 'Anzahl der vollen DAG-Durchläufe. End-Node Outputs werden als Kontext für den nächsten Loop weitergegeben.' },
      { key: 'graphWorkflowPresetAgents', type: 'boolean', default: true,                 description: 'Eingebaute DAG-aware kyegomez Prompt benutzen (Predecessors, Successors, Layer-Position).' },
      // graphWorkflowEdges is a [string,string][] tuple array — frontend doesn't yet support this option meta type.
      // Set via the sample config; edit JSON to change the topology.
    ],
    sampleConfig: {
      goal:             'Erstelle einen Mini-Markt-Report zu "Vue 3.5 Adoption". Researcher und Analyst arbeiten parallel als Eingabe; Synthesizer fasst zusammen; Editor + Reviewer prüfen parallel.',
      topology:         'graph-workflow',
      coordinators:     [
        coord('researcher', 'Researcher'),
        coord('analyst',    'Analyst'),
        coord('synth',      'Synthesizer'),
        coord('editor',     'Editor'),
        coord('reviewer',   'Reviewer'),
      ],
      topologyOptions:  {
        graphWorkflowEdges: [
          ['researcher', 'synth'],
          ['analyst',    'synth'],
          ['synth',      'editor'],
          ['synth',      'reviewer'],
        ],
        graphWorkflowLoops:        1,
        graphWorkflowPresetAgents: true,
      },
      timeoutMs:        600_000,
      globalTokenLimit: 5_000_000,
    },
  },

  'heavy-swarm': {
    topology:    'heavy-swarm',
    name:        'Heavy Swarm (Captain + Specialists + Synthesis)',
    description: 'Captain zerlegt das Goal in spezialisierte Fragen, N parallele Specialists antworten, Synthesis aggregiert zu einem Executive-Report. Iteriert optional mit prior-synthesis als Kontext. Aus kyegomez HeavySwarm portiert; Specialist-Anzahl flexibel (Original: research/analysis/alternatives/verification).',
    diagram: `
 Loop 1:
   ┌────────────┐
   │  Captain   │  (zerlegt → JSON: {id → question})
   └────────────┘
        │
   ┌────┼────┬────┐
   ▼    ▼    ▼    ▼
 ┌───┐┌───┐┌───┐┌───┐
 │ R ││ A ││Alt││ V │  parallele Specialists
 └───┘└───┘└───┘└───┘
   └────┼────┴────┘
        ▼
   ┌────────────┐
   │ Synthesis  │  (Executive-Report → heavy:final_report)
   └────────────┘
        │
 Loop 2:│ (synthesis seedet Captain + Synthesis)
        ▼
       ...
`.trim(),
    roleConventions: [
      'Mindestens 3 Coordinators (Captain + >=1 Specialist + Synthesis).',
      'Genau eine Rolle muss "captain" oder "question" enthalten.',
      'Genau eine Rolle muss "synthesis" enthalten.',
      'Specialists werden bei heavyPresetAgents=true per Rollen-Substring auf die kyegomez-Prompts gemappt: "research", "analysis", "alternatives", "verification". Sonst greift ein generischer Specialist-Prompt.',
    ],
    options: [
      { key: 'heavyLoops',        type: 'number',  default: 1,    min: 1, max: 5, description: 'Anzahl der vollen Captain → Specialists → Synthesis Zyklen. Folge-Loops sehen die vorherige Synthesis als Kontext.' },
      { key: 'heavyPresetAgents', type: 'boolean', default: true,                 description: 'Eingebaute kyegomez Captain/Specialist/Synthesis-Prompts benutzen.' },
    ],
    sampleConfig: {
      goal:             'Erstelle eine Entscheidungsempfehlung: Sollten wir 2026 von TypeScript auf Bun + Hono migrieren? Brauche Research, Analysis, Alternatives, Verification, dann Synthesis.',
      topology:         'heavy-swarm',
      coordinators:     [
        coord('captain',      'Captain (Question Decomposer)'),
        coord('research',     'Research Specialist'),
        coord('analysis',     'Analysis Specialist'),
        coord('alternatives', 'Alternatives Specialist'),
        coord('verification', 'Verification Specialist'),
        coord('synthesis',    'Synthesis Agent'),
      ],
      topologyOptions:  { heavyLoops: 1, heavyPresetAgents: true },
      timeoutMs:        720_000,
      globalTokenLimit: 8_000_000,
    },
  },

  'planner-worker': {
    topology:    'planner-worker',
    name:        'Planner + Worker Queue',
    description: 'Planner erstellt Task-DAG (mit Dependencies), Workers claimen + erledigen. Tasks leben in swarm_tasks-Tabelle (nicht Blackboard). Optional 1 Judge am Ende.',
    diagram: `
   ┌──────────┐                ┌──────────┐
   │ Planner  │───publish─────►│  Tasks   │
   └──────────┘                │ (SQLite) │
                               └──────────┘
                                ↑   ↑   ↑
                         claim/ │   │   │ /complete
                                │   │   │
                          ┌──────┐┌──────┐┌──────┐
                          │  W1  ││  W2  ││  W3  │
                          └──────┘└──────┘└──────┘
                                          │
                                          ▼
                                    ┌──────────┐
                                    │  Judge   │  (optional)
                                    └──────────┘
`.trim(),
    roleConventions: [
      'Mindestens 2 Coordinators.',
      'Genau eine Rolle muss "planner" enthalten.',
      'Optional: höchstens eine Rolle mit "judge" (kann fehlen).',
      'Mindestens 1 Worker (alles, was nicht planner/judge ist).',
    ],
    options: [
      { key: 'plannerWorkerPresetAgents', type: 'boolean', default: true,                 description: 'Eingebaute Planner/Worker/Judge-Prompts benutzen.' },
      { key: 'plannerWorkerLoops',        type: 'number',  default: 1,    min: 1, max: 5, description: 'Anzahl der Planner→Workers→Judge Cycles. Judge kann mit is_complete=true früh abbrechen; needs_fresh_start=true räumt die Queue komplett. Erfordert einen Judge-Coordinator wenn > 1.' },
    ],
    sampleConfig: {
      goal:             'Plane und schreibe ein 4-Kapitel-Mini-Tutorial für "Vue 3 Reactivity". Plan zuerst die Kapitel, dann jeder Worker schreibt eines.',
      topology:         'planner-worker',
      coordinators:     [
        coord('planner',  'Planner'),
        coord('worker-1', 'Worker'),
        coord('worker-2', 'Worker'),
        coord('judge',    'Judge'),
      ],
      topologyOptions:  { plannerWorkerPresetAgents: true },
      timeoutMs:        600_000,
      globalTokenLimit: 5_000_000,
    },
  },
};
