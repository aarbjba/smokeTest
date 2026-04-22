# Feature Plans

Scope dieses Dokuments: die 12 Convenience-Features, die als Nächstes gebaut werden.
Jede Sektion: **Zweck → Files → Approach → Aufwand**. `M` steht für Minuten-Schätzung.

---

## 1. Command Palette (`Ctrl+K`)

**Zweck:** Fuzzy-Suche über alle Todos + globale Aktionen ("Neuer Todo", "Filter: nur Jira", "Theme: Dark").

**Files**
- `apps/web/src/components/CommandPalette.vue` (neu)
- `apps/web/src/App.vue` (globaler Key-Listener + Overlay-Render)
- `apps/web/src/styles/app.css` (modal)

**Approach**
- Overlay-Modal mit Suchfeld, Liste von Matches, ↑/↓/Enter-Navigation, Esc schließt.
- Fuzzy-Match mit simplem `includes` oder eigener `fuzzyScore()` (kein Package, vermeidet fuse.js-Bundle).
- Actions-Registry als Array im Palette-Component: `{ id, label, icon, perform(router, stores) }`.
- Todos werden nach Titel gematcht; Click öffnet Detail. Aktionen sind fest kodiert.

**Aufwand:** ~25 M

---

## 2. Natural-Language Quick-Add

**Zweck:** In der "Neue Aufgabe"-Box soll der User `Fix login bug tomorrow #auth !high` tippen; Tags, Prio und Fälligkeit werden automatisch extrahiert.

**Files**
- `apps/web/src/utils/parseQuickAdd.ts` (neu, reine Funktion)
- `apps/web/src/components/NewTodoForm.vue` (onInput → Preview-Chips, onSubmit verwendet geparste Werte)

**Approach**
- Regex-basierter Parser:
  - `#[a-z][a-z0-9-]*` → Tag
  - `!(urgent|high|normal|low|someday|1-4)` → Priority
  - `today|tomorrow|mon(day)?|tue(sday)?|…|YYYY-MM-DD` → due_date
  - Rest = Titel
- Preview-Zeile unter Input zeigt erkannte Tokens als Chips (Tag-Chips grün, Prio-Chip rot/gelb/grau, Datum-Chip blau).
- Title-Feld bleibt die Quelle; Preview ist read-only.

**Aufwand:** ~20 M

---

## 3. Saved Views

**Zweck:** Filter-Kombinationen persistieren: "Meine Bugs" (tag:bug + source:jira), "Diese Woche" (due_date < 7d), "Blocked".

**Files**
- `apps/api/src/routes/settings.ts` (bereits da, Speicherung via `settings` Tabelle)
- `apps/web/src/stores/views.ts` (neu, Pinia)
- `apps/web/src/components/SavedViewsBar.vue` (neu, Chips + "Speichern als…")
- `apps/web/src/views/BoardView.vue` (View-Auswahl-Leiste)

**Approach**
- View = `{ id, name, filters: { sourceFilter, search, tags, dueBefore, status[] } }`
- `views` Liste im `settings` Store unter key `savedViews`.
- Chips in der Topbar: aktive View wird hervorgehoben.
- "Speichern als…" öffnet Prompt, snapshot aktuelle Filter.
- "Löschen" via Rechtsklick oder Hover-X.

**Aufwand:** ~30 M

---

## 4. Subtasks / Checklisten

**Zweck:** Pro Todo beliebig viele Subtasks/Checklisten-Einträge, individuell abhakbar. Fortschrittsbalken auf Card.

**Files**
- `apps/api/src/db.ts` (neue Tabelle `subtasks`)
- `apps/api/src/routes/subtasks.ts` (neu: list by todo, create, toggle, delete, reorder)
- `apps/api/src/index.ts` (router mounten)
- `apps/web/src/types.ts` (`Subtask`)
- `apps/web/src/api.ts` (api.subtasks.*)
- `apps/web/src/components/SubtaskList.vue` (neu)
- `apps/web/src/views/TodoDetailView.vue` (Sektion einblenden)
- `apps/web/src/components/TodoCard.vue` (Fortschritt `3/5` neben Titel)

