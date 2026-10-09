# ops-report-app

Field progress reporting for Casanova construction projects.
Supervisors report **% complete per elevation** from their phones; everything is saved to **Notion**,
rolled up to buildings and projects, and logged for managers.

> Full manual (how it works, rules, how to change things): see the **Ops Report App — Manual** page in Notion.

---

## Stack

| | |
|---|---|
| App | Next.js 15 (App Router) + TypeScript |
| Hosting | Vercel — every push to `main` deploys automatically |
| Code | GitHub (this repo) |
| Data | Notion (via an internal integration). No other database |

## Screens

- **Report** (`/`) — everyone: Project → Building → Elevation → set % → Save
- **Manager view** (`/manager`) — roles containing *Project Manager* or *Business Transformation*:
  projects overview (pie charts, rollups, division filter) + full change history with filters
- **Sign in** (`/login`) — password only, matched against **✅ Authorized Supervisors DB**

## Notion databases

| Database | Used for |
|---|---|
| ✅ Authorized Supervisors DB | Sign-in (Name, Email, Password, Active, Role) |
| 🏗️ Project DB | Project list (Name, Status, Division) |
| Buildings DB | Buildings; app writes Progress %, Completed, Last Progress Reported |
| Elevations DB | Elevations; app writes % Complete, Completed, Submitted By, Submitter Email |
| Elevation Progress DB | History log — one row per save |

The integration must be connected to all five (database ••• → Connections).
Columns are referenced by **property ID** (`lib/notion-props.json`), so renaming columns in Notion is safe.

## Key rules

- Projects shown: Division ≠ Brick, Status ≠ Completed, and has elevations
- Elevations named "Test…" are hidden (`SHOW_TEST_ELEVATIONS`)
- Progress can **only go up** (enforced on screen and on the server)
- Rollups (building ← elevations, project ← buildings): SQ-weighted average if every item with progress has SQ, otherwise simple average
- Each save writes a row to Elevation Progress DB; failures there never block the save

## Setup

1. `npm install`
2. Copy `.env.example` → `.env.local` and fill in:

   | Variable | |
   |---|---|
   | `NOTION_TOKEN` | Notion integration secret |
   | `SESSION_SECRET` | long random string (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
   | `NOTION_SUPERVISORS_DB` / `NOTION_PROJECTS_DB` / `NOTION_BUILDINGS_DB` / `NOTION_ELEVATIONS_DB` | database IDs |
   | `NOTION_LOG_DB` | Elevation Progress DB ID (history is off without it) |
   | `SHOW_TEST_ELEVATIONS` | `false` |
   | `SESSION_HOURS` | `12` |

3. `npm run notion:ids` — converts column names in `lib/notion-props.json` to IDs
4. `npm run dev` → http://localhost:3000

The same variables must be set in **Vercel → Settings → Environment Variables** (redeploy after changing them).
Never commit `.env.local`.

## Commands

| Command | |
|---|---|
| `npm run dev` | run locally |
| `npm run build` | production build (run before pushing to catch errors) |
| `npm run notion:ids` | refresh Notion column IDs after adding/re-creating a column |
| `git add . && git commit -m "…" && git push` | publish (Vercel deploys `main`) |

## Project structure

```
app/
  page.tsx, Tracker.tsx        Report screen
  manager/                     Manager view (page.tsx guards the role, ManagerView.tsx is the screen)
  login/                       Sign-in page
  api/
    login, logout              session cookie
    projects, buildings,
    elevations                 read data + rollup %s
    progress                   SAVE a report (elevation, log row, building rollup)
    manager/history            history feed with filters (managers only)
    manager/supervisors        supervisor names for the filter (managers only)
  globals.css                  all styles
  layout.tsx, manifest.ts      app shell, phone settings, home-screen app
components/SearchSelect.tsx    searchable dropdown
lib/
  config.ts                    env vars + Notion property keys
  notion-props.json            Notion column IDs (generated)
  notion.ts                    Notion API calls + readers
  session.ts                   signed sign-in cookie
  access.ts                    manager roles
  progress.ts                  % rollup math
  timeAgo.ts                   "2 hours ago"
scripts/notion-ids.mjs         column ID lookup
public/icons/                  app icons / logo
```

## Common changes

| Change | File |
|---|---|
| Manager roles | `lib/access.ts` → `MANAGER_ROLES` |
| Hidden divisions / statuses | `app/api/projects/route.ts` → `HIDE_DIVISION`, `HIDE_STATUSES` |
| Rollup math | `lib/progress.ts` → `rollup()` |
| Slider step / ticks | `app/Tracker.tsx` → `STEP`, `.ticks` list |
| Colors / layout | `app/globals.css` (level colors: `.level-1/2/3`) |
| Use a new Notion column | add to `lib/notion-props.json` → `npm run notion:ids` → use `props.<db>.<key>` in the API route |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Could not find property …` | fix the name in `notion-props.json`, run `npm run notion:ids` |
| `… is expected to be <type>` | column type in Notion doesn't match — change it in Notion |
| `EINVAL … readlink …\.next` | OneDrive conflict: `Remove-Item -Recurse -Force .next`, then `npm run dev` |
| History says "not set up" | `NOTION_LOG_DB` missing (local or Vercel) |
| No Manager view tab | check Role in Authorized Supervisors, then sign out and back in |
| Works locally, not live | check `git status` / `git log`, and Vercel → Deployments |

## Known limitations

- Passwords are stored as plain text in Notion (to be replaced by Microsoft SSO)
- Project % is shown in the app only (not saved to Notion)
- Downward corrections must be made directly in Notion