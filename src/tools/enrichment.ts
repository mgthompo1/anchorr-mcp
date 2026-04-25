import type { SupabaseClient } from '@supabase/supabase-js'

// Worker-side enrichment waterfall. Mirrors src/lib/enrichment in the Next.js
// app (same provider order, same schema, same TTLs) but uses fetch directly
// instead of provider SDKs so it runs on the Cloudflare Worker runtime.
//
// Cache is shared via Supabase tables — a hit from the web app warms this,
// and vice versa. This is the whole point: every Claude/Cursor agent that
// enriches via Anchorr feeds the same cache the web product reads from.

const ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'

// Token pricing in micro-dollars (USD * 10^6) per token. Sonnet 4.5.
const ANTHROPIC_INPUT_MICROS = 3
const ANTHROPIC_OUTPUT_MICROS = 15

// Apollo is per-credit; we estimate $0.05 for accounting purposes only.
const APOLLO_LOOKUP_MICROS = 50_000
// Hunter is roughly $0.025/lookup on the entry plan.
const HUNTER_LOOKUP_MICROS = 25_000

const CACHE_TTL_SECONDS = {
  apollo_contact: 60 * 60 * 24 * 7,
  apollo_company: 60 * 60 * 24 * 14,
  hunter_contact: 60 * 60 * 24 * 14,
  ai_contact: 60 * 60 * 24 * 14,
  ai_company: 60 * 60 * 24 * 30,
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface ContactQuery {
  email?: string
  first_name?: string
  last_name?: string
  domain?: string
}

export interface CompanyQuery {
  domain?: string
  name?: string
}

export interface ContactData {
  first_name?: string | null
  last_name?: string | null
  full_name?: string | null
  title?: string | null
  email?: string | null
  phone?: string | null
  linkedin_url?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  company?: string | null
  company_domain?: string | null
  company_industry?: string | null
  company_size?: string | number | null
}

export interface CompanyData {
  name?: string | null
  domain?: string | null
  website?: string | null
  industry?: string | null
  description?: string | null
  size?: string | number | null
  founded_year?: number | null
  city?: string | null
  state?: string | null
  country?: string | null
  linkedin_url?: string | null
  logo_url?: string | null
  phone?: string | null
  annual_revenue?: number | string | null
  technology_names?: string[] | null
}

interface AttemptLog {
  provider: string
  ok: boolean
  reason?: string
  error_message?: string
  latency_ms: number
  cost_micros: number
}

export interface WaterfallOutcome<T> {
  data: T | null
  resolved_by: string | null
  served_from: 'cache' | 'provider' | 'miss'
  attempts: AttemptLog[]
  total_cost_micros: number
  total_latency_ms: number
}

// ── Key normalisation ───────────────────────────────────────────────────────

function normalizeContactKey(q: ContactQuery): string | null {
  if (q.email) return `email:${q.email.trim().toLowerCase()}`
  if (q.first_name && q.last_name && q.domain) {
    const dom = q.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()
    return `name:${q.first_name.trim().toLowerCase()}.${q.last_name.trim().toLowerCase()}@${dom}`
  }
  return null
}

function normalizeCompanyKey(q: CompanyQuery): string | null {
  if (q.domain) return `domain:${q.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()}`
  if (q.name) return `name:${q.name.trim().toLowerCase()}`
  return null
}

// ── Cache ───────────────────────────────────────────────────────────────────

async function readCache<T>(
  supabase: SupabaseClient,
  orgId: string,
  targetType: 'contact' | 'company',
  key: string
): Promise<{ data: T; provider: string } | null> {
  const { data } = await supabase
    .from('enrichment_cache')
    .select('data, provider, expires_at, fetched_at')
    .eq('org_id', orgId)
    .eq('target_type', targetType)
    .eq('target_key', key)
    .gt('expires_at', new Date().toISOString())
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  return { data: data.data as T, provider: data.provider as string }
}

async function writeCache(
  supabase: SupabaseClient,
  args: {
    orgId: string
    targetType: 'contact' | 'company'
    targetKey: string
    provider: string
    data: unknown
    cost_micros: number
    shareable: boolean
    ttl_seconds: number
  }
): Promise<void> {
  await supabase
    .from('enrichment_cache')
    .upsert(
      {
        org_id: args.orgId,
        target_type: args.targetType,
        target_key: args.targetKey,
        provider: args.provider,
        data: args.data,
        cost_micros: args.cost_micros,
        shareable: args.shareable,
        fetched_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + args.ttl_seconds * 1000).toISOString(),
      },
      { onConflict: 'org_id,target_type,target_key,provider' }
    )
}

