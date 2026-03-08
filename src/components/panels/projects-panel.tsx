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

function shortenPath(path: string | null): string {
  if (!path) return '—'
  return path.replace(/^\/home\/[^/]+\//, '~/')
}

export function ProjectsPanel() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  const fetchProjects = useCallback(async () => {
    try {
      setError(null)
      const res = await fetch('/api/projects')
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Failed to load projects (${res.status})`)
      }
      const data = await res.json()
      setProjects(data.projects || [])
    } catch (err) {
      setError((err as Error).message || 'Failed to load projects')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchProjects()
  }, [fetchProjects])

  const handleSync = async () => {
    setSyncing(true)
    setError(null)
    try {
      const res = await fetch('/api/projects/sync', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Sync failed (${res.status})`)
      }
      await fetchProjects()
    } catch (err) {
      setError((err as Error).message || 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="h-full p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Projects</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Linked project directories with task and session stats.
            </p>
          </div>
          <button
            onClick={() => void handleSync()}
            disabled={syncing}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {syncing ? 'Syncing...' : 'Sync from Disk'}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-md bg-destructive/10 text-destructive text-sm px-4 py-3">
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="text-sm text-muted-foreground py-8 text-center">
            Loading projects...
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && projects.length === 0 && (
          <div className="rounded-xl border border-border bg-card px-6 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No projects found. Click Sync from Disk to discover projects.
            </p>
          </div>
        )}

        {/* Project cards */}
        {!loading && projects.length > 0 && (
          <div className="grid gap-3">
            {projects.map((project) => (
              <div
                key={project.id}
                className="rounded-xl border border-border bg-card p-4 space-y-2"
              >
                {/* Name + badge row */}
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-sm font-semibold text-foreground">
                    {project.name}
                  </h3>
                  <span className="text-xs px-2 py-0.5 rounded-md bg-muted text-muted-foreground font-mono">
                    {project.ticket_prefix}
                  </span>
                  {project.status !== 'active' && (
                    <span className="text-xs px-2 py-0.5 rounded-md bg-muted text-muted-foreground">
                      {project.status}
                    </span>
                  )}
                </div>

                {/* Path */}
                <p className="text-xs text-muted-foreground font-mono truncate" title={project.path || undefined}>
                  {shortenPath(project.path)}
                </p>

                {/* Description */}
                {project.description && (
                  <p className="text-sm text-muted-foreground">
                    {project.description}
                  </p>
                )}

                {/* Stats row */}
                <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1">
                  <span>
                    {project.task_count} {project.task_count === 1 ? 'task' : 'tasks'}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {project.active_session_count > 0 && (
                      <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                    )}
                    {project.session_count} {project.session_count === 1 ? 'session' : 'sessions'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
