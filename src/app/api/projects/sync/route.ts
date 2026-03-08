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