async function logRequest(
  supabase: SupabaseClient,
  args: {
    orgId: string
    targetType: 'contact' | 'company'
    targetKey: string
    outcome: WaterfallOutcome<unknown>
  }
): Promise<void> {
  await supabase.from('enrichment_requests').insert({
    org_id: args.orgId,
    target_type: args.targetType,
    target_key: args.targetKey,
    attempts: args.outcome.attempts,
    resolved_by: args.outcome.resolved_by,
    served_from: args.outcome.served_from,
    total_cost_micros: args.outcome.total_cost_micros,
    total_latency_ms: args.outcome.total_latency_ms,
  })
}

// ── Apollo over fetch ───────────────────────────────────────────────────────

async function getApolloKey(supabase: SupabaseClient, orgId: string): Promise<string | null> {
  const { data: org } = await supabase
    .from('organizations')
    .select('apollo_api_key')
    .eq('id', orgId)
    .single()
  return (org?.apollo_api_key as string | null) ?? null
}

async function apolloContact(
  supabase: SupabaseClient,
  orgId: string,
  q: ContactQuery
): Promise<{ ok: boolean; data?: ContactData; cost_micros: number; reason?: string; error_message?: string; shareable: boolean }> {
  const apiKey = await getApolloKey(supabase, orgId)
  if (!apiKey) return { ok: false, reason: 'not_configured', cost_micros: 0, shareable: false }
  if (!q.email) return { ok: false, reason: 'no_match', cost_micros: 0, shareable: false }

  const res = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: q.email, api_key: apiKey }),
  })
  if (res.status === 401) return { ok: false, reason: 'not_configured', cost_micros: 0, shareable: false }
  if (res.status === 429) return { ok: false, reason: 'rate_limited', cost_micros: 0, shareable: false }
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    return { ok: false, reason: 'error', error_message: txt.slice(0, 200), cost_micros: 0, shareable: false }
  }

  const body = (await res.json()) as { person?: Record<string, unknown> }
  const p = body.person
  if (!p) return { ok: false, reason: 'no_match', cost_micros: 0, shareable: false }
  const org = (p.organization ?? {}) as Record<string, unknown>
  const phones = (p.phone_numbers as Array<Record<string, unknown>> | undefined) ?? []

  return {
    ok: true,
    cost_micros: APOLLO_LOOKUP_MICROS,
    shareable: false,
    data: {
      first_name: (p.first_name as string | null) ?? null,
      last_name: (p.last_name as string | null) ?? null,
      full_name: (p.name as string | null) ?? null,
      title: (p.title as string | null) ?? null,
      email: ((p.email as string | null) ?? q.email) ?? null,
      phone: (phones[0]?.raw_number as string | null) ?? null,
      linkedin_url: (p.linkedin_url as string | null) ?? null,
      city: (p.city as string | null) ?? null,
      state: (p.state as string | null) ?? null,
      country: (p.country as string | null) ?? null,
      company: (org.name as string | null) ?? null,
      company_domain: (org.primary_domain as string | null) ?? null,
      company_industry: (org.industry as string | null) ?? null,
      company_size: (org.estimated_num_employees as string | number | null) ?? null,
    },
  }
}

