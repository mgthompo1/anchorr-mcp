import type { SupabaseClient } from '@supabase/supabase-js'

export interface SequenceStepInput {
  type: 'email' | 'task' | 'wait'
  subject?: string
  body?: string
  wait_days?: number
}

export async function createSequence(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    name: string
    description?: string
    status?: 'draft' | 'active' | 'paused'
    steps: SequenceStepInput[]
    created_by?: string
  }
) {
  const { data: seq, error: seqErr } = await supabase
    .from('sequences')
    .insert({
      org_id: orgId,
      name: params.name,
      description: params.description ?? '',
      status: params.status ?? 'draft',
      created_by: params.created_by ?? null,
    })
    .select('id, name, status')
    .single()

  if (seqErr || !seq) throw new Error(`Failed to create sequence: ${seqErr?.message ?? 'unknown'}`)

  const stepRows = params.steps.map((s, idx) => ({
    sequence_id: seq.id as string,
    position: idx + 1,
    type: s.type,
    subject: s.subject ?? null,
    body: s.body ?? null,
    wait_days: s.wait_days ?? 0,
  }))

  if (stepRows.length) {
    const { error: stepsErr } = await supabase.from('sequence_steps').insert(stepRows)
    if (stepsErr) {
      // Best-effort rollback
      await supabase.from('sequences').delete().eq('id', seq.id)
      throw new Error(`Failed to insert steps: ${stepsErr.message}`)
    }
  }

  return { id: seq.id, name: seq.name, status: seq.status, steps_added: stepRows.length }
}

export async function listSequences(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase
    .from('sequences')
    .select('id, name, description, status, enrolled_count, completed_count, created_at, updated_at')
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(100)
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function updateSequence(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    id: string
    name?: string
    description?: string
    status?: 'draft' | 'active' | 'paused'
    steps?: SequenceStepInput[]
  }
) {
  const { data: existing, error: findErr } = await supabase
    .from('sequences')
    .select('id')
    .eq('id', params.id)
    .eq('org_id', orgId)
    .maybeSingle()
  if (findErr || !existing) throw new Error('Sequence not found')

  const updates: Record<string, unknown> = {}
  if (params.name !== undefined) updates.name = params.name
  if (params.description !== undefined) updates.description = params.description
  if (params.status !== undefined) updates.status = params.status

  if (Object.keys(updates).length) {
    const { error: updErr } = await supabase
      .from('sequences')
      .update(updates)
      .eq('id', params.id)
      .eq('org_id', orgId)
    if (updErr) throw new Error(`Failed to update sequence: ${updErr.message}`)
  }

  let stepsReplaced: number | null = null
  if (params.steps) {
    const { error: delErr } = await supabase
      .from('sequence_steps')
      .delete()
      .eq('sequence_id', params.id)
    if (delErr) throw new Error(`Failed to clear steps: ${delErr.message}`)

    const stepRows = params.steps.map((s, idx) => ({
      sequence_id: params.id,
      position: idx + 1,
      type: s.type,
      subject: s.subject ?? null,
      body: s.body ?? null,
      wait_days: s.wait_days ?? 0,
    }))
    if (stepRows.length) {
      const { error: insErr } = await supabase.from('sequence_steps').insert(stepRows)
      if (insErr) throw new Error(`Failed to insert steps: ${insErr.message}`)
    }
    stepsReplaced = stepRows.length
  }

  return {
    id: params.id,
    updated_fields: Object.keys(updates),
    steps_replaced: stepsReplaced,
  }
}

