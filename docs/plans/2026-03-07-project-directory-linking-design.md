# Design: Link Projects to Filesystem Directories

**Date:** 2026-03-07
**Status:** Approved

## Problem

MC projects exist as task containers with ticket numbering but have no connection to the actual codebases they represent. Claude sessions already track `project_path` but aren't linked to MC projects. Projects have no dedicated UI page.

## Solution

Add a `path` column to projects, auto-discover projects by scanning a configurable directory (default `~/projects/`), auto-link Claude sessions by path matching, and add a Projects page to the nav.

## Design

### 1. Data Layer

**Migration 028** adds `path` column to `projects`:

```sql
ALTER TABLE projects ADD COLUMN path TEXT;
CREATE INDEX idx_projects_path ON projects(path);
```

No new tables. Claude sessions already have `project_path` -- we join on it.

### 2. Project Discovery Sync

New file: `src/lib/project-sync.ts`

Function `syncProjectsFromDirectory()`:
- Reads `MC_PROJECTS_DIR` env var (default: `~/projects/`)
- Lists subdirectories in that path
- For each directory:
  - If a project with matching slug exists: set its `path` to the directory
  - If no matching project: create one with name derived from folder name, auto-generated slug and ticket prefix
- The "general" project stays path-less (catch-all)
- Runs on startup via scheduler, same pattern as `syncAgentsFromConfig()`

Ticket prefix generation: uppercase first 4 chars of folder name (e.g. `mission-control` -> `MISS`), with dedup suffix if collision.

### 3. Claude Session Linking

In project API responses (`GET /api/projects`, `GET /api/projects/[id]`):
- Join `claude_sessions` where `project_path` starts with the project's `path`
- Return: session count, active session count, most recent session timestamp

### 4. Config

New entry in `src/lib/config.ts`:

```typescript
projectsDir: process.env.MC_PROJECTS_DIR || path.join(os.homedir(), 'projects')
```

### 5. API Changes

**`GET /api/projects`** — existing endpoint, enhanced response:
- Add `path`, `sessionCount`, `activeSessionCount`, `lastSessionAt` to each project

**`POST /api/projects`** — accept optional `path` field on create

**`PATCH /api/projects/[id]`** — accept `path` field on update

**`POST /api/projects/sync`** — new endpoint to trigger directory scan manually

### 6. UI — Projects Page

Add `projects` to the **core** nav group (between Tasks and Sessions).

**List view:**
- Table/cards showing: name, path (truncated), status, task count, active Claude sessions
- Click row -> project detail

**Detail view:**
- Project info with editable path field
- Tasks scoped to this project (reuse existing task list component)
- Claude sessions linked by path match
- Recent activity

### 7. Scheduler Integration

Add `syncProjectsFromDirectory()` call to the startup scheduler alongside existing agent sync. Runs once on startup and can be triggered manually via the sync endpoint.

## Decisions

- **Approach:** Scan-and-match (auto-discover from directory) with manual override
- **Path matching:** `claude_sessions.project_path` starts with `projects.path` (prefix match handles subdirs)
- **Default scan dir:** `~/projects/` via `MC_PROJECTS_DIR` env var
- **"General" project:** Stays path-less, serves as catch-all for unlinked tasks
- **No new tables:** Leverages existing `projects` and `claude_sessions` tables

## Out of Scope

- Git status/branch display per project (future enhancement)
- Agent-to-project linking via workspace paths (future enhancement)
- Multi-directory scanning (single dir for now)