async function apolloCompany(
  supabase: SupabaseClient,
  orgId: string,
  q: CompanyQuery
): Promise<{ ok: boolean; data?: CompanyData; cost_micros: number; reason?: string; error_message?: string; shareable: boolean }> {
  const apiKey = await getApolloKey(supabase, orgId)
  if (!apiKey) return { ok: false, reason: 'not_configured', cost_micros: 0, shareable: false }
  const domain = (q.domain ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()
  if (!domain) return { ok: false, reason: 'no_match', cost_micros: 0, shareable: false }

  const res = await fetch('https://api.apollo.io/api/v1/organizations/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain, api_key: apiKey }),
  })
  if (res.status === 401) return { ok: false, reason: 'not_configured', cost_micros: 0, shareable: false }
  if (res.status === 429) return { ok: false, reason: 'rate_limited', cost_micros: 0, shareable: false }
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    return { ok: false, reason: 'error', error_message: txt.slice(0, 200), cost_micros: 0, shareable: false }
  }

  const body = (await res.json()) as { organization?: Record<string, unknown> }
  const c = body.organization
  if (!c) return { ok: false, reason: 'no_match', cost_micros: 0, shareable: false }

  return {
    ok: true,
    cost_micros: APOLLO_LOOKUP_MICROS,
    shareable: false,
    data: {
      name: (c.name as string | null) ?? null,
      domain: ((c.primary_domain as string | null) ?? domain) ?? null,
      website: (c.website_url as string | null) ?? null,
      industry: (c.industry as string | null) ?? null,
      description: (c.short_description as string | null) ?? null,
      size: (c.estimated_num_employees as string | number | null) ?? null,
      founded_year: (c.founded_year as number | null) ?? null,
      city: (c.city as string | null) ?? null,
      state: (c.state as string | null) ?? null,
      country: (c.country as string | null) ?? null,
      linkedin_url: (c.linkedin_url as string | null) ?? null,
      logo_url: (c.logo_url as string | null) ?? null,
      phone: (c.phone as string | null) ?? null,
      annual_revenue: (c.annual_revenue as number | string | null) ?? null,
      technology_names: (c.technology_names as string[] | null) ?? [],
    },
  }
}

// ── Hunter over fetch ───────────────────────────────────────────────────────

async function getHunterKey(supabase: SupabaseClient, orgId: string): Promise<string | null> {
  const { data: org } = await supabase
    .from('organizations')
    .select('hunter_api_key')
    .eq('id', orgId)
    .single()
  return (org?.hunter_api_key as string | null) ?? null
}

async function hunterContact(
  supabase: SupabaseClient,
  orgId: string,
  q: ContactQuery
): Promise<{ ok: boolean; data?: ContactData; cost_micros: number; reason?: string; error_message?: string; shareable: boolean }> {
  const apiKey = await getHunterKey(supabase, orgId)
  if (!apiKey) return { ok: false, reason: 'not_configured', cost_micros: 0, shareable: false }

  // Path A: have an email — verify it.
  if (q.email) {
    const url = `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(q.email)}&api_key=${encodeURIComponent(apiKey)}`
    const res = await fetch(url)
    if (res.status === 401) return { ok: false, reason: 'not_configured', cost_micros: 0, shareable: false }
    if (res.status === 429) return { ok: false, reason: 'rate_limited', cost_micros: 0, shareable: false }
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return { ok: false, reason: 'error', error_message: txt.slice(0, 200), cost_micros: 0, shareable: false }
    }
    const body = (await res.json()) as { data?: { result?: string | null; email?: string | null } }
    const v = body.data
    if (!v) return { ok: false, reason: 'no_match', cost_micros: 0, shareable: false }
    if (v.result === 'undeliverable') return { ok: false, reason: 'no_match', cost_micros: 0, shareable: false }
    return {
      ok: true,
      cost_micros: HUNTER_LOOKUP_MICROS,
      shareable: false,
      data: { email: v.email ?? q.email },
    }
  }

  // Path B: have name + domain — find the email.
  if (q.first_name && q.last_name && q.domain) {
    const dom = q.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()
    const url = `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(dom)}&first_name=${encodeURIComponent(q.first_name)}&last_name=${encodeURIComponent(q.last_name)}&api_key=${encodeURIComponent(apiKey)}`
    const res = await fetch(url)
    if (res.status === 401) return { ok: false, reason: 'not_configured', cost_micros: 0, shareable: false }
    if (res.status === 429) return { ok: false, reason: 'rate_limited', cost_micros: 0, shareable: false }
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return { ok: false, reason: 'error', error_message: txt.slice(0, 200), cost_micros: 0, shareable: false }
    }
    const body = (await res.json()) as {
      data?: {
        email?: string | null
        first_name?: string | null
        last_name?: string | null
        position?: string | null
        linkedin_url?: string | null
        company?: string | null
        domain?: string | null
      }
    }
    const f = body.data
    if (!f?.email) return { ok: false, reason: 'no_match', cost_micros: 0, shareable: false }
    return {
      ok: true,
      cost_micros: HUNTER_LOOKUP_MICROS,
      shareable: false,
      data: {
        first_name: f.first_name ?? q.first_name,
        last_name: f.last_name ?? q.last_name,
        email: f.email,
        title: f.position ?? null,
        linkedin_url: f.linkedin_url ?? null,
        company: f.company ?? null,
        company_domain: f.domain ?? dom,
      },
    }
  }

  return { ok: false, reason: 'no_match', cost_micros: 0, shareable: false }
}

