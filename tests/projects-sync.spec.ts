import { test, expect } from '@playwright/test'
import { API_KEY_HEADER } from './helpers'

test.describe('Project Directory Sync', () => {
  test('POST /api/projects/sync returns sync results', async ({ request }) => {
    const res = await request.post('/api/projects/sync', {
      headers: API_KEY_HEADER,
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.scanned).toBeGreaterThanOrEqual(0)
    expect(body.projects).toBeDefined()
    expect(Array.isArray(body.projects)).toBe(true)
  })

  test('GET /api/projects returns projects with path and stats', async ({ request }) => {
    const res = await request.get('/api/projects', {
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
    const listRes = await request.get('/api/projects', {
      headers: API_KEY_HEADER,
    })
    const { projects } = await listRes.json()
    const target = projects.find((p: any) => p.slug !== 'general')
    if (!target) {
      test.skip()
      return
    }

    const res = await request.patch(`/api/projects/${target.id}`, {
      headers: { ...API_KEY_HEADER, 'Content-Type': 'application/json' },
      data: { path: '/tmp/test-project-path' },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.project.path).toBe('/tmp/test-project-path')

    // Restore original path
    await request.patch(`/api/projects/${target.id}`, {
      headers: { ...API_KEY_HEADER, 'Content-Type': 'application/json' },
      data: { path: target.path || '' },
    })
  })
})
