# Werkbank

Todo-App für Programmierer mit Handwerker-Theme, SQLite-Backend, GitHub- und Jira-Integration, Pomodoro-Timer und Code-Snippets pro Todo.

## Quickstart

```bash
cp .env.example .env   # API-Key generieren, siehe Kommentar in der Datei
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend:  http://localhost:3001

## Spalten (Handwerker-Metaphorik)

| Status      | Spalte        |
| ----------- | ------------- |
| todo        | Werkbank      |
| in_progress | Unter Hammer  |
| done        | Ablage        |

## Themes

Umschaltbar über den Button oben rechts: **Workshop** (Holz/Stahl), **Dark**, **Light**, **Terminal-Green**.

## GitHub / Jira einrichten

In der App unter *Einstellungen*:

- **GitHub**: Personal Access Token (`repo` scope) + Liste der Repos (`owner/name`)
- **Jira**: Base-URL + Email + API-Token + JQL-Filter (z. B. `assignee = currentUser() AND statusCategory != Done`)

Tokens werden AES-256-GCM-verschlüsselt in SQLite abgelegt (Key in `.env`). Tokens verlassen das Backend nie — das Frontend sieht nur maskierte Platzhalter.

## Struktur

```
werkbank/
├── apps/
│   ├── api/   # Express + better-sqlite3 + Zod
│   └── web/   # Vue 3 + Vite + TS + Pinia
```