// ── AI research over fetch ──────────────────────────────────────────────────

async function getAnthropicKey(
  supabase: SupabaseClient,
  orgId: string,
  fallback: string | undefined
): Promise<string | null> {
  const { data: org } = await supabase
    .from('organizations')
    .select('anthropic_api_key, platform_ai_enabled')
    .eq('id', orgId)
    .single()
  if (org?.anthropic_api_key) return org.anthropic_api_key as string
  if (org?.platform_ai_enabled && fallback) return fallback
  return null
}

async function fetchPageText(url: string): Promise<string> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Anchorr Enrichment Bot/1.0' },
    })
    clearTimeout(timer)
    if (!res.ok) return ''
    const html = await res.text()
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000)
  } catch {
    return ''
  }
}

interface AnthropicResp {
  content: Array<{ type: string; text?: string }>
  usage: { input_tokens: number; output_tokens: number }
}

async function callAnthropic(
  apiKey: string,
  prompt: string
): Promise<{ text: string; cost_micros: number } | null> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) return null
  const body = (await res.json()) as AnthropicResp
  const text = body.content[0]?.type === 'text' ? body.content[0].text ?? '' : ''
  const cost =
    body.usage.input_tokens * ANTHROPIC_INPUT_MICROS +
    body.usage.output_tokens * ANTHROPIC_OUTPUT_MICROS
  return { text, cost_micros: cost }
}

function tryParseJson<T>(text: string): T | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try { return JSON.parse(cleaned) as T } catch { return null }
}

