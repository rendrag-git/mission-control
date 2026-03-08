# Project Directory Linking — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Link MC projects to filesystem directories, auto-discover projects from `~/projects/`, auto-link Claude sessions by path, and add a Projects page to the nav.

**Architecture:** Add `path` column to projects table via migration. New `project-sync.ts` scans a configurable directory and upserts projects. Projects API enhanced with path + session stats. New `ProjectsPanel` component added to nav and content router.

**Tech Stack:** Next.js App Router, better-sqlite3, React, Tailwind CSS

---

### Task 1: Migration — Add `path` column to projects

**Files:**
- Modify: `src/lib/migrations.ts` (append after line ~832)

**Step 1: Add migration 028**

Add to the `migrations` array in `src/lib/migrations.ts`, after the `027_agent_api_keys` entry:

```typescript
  {
    id: '028_project_directory_linking',
    up: (db) => {
      const hasProjects = db
        .prepare(`SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = 'projects'`)
        .get() as { ok?: number } | undefined
      if (!hasProjects?.ok) return

      const cols = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'path')) {
        db.exec(`ALTER TABLE projects ADD COLUMN path TEXT`)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path)`)
    }
  },
```

**Step 2: Verify migration runs**

```bash
# Delete the DB to force fresh migration run (or just restart dev)
npm run dev
```

Check the server logs for migration success. Verify with:
```bash
sqlite3 .data/mission-control.db "PRAGMA table_info(projects)" | grep path
```

Expected: a row containing `path|TEXT`

**Step 3: Commit**

```bash
git add src/lib/migrations.ts
git commit -m "feat: add path column to projects table (migration 028)"
```

---

### Task 2: Config — Add `projectsDir` setting

**Files:**
- Modify: `src/lib/config.ts` (line ~77, in the config export)

**Step 1: Add projectsDir to config**

In `src/lib/config.ts`, add to the `config` object (after `homeDir`):

```typescript
  projectsDir:
    process.env.MC_PROJECTS_DIR || path.join(os.homedir(), 'projects'),
```

**Step 2: Commit**

```bash
git add src/lib/config.ts
git commit -m "feat: add projectsDir config for project auto-discovery"
```

---

### Task 3: Project Sync — Auto-discover from filesystem

**Files:**
- Create: `src/lib/project-sync.ts`

**Step 1: Create the sync module**

Create `src/lib/project-sync.ts`:

```typescript
/**
 * Project Directory Sync
 *
 * Scans a configurable directory for subdirectories and upserts
 * matching MC projects with their filesystem paths.
 */

import { readdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { config } from './config'
import { getDatabase, logAuditEvent } from './db'
import { logger } from './logger'

export interface ProjectSyncResult {
  scanned: number
  created: number
  updated: number
  projects: Array<{ name: string; action: 'created' | 'updated' | 'unchanged' }>
  error?: string
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function deriveTicketPrefix(name: string, existingPrefixes: Set<string>): string {
  // Start with first 4 uppercase chars
  let base = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4)
  if (!base) base = 'PROJ'
  let prefix = base
  let suffix = 0
  while (existingPrefixes.has(prefix)) {
    suffix++
    prefix = base.slice(0, 3) + suffix
  }
  return prefix
}

export function syncProjectsFromDirectory(
  actor: string = 'system',
  workspaceId: number = 1
): ProjectSyncResult {
  const dir = config.projectsDir
  const result: ProjectSyncResult = { scanned: 0, created: 0, updated: 0, projects: [] }

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (err: any) {
    const msg = `Cannot read projects directory: ${dir} — ${err.message}`
    logger.warn(msg)
    return { ...result, error: msg }
  }

  const db = getDatabase()

  // Get existing prefixes to avoid collisions
  const existingPrefixes = new Set(
    (db.prepare(`SELECT ticket_prefix FROM projects WHERE workspace_id = ?`).all(workspaceId) as Array<{ ticket_prefix: string }>)
      .map((r) => r.ticket_prefix)
  )

  const getBySlug = db.prepare(`SELECT id, path FROM projects WHERE workspace_id = ? AND slug = ? LIMIT 1`)
  const insertProject = db.prepare(`
    INSERT INTO projects (workspace_id, name, slug, description, ticket_prefix, path, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', unixepoch(), unixepoch())
  `)
  const updatePath = db.prepare(`UPDATE projects SET path = ?, updated_at = unixepoch() WHERE id = ?`)

  db.transaction(() => {
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      try {
        if (!statSync(fullPath).isDirectory()) continue
      } catch {
        continue
      }

      result.scanned++
      const slug = slugify(entry)
      if (!slug || slug === 'general') continue

      const existing = getBySlug.get(workspaceId, slug) as { id: number; path: string | null } | undefined

      if (existing) {
        if (existing.path !== fullPath) {
          updatePath.run(fullPath, existing.id)
          result.updated++
          result.projects.push({ name: entry, action: 'updated' })
        } else {
          result.projects.push({ name: entry, action: 'unchanged' })
        }
      } else {
        const name = entry
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase())
        const prefix = deriveTicketPrefix(entry, existingPrefixes)
        existingPrefixes.add(prefix)
        insertProject.run(workspaceId, name, slug, null, prefix, fullPath)
        result.created++
        result.projects.push({ name: entry, action: 'created' })
      }
    }
  })()

  if (result.created > 0 || result.updated > 0) {
    logAuditEvent(db, {
      action: 'project_sync',
      actor,
      detail: `Synced projects from ${dir}: ${result.created} created, ${result.updated} updated, ${result.scanned} scanned`,
    })
  }

  logger.info(`Project sync: ${result.created} created, ${result.updated} updated, ${result.scanned} dirs scanned from ${dir}`)
  return result
}
```

**Step 2: Verify it compiles**

```bash
npx tsc --noEmit src/lib/project-sync.ts 2>&1 || true
# Or just restart dev and check for errors
npm run dev
```

**Step 3: Commit**

```bash
git add src/lib/project-sync.ts
git commit -m "feat: add project-sync to auto-discover projects from filesystem"
```

---

### Task 4: Scheduler — Run project sync on startup

**Files:**
- Modify: `src/lib/scheduler.ts`

**Step 1: Import and call on startup**

At the top of `src/lib/scheduler.ts`, add import:

```typescript
import { syncProjectsFromDirectory } from './project-sync'
```

In `initScheduler()` (after the agent sync call around line 222), add:

```typescript
  // Auto-discover projects from filesystem on startup
  try {
    syncProjectsFromDirectory('startup')
  } catch (err) {
    logger.warn({ err }, 'Project directory sync failed')
  }
```

Note: `syncProjectsFromDirectory` is synchronous (uses `readdirSync`), so no `await` needed. Place it right after the `syncAgentsFromConfig('startup')` call.

**Step 2: Verify startup runs sync**

```bash
npm run dev
```

Check server logs for "Project sync:" message. Verify projects were created:

```bash
curl -s -H 'X-API-Key: mc-local-dev' http://localhost:3001/api/projects | jq '.projects[] | {name, slug, path}'
```

Expected: projects matching directories in `~/projects/`

**Step 3: Commit**

```bash
git add src/lib/scheduler.ts
git commit -m "feat: run project directory sync on startup"
```

---

### Task 5: API — Add `path` and session stats to project responses

**Files:**
- Modify: `src/app/api/projects/route.ts` (GET + POST handlers)
- Modify: `src/app/api/projects/[id]/route.ts` (GET + PATCH handlers)

**Step 1: Update GET /api/projects to include path and session stats**

In `src/app/api/projects/route.ts`, replace the SELECT query in the GET handler (lines 30-36) with:

```typescript
    const projects = db.prepare(`
      SELECT p.id, p.workspace_id, p.name, p.slug, p.description, p.ticket_prefix,
             p.ticket_counter, p.status, p.path, p.created_at, p.updated_at,
             (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) AS task_count,
             (SELECT COUNT(*) FROM claude_sessions WHERE project_path = p.path AND p.path IS NOT NULL) AS session_count,
             (SELECT COUNT(*) FROM claude_sessions WHERE project_path = p.path AND p.path IS NOT NULL AND is_active = 1) AS active_session_count,
             (SELECT MAX(last_message_at) FROM claude_sessions WHERE project_path = p.path AND p.path IS NOT NULL) AS last_session_at
      FROM projects p
      WHERE p.workspace_id = ?
        ${includeArchived ? '' : "AND p.status = 'active'"}
      ORDER BY p.name COLLATE NOCASE ASC
    `).all(workspaceId)