**Approach**
- Tabelle: `id, todo_id FK CASCADE, title, done INTEGER, position INTEGER, created_at`.
- REST: `GET /api/subtasks/by-todo/:id`, `POST`, `PATCH /api/subtasks/:id`, `DELETE`.
- UI: Liste mit Checkboxen, Inline-Edit beim Klick auf Titel, + "Neuer Subtask".
- Card: "🟢 3/5" wenn `>=1` Subtask.

**Aufwand:** ~45 M

---

## 5. Recurring Todos (Daily Standup)

**Zweck:** Wiederkehrende Todos auto-generieren, z.B. jeden Wochentag 8:00 "Standup".

**Files**
- `apps/api/src/db.ts` (neue Tabelle `recurrences`)
- `apps/api/src/routes/recurrences.ts` (neu: CRUD)
- `apps/api/src/services/recurrence-generator.ts` (neu: täglich prüft und fires)
- `apps/api/src/index.ts` (router + scheduler.ts integrieren)
- `apps/web/src/types.ts` (`Recurrence`)
- `apps/web/src/api.ts`
- `apps/web/src/views/SettingsView.vue` (Sektion "Wiederkehrende Aufgaben")

**Approach**
- Recurrence = `{ id, title, description, tags, priority, cron_expression (oder simple daily/weekdays/weekly), next_fire_at }`.
- Scheduler läuft stündlich (erweitere `scheduler.ts`): wenn `next_fire_at <= now`, erzeugt einen Todo mit `source='local'` und setzt `next_fire_at` auf nächste Ausführung.
- Minimale Cron-Parse: Preset-Auswahl (täglich/werktäglich/wöchentlich/monatlich) — kein Full-Cron.

**Aufwand:** ~50 M

---

## 6. Stack-Trace-Parser

**Zweck:** Paste eines Stack Traces in Description oder Snippet → Dateipfade werden als klickbare Links gerendert, die `vscode://file/<path>:<line>` öffnen (VS Code URL Scheme).

**Files**
- `apps/web/src/utils/linkifyStackTrace.ts` (neu)
- `apps/web/src/components/SnippetEditor.vue` (in Preview einbinden)
- `apps/web/src/views/TodoDetailView.vue` (Description-Markdown-Render)

**Approach**
- Regex matcht typische Formate: `at Foo (/abs/path.ts:12:34)`, `/abs/path.ts:12:34`, `File "/abs/path.py", line 42`.
- Render als `<a href="vscode://file${path}:${line}">path:line</a>`.
- Whitelisting: nur echte Paths (startet mit / oder Buchstabe + :\ auf Win), nicht URLs.

**Aufwand:** ~15 M

---

## 7. Git-Branch-Helper

**Zweck:** Button auf der Detail-View: "Branch aus Titel erzeugen". Kopiert Kommando `git checkout -b feat/titel` in Zwischenablage, optional im gewählten `working_directory` ausführen.

**Files**
- `apps/web/src/components/GitBranchButton.vue` (neu)
- `apps/web/src/views/TodoDetailView.vue` (Button-Row)
- `apps/api/src/routes/git.ts` (neu, optional: `POST /api/git/branch { cwd, name }` → spawnt git)

**Approach**
- Slug-Funktion: Titel → `feat/repo-fix-login-bug` (kill non-alnum, lowercase, prefix je nach Heuristik: `fix/` wenn "fix"/"bug" drin, `feat/` default).
- Button: "📋 Copy-Befehl" (immer) + "⚡ Ausführen" (wenn `working_directory` gesetzt, spawnt `git` in cwd).

**Aufwand:** ~20 M

---

## 8. Undo (`Ctrl+Z`)

**Zweck:** Letzte Aktion rückgängig machen (verschieben, löschen, status-change). Client-side ohne Server-History.

**Files**
- `apps/web/src/stores/undo.ts` (neu)
- `apps/web/src/stores/todos.ts` (nach jeder mutierenden Action → `undoStack.push`)
- `apps/web/src/App.vue` (Ctrl+Z Listener)