async function aiContact(
  supabase: SupabaseClient,
  orgId: string,
  fallbackKey: string | undefined,
  q: ContactQuery
): Promise<{ ok: boolean; data?: ContactData; cost_micros: number; reason?: string; error_message?: string; shareable: boolean }> {
  const apiKey = await getAnthropicKey(supabase, orgId, fallbackKey)
  if (!apiKey) return { ok: false, reason: 'not_configured', cost_micros: 0, shareable: true }
  if (!q.email && !(q.first_name && q.last_name)) {
    return { ok: false, reason: 'no_match', cost_micros: 0, shareable: true }
  }

  const inferredDomain = (q.domain ?? q.email?.split('@')[1] ?? '').toLowerCase()
  const pageText = inferredDomain ? await fetchPageText(`https://${inferredDomain}`) : ''

  const prompt = `You are a B2B contact research assistant. Identify the person below and infer their professional context using publicly known information.

Email: ${q.email ?? '(unknown)'}
Name hint: ${[q.first_name, q.last_name].filter(Boolean).join(' ') || '(unknown)'}
Company domain: ${inferredDomain || '(unknown)'}

${pageText ? `Company website content (for context, not necessarily about this person):\n${pageText}` : ''}

Respond with ONLY a JSON object — no markdown, no fences:
{"first_name":string|null,"last_name":string|null,"full_name":string|null,"title":string|null,"linkedin_url":string|null,"city":string|null,"state":string|null,"country":string|null,"company":string|null,"company_domain":string|null,"company_industry":string|null,"company_size":string|null}

If you cannot determine a field with confidence, set it to null. Do not fabricate.`

  const resp = await callAnthropic(apiKey, prompt)
  if (!resp) return { ok: false, reason: 'error', error_message: 'anthropic_call_failed', cost_micros: 0, shareable: true }
  const parsed = tryParseJson<ContactData>(resp.text)
  if (!parsed) return { ok: false, reason: 'error', error_message: 'parse_failure', cost_micros: resp.cost_micros, shareable: true }

  return {
    ok: true,
    cost_micros: resp.cost_micros,
    shareable: true,
    data: { ...parsed, email: q.email ?? null },
  }
}

