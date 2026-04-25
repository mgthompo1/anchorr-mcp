import type { SupabaseClient } from '@supabase/supabase-js'

export async function listTemplates(
  supabase: SupabaseClient,
  orgId: string,
  params: { category?: string; limit?: number }
) {
  let q = supabase
    .from('email_templates')
    .select('id, name, subject, category, updated_at, created_at')
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(Math.min(params.limit ?? 50, 200))

  if (params.category) q = q.eq('category', params.category)

  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function getTemplate(
  supabase: SupabaseClient,
  orgId: string,
  templateId: string
) {
  const { data, error } = await supabase
    .from('email_templates')
    .select('id, name, subject, body, category, created_at, updated_at')
    .eq('id', templateId)
    .eq('org_id', orgId)
    .single()
  if (error || !data) throw new Error('Template not found')
  return data
}

export async function createTemplate(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    name: string
    subject: string
    body: string
    category?: string
    created_by?: string
  }
) {
  const { data, error } = await supabase
    .from('email_templates')
    .insert({
      org_id: orgId,
      name: params.name,
      subject: params.subject,
      body: params.body,
      category: params.category ?? 'general',
      created_by: params.created_by ?? null,
    })
    .select('id, name, subject, category')
    .single()
  if (error || !data) throw new Error(`Create failed: ${error?.message}`)
  return data
}

export async function updateTemplate(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    id: string
    name?: string
    subject?: string
    body?: string
    category?: string
  }
) {
  const { id, ...patch } = params
  const clean: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) clean[k] = v
  }
  const { data, error } = await supabase
    .from('email_templates')
    .update(clean)
    .eq('id', id)
    .eq('org_id', orgId)
    .select('id, name, subject, category, updated_at')
    .single()
  if (error || !data) throw new Error(`Update failed: ${error?.message}`)
  return data
}
