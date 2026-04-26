import type { SupabaseClient } from '@supabase/supabase-js'

const EDITABLE_FIELDS = [
  'enabled',
  'target_titles',
  'target_industries',
  'target_company_sizes',
  'target_locations',
  'daily_prospect_limit',
  'daily_email_limit',
  'sequence_id',
  'booking_link_id',
  'owner_directives',
  'personality',
  'context_notes',
  'product_description',
  'value_props',
  'qualifying_signals',
  'disqualifying_signals',
  'review_queue_enabled',
  'minimum_score_to_enroll',
] as const

type EditableField = (typeof EDITABLE_FIELDS)[number]

export async function getAgentConfig(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase
    .from('agent_config')
    .select('*')
    .eq('org_id', orgId)
    .single()
  if (error || !data) throw new Error('Agent config not found')
  return data
}

export async function updateAgentConfig(
  supabase: SupabaseClient,
  orgId: string,
  patch: Record<string, unknown>
) {
  // Allowlist keys — never let an MCP client touch id, org_id, counters, etc.
  const clean: Record<string, unknown> = {}
  for (const key of EDITABLE_FIELDS) {
    if (patch[key as EditableField] !== undefined) {
      clean[key] = patch[key as EditableField]
    }
  }
  if (!Object.keys(clean).length) throw new Error('No editable fields in patch')
  clean.updated_at = new Date().toISOString()

  const { data, error } = await supabase
    .from('agent_config')
    .update(clean)
    .eq('org_id', orgId)
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function getAgentOverview(supabase: SupabaseClient, orgId: string) {
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const startIso = startOfDay.toISOString()

  const [configRes, pendingRes, repliesRes] = await Promise.all([
    supabase
      .from('agent_config')
      .select(
        'enabled, prospects_today, emails_today, daily_prospect_limit, daily_email_limit, last_run_at'
      )
      .eq('org_id', orgId)
      .single(),
    supabase
      .from('agent_candidates')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('status', 'pending_review'),
    supabase
      .from('sequence_replies')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .gte('created_at', startIso),
  ])

  return {
    enabled: !!configRes.data?.enabled,
    prospects_today: configRes.data?.prospects_today ?? 0,
    emails_today: configRes.data?.emails_today ?? 0,
    daily_prospect_limit: configRes.data?.daily_prospect_limit ?? 0,
    daily_email_limit: configRes.data?.daily_email_limit ?? 0,
    last_run_at: configRes.data?.last_run_at ?? null,
    pending_candidates: pendingRes.count ?? 0,
    replies_today: repliesRes.count ?? 0,
  }
}

// Triggers a real hunt run. Delegates to the Next.js cron endpoint rather
// than reimplementing scoring/drafting/enrollment in the Worker — keeps the
// hunt logic in one place and avoids duplicating the Anthropic + enrichment
// stack inside the MCP runtime.
export async function runAgentHunt(
  appUrl: string,
  cronSecret: string,
  orgId: string
) {
  const url = appUrl.replace(/\/$/, '') + '/api/cron/agent-hunt'
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cron-secret': cronSecret,
    },
    body: JSON.stringify({ org_id: orgId }),
  })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`Hunt endpoint returned non-JSON (${res.status}): ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const err = (parsed as { error?: string } | null)?.error ?? `HTTP ${res.status}`
    throw new Error(`Hunt failed: ${err}`)
  }
  // The cron endpoint returns { runs: [...] } — pull the org's row out for clarity.
  const runs = (parsed as { runs?: Array<Record<string, unknown>> } | null)?.runs ?? []
  const mine = runs.find((r) => (r as { org_id?: string }).org_id === orgId) ?? runs[0] ?? null
  return mine ?? { org_id: orgId, candidates_added: 0, candidates_scored: 0, auto_enrolled: 0 }
}

// Approve a pending candidate. Calls the Next.js PATCH endpoint with the
// cron secret so the full approve flow runs (status update → contact
// create → sequence enrollment → enrichment), instead of reimplementing
// any of that in the Worker.
export async function approveAgentCandidate(
  appUrl: string,
  cronSecret: string,
  orgId: string,
  candidateId: string,
  feedbackTags: string[],
  reason: string | undefined
) {
  const url = appUrl.replace(/\/$/, '') + '/api/agent/candidates'
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-cron-secret': cronSecret,
    },
    body: JSON.stringify({
      org_id: orgId,
      id: candidateId,
      action: 'approve',
      feedback_tags: feedbackTags,
      reason: reason ?? '',
    }),
  })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`Approve endpoint returned non-JSON (${res.status}): ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const err = (parsed as { error?: string } | null)?.error ?? `HTTP ${res.status}`
    throw new Error(`Approve failed: ${err}`)
  }
  return {
    candidate_id: candidateId,
    status: 'approved',
    enrolled: !!(parsed as { enrolled?: boolean } | null)?.enrolled,
    feedback_tags: feedbackTags,
  }
}
