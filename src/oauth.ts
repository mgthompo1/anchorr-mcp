// MCP OAuth 2.0 flow (RFC 6749 + RFC 7591 dynamic registration + PKCE).
// Mirrors the Givvv implementation — the access_token returned is the user's
// own API key, so all downstream Bearer validation goes through the same path.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseClient, type Env } from './supabase.js'
import { authenticateRequest, AuthError } from './auth.js'

async function hmacSign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function hmacVerify(payload: string, sigHex: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const sigBytes = new Uint8Array(sigHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)))
  return crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(payload))
}

async function createAuthCode(
  apiKey: string,
  codeChallenge: string,
  secret: string
): Promise<string> {
  const payload = JSON.stringify({
    k: apiKey,
    c: codeChallenge,
    e: Date.now() + 5 * 60 * 1000,
  })
  const sig = await hmacSign(payload, secret)
  return btoa(payload) + '.' + sig
}

async function verifyAuthCode(
  code: string,
  secret: string
): Promise<{ apiKey: string; codeChallenge: string } | null> {
  try {
    const [payloadB64, sig] = code.split('.')
    if (!payloadB64 || !sig) return null
    const payload = atob(payloadB64)
    if (!(await hmacVerify(payload, sig, secret))) return null
    const data = JSON.parse(payload) as { k: string; c: string; e: number }
    if (data.e < Date.now()) return null
    return { apiKey: data.k, codeChallenge: data.c }
  } catch {
    return null
  }
}

async function pkceVerify(verifier: string, challenge: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier))
  const computed = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return computed === challenge
}

// ── Handler — returns a Response if the path is an OAuth endpoint, else null ──

