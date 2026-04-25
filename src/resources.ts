import type { SupabaseClient } from '@supabase/supabase-js'

type SingleOrArr<T> = T | T[] | null | undefined

function one<T>(v: SingleOrArr<T>): T | null {
  if (!v) return null
  return Array.isArray(v) ? v[0] ?? null : v
}

export async function orgOverview(supabase: SupabaseClient, orgId: string) {
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const startIso = startOfDay.toISOString()

  const [
    orgRes,
    openDealsRes,
    wonMonthRes,
    pendingCandidatesRes,
    repliesTodayRes,
    tasksOpenRes,
    contactsRes,
  ] = await Promise.all([
    supabase.from('organizations').select('name').eq('id', orgId).single(),
    supabase.from('deals').select('id, value, currency').eq('org_id', orgId).is('closed_at', null),
    supabase
      .from('deals')
      .select('id, value')
      .eq('org_id', orgId)
      .eq('closed_won', true)
      .gte('closed_at', new Date(Date.now() - 30 * 86400000).toISOString()),
    supabase
      .from('agent_candidates')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('status', 'pending_review'),
    supabase
      .from('sequence_replies')
      .select('intent')
      .eq('org_id', orgId)
      .gte('created_at', startIso),
    supabase
      .from('activities')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('type', 'task')
      .is('completed_at', null),
    supabase
      .from('contacts')
      .select('status', { count: 'exact' })
      .eq('org_id', orgId)
      .limit(2000),
  ])

  const openDeals = openDealsRes.data ?? []
  const wonMonth = wonMonthRes.data ?? []
  const pipelineValue = openDeals.reduce((s, d) => s + (Number(d.value) || 0), 0)
  const wonValue = wonMonth.reduce((s, d) => s + (Number(d.value) || 0), 0)

  const contactsByStatus: Record<string, number> = {}
  for (const c of contactsRes.data ?? []) {
    const s = (c.status as string) ?? 'unknown'
    contactsByStatus[s] = (contactsByStatus[s] ?? 0) + 1
  }

  const repliesByIntent: Record<string, number> = {}
  for (const r of repliesTodayRes.data ?? []) {
    const i = (r.intent as string) ?? 'unknown'
    repliesByIntent[i] = (repliesByIntent[i] ?? 0) + 1
  }

  return {
    organization: orgRes.data?.name ?? 'Unknown',
    pipeline: {
      open_deals: openDeals.length,
      pipeline_value: Math.round(pipelineValue * 100) / 100,
      won_last_30d_count: wonMonth.length,
      won_last_30d_value: Math.round(wonValue * 100) / 100,
    },
    contacts: {
      total: contactsRes.count ?? 0,
      by_status: contactsByStatus,
    },
    agent: {
      pending_candidates: pendingCandidatesRes.count ?? 0,
      replies_today: (repliesTodayRes.data ?? []).length,
      replies_by_intent_today: repliesByIntent,
    },
    tasks: {
      open: tasksOpenRes.count ?? 0,
    },
  }
}

