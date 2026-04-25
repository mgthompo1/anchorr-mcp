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

export async function updateCandidateStatus(
  supabase: SupabaseClient,
  orgId: string,
  params: { candidate_id: string; action: 'reject' }
) {
  const { error } = await supabase
    .from('agent_candidates')
    .update({
      status: 'rejected',
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', params.candidate_id)
    .eq('org_id', orgId)
  if (error) throw new Error(error.message)
  return { candidate_id: params.candidate_id, status: 'rejected' }
}
