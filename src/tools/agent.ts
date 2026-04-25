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