```

**Step 2: Update GET /api/projects/[id] to include path and session stats**

In `src/app/api/projects/[id]/route.ts`, replace the SELECT query in the GET handler (lines 31-35) with:

```typescript
    const project = db.prepare(`
      SELECT p.id, p.workspace_id, p.name, p.slug, p.description, p.ticket_prefix,
             p.ticket_counter, p.status, p.path, p.created_at, p.updated_at,
             (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) AS task_count,
             (SELECT COUNT(*) FROM claude_sessions WHERE project_path = p.path AND p.path IS NOT NULL) AS session_count,
             (SELECT COUNT(*) FROM claude_sessions WHERE project_path = p.path AND p.path IS NOT NULL AND is_active = 1) AS active_session_count,
             (SELECT MAX(last_message_at) FROM claude_sessions WHERE project_path = p.path AND p.path IS NOT NULL) AS last_session_at
      FROM projects p
      WHERE p.id = ? AND p.workspace_id = ?
    `).get(projectId, workspaceId)
```

**Step 3: Accept `path` in POST /api/projects**

In `src/app/api/projects/route.ts` POST handler, after the `slugInput` line (line 60), add:

```typescript
    const pathInput = typeof body?.path === 'string' ? body.path.trim() : null
```

Update the INSERT statement (lines 78-81) to include `path`:

```typescript
    const result = db.prepare(`
      INSERT INTO projects (workspace_id, name, slug, description, ticket_prefix, path, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', unixepoch(), unixepoch())
    `).run(workspaceId, name, slug, description || null, ticketPrefix, pathInput)
```

Update the SELECT after insert (lines 83-87) to include `path`:

```typescript
    const project = db.prepare(`
      SELECT id, workspace_id, name, slug, description, ticket_prefix, ticket_counter, path, status, created_at, updated_at
      FROM projects
      WHERE id = ?
    `).get(Number(result.lastInsertRowid))
```

**Step 4: Accept `path` in PATCH /api/projects/[id]**

In `src/app/api/projects/[id]/route.ts` PATCH handler, after the status block (line 101), add:

```typescript
    if (typeof body?.path === 'string') {
      updates.push('path = ?')
      paramsList.push(body.path.trim() || null)
    }
```

Update the SELECT after update (lines 112-116) to include `path`:

```typescript
    const project = db.prepare(`
      SELECT id, workspace_id, name, slug, description, ticket_prefix, ticket_counter, path, status, created_at, updated_at
      FROM projects
      WHERE id = ? AND workspace_id = ?
    `).get(projectId, workspaceId)
