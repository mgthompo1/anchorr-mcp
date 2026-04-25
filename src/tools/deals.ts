import type { SupabaseClient } from '@supabase/supabase-js'

export async function listDeals(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    status?: 'open' | 'won' | 'lost'
    contact_id?: string
    company_id?: string
    stage_id?: string
    limit?: number
  }
) {
  let q = supabase
    .from('deals')
    .select(
      'id, title, value, currency, stage_id, pipeline_id, contact_id, company_id, expected_close_date, probability, closed_at, closed_won, tags, created_at, updated_at, stage:pipeline_stages(name, position, is_won, is_lost, color)'
    )
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(Math.min(params.limit ?? 50, 200))

  if (params.status === 'open') q = q.is('closed_at', null)
  if (params.status === 'won') q = q.eq('closed_won', true).not('closed_at', 'is', null)
  if (params.status === 'lost') q = q.eq('closed_won', false).not('closed_at', 'is', null)
  if (params.contact_id) q = q.eq('contact_id', params.contact_id)
  if (params.company_id) q = q.eq('company_id', params.company_id)
  if (params.stage_id) q = q.eq('stage_id', params.stage_id)

  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function getDeal(
  supabase: SupabaseClient,
  orgId: string,
  dealId: string
) {
  const { data, error } = await supabase
    .from('deals')
    .select(
      '*, stage:pipeline_stages(id, name, position, is_won, is_lost, color), contact:contacts(id, first_name, last_name, email), company:companies(id, name, website)'
    )
    .eq('id', dealId)
    .eq('org_id', orgId)
    .single()
  if (error || !data) throw new Error('Deal not found')
  return data
}

export async function createDeal(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    title: string
    value?: number
    currency?: string
    pipeline_id?: string
    stage_id?: string
    contact_id?: string
    company_id?: string
    expected_close_date?: string
    probability?: number
    tags?: string[]
    owner_id?: string
  }
) {
  // If no stage_id provided, pick the first non-won/lost stage of the
  // referenced pipeline (or the default pipeline for the org)
  let stageId = params.stage_id ?? null
  let pipelineId = params.pipeline_id ?? null
  if (!stageId) {
    if (!pipelineId) {
      const { data: pipe } = await supabase
        .from('pipelines')
        .select('id')
        .eq('org_id', orgId)
        .order('created_at')
        .limit(1)
        .maybeSingle()
      pipelineId = (pipe?.id as string | undefined) ?? null
    }
    if (pipelineId) {
      const { data: firstStage } = await supabase
        .from('pipeline_stages')
        .select('id')
        .eq('pipeline_id', pipelineId)
        .eq('is_won', false)
        .eq('is_lost', false)
        .order('position')
        .limit(1)
        .maybeSingle()
      stageId = (firstStage?.id as string | undefined) ?? null
    }
  }
  if (!stageId || !pipelineId) {
    throw new Error('Could not resolve a default pipeline/stage — pass stage_id explicitly')
  }

  const { data, error } = await supabase
    .from('deals')
    .insert({
      org_id: orgId,
      title: params.title,
      value: params.value ?? 0,
      currency: params.currency ?? 'USD',
      stage_id: stageId,
      pipeline_id: pipelineId,
      contact_id: params.contact_id ?? null,
      company_id: params.company_id ?? null,
      expected_close_date: params.expected_close_date ?? null,
      probability: params.probability ?? null,
      tags: params.tags ?? [],
      owner_id: params.owner_id ?? null,
    })
    .select('id, title, value, currency, stage_id, pipeline_id')
    .single()
  if (error || !data) throw new Error(`Failed to create deal: ${error?.message}`)
  return data
}

export async function updateDeal(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    id: string
    title?: string
    value?: number
    currency?: string
    expected_close_date?: string | null
    probability?: number | null
    tags?: string[]
    stage_id?: string
    contact_id?: string | null
    company_id?: string | null
  }
) {
  const { id, ...patch } = params
  const clean: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) clean[k] = v
  }
  const { data, error } = await supabase
    .from('deals')
    .update(clean)
    .eq('id', id)
    .eq('org_id', orgId)
    .select('id, title, value, stage_id, closed_at, closed_won')
    .single()
  if (error || !data) throw new Error(`Update failed: ${error?.message}`)
  return data
}

export async function moveDealStage(
  supabase: SupabaseClient,
  orgId: string,
  params: { deal_id: string; stage_name?: string; stage_id?: string }
) {
  let stageId = params.stage_id ?? null
  if (!stageId && params.stage_name) {
    const { data: deal } = await supabase
      .from('deals')
      .select('pipeline_id')
      .eq('id', params.deal_id)
      .eq('org_id', orgId)
      .single()
    if (!deal) throw new Error('Deal not found')
    const { data: stage } = await supabase
      .from('pipeline_stages')
      .select('id')
      .eq('pipeline_id', deal.pipeline_id)
      .ilike('name', params.stage_name)
      .maybeSingle()
    stageId = (stage?.id as string | undefined) ?? null
  }
  if (!stageId) throw new Error('Stage not found — pass stage_id or an exact stage_name')

  const { data, error } = await supabase
    .from('deals')
    .update({ stage_id: stageId, updated_at: new Date().toISOString() })
    .eq('id', params.deal_id)
    .eq('org_id', orgId)
    .select('id, stage_id')
    .single()
  if (error || !data) throw new Error(`Move failed: ${error?.message}`)
  return data
}

export async function closeDeal(
  supabase: SupabaseClient,
  orgId: string,
  params: { deal_id: string; outcome: 'won' | 'lost'; reason?: string }
) {
  // Find the appropriate won/lost stage for the deal's pipeline
  const { data: deal } = await supabase
    .from('deals')
    .select('pipeline_id')
    .eq('id', params.deal_id)
    .eq('org_id', orgId)
    .single()
  if (!deal) throw new Error('Deal not found')

  const { data: stage } = await supabase
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', deal.pipeline_id)
    .eq(params.outcome === 'won' ? 'is_won' : 'is_lost', true)
    .maybeSingle()

  const patch: Record<string, unknown> = {
    closed_at: new Date().toISOString(),
    closed_won: params.outcome === 'won',
    updated_at: new Date().toISOString(),
  }
  if (stage?.id) patch.stage_id = stage.id

  const { data, error } = await supabase
    .from('deals')
    .update(patch)
    .eq('id', params.deal_id)
    .eq('org_id', orgId)
    .select('id, closed_at, closed_won, stage_id')
    .single()
  if (error || !data) throw new Error(`Close failed: ${error?.message}`)
  return data
}