async function aiCompany(
  supabase: SupabaseClient,
  orgId: string,
  fallbackKey: string | undefined,
  q: CompanyQuery
): Promise<{ ok: boolean; data?: CompanyData; cost_micros: number; reason?: string; error_message?: string; shareable: boolean }> {
  const apiKey = await getAnthropicKey(supabase, orgId, fallbackKey)
  if (!apiKey) return { ok: false, reason: 'not_configured', cost_micros: 0, shareable: true }

  const domain = (q.domain ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()
  if (!domain && !q.name) return { ok: false, reason: 'no_match', cost_micros: 0, shareable: true }
  const pageText = domain ? await fetchPageText(`https://${domain}`) : ''

  const prompt = `You are a B2B company research assistant. Based on the inputs below, extract structured firmographic information.

Domain: ${domain || '(unknown)'}
Name hint: ${q.name || '(unknown)'}

${pageText ? `Website content:\n${pageText}` : 'The website was unreachable. Use your knowledge of this domain or company if you recognise it.'}

Respond with ONLY a JSON object — no markdown, no fences:
{"name":string|null,"domain":string|null,"website":string|null,"description":string|null,"industry":string|null,"size":string|null,"founded_year":number|null,"city":string|null,"state":string|null,"country":string|null,"linkedin_url":string|null}

If you cannot determine a field with confidence, set it to null. Do not fabricate.`

  const resp = await callAnthropic(apiKey, prompt)
  if (!resp) return { ok: false, reason: 'error', error_message: 'anthropic_call_failed', cost_micros: 0, shareable: true }
  const parsed = tryParseJson<CompanyData>(resp.text)
  if (!parsed) return { ok: false, reason: 'error', error_message: 'parse_failure', cost_micros: resp.cost_micros, shareable: true }

  return {
    ok: true,
    cost_micros: resp.cost_micros,
    shareable: true,
    data: parsed,
  }
}

// ── Public waterfall ────────────────────────────────────────────────────────

export interface EnrichmentEnv {
  ANTHROPIC_API_KEY?: string
}

export async function enrichContact(
  supabase: SupabaseClient,
  env: EnrichmentEnv,
  orgId: string,
  query: ContactQuery
): Promise<WaterfallOutcome<ContactData>> {
  const key = normalizeContactKey(query)
  if (!key) {
    return { data: null, resolved_by: null, served_from: 'miss', attempts: [], total_cost_micros: 0, total_latency_ms: 0 }
  }

  const startedAt = Date.now()
  const cached = await readCache<ContactData>(supabase, orgId, 'contact', key)
  if (cached) {
    const outcome: WaterfallOutcome<ContactData> = {
      data: cached.data,
      resolved_by: cached.provider,
      served_from: 'cache',
      attempts: [],
      total_cost_micros: 0,
      total_latency_ms: Date.now() - startedAt,
    }
    await logRequest(supabase, { orgId, targetType: 'contact', targetKey: key, outcome })
    return outcome
  }

  const attempts: AttemptLog[] = []
  let resolved: { provider: string; data: ContactData; cost_micros: number; shareable: boolean } | null = null

  // Apollo first.
  {
    const t0 = Date.now()
    const r = await apolloContact(supabase, orgId, query).catch((e) => ({
      ok: false as const, reason: 'error', error_message: (e as Error).message?.slice(0, 200), cost_micros: 0, shareable: false,
    }))
    attempts.push({ provider: 'apollo', ok: r.ok, reason: r.reason, error_message: r.error_message, latency_ms: Date.now() - t0, cost_micros: r.cost_micros })
    if (r.ok && r.data) resolved = { provider: 'apollo', data: r.data, cost_micros: r.cost_micros, shareable: r.shareable }
  }

  if (!resolved) {
    const t0 = Date.now()
    const r = await hunterContact(supabase, orgId, query).catch((e) => ({
      ok: false as const, reason: 'error', error_message: (e as Error).message?.slice(0, 200), cost_micros: 0, shareable: false,
    }))
    attempts.push({ provider: 'hunter', ok: r.ok, reason: r.reason, error_message: r.error_message, latency_ms: Date.now() - t0, cost_micros: r.cost_micros })
    if (r.ok && r.data) resolved = { provider: 'hunter', data: r.data, cost_micros: r.cost_micros, shareable: r.shareable }
  }

  if (!resolved) {
    const t0 = Date.now()
    const r = await aiContact(supabase, orgId, env.ANTHROPIC_API_KEY, query).catch((e) => ({
      ok: false as const, reason: 'error', error_message: (e as Error).message?.slice(0, 200), cost_micros: 0, shareable: true,
    }))
    attempts.push({ provider: 'ai_research', ok: r.ok, reason: r.reason, error_message: r.error_message, latency_ms: Date.now() - t0, cost_micros: r.cost_micros })
    if (r.ok && r.data) resolved = { provider: 'ai_research', data: r.data, cost_micros: r.cost_micros, shareable: r.shareable }
  }

  if (resolved) {
    const ttl =
      resolved.provider === 'apollo' ? CACHE_TTL_SECONDS.apollo_contact :
      resolved.provider === 'hunter' ? CACHE_TTL_SECONDS.hunter_contact :
      CACHE_TTL_SECONDS.ai_contact
    await writeCache(supabase, {
      orgId,
      targetType: 'contact',
      targetKey: key,
      provider: resolved.provider,
      data: resolved.data,
      cost_micros: resolved.cost_micros,
      shareable: resolved.shareable,
      ttl_seconds: ttl,
    })
  }

  const outcome: WaterfallOutcome<ContactData> = {
    data: resolved?.data ?? null,
    resolved_by: resolved?.provider ?? null,
    served_from: resolved ? 'provider' : 'miss',
    attempts,
    total_cost_micros: attempts.reduce((s, a) => s + a.cost_micros, 0),
    total_latency_ms: Date.now() - startedAt,
  }
  await logRequest(supabase, { orgId, targetType: 'contact', targetKey: key, outcome })
  return outcome
}

// ── Bulk contact enrichment ─────────────────────────────────────────────────

export interface BulkContactItem {
  contact_id: string
  status: 'resolved' | 'cached' | 'missed' | 'error'
  resolved_by: string | null
  cost_micros: number
  error?: string
}

export interface BulkContactOutcome {
  processed: number
  resolved: number
  cached: number
  missed: number
  errored: number
  total_cost_micros: number
  by_provider: Record<string, number>
  per_contact: BulkContactItem[]
}

// Concurrency cap: Apollo and Hunter both rate-limit per-IP. 5 in flight is
// well under their published limits and keeps total wall-time reasonable on a
// 200-contact batch (cache hits are sub-100ms; cold lookups average ~2s).
const BULK_CONCURRENCY = 5

async function runWithConcurrency<T, U>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<U>
): Promise<U[]> {
  const results: U[] = new Array(items.length)
  let cursor = 0
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i]!, i)
    }
  })
  await Promise.all(workers)
  return results
}

