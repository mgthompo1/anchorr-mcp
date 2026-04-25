import { createClient } from '@supabase/supabase-js'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_KEY: string
}

export function createSupabaseClient(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
