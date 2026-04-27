import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { createSupabaseClient, type Env } from './supabase.js'
import { authenticateRequest, AuthError, requireScope, type ApiKeyRecord } from './auth.js'
import {
  createSequence,
  listSequences,
  getSequence,
  updateSequence,
  deleteSequence,
  unenrollContact,
} from './tools/sequences.js'
import {
  listContacts,
  getContact,
  createContact,
  bulkCreateContacts,
  enrollContactInSequence,
} from './tools/contacts.js'
import { listCandidates, updateCandidateStatus, FEEDBACK_TAGS } from './tools/candidates.js'
import { getAgentConfig, updateAgentConfig, getAgentOverview, runAgentHunt, approveAgentCandidate } from './tools/agent.js'
import {
  listDeals,
  getDeal,
  createDeal,
  updateDeal,
  moveDealStage,
  closeDeal,
} from './tools/deals.js'
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
} from './tools/templates.js'
import {
  listActivities,
  logActivity,
  createTask,
  completeTask,
} from './tools/activities.js'
import {
  listCompanies,
  getCompany,
  createCompany,
  updateCompany,
} from './tools/companies.js'
import { enrichContact, enrichCompany, bulkEnrichContacts } from './tools/enrichment.js'
import { orgOverview, dealBrief, contactBrief, companyBrief } from './resources.js'
import { handleOAuth } from './oauth.js'

