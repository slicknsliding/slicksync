/**
 * Low-level Supabase PostgREST HTTP client.
 * All Nuvio API calls go through these functions.
 */

// Nuvio's backend, fronted by their own custom domain (api.nuvio.tv) rather than
// the raw Supabase project URL. Confirmed current as of the AIOManager reference
// implementation (github.com/Sonicx161/AIOManager, beta branch) — the previous
// default here pointed at a raw *.supabase.co URL that no longer authenticates.
const SUPABASE_URL = process.env.NUVIO_SUPABASE_URL || 'https://api.nuvio.tv'
const SUPABASE_ANON_KEY = process.env.NUVIO_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI'

function headers(accessToken) {
  return {
    'apikey': SUPABASE_ANON_KEY,
    'authorization': `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'prefer': 'return=representation'
  }
}

async function supabaseGet(table, params, accessToken) {
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`
  const res = await fetch(url, { headers: headers(accessToken) })
  if (!res.ok) {
    console.error(`Supabase GET ${table} failed (${res.status})`)
    const err = new Error('Provider request failed')
    err.status = res.status
    throw err
  }
  return await res.json()
}

async function supabasePost(table, rows, accessToken) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify(rows)
  })
  if (!res.ok) {
    console.error(`Supabase POST ${table} failed (${res.status})`)
    const err = new Error('Provider request failed')
    err.status = res.status
    throw err
  }
  return await res.json()
}

async function supabaseDelete(table, params, accessToken) {
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: headers(accessToken)
  })
  if (!res.ok) {
    console.error(`Supabase DELETE ${table} failed (${res.status})`)
    const err = new Error('Provider request failed')
    err.status = res.status
    throw err
  }
}

async function supabaseRpc(fn, body, accessToken) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/${fn}`
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    console.error(`Supabase RPC ${fn} failed (${res.status})`)
    const err = new Error('Provider request failed')
    err.status = res.status
    throw err
  }
  return await res.json()
}

module.exports = { supabaseGet, supabasePost, supabaseDelete, supabaseRpc, SUPABASE_URL, SUPABASE_ANON_KEY }
