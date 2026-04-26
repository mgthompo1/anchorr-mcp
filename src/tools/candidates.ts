import type { SupabaseClient } from '@supabase/supabase-js'

export async function listCandidates(
  supabase: SupabaseClient,
  orgId: string,
  params: { status?: string; limit?: number }
) {
  let q = supabase
    .from('agent_candidates')
    .select(
      'id, first_name, last_name, email, title, company_name, company_domain, location, industry, score, score_reasoning, preview_subject, preview_body, status, created_at'
    )
    .eq('org_id', orgId)
    .order('score', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(Math.min(params.limit ?? 50, 200))

  if (params.status) q = q.eq('status', params.status)
  else q = q.eq('status', 'pending_review')

  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

// Canonical feedback tag vocabulary — must match the UI's REJECT_TAG_OPTIONS
// (src/app/(dashboard)/agent/candidates/page.tsx) and the API allowlist
// (src/app/api/agent/candidates/route.ts). Distill cron reads these as
// ground-truth corrections to the rubric.
export const FEEDBACK_TAGS = [
  'wrong_title',
  'wrong_industry',
  'wrong_company_size',
  'score_too_high',
  'score_too_low',
  'bad_email_draft',
  'good_fit',
  'bad_fit',
] as const
export type FeedbackTag = (typeof FEEDBACK_TAGS)[number]

export async function updateCandidateStatus(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    candidate_id: string
    action: 'reject'
    feedback_tags?: string[]
    reason?: string
  }
) {
  // Filter to known tags — silently drop unknowns rather than poison the
  // distill prompt with arbitrary strings.
  const allowed = new Set<string>(FEEDBACK_TAGS)
  const tags = (params.feedback_tags ?? [])
    .filter((t) => allowed.has(t))
    .slice(0, 8)

  const update: Record<string, unknown> = {
    status: 'rejected',
    reviewed_at: new Date().toISOString(),
    feedback_tags: tags,
  }
  if (params.reason && params.reason.trim()) {
    update.notes = params.reason.trim().slice(0, 500)
  }

  const { error } = await supabase
    .from('agent_candidates')
    .update(update)
    .eq('id', params.candidate_id)
    .eq('org_id', orgId)
  if (error) throw new Error(error.message)
  return {
    candidate_id: params.candidate_id,
    status: 'rejected',
    feedback_tags: tags,
  }
}
