import type { SupabaseClient } from '@supabase/supabase-js'

export type ActivityType = 'call' | 'email' | 'meeting' | 'note' | 'task'

export async function listActivities(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    contact_id?: string
    company_id?: string
    deal_id?: string
    type?: ActivityType
    limit?: number
  }
) {
  let q = supabase
    .from('activities')
    .select(
      'id, type, subject, body, contact_id, company_id, deal_id, user_id, due_at, completed_at, created_at'
    )
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(Math.min(params.limit ?? 50, 200))

  if (params.contact_id) q = q.eq('contact_id', params.contact_id)
  if (params.company_id) q = q.eq('company_id', params.company_id)
  if (params.deal_id) q = q.eq('deal_id', params.deal_id)
  if (params.type) q = q.eq('type', params.type)

  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function logActivity(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    type: Exclude<ActivityType, 'task'>
    subject: string
    body?: string
    contact_id?: string
    company_id?: string
    deal_id?: string
    user_id?: string
    completed_at?: string
  }
) {
  const { data, error } = await supabase
    .from('activities')
    .insert({
      org_id: orgId,
      type: params.type,
      subject: params.subject,
      body: params.body ?? null,
      contact_id: params.contact_id ?? null,
      company_id: params.company_id ?? null,
      deal_id: params.deal_id ?? null,
      user_id: params.user_id ?? null,
      // Historic activity — it's already done
      completed_at: params.completed_at ?? new Date().toISOString(),
    })
    .select('id, type, subject, completed_at')
    .single()
  if (error || !data) throw new Error(`Log failed: ${error?.message}`)
  return data
}

export async function createTask(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    subject: string
    body?: string
    due_at?: string // ISO
    contact_id?: string
    company_id?: string
    deal_id?: string
    user_id?: string
  }
) {
  const { data, error } = await supabase
    .from('activities')
    .insert({
      org_id: orgId,
      type: 'task',
      subject: params.subject,
      body: params.body ?? null,
      due_at: params.due_at ?? null,
      contact_id: params.contact_id ?? null,
      company_id: params.company_id ?? null,
      deal_id: params.deal_id ?? null,
      user_id: params.user_id ?? null,
    })
    .select('id, type, subject, due_at')
    .single()
  if (error || !data) throw new Error(`Task create failed: ${error?.message}`)
  return data
}

export async function completeTask(
  supabase: SupabaseClient,
  orgId: string,
  params: { task_id: string }
) {
  const { data, error } = await supabase
    .from('activities')
    .update({ completed_at: new Date().toISOString() })
    .eq('id', params.task_id)
    .eq('org_id', orgId)
    .eq('type', 'task')
    .select('id, completed_at')
    .single()
  if (error || !data) throw new Error(`Complete failed: ${error?.message}`)
  return data
}