```

**Step 5: Verify API responses include path and stats**

```bash
curl -s -H 'X-API-Key: mc-local-dev' http://localhost:3001/api/projects | jq '.projects[0]'
```

Expected: response includes `path`, `task_count`, `session_count`, `active_session_count`, `last_session_at`

**Step 6: Commit**

```bash
git add src/app/api/projects/route.ts src/app/api/projects/[id]/route.ts
git commit -m "feat: add path and session stats to project API responses"
```

---

### Task 6: API — Add project sync endpoint

**Files:**
- Create: `src/app/api/projects/sync/route.ts`

**Step 1: Create the sync endpoint**

Create `src/app/api/projects/sync/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { syncProjectsFromDirectory } from '@/lib/project-sync'

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const workspaceId = auth.user.workspace_id ?? 1
  const actor = auth.user.name || auth.user.email || 'api'
  const result = syncProjectsFromDirectory(actor, workspaceId)

  if (result.error) {
    return NextResponse.json({ error: result.error, ...result }, { status: 500 })
  }

  return NextResponse.json(result)
}
```

**Step 2: Verify endpoint**

```bash
curl -s -X POST -H 'X-API-Key: mc-local-dev' http://localhost:3001/api/projects/sync | jq
```

Expected: JSON with `scanned`, `created`, `updated`, `projects` array

**Step 3: Commit**

```bash
git add src/app/api/projects/sync/route.ts
git commit -m "feat: add POST /api/projects/sync endpoint"
```

---

### Task 7: UI — Projects panel component

**Files:**
- Create: `src/components/panels/projects-panel.tsx`

**Step 1: Create the panel**

Create `src/components/panels/projects-panel.tsx`:

```tsx
'use client'

import { useState, useEffect, useCallback } from 'react'

interface Project {
  id: number
  name: string
  slug: string
  description: string | null
  ticket_prefix: string
  ticket_counter: number
  path: string | null
  status: string
  task_count: number
  session_count: number
  active_session_count: number
  last_session_at: string | null
  created_at: number
  updated_at: number
}