export async function bulkEnrichContacts(
  supabase: SupabaseClient,
  env: EnrichmentEnv,
  orgId: string,
  contactIds: string[]
): Promise<BulkContactOutcome> {
  // Fetch the contacts we're actually authorised to enrich. RLS would also
  // gate this but we're on the service role here, so the org_id filter is
  // load-bearing — never skip it.
  const { data: contacts, error } = await supabase
    .from('contacts')
    .select('id, email, first_name, last_name, company:companies(domain)')
    .eq('org_id', orgId)
    .in('id', contactIds)
  if (error) throw new Error(`Failed to load contacts: ${error.message}`)

  const found = contacts ?? []
  const foundIds = new Set(found.map((c) => c.id as string))

  const perContact: BulkContactItem[] = []
  const byProvider: Record<string, number> = {}

  // Mark any IDs the caller asked for that we didn't find — likely cross-org
  // or deleted. Reported as errors so the caller's reconciliation is honest.
  for (const id of contactIds) {
    if (!foundIds.has(id)) {
      perContact.push({
        contact_id: id,
        status: 'error',
        resolved_by: null,
        cost_micros: 0,
        error: 'contact not found in org',
      })
    }
  }

  const enrichResults = await runWithConcurrency(found, BULK_CONCURRENCY, async (c) => {
    const company = (Array.isArray(c.company) ? c.company[0] : c.company) as { domain?: string | null } | null
    const domain = company?.domain ?? (c.email ? (c.email as string).split('@')[1] : null)
    try {
      const outcome = await enrichContact(supabase, env, orgId, {
        email: (c.email as string | null) ?? undefined,
        first_name: (c.first_name as string | null) ?? undefined,
        last_name: (c.last_name as string | null) ?? undefined,
        domain: domain ?? undefined,
      })
      // Additively merge resolved fields onto the contact, only-empty.
      if (outcome.data) {
        const { data: existing } = await supabase
          .from('contacts')
          .select('*')
          .eq('id', c.id as string)
          .eq('org_id', orgId)
          .single()
        if (existing) {
          const updates: Record<string, unknown> = {}
          const set = (col: string, value: unknown) => {
            if (value == null) return
            const e = existing as Record<string, unknown>
            if (e[col] != null && e[col] !== '') return
            updates[col] = value
          }
          const d = outcome.data
          set('first_name', d.first_name)
          set('last_name', d.last_name)
          set('title', d.title)
          set('phone', d.phone)
          set('linkedin_url', d.linkedin_url)
          set('city', d.city)
          set('state', d.state)
          set('country', d.country)
          if (Object.keys(updates).length > 0) {
            await supabase.from('contacts').update(updates).eq('id', c.id as string)
          }
        }
      }
      return {
        contact_id: c.id as string,
        outcome,
      }
    } catch (err) {
      return {
        contact_id: c.id as string,
        outcome: null as null,
        error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      }
    }
  })

  let resolved = 0, cached = 0, missed = 0, errored = perContact.length
  let totalCost = 0
  for (const r of enrichResults) {
    if (r.outcome === null || (r as { error?: string }).error) {
      perContact.push({
        contact_id: r.contact_id,
        status: 'error',
        resolved_by: null,
        cost_micros: 0,
        error: (r as { error?: string }).error,
      })
      errored++
      continue
    }
    const o = r.outcome
    totalCost += o.total_cost_micros
    if (o.served_from === 'cache') {
      cached++
      perContact.push({
        contact_id: r.contact_id,
        status: 'cached',
        resolved_by: o.resolved_by,
        cost_micros: 0,
      })
      if (o.resolved_by) byProvider[o.resolved_by] = (byProvider[o.resolved_by] ?? 0) + 1
    } else if (o.served_from === 'provider') {
      resolved++
      perContact.push({
        contact_id: r.contact_id,
        status: 'resolved',
        resolved_by: o.resolved_by,
        cost_micros: o.total_cost_micros,
      })
      if (o.resolved_by) byProvider[o.resolved_by] = (byProvider[o.resolved_by] ?? 0) + 1
    } else {
      missed++
      perContact.push({
        contact_id: r.contact_id,
        status: 'missed',
        resolved_by: null,
        cost_micros: o.total_cost_micros,
      })
    }
  }

  return {
    processed: contactIds.length,
    resolved,
    cached,
    missed,
    errored,
    total_cost_micros: totalCost,
    by_provider: byProvider,
    per_contact: perContact,
  }
}