// Stop a contact's active sequence enrollment without affecting other
// enrollments in the same sequence. Use this when a test enrollment slipped
// through, when a deal closed mid-cadence, or when an unsubscribe needs to
// take effect immediately. Sets status='completed' (terminal — sequence
// runner ignores it) and clears next_action_at so the next cron tick can't
// fire a stale step. Keeps the row for audit; use delete only if you need
// it gone from history.
export async function unenrollContact(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    sequence_id?: string
    contact_id?: string
    contact_email?: string
    enrollment_id?: string
  }
) {
  // Resolve to a single enrollment row. Three valid lookup shapes:
  //   1. enrollment_id directly (preferred — unambiguous)
  //   2. sequence_id + contact_id
  //   3. sequence_id + contact_email (resolves contact first)
  let enrollmentId: string | null = params.enrollment_id ?? null

  if (!enrollmentId) {
    if (!params.sequence_id) {
      throw new Error('Provide enrollment_id, OR sequence_id + contact_id, OR sequence_id + contact_email')
    }
    let contactId = params.contact_id ?? null
    if (!contactId && params.contact_email) {
      const { data: c } = await supabase
        .from('contacts')
        .select('id')
        .eq('org_id', orgId)
        .eq('email', params.contact_email.toLowerCase().trim())
        .maybeSingle()
      if (!c) throw new Error(`No contact found with email ${params.contact_email} in this org`)
      contactId = c.id as string
    }
    if (!contactId) throw new Error('Provide contact_id or contact_email when looking up by sequence_id')

    const { data: enr } = await supabase
      .from('sequence_enrollments')
      .select('id, status')
      .eq('org_id', orgId)
      .eq('sequence_id', params.sequence_id)
      .eq('contact_id', contactId)
      .maybeSingle()
    if (!enr) throw new Error('No enrollment found for this contact in this sequence')
    enrollmentId = enr.id as string
  }

  // Verify the enrollment belongs to this org before mutating.
  const { data: existing, error: findErr } = await supabase
    .from('sequence_enrollments')
    .select('id, status, sequence_id, contact_id')
    .eq('id', enrollmentId)
    .eq('org_id', orgId)
    .maybeSingle()
  if (findErr || !existing) throw new Error('Enrollment not found in this org')
  if (existing.status === 'completed' || existing.status === 'replied' || existing.status === 'bounced') {
    return {
      enrollment_id: enrollmentId,
      status: existing.status,
      changed: false,
      note: `Already in terminal state (${existing.status}); nothing to stop.`,
    }
  }

  const { error: updErr } = await supabase
    .from('sequence_enrollments')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      next_action_at: null,
    })
    .eq('id', enrollmentId)
    .eq('org_id', orgId)
  if (updErr) throw new Error(`Failed to unenroll: ${updErr.message}`)

  return {
    enrollment_id: enrollmentId,
    status: 'completed',
    changed: true,
    sequence_id: existing.sequence_id,
    contact_id: existing.contact_id,
  }
}

export async function deleteSequence(
  supabase: SupabaseClient,
  orgId: string,
  sequenceId: string
) {
  // Verify it exists and belongs to this org before delete.
  const { data: existing, error: findErr } = await supabase
    .from('sequences')
    .select('id, name, enrolled_count')
    .eq('id', sequenceId)
    .eq('org_id', orgId)
    .maybeSingle()
  if (findErr || !existing) throw new Error('Sequence not found')

  // Refuse to silently nuke a sequence with active enrollments — caller can
  // pause the sequence and unenroll explicitly if they really want this gone.
  if ((existing.enrolled_count ?? 0) > 0) {
    throw new Error(
      `Sequence "${existing.name}" has ${existing.enrolled_count} active enrollments. Pause it and unenroll first, or delete those enrollments before deleting the sequence.`
    )
  }

  // Cascade: sequence_steps and sequence_enrollments have ON DELETE CASCADE
  // on sequence_id (verified in migrations). Single delete handles cleanup.
  const { error: delErr } = await supabase
    .from('sequences')
    .delete()
    .eq('id', sequenceId)
    .eq('org_id', orgId)
  if (delErr) throw new Error(`Failed to delete sequence: ${delErr.message}`)

  return { id: sequenceId, name: existing.name, deleted: true }
}

export async function getSequence(
  supabase: SupabaseClient,
  orgId: string,
  sequenceId: string
) {
  const [seqRes, stepsRes] = await Promise.all([
    supabase
      .from('sequences')
      .select('id, name, description, status, enrolled_count, completed_count, created_at, updated_at')
      .eq('id', sequenceId)
      .eq('org_id', orgId)
      .single(),
    supabase
      .from('sequence_steps')
      .select('id, position, type, subject, body, wait_days')
      .eq('sequence_id', sequenceId)
      .order('position'),
  ])
  if (seqRes.error || !seqRes.data) throw new Error('Sequence not found')
  return { ...seqRes.data, steps: stepsRes.data ?? [] }
}