export function ProjectsPanel() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects')
      if (!res.ok) throw new Error('Failed to fetch projects')
      const data = await res.json()
      setProjects(data.projects || [])
      setError(null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  const handleSync = async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/projects/sync', { method: 'POST' })
      if (!res.ok) throw new Error('Sync failed')
      await fetchProjects()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSyncing(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6 text-muted-foreground text-sm">Loading projects...</div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Projects</h2>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {syncing ? 'Syncing...' : 'Sync from Disk'}
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      <div className="grid gap-3">
        {projects.map((project) => (
          <div
            key={project.id}
            className="p-4 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors"
          >
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">{project.name}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                    {project.ticket_prefix}
                  </span>
                </div>
                {project.path && (
                  <div className="text-xs text-muted-foreground font-mono truncate max-w-md" title={project.path}>
                    {project.path.replace(/^\/home\/[^/]+\//, '~/')}
                  </div>
                )}
                {project.description && (
                  <div className="text-sm text-muted-foreground">{project.description}</div>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span title="Tasks">{project.task_count} tasks</span>
                {project.session_count > 0 && (
                  <span title="Claude sessions">
                    {project.active_session_count > 0 && (
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1" />
                    )}
                    {project.session_count} sessions
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}

        {projects.length === 0 && (
          <div className="text-center py-8 text-muted-foreground text-sm">
            No projects found. Click &quot;Sync from Disk&quot; to discover projects.
          </div>
        )}
      </div>
    </div>
  )
}
```

**Step 2: Verify it compiles**

```bash
npm run dev
# Check for compilation errors in terminal
```

**Step 3: Commit**

```bash
git add src/components/panels/projects-panel.tsx
git commit -m "feat: add ProjectsPanel component"
```

---

### Task 8: Wire up nav + content router

**Files:**
- Modify: `src/components/layout/nav-rail.tsx` (line ~28, add projects item)
- Modify: `src/app/[[...panel]]/page.tsx` (import + case in switch)

**Step 1: Add Projects to nav-rail**

In `src/components/layout/nav-rail.tsx`, in the `core` group items array (after line 27, the tasks entry), add:

```typescript
      { id: 'projects', label: 'Projects', icon: <ProjectsIcon />, priority: false },
```

Find the SVG icon definitions section in the same file (search for `function OverviewIcon` or similar icon components). Add a new icon component near the others:

```tsx
function ProjectsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  )
}
```

**Step 2: Add ProjectsPanel to content router**

In `src/app/[[...panel]]/page.tsx`, add the import (after line 16, the TaskBoardPanel import):

```typescript
import { ProjectsPanel } from '@/components/panels/projects-panel'
```

In the `ContentRouter` switch statement, add a case after `case 'tasks'` (line 215):

```typescript
    case 'projects':
      return <ProjectsPanel />
```

**Step 3: Verify navigation works**

```bash
npm run dev
```

Open `http://localhost:3001/projects` in browser. Should show the Projects panel with auto-discovered projects.

**Step 4: Commit**

```bash
git add src/components/layout/nav-rail.tsx src/app/[[...panel]]/page.tsx
git commit -m "feat: add Projects page to nav and content router"
```

---

### Task 9: E2E test — project sync and API

**Files:**
- Create: `tests/projects-sync.spec.ts`

**Step 1: Write the test**

Create `tests/projects-sync.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'
import { API_KEY_HEADER } from './helpers'

const BASE = process.env.BASE_URL || 'http://localhost:3001'

test.describe('Project Directory Sync', () => {
  test('POST /api/projects/sync returns sync results', async ({ request }) => {
    const res = await request.post(`${BASE}/api/projects/sync`, {
      headers: API_KEY_HEADER,
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.scanned).toBeGreaterThanOrEqual(0)
    expect(body.projects).toBeDefined()
    expect(Array.isArray(body.projects)).toBe(true)
  })

  test('GET /api/projects returns projects with path and stats', async ({ request }) => {
    const res = await request.get(`${BASE}/api/projects`, {
      headers: API_KEY_HEADER,
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.projects).toBeDefined()
    expect(Array.isArray(body.projects)).toBe(true)

    // At least the "general" project should exist
    const general = body.projects.find((p: any) => p.slug === 'general')
    expect(general).toBeDefined()

    // Check that new fields are present
    for (const project of body.projects) {
      expect(project).toHaveProperty('task_count')
      expect(project).toHaveProperty('session_count')
      expect(project).toHaveProperty('active_session_count')
    }
  })

  test('PATCH /api/projects/[id] accepts path field', async ({ request }) => {
    // Find a non-general project
    const listRes = await request.get(`${BASE}/api/projects`, {
      headers: API_KEY_HEADER,
    })
    const { projects } = await listRes.json()
    const target = projects.find((p: any) => p.slug !== 'general')
    if (!target) {
      test.skip()
      return
    }

    const res = await request.patch(`${BASE}/api/projects/${target.id}`, {
      headers: { ...API_KEY_HEADER, 'Content-Type': 'application/json' },
      data: { path: '/tmp/test-project-path' },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.project.path).toBe('/tmp/test-project-path')

    // Restore original path
    await request.patch(`${BASE}/api/projects/${target.id}`, {
      headers: { ...API_KEY_HEADER, 'Content-Type': 'application/json' },
      data: { path: target.path || '' },
    })
  })
})
```

**Step 2: Run the tests**

```bash
npm run test:e2e -- tests/projects-sync.spec.ts
```

Expected: All tests pass

**Step 3: Commit**

```bash
git add tests/projects-sync.spec.ts
git commit -m "test: add e2e tests for project directory sync"
```

---

### Task 10: Final verification

**Step 1: Full build check**

```bash
npx next build
```

Expected: Build succeeds with no errors

**Step 2: Verify end-to-end flow**

1. Start dev server: `npm run dev`
2. Open `http://localhost:3001/projects`
3. Verify projects from `~/projects/` appear with paths
4. Click "Sync from Disk" — should refresh with latest dirs
5. Check that session counts show for projects with matching Claude sessions

**Step 3: Final commit if any cleanup needed**

```bash
git add -A
git status
# Only commit if there are changes
```