export async function handleOAuth(
  req: Request,
  env: Env,
  withCors: (r: Response) => Response
): Promise<Response | null> {
  const url = new URL(req.url)

  // Protected Resource Metadata (RFC 9728)
  if (url.pathname === '/.well-known/oauth-protected-resource') {
    return withCors(
      Response.json({
        resource: `${url.origin}/`,
        authorization_servers: [`${url.origin}/`],
        bearer_methods_supported: ['header', 'body'],
        scopes_supported: [],
      })
    )
  }

  // Authorization Server Metadata
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    return withCors(
      Response.json({
        issuer: url.origin,
        authorization_endpoint: `${url.origin}/oauth/authorize`,
        token_endpoint: `${url.origin}/oauth/token`,
        registration_endpoint: `${url.origin}/oauth/register`,
        revocation_endpoint: `${url.origin}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      })
    )
  }

  // Dynamic Client Registration (RFC 7591) — accept any client
  if (url.pathname === '/oauth/register' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    return withCors(
      new Response(
        JSON.stringify({
          client_id: crypto.randomUUID(),
          client_name: body.client_name ?? 'MCP Client',
          redirect_uris: body.redirect_uris ?? [],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )
    )
  }

  // Authorize POST — validate the API key, issue signed auth code
  if (url.pathname === '/oauth/authorize' && req.method === 'POST') {
    const formData = await req.formData()
    const apiKeyRaw = ((formData.get('api_key') as string) || '').trim()
    const redirectUri = (formData.get('redirect_uri') as string) || ''
    const state = (formData.get('state') as string) || ''
    const codeChallenge = (formData.get('code_challenge') as string) || ''

    // Validate by trying to authenticate a fake request with this key
    const supabase = createSupabaseClient(env)
    const fakeReq = new Request('https://ignored/', {
      headers: { authorization: `Bearer ${apiKeyRaw}` },
    })
    let valid = true
    try {
      await authenticateRequest(fakeReq, supabase)
    } catch (err) {
      if (err instanceof AuthError) valid = false
    }

    if (!valid) {
      const retry = new URL(`${url.origin}/oauth/authorize`)
      retry.searchParams.set('redirect_uri', redirectUri)
      retry.searchParams.set('state', state)
      retry.searchParams.set('code_challenge', codeChallenge)
      retry.searchParams.set('error', 'invalid_key')
      return Response.redirect(retry.toString(), 302)
    }

    const code = await createAuthCode(apiKeyRaw, codeChallenge, env.SUPABASE_SERVICE_KEY)
    const redirect = new URL(redirectUri)
    redirect.searchParams.set('code', code)
    if (state) redirect.searchParams.set('state', state)
    return Response.redirect(redirect.toString(), 302)
  }

  // Authorize GET — render the paste-your-key form
  if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
    const clientId = url.searchParams.get('client_id') ?? ''
    const redirectUri = url.searchParams.get('redirect_uri') ?? ''
    const state = url.searchParams.get('state') ?? ''
    const codeChallenge = url.searchParams.get('code_challenge') ?? ''
    const codeChallengeMethod = url.searchParams.get('code_challenge_method') ?? ''
    const error = url.searchParams.get('error') ?? ''

    const errorHtml = error
      ? '<p style="color:#ef4444;font-weight:600;margin-bottom:1rem;">Invalid API key — try again.</p>'
      : ''

    const html = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anchorr — Connect</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem}
  .card{background:#151515;border:1px solid #262626;border-radius:12px;padding:2rem;max-width:420px;width:100%}
  .brand{display:flex;align-items:center;gap:8px;margin-bottom:1.5rem;font-weight:600;font-size:14px}
  .dot{width:8px;height:8px;border-radius:50%;background:#f97316}
  h1{font-size:1.15rem;font-weight:600;margin-bottom:0.25rem;letter-spacing:-0.02em}
  p{font-size:0.8125rem;color:#a3a3a3;margin-bottom:1.25rem;line-height:1.5}
  label{display:block;font-size:0.75rem;font-weight:500;margin-bottom:6px;color:#d4d4d4}
  input[type=password]{width:100%;padding:10px 12px;background:#0a0a0a;border:1px solid #262626;border-radius:6px;color:#e5e5e5;font-family:'SF Mono',Monaco,monospace;font-size:0.8125rem;outline:none}
  input[type=password]:focus{border-color:#f97316}
  button{width:100%;padding:10px;background:#f97316;color:#0a0a0a;border:none;border-radius:6px;font-size:0.875rem;font-weight:600;cursor:pointer;margin-top:1rem}
  button:hover{background:#ea580c}
  .hint{font-size:0.7rem;color:#737373;margin-top:6px}
</style></head>
<body>
  <div class="card">
    <div class="brand"><span class="dot"></span>Anchorr</div>
    <h1>Connect your account</h1>
    <p>Paste your Anchorr API key to authorize this client. Create keys in <strong>Settings → Integrations → API Keys</strong>.</p>
    ${errorHtml}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${clientId}">
      <input type="hidden" name="redirect_uri" value="${redirectUri}">
      <input type="hidden" name="state" value="${state}">
      <input type="hidden" name="code_challenge" value="${codeChallenge}">
      <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
      <label for="api_key">API Key</label>
      <input type="password" id="api_key" name="api_key" placeholder="ancr_live_..." required autofocus>
      <p class="hint">Keys start with ancr_live_ and are shown once when created.</p>
      <button type="submit">Connect</button>
    </form>
  </div>
</body></html>`
    return new Response(html, { headers: { 'Content-Type': 'text/html' } })
  }

  // Token exchange
  if (url.pathname === '/oauth/token' && req.method === 'POST') {
    let code = ''
    let codeVerifier = ''
    const contentType = req.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const body = (await req.json()) as Record<string, string>
      code = body.code ?? ''
      codeVerifier = body.code_verifier ?? ''
    } else {
      const formData = await req.formData()
      code = ((formData.get('code') as string) || '')
      codeVerifier = ((formData.get('code_verifier') as string) || '')
    }
    if (!code) return withCors(Response.json({ error: 'invalid_grant' }, { status: 400 }))

    const stored = await verifyAuthCode(code, env.SUPABASE_SERVICE_KEY)
    if (!stored) return withCors(Response.json({ error: 'invalid_grant' }, { status: 400 }))

    if (stored.codeChallenge && codeVerifier) {
      const ok = await pkceVerify(codeVerifier, stored.codeChallenge)
      if (!ok) {
        return withCors(
          Response.json(
            { error: 'invalid_grant', error_description: 'PKCE verification failed' },
            { status: 400 }
          )
        )
      }
    }

    return withCors(
      Response.json({
        access_token: stored.apiKey,
        token_type: 'Bearer',
        expires_in: 31536000,
        scope: '*',
      })
    )
  }

  // Revocation (RFC 7009) — best-effort, always return 200
  if (url.pathname === '/oauth/revoke' && req.method === 'POST') {
    let token = ''
    const contentType = req.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const body = (await req.json()) as Record<string, string>
      token = body.token ?? ''
    } else {
      const formData = await req.formData()
      token = ((formData.get('token') as string) || '')
    }
    if (token) {
      const supabase: SupabaseClient = createSupabaseClient(env)
      const encoder = new TextEncoder()
      const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token))
      const keyHash = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      await supabase.from('api_keys').delete().eq('key_hash', keyHash)
    }
    return withCors(new Response(null, { status: 200 }))
  }

  return null
}
