# ops-report-app

Construction progress tracker for field supervisors. Next.js (App Router) on Vercel, backed by Notion.
Separate project from `ops-log-app`: it shares no code with that app.

## Flow

1. Supervisor enters a **password only** → matched against an **Active** record in *✅ Authorized Supervisors DB*.
2. Pick a **Project** (searchable; Completed projects hidden) from *🏗️ Project DB*.
3. Pick a **Building** (searchable, shows Building Type) from *Buildings DB*, filtered by the project relation.
4. Pick an **Elevation** (plain dropdown) from *Elevations DB*, filtered by the building relation.
5. Set the completion % and save.

## What gets written to Notion on save

| Database | Property | Value |
|---|---|---|
| Elevations DB | `% Complete (Elevations)` | chosen % (stored as 0–1, shown as %) |
| Elevations DB | `Completed` | checked when 100% |
| Elevations DB | `Submitted By` | supervisor's Name |
| Elevations DB | `Submitter Email` | supervisor's Email |
| Buildings DB | `Last Progress Reported` | current date/time |

Nothing else is touched. The `Ops Log Created` fields are never read or written.

## Setup

1. **Notion integration:** Create an internal integration, copy its token, and share these 4 databases with it
   (••• → Connections): Authorized Supervisors, Project DB, Buildings DB, Elevations DB.
2. **Env vars:** copy `.env.example` → `.env.local` and fill in `NOTION_TOKEN` and `SESSION_SECRET`.
   The database IDs are already filled in.
3. **Run locally:**
   ```bash
   npm install
   npm run dev
   ```
   Open http://localhost:3000.
4. **Deploy:** push to GitHub, import in Vercel, and add the same env vars in Project Settings → Environment Variables.

## Notes

- **Unique passwords:** each supervisor needs a different password. If two Active records share one, login is refused
  with a message to contact the office.
- Passwords are checked on the server only; the supervisor list never reaches the browser.
  Sign-in is a signed, HTTP-only cookie (default 12 h, `SESSION_HOURS`).
- Elevations named `Test …` are hidden unless `SHOW_TEST_ELEVATIONS=true`.
- If a Notion column is renamed, update the names in `lib/config.ts` (`props`).
- `Submitted By` holds only the latest reporter. A per-change history log is a planned next step.

## Structure

```
app/
  page.tsx            → session check, renders Tracker
  Tracker.tsx         → the 4-step form
  login/              → password screen
  api/login|logout    → session cookie
  api/projects        → GET list
  api/buildings       → GET ?projectId=
  api/elevations      → GET ?buildingId=
  api/progress        → POST { elevationId, percent }
components/SearchSelect.tsx
lib/config.ts  lib/notion.ts  lib/session.ts
```