type McpEnv = Env & {
  ENVIRONMENT?: string
  ANTHROPIC_API_KEY?: string
  // Required by run_agent_hunt — points at the Anchorr Next.js app and
  // the cron secret used to authorize server-to-server hunt triggers.
  APP_URL?: string
  CRON_SECRET?: string
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

// ── Audit logging ───────────────────────────────────────────────────────────

function logAuditEvent(
  env: McpEnv,
  apiKey: ApiKeyRecord,
  toolName: string,
  params: unknown,
  success: boolean,
  errorMessage: string | null,
  durationMs: number
) {
  const supabase = createSupabaseClient(env)
  supabase
    .from('mcp_audit_log')
    .insert({
      api_key_id: apiKey.id,
      org_id: apiKey.org_id,
      tool_name: toolName,
      params: JSON.parse(JSON.stringify(params ?? {})),
      success,
      error_message: errorMessage?.slice(0, 500) ?? null,
      duration_ms: durationMs,
      called_at: new Date().toISOString(),
    })
    .then(() => {})
}

// ── Server factory ──────────────────────────────────────────────────────────

function createServer(env: McpEnv, apiKey: ApiKeyRecord | null): McpServer {
  const server = new McpServer({ name: 'anchorr-mcp', version: '0.1.0' })

  const getCtx = () => {
    if (!apiKey) {
      throw new Error(
        'Authentication required. Provide your API key as `Authorization: Bearer ancr_live_...`.'
      )
    }
    return { supabase: createSupabaseClient(env), orgId: apiKey.org_id, key: apiKey }
  }

  const tool = <Schema extends z.ZodRawShape>(
    name: string,
    description: string,
    scope: string,
    schema: Schema,
    handler: (args: z.infer<z.ZodObject<Schema>>, ctx: ReturnType<typeof getCtx>) => Promise<unknown>
  ) => {
    server.tool(name, description, schema, async (args) => {
      const start = Date.now()
      let ctx: ReturnType<typeof getCtx>
      try {
        ctx = getCtx()
      } catch (err) {
        return {
          content: [{ type: 'text', text: (err as Error).message }],
          isError: true,
        }
      }
      try {
        requireScope(ctx.key, scope)
        const result = await handler(args, ctx)
        logAuditEvent(env, ctx.key, name, args, true, null, Date.now() - start)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logAuditEvent(env, ctx.key, name, args, false, msg, Date.now() - start)
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
      }
    })
  }

  // ── Sequences ──────────────────────────────────────────────────────────
  tool(
    'list_sequences',
    'List all sequences in the organization.',
    'sequences:read',
    {},
    async (_args, { supabase, orgId }) => listSequences(supabase, orgId)
  )

  tool(
    'get_sequence',
    'Get a sequence by id with all its steps.',
    'sequences:read',
    { id: z.string().uuid() },
    async ({ id }, { supabase, orgId }) => getSequence(supabase, orgId, id)
  )

  tool(
    'create_sequence',
    'Create a sequence with steps. Each step is email | task | wait. wait_days means "wait this many days before running this step".',
    'sequences:write',
    {
      name: z.string().min(1),
      description: z.string().optional(),
      status: z.enum(['draft', 'active', 'paused']).optional(),
      steps: z
        .array(
          z.object({
            type: z.enum(['email', 'task', 'wait']),
            subject: z.string().optional(),
            body: z.string().optional(),
            wait_days: z.number().int().min(0).max(365).optional(),
          })
        )
        .min(1),
    },
    async (args, { supabase, orgId }) => createSequence(supabase, orgId, args)
  )

  tool(
    'update_sequence',
    'Update a sequence. Top-level fields (name, description, status) are patched. If `steps` is provided, ALL existing steps are replaced with the new set (same semantics as the UI editor).',
    'sequences:write',
    {
      id: z.string().uuid(),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      status: z.enum(['draft', 'active', 'paused']).optional(),
      steps: z
        .array(
          z.object({
            type: z.enum(['email', 'task', 'wait']),
            subject: z.string().optional(),
            body: z.string().optional(),
            wait_days: z.number().int().min(0).max(365).optional(),
          })
        )
        .optional(),
    },
    async (args, { supabase, orgId }) => updateSequence(supabase, orgId, args)
  )

  tool(
    'delete_sequence',
    'Permanently delete a sequence and all its steps. Refuses if the sequence has active enrollments — pause it and unenroll first if you really want it gone. Cascade removes sequence_steps and sequence_enrollments.',
    'sequences:write',
    { id: z.string().uuid() },
    async ({ id }, { supabase, orgId }) => deleteSequence(supabase, orgId, id)
  )

  tool(
    'unenroll_contact',
    'Stop a single contact\'s active enrollment in a sequence WITHOUT pausing the sequence for everyone else. Use when a test enrollment slipped through, a deal closed mid-cadence, or an unsubscribe needs to take effect immediately. Sets the enrollment to status=completed (terminal) and clears next_action_at so the next cron tick can\'t fire a stale step. Provide enrollment_id directly OR sequence_id + (contact_id or contact_email).',
    'sequences:write',
    {
      enrollment_id: z.string().uuid().optional()
        .describe('Direct enrollment id — preferred, unambiguous.'),
      sequence_id: z.string().uuid().optional()
        .describe('Sequence id — required if enrollment_id is not provided.'),
      contact_id: z.string().uuid().optional()
        .describe('Contact id — required with sequence_id when enrollment_id is not provided (use this OR contact_email).'),
      contact_email: z.string().email().optional()
        .describe('Contact email — alternative to contact_id when paired with sequence_id.'),
    },
    async (args, { supabase, orgId }) => unenrollContact(supabase, orgId, args)
  )

  // ── Contacts ───────────────────────────────────────────────────────────
  tool(
    'list_contacts',
    'List contacts. Filter by status (lead|prospect|customer|churned) or company_id.',
    'contacts:read',
    {
      status: z.string().optional(),
      company_id: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (args, { supabase, orgId }) => listContacts(supabase, orgId, args)
  )

  tool(
    'get_contact',
    'Get a contact with company and custom_fields.',
    'contacts:read',
    { id: z.string().uuid() },
    async ({ id }, { supabase, orgId }) => getContact(supabase, orgId, id)
  )

  tool(
    'create_contact',
    'Create a contact. If company_name is given, the company is created or linked automatically.',
    'contacts:write',
    {
      first_name: z.string().min(1),
      last_name: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      title: z.string().optional(),
      status: z.enum(['lead', 'prospect', 'customer', 'churned']).optional(),
      source: z.string().optional(),
      tags: z.array(z.string()).optional(),
      company_name: z.string().optional(),
    },
    async (args, { supabase, orgId }) => createContact(supabase, orgId, args)
  )

  tool(
    'bulk_create_contacts',
    'Bulk-import up to 200 contacts in a single call. Resolves company_name → company_id in batch (creating any missing companies once), dedupes against existing emails in the org by default, and reports per-row errors instead of failing the whole batch. Use this for HubSpot/CSV/CRM migrations rather than calling create_contact in a loop.',
    'contacts:write',
    {
      contacts: z
        .array(
          z.object({
            first_name: z.string().min(1),
            last_name: z.string().optional(),
            email: z.string().email().optional(),
            phone: z.string().optional(),
            title: z.string().optional(),
            status: z.enum(['lead', 'prospect', 'customer', 'churned']).optional(),
            source: z.string().optional(),
            tags: z.array(z.string()).optional(),
            company_name: z.string().optional(),
          })
        )
        .min(1)
        .max(200),
      dedupe_by_email: z.boolean().optional(),
      default_source: z.string().optional(),
    },
    async (args, { supabase, orgId }) => bulkCreateContacts(supabase, orgId, args)
  )

  tool(
    'enroll_contact_in_sequence',
    'Enroll a contact in a sequence.',
    'sequences:write',
    { contact_id: z.string().uuid(), sequence_id: z.string().uuid() },
    async (args, { supabase, orgId }) => enrollContactInSequence(supabase, orgId, args)
  )

  // ── Agent candidates ───────────────────────────────────────────────────
  tool(
    'list_agent_candidates',
    'List scored prospect candidates. Default status=pending_review.',
    'agent:read',
    {
      status: z.enum(['pending_review', 'enrolled', 'rejected', 'skipped', 'all']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (args, { supabase, orgId }) =>
      listCandidates(supabase, orgId, {
        status: args.status === 'all' ? undefined : args.status,
        allStatuses: args.status === 'all',
        limit: args.limit,
      })
  )

  tool(
    'reject_agent_candidate',
    `Reject a pending candidate. Pass feedback_tags from the canonical vocabulary so the daily distill cron can turn the rejection into rubric corrections — without tags the rejection is silent for learning. Allowed tags: ${FEEDBACK_TAGS.join(', ')}. Use as many as apply (e.g. ["wrong_industry","score_too_high"]).`,
    'agent:write',
    {
      candidate_id: z.string().uuid(),
      feedback_tags: z.array(z.enum(FEEDBACK_TAGS)).optional()
        .describe('Structured corrections fed into the next learning distillation.'),
      reason: z.string().max(500).optional()
        .describe('Optional free-text note (kept on agent_candidates.notes).'),
    },
    async (args, { supabase, orgId }) =>
      updateCandidateStatus(supabase, orgId, { ...args, action: 'reject' })
  )

  tool(
    'approve_agent_candidate',
    `Approve a pending candidate. Triggers the full enrollment flow: status → approved, contact created (with company), enrichment waterfall, sequence enrollment. Pass feedback_tags (especially good_email_draft) so the distill cron learns which drafts work. Allowed tags: ${FEEDBACK_TAGS.join(', ')}. Returns { enrolled: true } on success — fails if no sequence is configured in agent_config.`,
    'agent:write',
    {
      candidate_id: z.string().uuid(),
      feedback_tags: z.array(z.enum(FEEDBACK_TAGS)).optional()
        .describe('Structured signal for the distillation cron — use good_email_draft when the agent nailed it.'),
      reason: z.string().max(500).optional()
        .describe('Optional free-text note (kept on agent_candidates.notes).'),
    },
    async (args, { orgId }) => {
      if (!env.APP_URL || !env.CRON_SECRET) {
        throw new Error(
          'approve_agent_candidate is unavailable — the MCP server is missing APP_URL and/or CRON_SECRET. Set them with `wrangler secret put APP_URL` and `wrangler secret put CRON_SECRET`.'
        )
      }
      return approveAgentCandidate(
        env.APP_URL,
        env.CRON_SECRET,
        orgId,
        args.candidate_id,
        args.feedback_tags ?? [],
        args.reason
      )
    }
  )

  // ── Agent config + overview ────────────────────────────────────────────
  tool(
    'get_agent_config',
    'Read the agent configuration (ICP, limits, sequence, safety flags).',
    'agent:read',
    {},
    async (_args, { supabase, orgId }) => getAgentConfig(supabase, orgId)
  )

  tool(
    'update_agent_config',
    'Update the agent configuration. Only editable fields are applied.',
    'agent:write',
    {
      enabled: z.boolean().optional(),
      target_titles: z.array(z.string()).optional(),
      target_industries: z.array(z.string()).optional(),
      target_company_sizes: z.array(z.string()).optional(),
      target_locations: z.array(z.string()).optional(),
      daily_prospect_limit: z.number().int().min(1).max(100).optional(),
      daily_email_limit: z.number().int().min(1).max(100).optional(),
      sequence_id: z.string().uuid().nullable().optional(),
      booking_link_id: z.string().uuid().nullable().optional(),
      owner_directives: z.string().optional(),
      personality: z.string().optional(),
      context_notes: z.string().optional(),
      product_description: z.string().optional(),
      value_props: z.array(z.string()).optional(),
      qualifying_signals: z.array(z.string()).optional(),
      disqualifying_signals: z.array(z.string()).optional(),
      review_queue_enabled: z.boolean().optional(),
      minimum_score_to_enroll: z.number().int().min(1).max(10).optional(),
    },
    async (args, { supabase, orgId }) => updateAgentConfig(supabase, orgId, args)
  )

  tool(
    'get_agent_overview',
    "Today's agent snapshot: prospects_today, emails_today, pending_candidates, replies_today, last_run_at.",
    'agent:read',
    {},
    async (_args, { supabase, orgId }) => getAgentOverview(supabase, orgId)
  )

  tool(
    'run_agent_hunt',
    'Trigger an immediate hunt run for the org (Apollo search → score → enroll/queue). Returns the same shape as the daily cron: { candidates_added, candidates_scored, auto_enrolled, errors, skipped_reason? }. Subject to daily_prospect_limit — if prospects_today already hit the cap, returns skipped_reason: "daily cap reached".',
    'agent:write',
    {},
    async (_args, { orgId }) => {
      if (!env.APP_URL || !env.CRON_SECRET) {
        throw new Error(
          'run_agent_hunt is unavailable — the MCP server is missing APP_URL and/or CRON_SECRET. Set them with `wrangler secret put APP_URL` and `wrangler secret put CRON_SECRET`.'
        )
      }
      return runAgentHunt(env.APP_URL, env.CRON_SECRET, orgId)
    }
  )

  // ── Companies ──────────────────────────────────────────────────────────
  tool(
    'list_companies',
    'List companies. Optional search (ilike on name) and industry filter.',
    'companies:read',
    {
      search: z.string().optional(),
      industry: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (args, { supabase, orgId }) => listCompanies(supabase, orgId, args)
  )

  tool(
    'get_company',
    'Get a company with its contacts.',
    'companies:read',
    { id: z.string().uuid() },
    async ({ id }, { supabase, orgId }) => getCompany(supabase, orgId, id)
  )

  tool(
    'create_company',
    'Create a company record.',
    'companies:write',
    {
      name: z.string().min(1),
      website: z.string().optional(),
      domain: z.string().optional(),
      industry: z.string().optional(),
      size: z.string().optional(),
      address: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      country: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async (args, { supabase, orgId }) => createCompany(supabase, orgId, args)
  )

  tool(
    'update_company',
    'Update a company — only supplied fields are changed.',
    'companies:write',
    {
      id: z.string().uuid(),
      name: z.string().optional(),
      website: z.string().optional(),
      domain: z.string().optional(),
      industry: z.string().optional(),
      size: z.string().optional(),
      address: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      country: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async (args, { supabase, orgId }) => updateCompany(supabase, orgId, args)
  )

  // ── Deals ──────────────────────────────────────────────────────────────
  tool(
    'list_deals',
    'List deals. Filter by status (open|won|lost), contact, company, or stage.',
    'deals:read',
    {
      status: z.enum(['open', 'won', 'lost']).optional(),
      contact_id: z.string().uuid().optional(),
      company_id: z.string().uuid().optional(),
      stage_id: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (args, { supabase, orgId }) => listDeals(supabase, orgId, args)
  )

  tool(
    'get_deal',
    'Get a deal with its stage, contact, and company.',
    'deals:read',
    { id: z.string().uuid() },
    async ({ id }, { supabase, orgId }) => getDeal(supabase, orgId, id)
  )

  tool(
    'create_deal',
    'Create a deal. If stage_id is omitted, uses the first non-won/lost stage of the default pipeline.',
    'deals:write',
    {
      title: z.string().min(1),
      value: z.number().optional(),
      currency: z.string().optional(),
      pipeline_id: z.string().uuid().optional(),
      stage_id: z.string().uuid().optional(),
      contact_id: z.string().uuid().optional(),
      company_id: z.string().uuid().optional(),
      expected_close_date: z.string().optional(),
      probability: z.number().min(0).max(100).optional(),
      tags: z.array(z.string()).optional(),
    },
    async (args, { supabase, orgId }) => createDeal(supabase, orgId, args)
  )

  tool(
    'update_deal',
    'Update deal fields — title, value, tags, stage_id, etc.',
    'deals:write',
    {
      id: z.string().uuid(),
      title: z.string().optional(),
      value: z.number().optional(),
      currency: z.string().optional(),
      expected_close_date: z.string().nullable().optional(),
      probability: z.number().min(0).max(100).nullable().optional(),
      tags: z.array(z.string()).optional(),
      stage_id: z.string().uuid().optional(),
      contact_id: z.string().uuid().nullable().optional(),
      company_id: z.string().uuid().nullable().optional(),
    },
    async (args, { supabase, orgId }) => updateDeal(supabase, orgId, args)
  )

  tool(
    'move_deal_to_stage',
    'Move a deal to a new stage — by stage_id or exact stage_name.',
    'deals:write',
    {
      deal_id: z.string().uuid(),
      stage_id: z.string().uuid().optional(),
      stage_name: z.string().optional(),
    },
    async (args, { supabase, orgId }) => moveDealStage(supabase, orgId, args)
  )

  tool(
    'close_deal',
    'Close a deal as won or lost. Moves it to the pipeline\'s won/lost stage and stamps closed_at.',
    'deals:write',
    {
      deal_id: z.string().uuid(),
      outcome: z.enum(['won', 'lost']),
      reason: z.string().optional(),
    },
    async (args, { supabase, orgId }) => closeDeal(supabase, orgId, args)
  )

  // ── Templates ──────────────────────────────────────────────────────────
  tool(
    'list_templates',
    'List email templates. Optional category filter.',
    'templates:read',
    {
      category: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (args, { supabase, orgId }) => listTemplates(supabase, orgId, args)
  )

  tool(
    'get_template',
    'Get a template by id (includes subject and body).',
    'templates:read',
    { id: z.string().uuid() },
    async ({ id }, { supabase, orgId }) => getTemplate(supabase, orgId, id)
  )

  tool(
    'create_template',
    'Create a new email template.',
    'templates:write',
    {
      name: z.string().min(1),
      subject: z.string().min(1),
      body: z.string().min(1),
      category: z.string().optional(),
    },
    async (args, { supabase, orgId }) => createTemplate(supabase, orgId, args)
  )

  tool(
    'update_template',
    'Update a template.',
    'templates:write',
    {
      id: z.string().uuid(),
      name: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      category: z.string().optional(),
    },
    async (args, { supabase, orgId }) => updateTemplate(supabase, orgId, args)
  )

  // ── Activities ─────────────────────────────────────────────────────────
  tool(
    'list_activities',
    'List activities against a contact, company, or deal. Filter by type (call|email|meeting|note|task).',
    'activities:read',
    {
      contact_id: z.string().uuid().optional(),
      company_id: z.string().uuid().optional(),
      deal_id: z.string().uuid().optional(),
      type: z.enum(['call', 'email', 'meeting', 'note', 'task']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (args, { supabase, orgId }) => listActivities(supabase, orgId, args)
  )

  tool(
    'log_activity',
    'Log a historic activity (call/email/meeting/note). For tasks, use create_task instead. Stamps completed_at now by default.',
    'activities:write',
    {
      type: z.enum(['call', 'email', 'meeting', 'note']),
      subject: z.string().min(1),
      body: z.string().optional(),
      contact_id: z.string().uuid().optional(),
      company_id: z.string().uuid().optional(),
      deal_id: z.string().uuid().optional(),
      completed_at: z.string().optional(),
    },
    async (args, { supabase, orgId }) => logActivity(supabase, orgId, args)
  )

  tool(
    'create_task',
    'Create a task (open activity with due date).',
    'activities:write',
    {
      subject: z.string().min(1),
      body: z.string().optional(),
      due_at: z.string().optional(),
      contact_id: z.string().uuid().optional(),
      company_id: z.string().uuid().optional(),
      deal_id: z.string().uuid().optional(),
    },
    async (args, { supabase, orgId }) => createTask(supabase, orgId, args)
  )

  tool(
    'complete_task',
    'Mark a task as complete — stamps completed_at now.',
    'activities:write',
    { task_id: z.string().uuid() },
    async (args, { supabase, orgId }) => completeTask(supabase, orgId, args)
  )

  // ── Enrichment ─────────────────────────────────────────────────────────
  // Runs the same waterfall the web app uses (Apollo → AI research) and
  // shares the cache via Supabase tables. Cache hits are free and warm both
  // surfaces — every Claude/Cursor agent that enriches via Anchorr feeds the
  // dataset the web product reads from.
  tool(
    'enrich_contact',
    'Resolve a contact via the enrichment waterfall (Apollo first if configured, then AI research). Provide an email, OR all of (first_name, last_name, domain). Returns the resolved data plus which provider answered, whether it came from cache, the per-attempt cost in micro-dollars, and total latency. Cached results are returned instantly with cost=0; fresh lookups are cached for 7 days (Apollo) or 14 days (AI). Pass a contact_id to additively merge the result onto that record (only empty fields are filled — your edits are never overwritten).',
    'enrichment:write',
    {
      email: z.string().email().optional(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      domain: z.string().optional(),
      contact_id: z.string().uuid().optional(),
    },
    async (args, { supabase, orgId }) => {
      if (!args.email && !(args.first_name && args.last_name && args.domain)) {
        throw new Error('Provide an email, or all of (first_name, last_name, domain).')
      }
      const outcome = await enrichContact(supabase, env, orgId, args)
      if (args.contact_id && outcome.data) {
        const { data: existing } = await supabase
          .from('contacts')
          .select('*')
          .eq('id', args.contact_id)
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
            await supabase.from('contacts').update(updates).eq('id', args.contact_id)
          }
        }
      }
      return outcome
    }
  )

  tool(
    'bulk_enrich_contacts',
    'Enrich up to 200 existing contacts in a single call. Pass an array of contact IDs from the org. Each contact runs through the same waterfall (Apollo → Hunter → AI research) with concurrency capped at 5 to stay under provider rate limits, and resolved fields are additively merged onto each record (never overwriting your edits). Returns aggregate counts (resolved / cached / missed / errored), total cost in micro-dollars, breakdown by provider, and per-contact outcomes. This is the "feed me a list of fresh leads, give me back enriched records ready for sequence enrollment" workflow — pair with create_contact / bulk_create_contacts for full agent-driven prospecting loops.',
    'enrichment:write',
    {
      contact_ids: z.array(z.string().uuid()).min(1).max(200),
    },
    async ({ contact_ids }, { supabase, orgId }) =>
      bulkEnrichContacts(supabase, env, orgId, contact_ids)
  )

  tool(
    'enrich_company',
    'Resolve a company via the enrichment waterfall (Apollo first if configured, then AI research over the public web). Provide a domain or a name. Returns the resolved firmographic data plus which provider answered, whether it came from cache, the per-attempt cost in micro-dollars, and total latency. Cached results are free; fresh lookups are cached for 14 days (Apollo) or 30 days (AI). Pass a company_id to additively merge the result onto that record (only empty fields are filled).',
    'enrichment:write',
    {
      domain: z.string().optional(),
      name: z.string().optional(),
      company_id: z.string().uuid().optional(),
    },
    async (args, { supabase, orgId }) => {
      if (!args.domain && !args.name) {
        throw new Error('Provide a domain or company name.')
      }
      const outcome = await enrichCompany(supabase, env, orgId, args)
      if (args.company_id && outcome.data) {
        const { data: existing } = await supabase
          .from('companies')
          .select('*')
          .eq('id', args.company_id)
          .eq('org_id', orgId)
          .single()
        if (existing) {
          const updates: Record<string, unknown> = { enriched_at: new Date().toISOString() }
          const set = (col: string, value: unknown) => {
            if (value == null) return
            const e = existing as Record<string, unknown>
            if (e[col] != null && e[col] !== '') return
            updates[col] = value
          }
          const d = outcome.data
          set('name', d.name)
          set('domain', d.domain)
          set('website', d.website)
          set('industry', d.industry)
          set('description', d.description)
          set('size', d.size)
          set('city', d.city)
          set('state', d.state)
          set('country', d.country)
          set('linkedin_url', d.linkedin_url)
          set('logo_url', d.logo_url)
          set('phone', d.phone)
          await supabase.from('companies').update(updates).eq('id', args.company_id)
        }
      }
      return outcome
    }
  )

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Resources — composite reads optimised for "prep-for-meeting" / "brief me"
  // style prompts. One call replaces many tool chains.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const resourceJson = (uri: string, data: unknown) => ({
    contents: [
      {
        uri,
        mimeType: 'application/json' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  })

  server.resource(
    'org-overview',
    'anchorr://org/overview',
    { description: 'Organization snapshot: pipeline, contacts, agent, tasks' },
    async (uri) => {
      const { supabase, orgId } = getCtx()
      requireScope(apiKey as ApiKeyRecord, 'deals:read') // covers pipeline; add separate reports:read later
      return resourceJson(uri.href, await orgOverview(supabase, orgId))
    }
  )

  server.resource(
    'deal-brief',
    'anchorr://deal/{id}/brief',
    { description: 'Deal + contact + company + recent activities + research in one blob' },
    async (uri) => {
      const { supabase, orgId } = getCtx()
      requireScope(apiKey as ApiKeyRecord, 'deals:read')
      const id = uri.pathname.split('/').filter(Boolean)[1] // /deal/{id}/brief → parts = ["deal", id, "brief"]
      if (!id) throw new Error('Deal id required in URI')
      return resourceJson(uri.href, await dealBrief(supabase, orgId, id))
    }
  )

  server.resource(
    'contact-brief',
    'anchorr://contact/{id}/brief',
    { description: 'Contact + company + activities + deals + sequence enrollments + research' },
    async (uri) => {
      const { supabase, orgId } = getCtx()
      requireScope(apiKey as ApiKeyRecord, 'contacts:read')
      const id = uri.pathname.split('/').filter(Boolean)[1]
      if (!id) throw new Error('Contact id required in URI')
      return resourceJson(uri.href, await contactBrief(supabase, orgId, id))
    }
  )

  server.resource(
    'company-brief',
    'anchorr://company/{id}/brief',
    { description: 'Company + contacts + deals + activities + research' },
    async (uri) => {
      const { supabase, orgId } = getCtx()
      requireScope(apiKey as ApiKeyRecord, 'companies:read')
      const id = uri.pathname.split('/').filter(Boolean)[1]
      if (!id) throw new Error('Company id required in URI')
      return resourceJson(uri.href, await companyBrief(supabase, orgId, id))
    }
  )

  return server
}

// ── Worker entry ────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: McpEnv): Promise<Response> {
    const url = new URL(req.url)

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS })
    }

    if (url.pathname === '/health') {
      return withCors(Response.json({ status: 'ok', service: 'anchorr-mcp', version: '0.1.0' }))
    }

    // OAuth 2.0 endpoints (Claude.ai web flow)
    const oauthResponse = await handleOAuth(req, env, withCors)
    if (oauthResponse) return oauthResponse

    if (url.pathname === '/') {
      return withCors(
        Response.json({
          service: 'Anchorr MCP Server',
          version: '0.1.0',
          transport: { endpoint: '/mcp', method: 'POST' },
          auth: 'Bearer token in Authorization header (ancr_live_...)',
          scopes: [
            'sequences:read', 'sequences:write',
            'contacts:read', 'contacts:write',
            'companies:read', 'companies:write',
            'deals:read', 'deals:write',
            'templates:read', 'templates:write',
            'activities:read', 'activities:write',
            'agent:read', 'agent:write',
          ],
        })
      )
    }

    if (url.pathname === '/mcp') {
      let apiKey: ApiKeyRecord | null = null
      try {
        apiKey = await authenticateRequest(req, createSupabaseClient(env))
      } catch (err) {
        if (!(err instanceof AuthError)) {
          const msg = err instanceof Error ? err.message : 'Auth error'
          return withCors(Response.json({ error: msg }, { status: 500 }))
        }
        // Per MCP auth spec, return 401 with WWW-Authenticate pointing at the
        // protected-resource metadata so OAuth-capable clients (Claude Desktop,
        // Claude.ai) initiate the OAuth flow. Without this, clients assume the
        // server is public and skip auth entirely.
        const wwwAuth = `Bearer realm="anchorr-mcp", resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`
        return withCors(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32001, message: err.message },
              id: null,
            }),
            {
              status: 401,
              headers: {
                'Content-Type': 'application/json',
                'WWW-Authenticate': wwwAuth,
              },
            }
          )
        )
      }

      const server = createServer(env, apiKey)
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless per request
      })

      await server.connect(transport)
      const response = await transport.handleRequest(req)
      if (!response) {
        return withCors(Response.json({ error: 'Unsupported method' }, { status: 405 }))
      }
      return withCors(response)
    }

    return withCors(Response.json({ error: 'Not found' }, { status: 404 }))
  },
} satisfies ExportedHandler<McpEnv>
