# Werkbank Sandbox — Plan Index & Roadmap

Alle Planungs-Artefakte für das Feature *"Autonome Claude-Agent-Runs in ephemerer Docker-Sandbox auf `lp03.uts`"*. Lies von oben nach unten, dann arbeite die Phasen in Reihenfolge ab.

## Plan-Hierarchie

```
README.md                           ← hier: Index & Roadmap
│
├─ finigs_just_as_resource_and_knowlege.txt   ← Research (Backing für Entscheidungen)
│
├─ sandbox-plan_v1_initial.md        ← initialer Plan (nur User-Entscheidungen, superseded)
├─ sandbox-plan_v2_final.md          ← **finaler Gesamt-Plan** (Research-gehärtet, supersedet v1)
│
└─ Phasen-Pläne (Umsetzungs-Detail):
   ├─ phase-01-infrastructure-image.md   ← M1: Bootstrap lp03 + Docker Image
   ├─ phase-02-backend-runner.md         ← M2: Backend Runner + DB + Session Bridge
   ├─ phase-03-frontend.md               ← M3: UI + Settings
   └─ phase-04-verification-docs.md      ← M4: E2E-Tests + Docs + Ops
```

## Milestone-Übersicht

| # | Milestone | Plan | Liefert | Abhängigkeiten |
|---|-----------|------|---------|----------------|
| M1 | Infrastructure & Image | `phase-01-infrastructure-image.md` | `werkbank-sandbox:latest` auf lp03 via manuellem `docker run` testbar | SSH-Zugang zu lp03, GitHub-PAT, Test-Repo |
| M2 | Backend Runner + DB | `phase-02-backend-runner.md` | `POST /api/sandbox/:todoId/start` funktional, Stream-JSON über SSE live | M1 |
| M3 | Frontend Integration | `phase-03-frontend.md` | UI-Button startet Runs, Status-Chip, Settings-Sektion | M1 + M2 |
| M4 | Verification & Docs | `phase-04-verification-docs.md` | 15 Verification-Cases grün, Runbook + Troubleshooting, Go/No-Go-Checkliste | M1 + M2 + M3 |

## Reihenfolge & Parallelisierbarkeit

- **Strikt sequenziell**: M1 → M2 → M3 → M4 (jeder Milestone konsumiert Outputs des vorherigen)
- **Innerhalb eines Milestones**: Tasks sind atomar per Commit, aber Reihenfolge matters (z.B. DB-Migration vor Service, Service vor Route, Route vor Mount)
- **Nichts parallel außer Planung** (die ist jetzt fertig)

## Commit-Strategie

Jede Task in jedem Phasen-Plan hat einen Commit-Message-Vorschlag. CLAUDE.md-Regel: *"Always commit after implementing"* — also jede abgeschlossene Task = ein Commit, bevor die nächste startet. Kein Squashing am Ende.

## Vor dem ersten Run (Pre-Flight)

Phase 0 Bootstrap (in `phase-01` Task 1.1 dokumentiert) muss **einmal manuell** auf lp03 + VM durchlaufen werden, bevor M1-Task-1.6 (der erste End-to-End-Smoke-Run) funktionieren kann:
- SSH-Key generieren, Pubkey auf lp03 deployen
- Docker auf lp03 installieren + werkbank-User
- `docker context create lp03 --docker host=ssh://werkbank@lp03.uts` auf der VM
- Host-Level iptables `169.254.169.254`-Block
- `docker system prune`-Cron

## Offene Fragen (aus v2, zu klären vor M1-Start)

- **Windows-VM hat `docker`-CLI?** Ohne geht `docker --context lp03 …` nicht. Install: Docker Desktop oder `choco install docker-cli`.
- **PAT-Scope**: fine-grained mit Contents+PR RW, oder classic mit `repo`? Fine-grained bevorzugt, Fallback dokumentiert.
- **SSO-enforced Org?** Dann muss PAT für SSO authorisiert werden (GitHub-UI).

## Go-Signal

Sobald die drei offenen Fragen beantwortet sind und Phase 0 Bootstrap einmal durchgelaufen ist, kann M1 starten. Per `CLAUDE.md` gilt: *"Du startest keine Projekte selber ... nur wenn ICH dich dazu bitte machst du das!"* — ich warte auf explizites Go.