**Approach**
- Undo-Eintrag: `{ label, apply(), revert() }`.
- move/update/reorder/remove schieben einen Eintrag auf den Stack (bis 20).
- Ctrl+Z → `pop().revert()`.
- Toast: "Rückgängig gemacht: Titel wurde verschoben" mit "Redo".

**Aufwand:** ~30 M

---

## 9. Standup-Generator

**Zweck:** Button "Standup kopieren" → generiert Markdown aus: gestern erledigte (done) Todos + heute in progress + blocked.

**Files**
- `apps/api/src/routes/standup.ts` (neu: `GET /api/standup` → JSON mit `yesterday`, `today`, `blocked`)
- `apps/web/src/components/StandupButton.vue` (neu, im Topbar oder Board)
- `apps/web/src/api.ts`

**Approach**
- Query Todos wo `updated_at` zwischen "gestern 0:00" und "heute 0:00" AND `status = 'done'` → yesterday.
- Wo `status IN ('in_progress', 'test')` → today.
- Wo `tags` enthält `blocked` OR Titel enthält `[BLOCKED]` → blocked.
- Frontend rendert Markdown, "Copy" in Zwischenablage.

**Aufwand:** ~25 M

---

## 10. ICS-Export (Kalender-Sync)

**Zweck:** Alle Todos mit `due_date` als iCalendar-Feed exportieren. URL kann in Outlook/Google Cal abonniert werden.

**Files**
- `apps/api/src/routes/ics.ts` (neu: `GET /api/ics.ics` → text/calendar)
- `apps/web/src/views/SettingsView.vue` (Button "ICS-URL kopieren")

**Approach**
- RFC 5545 VEVENT pro Todo mit `due_date`.
- UID: `todo-${id}@werkbank.local`.
- DTSTART/DTEND aus due_date (1h-Event), SUMMARY aus Titel.
- Keine Auth — lokaler Dienst, Risiko minimal.

**Aufwand:** ~20 M

---

## 11. Browser-Benachrichtigungen

**Zweck:** Wenn ein Todo fällig ist (now >= due_date, noch nicht `done`), Notification via Web Notifications API.

**Files**
- `apps/web/src/composables/useDueNotifications.ts` (neu)
- `apps/web/src/App.vue` (onMounted → permission request + polling)

**Approach**
- Permission nur beim ersten Klick eines Buttons anfordern (sonst blockt Chrome).
- Alle 5 min lokale Prüfung: `due_date < now AND !notified`.
- Shown-Tracking in localStorage (Set von `todoId:due_date`) — doppelte Benachrichtigungen vermeiden.

**Aufwand:** ~25 M

---

## 12. Bulk-Ops

**Zweck:** Mehrere Cards via Shift+Click markieren → Bulk-Actions: Move, Tag, Delete.

**Files**
- `apps/web/src/stores/selection.ts` (neu, Set<number>)
- `apps/web/src/components/TodoCard.vue` (Checkbox, Shift+Click Range-Select)
- `apps/web/src/components/BulkActionsBar.vue` (neu, erscheint wenn selected.size > 0)
- `apps/api/src/routes/todos.ts` (`POST /api/todos/bulk`)

**Approach**
- Selection: `Set<number>` in Pinia.
- Card zeigt Checkbox wenn mindestens 1 selected, sonst nur bei Hover.
- Bulk-Bar: "3 selected · Move to…(select) · Tag…(input) · Delete". Immer unten fixiert.
- Backend-Route: `{ ids: number[], action: 'move'|'tag'|'delete', payload: {...} }`.

**Aufwand:** ~40 M

---

## Gesamt-Aufwand

| Wave | Features | Agent-isoliert? | Aufwand |
|------|----------|-----------------|---------|
| 1    | #2, #6, #7 | ja (unabhängige files) | ~55 M |
| 2    | #1, #3, #9 | bedingt (nur types.ts evtl. shared) | ~80 M |
| 3    | #8, #10, #11 | ja | ~75 M |
| 4    | #4 | einzeln (DB + Routes + TodoDetail + Card) | ~45 M |
| 5    | #12 | einzeln (stores + cards + routes) | ~40 M |
| 6    | #5 | einzeln (DB + scheduler) | ~50 M |

**Total:** ~345 M = rund 6 Stunden konzentrierte Entwicklung.
