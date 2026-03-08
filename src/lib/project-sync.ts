/**
 * Project Directory Sync
 *
 * Scans a projects directory (default ~/projects/) and upserts matching
 * project records into the MC database.  Each subdirectory becomes a
 * project whose slug is the lowercased, hyphen-normalised folder name.
 */

import { readdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { config } from './config'
import { getDatabase, logAuditEvent } from './db'
import { logger } from './logger'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProjectSyncResult {
  scanned: number
  created: number
  updated: number
  projects: Array<{ name: string; action: 'created' | 'updated' | 'unchanged' }>
  error?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a directory name to a URL-safe slug */
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Title-case a slug: "my-cool-project" → "My Cool Project" */
function titleCase(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Derive a unique 4-character ticket prefix from a slug.
 *
 * Takes the first 4 alphanumeric characters (uppercased).  If that prefix
 * already exists in `existing`, appends an incrementing digit until unique.
 */
function derivePrefix(slug: string, existing: Set<string>): string {
  const base = slug
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 4)
    .toUpperCase()

  if (!base) return 'PROJ'

  // Pad short slugs
  const padded = base.padEnd(4, 'X')

  if (!existing.has(padded)) return padded

  // Collision — try with trailing digit (up to 99)
  for (let i = 1; i < 100; i++) {
    const suffix = String(i)
    const candidate = (padded.slice(0, 4 - suffix.length) + suffix).toUpperCase()
    if (!existing.has(candidate)) return candidate
  }

  // Extremely unlikely fallback
  return padded
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

export function syncProjectsFromDirectory(
  actor: string = 'system',
  workspaceId: number = 1,
): ProjectSyncResult {
  const projectsDir = config.projectsDir

  // Read subdirectories -------------------------------------------------------
  let entries: string[]
  try {
    entries = readdirSync(projectsDir)
  } catch (err: any) {
    logger.warn({ err, dir: projectsDir }, 'Cannot read projects directory')
    return { scanned: 0, created: 0, updated: 0, projects: [], error: err.message }
  }

  // Filter to actual directories
  const dirs: Array<{ name: string; slug: string; fullPath: string }> = []
  for (const entry of entries) {
    const fullPath = join(projectsDir, entry)
    try {
      if (!statSync(fullPath).isDirectory()) continue
    } catch {
      continue
    }

    const slug = slugify(basename(entry))
    if (!slug || slug === 'general') continue

    dirs.push({ name: titleCase(slug), slug, fullPath })
  }

  const scanned = dirs.length

  // DB work -------------------------------------------------------------------
  const db = getDatabase()

  // Collect existing prefixes so we can avoid collisions
  const existingPrefixes = new Set<string>(
    (
      db
        .prepare('SELECT ticket_prefix FROM projects WHERE workspace_id = ?')
        .all(workspaceId) as Array<{ ticket_prefix: string }>
    ).map((r) => r.ticket_prefix),
  )

  let created = 0
  let updated = 0
  const results: ProjectSyncResult['projects'] = []

  const findBySlug = db.prepare(
    'SELECT id, path, name FROM projects WHERE workspace_id = ? AND slug = ?',
  )
  const insertProject = db.prepare(`
    INSERT INTO projects (workspace_id, name, slug, ticket_prefix, ticket_counter, path, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, 'active', unixepoch(), unixepoch())
  `)
  const updatePath = db.prepare(`
    UPDATE projects SET path = ?, updated_at = unixepoch() WHERE id = ?
  `)

  db.transaction(() => {
    for (const dir of dirs) {
      const existing = findBySlug.get(workspaceId, dir.slug) as
        | { id: number; path: string | null; name: string }
        | undefined

      if (existing) {
        if (existing.path !== dir.fullPath) {
          updatePath.run(dir.fullPath, existing.id)
          results.push({ name: existing.name, action: 'updated' })
          updated++
        } else {
          results.push({ name: existing.name, action: 'unchanged' })
        }
      } else {
        const prefix = derivePrefix(dir.slug, existingPrefixes)
        existingPrefixes.add(prefix)
        insertProject.run(workspaceId, dir.name, dir.slug, prefix, dir.fullPath)
        results.push({ name: dir.name, action: 'created' })
        created++
      }
    }
  })()

  // Audit & logging -----------------------------------------------------------
  if (created > 0 || updated > 0) {
    logAuditEvent({
      action: 'project_sync',
      actor,
      detail: {
        scanned,
        created,
        updated,
        projects: results
          .filter((p) => p.action !== 'unchanged')
          .map((p) => p.name),
      },
    })
  }

  logger.info({ scanned, created, updated }, 'Project directory sync complete')
  return { scanned, created, updated, projects: results }
}
