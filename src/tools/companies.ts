import type { SupabaseClient } from '@supabase/supabase-js'

export async function listCompanies(
  supabase: SupabaseClient,
  orgId: string,
  params: { search?: string; industry?: string; limit?: number }
) {
  let q = supabase
    .from('companies')
    .select('id, name, website, domain, industry, size, city, country, tags, updated_at')
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(Math.min(params.limit ?? 50, 200))

  if (params.industry) q = q.eq('industry', params.industry)
  if (params.search) q = q.ilike('name', `%${params.search}%`)

  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function getCompany(
  supabase: SupabaseClient,
  orgId: string,
  companyId: string
) {
  const { data, error } = await supabase
    .from('companies')
    .select('*, contacts:contacts(id, first_name, last_name, email, title, status)')
    .eq('id', companyId)
    .eq('org_id', orgId)
    .single()
  if (error || !data) throw new Error('Company not found')
  return data
}

export async function createCompany(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    name: string
    website?: string
    domain?: string
    industry?: string
    size?: string
    address?: string
    city?: string
    state?: string
    country?: string
    description?: string
    tags?: string[]
    owner_id?: string
  }
) {
  const { data, error } = await supabase
    .from('companies')
    .insert({
      org_id: orgId,
      name: params.name,
      website: params.website ?? null,
      domain: params.domain ?? null,
      industry: params.industry ?? null,
      size: params.size ?? null,
      address: params.address ?? null,
      city: params.city ?? null,
      state: params.state ?? null,
      country: params.country ?? null,
      description: params.description ?? null,
      tags: params.tags ?? [],
      owner_id: params.owner_id ?? null,
    })
    .select('id, name, website, industry')
    .single()
  if (error || !data) throw new Error(`Create failed: ${error?.message}`)
  return data
}

export async function updateCompany(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    id: string
    name?: string
    website?: string
    domain?: string
    industry?: string
    size?: string
    address?: string
    city?: string
    state?: string
    country?: string
    description?: string
    tags?: string[]
  }
) {
  const { id, ...patch } = params
  const clean: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) clean[k] = v
  }
  const { data, error } = await supabase
    .from('companies')
    .update(clean)
    .eq('id', id)
    .eq('org_id', orgId)
    .select('id, name, industry, updated_at')
    .single()
  if (error || !data) throw new Error(`Update failed: ${error?.message}`)
  return data
}
