# 16 — Validation Edge Cases

Negative tests: configs that MUST fail validation. They are POSTed to
`/api/swarm/validate` (no spawn, no tokens). Expected response:
`{ ok: false, errors: [...] }` plus specific error substrings.

| Sub-Test | What's wrong | Expected error substring |
|---|---|---|
| 16a-bogus-flow         | agent-rearrange flow references unknown id "X" | "unknown coordinator id" |
| 16b-graph-cycle        | graph-workflow edges form a cycle a→b→a       | "contains a cycle" |
| 16c-planner-no-judge   | planner-worker loops=3 but no judge coord     | "requires a judge" |
| 16d-sequential-too-few | sequential with only 1 coordinator            | "at least 2 coordinators" |
