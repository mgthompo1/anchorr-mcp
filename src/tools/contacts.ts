import type { SupabaseClient } from '@supabase/supabase-js'

export async function listContacts(
  supabase: SupabaseClient,
  orgId: string,
  params: { status?: string; limit?: number; company_id?: string }
) {
  let q = supabase
    .from('contacts')
    .select('id, first_name, last_name, email, title, status, source, company_id, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(Math.min(params.limit ?? 50, 200))

  if (params.status) q = q.eq('status', params.status)
  if (params.company_id) q = q.eq('company_id', params.company_id)

  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function getContact(
  supabase: SupabaseClient,
  orgId: string,
  contactId: string
) {
  const { data, error } = await supabase
    .from('contacts')
    .select(
      'id, first_name, last_name, email, phone, title, status, source, tags, custom_fields, company:companies(id, name, website, industry), created_at'
    )
    .eq('id', contactId)
    .eq('org_id', orgId)
    .single()
  if (error || !data) throw new Error('Contact not found')
  return data
}

export async function createContact(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    first_name: string
    last_name?: string
    email?: string
    phone?: string
    title?: string
    status?: string
    source?: string
    tags?: string[]
    company_name?: string
    owner_id?: string
  }
) {
  let companyId: string | null = null
  if (params.company_name) {
    const { data: existing } = await supabase
      .from('companies')
      .select('id')
      .eq('org_id', orgId)
      .eq('name', params.company_name)
      .maybeSingle()
    if (existing) {
      companyId = existing.id as string
    } else {
      const { data: created } = await supabase
        .from('companies')
        .insert({ org_id: orgId, name: params.company_name })
        .select('id')
        .single()
      companyId = (created?.id as string | undefined) ?? null
    }
  }

  const { data, error } = await supabase
    .from('contacts')
    .insert({
      org_id: orgId,
      first_name: params.first_name,
      last_name: params.last_name ?? '—',
      email: params.email ?? null,
      phone: params.phone ?? null,
      title: params.title ?? null,
      status: params.status ?? 'lead',
      source: params.source ?? 'MCP',
      tags: params.tags ?? [],
      company_id: companyId,
      owner_id: params.owner_id ?? null,
    })
    .select('id, first_name, last_name, email, status, source')
    .single()
  if (error || !data) throw new Error(`Failed to create contact: ${error?.message}`)
  return data
}

export type BulkContactInput = {
  first_name: string
  last_name?: string
  email?: string
  phone?: string
  title?: string
  status?: 'lead' | 'prospect' | 'customer' | 'churned'
  source?: string
  tags?: string[]
  company_name?: string
}

export type BulkCreateResult = {
  created: number
  skipped_duplicates: number
  failed: number
  errors: { index: number; email: string | null; error: string }[]
  companies_created: number
}

export async function bulkCreateContacts(
  supabase: SupabaseClient,
  orgId: string,
  params: { contacts: BulkContactInput[]; dedupe_by_email?: boolean; default_source?: string }
): Promise<BulkCreateResult> {
  const dedupe = params.dedupe_by_email !== false
  const defaultSource = params.default_source ?? 'MCP-import'
  const errors: BulkCreateResult['errors'] = []

  // 1. Resolve companies in batch — one fetch + one insert covers all distinct names.
  const distinctCompanyNames = Array.from(
    new Set(
      params.contacts
        .map((c) => c.company_name?.trim())
        .filter((n): n is string => !!n && n.length > 0)
    )
  )

  const companyMap = new Map<string, string>()
  let companiesCreated = 0

  if (distinctCompanyNames.length > 0) {
    const { data: existingCompanies } = await supabase
      .from('companies')
      .select('id, name')
      .eq('org_id', orgId)
      .in('name', distinctCompanyNames)

    for (const c of existingCompanies ?? []) {
      companyMap.set((c.name as string).toLowerCase(), c.id as string)
    }

    const missing = distinctCompanyNames.filter(
      (n) => !companyMap.has(n.toLowerCase())
    )
    if (missing.length > 0) {
      const { data: created, error: companyErr } = await supabase
        .from('companies')
        .insert(missing.map((name) => ({ org_id: orgId, name })))
        .select('id, name')
      if (companyErr) {
        throw new Error(`Failed to create companies: ${companyErr.message}`)
      }
      for (const c of created ?? []) {
        companyMap.set((c.name as string).toLowerCase(), c.id as string)
        companiesCreated++
      }
    }
  }

  // 2. Dedupe against existing emails (case-insensitive — store/compare lowercased).
  const existingEmails = new Set<string>()
  if (dedupe) {
    const incomingEmails = Array.from(
      new Set(
        params.contacts
          .map((c) => c.email?.trim().toLowerCase())
          .filter((e): e is string => !!e && e.length > 0)
      )
    )
    if (incomingEmails.length > 0) {
      const { data: dupes } = await supabase
        .from('contacts')
        .select('email')
        .eq('org_id', orgId)
        .in('email', incomingEmails)
      for (const d of dupes ?? []) {
        if (d.email) existingEmails.add((d.email as string).toLowerCase())
      }
    }
  }

  // 3. Build rows, dropping duplicates and rows that fail validation.
  const seenInBatch = new Set<string>()
  let skipped = 0
  const rows: Record<string, unknown>[] = []

  params.contacts.forEach((c, idx) => {
    const email = c.email?.trim() || null
    const emailKey = email?.toLowerCase() ?? null

    if (emailKey && existingEmails.has(emailKey)) {
      skipped++
      return
    }
    if (emailKey && seenInBatch.has(emailKey)) {
      skipped++
      return
    }
    if (!c.first_name?.trim()) {
      errors.push({ index: idx, email, error: 'first_name is required' })
      return
    }
    if (emailKey) seenInBatch.add(emailKey)

    rows.push({
      org_id: orgId,
      first_name: c.first_name.trim(),
      last_name: c.last_name?.trim() || '—',
      email,
      phone: c.phone ?? null,
      title: c.title ?? null,
      status: c.status ?? 'lead',
      source: c.source ?? defaultSource,
      tags: c.tags ?? [],
      company_id: c.company_name
        ? companyMap.get(c.company_name.trim().toLowerCase()) ?? null
        : null,
    })
  })

  // 4. Single insert. On failure, fall back row-by-row to surface the bad rows.
  let created = 0
  if (rows.length > 0) {
    const { data, error } = await supabase
      .from('contacts')
      .insert(rows)
      .select('id')
    if (error) {
      // Bulk insert failed — likely one bad row poisoned the whole batch.
      // Retry one-at-a-time so the caller learns which rows are bad.
      for (let i = 0; i < rows.length; i++) {
        const { error: rowErr } = await supabase.from('contacts').insert(rows[i]!)
        if (rowErr) {
          errors.push({
            index: i,
            email: (rows[i]!.email as string | null) ?? null,
            error: rowErr.message,
          })
        } else {
          created++
        }
      }
    } else {
      created = data?.length ?? rows.length
    }
  }

  return {
    created,
    skipped_duplicates: skipped,
    failed: errors.length,
    errors,
    companies_created: companiesCreated,
  }
}

export async function enrollContactInSequence(
  supabase: SupabaseClient,
  orgId: string,
  params: { contact_id: string; sequence_id: string }
) {
  const { data, error } = await supabase
    .from('sequence_enrollments')
    .insert({
      org_id: orgId,
      contact_id: params.contact_id,
      sequence_id: params.sequence_id,
      current_step: 0,
      status: 'active',
      next_action_at: new Date(Date.now() + 60_000).toISOString(),
    })
    .select('id, status')
    .single()
  if (error || !data) throw new Error(`Enroll failed: ${error?.message}`)
  return data
}
