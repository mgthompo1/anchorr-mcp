import type { SupabaseClient } from '@supabase/supabase-js'

export interface ApiKeyRecord {
  id: string
  org_id: string
  name: string
  scopes: string[]
  // The user who issued this key. Surfaced so write tools that have a
  // created_by / owner column (e.g. sequences) can credit the right
  // person — without it, sequences end up created_by NULL and the
  // executor can't resolve a sender mailbox, falling back to Resend.
  created_by: string | null
}

export class AuthError extends Error {
  status: number
  constructor(message: string, status = 401) {
    super(message)
    this.status = status
  }
}

// Hash a raw key with SHA-256 using Web Crypto — Cloudflare Worker runtime.
async function sha256(key: string): Promise<string> {
  const data = new TextEncoder().encode(key)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Authenticate an incoming request by Bearer key.
 * Keys are prefixed `anchorr_` and stored as SHA-256 hashes in api_keys.
 */
export async function authenticateRequest(
  req: Request,
  supabase: SupabaseClient
): Promise<ApiKeyRecord> {
  const auth = req.headers.get('authorization')
  const raw = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null
  if (!raw) throw new AuthError('Missing Bearer token')
  if (!raw.startsWith('ancr_')) throw new AuthError('Invalid key format')

  const hash = await sha256(raw)
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, org_id, name, scopes, created_by')
    .eq('key_hash', hash)
    .maybeSingle()

  if (error || !data) throw new AuthError('Invalid API key')

  // Non-blocking last-used stamp
  supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {})

  return {
    id: data.id as string,
    org_id: data.org_id as string,
    name: data.name as string,
    scopes: (data.scopes as string[] | null) ?? [],
    created_by: (data.created_by as string | null) ?? null,
  }
}

export function hasScope(key: ApiKeyRecord, scope: string): boolean {
  if (!key.scopes.length) return true // no scopes configured == full access (admin-issued keys)
  if (key.scopes.includes('*')) return true
  if (key.scopes.includes(scope)) return true
  // prefix match: "sequences:*" grants "sequences:write" etc.
  const [resource] = scope.split(':')
  return key.scopes.includes(`${resource}:*`)
}

export function requireScope(key: ApiKeyRecord, scope: string) {
  if (!hasScope(key, scope)) {
    throw new AuthError(`Missing scope: ${scope}`, 403)
  }
}