export async function enrichCompany(
  supabase: SupabaseClient,
  env: EnrichmentEnv,
  orgId: string,
  query: CompanyQuery
): Promise<WaterfallOutcome<CompanyData>> {
  const key = normalizeCompanyKey(query)
  if (!key) {
    return { data: null, resolved_by: null, served_from: 'miss', attempts: [], total_cost_micros: 0, total_latency_ms: 0 }
  }

  const startedAt = Date.now()
  const cached = await readCache<CompanyData>(supabase, orgId, 'company', key)
  if (cached) {
    const outcome: WaterfallOutcome<CompanyData> = {
      data: cached.data,
      resolved_by: cached.provider,
      served_from: 'cache',
      attempts: [],
      total_cost_micros: 0,
      total_latency_ms: Date.now() - startedAt,
    }
    await logRequest(supabase, { orgId, targetType: 'company', targetKey: key, outcome })
    return outcome
  }

  const attempts: AttemptLog[] = []
  let resolved: { provider: string; data: CompanyData; cost_micros: number; shareable: boolean } | null = null

  {
    const t0 = Date.now()
    const r = await apolloCompany(supabase, orgId, query).catch((e) => ({
      ok: false as const, reason: 'error', error_message: (e as Error).message?.slice(0, 200), cost_micros: 0, shareable: false,
    }))
    attempts.push({ provider: 'apollo', ok: r.ok, reason: r.reason, error_message: r.error_message, latency_ms: Date.now() - t0, cost_micros: r.cost_micros })
    if (r.ok && r.data) resolved = { provider: 'apollo', data: r.data, cost_micros: r.cost_micros, shareable: r.shareable }
  }

  if (!resolved) {
    const t0 = Date.now()
    const r = await aiCompany(supabase, orgId, env.ANTHROPIC_API_KEY, query).catch((e) => ({
      ok: false as const, reason: 'error', error_message: (e as Error).message?.slice(0, 200), cost_micros: 0, shareable: true,
    }))
    attempts.push({ provider: 'ai_research', ok: r.ok, reason: r.reason, error_message: r.error_message, latency_ms: Date.now() - t0, cost_micros: r.cost_micros })
    if (r.ok && r.data) resolved = { provider: 'ai_research', data: r.data, cost_micros: r.cost_micros, shareable: r.shareable }
  }

  if (resolved) {
    await writeCache(supabase, {
      orgId,
      targetType: 'company',
      targetKey: key,
      provider: resolved.provider,
      data: resolved.data,
      cost_micros: resolved.cost_micros,
      shareable: resolved.shareable,
      ttl_seconds: resolved.provider === 'apollo' ? CACHE_TTL_SECONDS.apollo_company : CACHE_TTL_SECONDS.ai_company,
    })
  }

  const outcome: WaterfallOutcome<CompanyData> = {
    data: resolved?.data ?? null,
    resolved_by: resolved?.provider ?? null,
    served_from: resolved ? 'provider' : 'miss',
    attempts,
    total_cost_micros: attempts.reduce((s, a) => s + a.cost_micros, 0),
    total_latency_ms: Date.now() - startedAt,
  }
  await logRequest(supabase, { orgId, targetType: 'company', targetKey: key, outcome })
  return outcome
}