export async function dealBrief(
  supabase: SupabaseClient,
  orgId: string,
  dealId: string
) {
  const { data: deal, error } = await supabase
    .from('deals')
    .select(
      '*, stage:pipeline_stages(id, name, position, is_won, is_lost), contact:contacts(id, first_name, last_name, email, phone, title), company:companies(id, name, website, domain, industry, size, city, country, description)'
    )
    .eq('id', dealId)
    .eq('org_id', orgId)
    .single()
  if (error || !deal) throw new Error('Deal not found')

  const contact = one(deal.contact as SingleOrArr<{ id: string }>)
  const company = one(deal.company as SingleOrArr<{ id: string }>)

  const [activitiesRes, researchContactRes, researchCompanyRes] = await Promise.all([
    supabase
      .from('activities')
      .select('id, type, subject, body, completed_at, due_at, created_at')
      .eq('org_id', orgId)
      .or(
        [
          `deal_id.eq.${dealId}`,
          contact ? `contact_id.eq.${contact.id}` : null,
          company ? `company_id.eq.${company.id}` : null,
        ]
          .filter(Boolean)
          .join(',')
      )
      .order('created_at', { ascending: false })
      .limit(15),
    contact
      ? supabase
          .from('agent_research')
          .select('summary, recent_news, pain_point_hypotheses, tech_stack, created_at')
          .eq('org_id', orgId)
          .eq('subject_type', 'contact')
          .eq('subject_id', contact.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    company
      ? supabase
          .from('agent_research')
          .select('summary, recent_news, pain_point_hypotheses, tech_stack, created_at')
          .eq('org_id', orgId)
          .eq('subject_type', 'company')
          .eq('subject_id', company.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  return {
    deal: {
      id: deal.id,
      title: deal.title,
      value: deal.value,
      currency: deal.currency,
      stage: one(deal.stage as SingleOrArr<{ name: string }>),
      expected_close_date: deal.expected_close_date,
      probability: deal.probability,
      tags: deal.tags,
      closed_at: deal.closed_at,
      closed_won: deal.closed_won,
      created_at: deal.created_at,
      updated_at: deal.updated_at,
    },
    contact,
    company,
    activities: activitiesRes.data ?? [],
    research: {
      contact: researchContactRes.data ?? null,
      company: researchCompanyRes.data ?? null,
    },
  }
}

export async function contactBrief(
  supabase: SupabaseClient,
  orgId: string,
  contactId: string
) {
  const { data: contact, error } = await supabase
    .from('contacts')
    .select(
      '*, company:companies(id, name, website, industry, size, city, country)'
    )
    .eq('id', contactId)
    .eq('org_id', orgId)
    .single()
  if (error || !contact) throw new Error('Contact not found')

  const company = one(contact.company as SingleOrArr<{ id: string }>)

  const [activitiesRes, dealsRes, enrollmentsRes, researchRes] = await Promise.all([
    supabase
      .from('activities')
      .select('id, type, subject, body, completed_at, due_at, created_at')
      .eq('org_id', orgId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(15),
    supabase
      .from('deals')
      .select('id, title, value, stage_id, closed_at, closed_won, created_at, stage:pipeline_stages(name, is_won, is_lost)')
      .eq('org_id', orgId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase
      .from('sequence_enrollments')
      .select('id, status, current_step, next_action_at, sequence:sequences(name)')
      .eq('org_id', orgId)
      .eq('contact_id', contactId)
      .order('enrolled_at', { ascending: false })
      .limit(5),
    supabase
      .from('agent_research')
      .select('summary, recent_news, pain_point_hypotheses, tech_stack, created_at')
      .eq('org_id', orgId)
      .eq('subject_type', 'contact')
      .eq('subject_id', contactId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  return {
    contact: {
      id: contact.id,
      first_name: contact.first_name,
      last_name: contact.last_name,
      email: contact.email,
      phone: contact.phone,
      title: contact.title,
      status: contact.status,
      source: contact.source,
      tags: contact.tags,
      created_at: contact.created_at,
    },
    company,
    activities: activitiesRes.data ?? [],
    deals: dealsRes.data ?? [],
    sequence_enrollments: enrollmentsRes.data ?? [],
    research: researchRes.data ?? null,
  }
}

export async function companyBrief(
  supabase: SupabaseClient,
  orgId: string,
  companyId: string
) {
  const { data: company, error } = await supabase
    .from('companies')
    .select('*')
    .eq('id', companyId)
    .eq('org_id', orgId)
    .single()
  if (error || !company) throw new Error('Company not found')

  const [contactsRes, dealsRes, activitiesRes, researchRes] = await Promise.all([
    supabase
      .from('contacts')
      .select('id, first_name, last_name, email, title, status')
      .eq('org_id', orgId)
      .eq('company_id', companyId)
      .limit(50),
    supabase
      .from('deals')
      .select('id, title, value, closed_at, closed_won, stage:pipeline_stages(name)')
      .eq('org_id', orgId)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('activities')
      .select('id, type, subject, created_at')
      .eq('org_id', orgId)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(15),
    supabase
      .from('agent_research')
      .select('summary, recent_news, pain_point_hypotheses, tech_stack, leadership, created_at')
      .eq('org_id', orgId)
      .eq('subject_type', 'company')
      .eq('subject_id', companyId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  return {
    company: {
      id: company.id,
      name: company.name,
      website: company.website,
      domain: company.domain,
      industry: company.industry,
      size: company.size,
      city: company.city,
      country: company.country,
      description: company.description,
      tags: company.tags,
    },
    contacts: contactsRes.data ?? [],
    deals: dealsRes.data ?? [],
    activities: activitiesRes.data ?? [],
    research: researchRes.data ?? null,
  }
}
