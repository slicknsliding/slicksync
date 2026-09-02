// The AI rule-writer: plain English in, a ready-to-review automation rule
// out. "if RPDB dies and there is no backup, alert me loudly" becomes a
// real {name, triggerType, conditions, actions} draft, opened in the SAME
// editor recipes use - reviewed and saved by a person, never created
// directly. The whole feature is a better on-ramp to the existing engine,
// not a second engine.
//
// Everything the model may use comes from describeRegistry() - the same
// registry the editor renders - and everything the model returns is
// validated back against it: unknown triggers are rejected outright,
// unknown condition fields/operators and unknown action config keys are
// DROPPED with a warning rather than saved. The model proposes; the
// registry disposes.

const { TRIGGERS, OPERATORS, ACTIONS, describeRegistry } = require('./registry')

const SYSTEM_PROMPT = () => `You turn a user's plain-English wish into ONE automation rule for a media-server manager.

Reply with STRICT JSON only - no markdown, no commentary. Shape:
{"name": string, "triggerType": string, "triggerConfig": object?, "conditions": [{"field": string, "op": string, "value": string?}]?, "actions": [{"type": string, "config": object}]}

Rules:
- triggerType MUST be one of the trigger "type" values below. Never invent one.
- conditions are optional; each field must belong to the chosen trigger's fields, each op to the operators list. Omit "value" for unary operators (is true / is false).
- actions: at least one; each type from the actions list; config keys only from that action's configFields. For notify, write a short useful title and message - {{fieldName}} inserts trigger values.
- "name" is a short human name for the rule.
- If the wish maps to a scheduled time, use the time trigger's triggerConfig (hour 0-23, minute, optional days array 0-6, 0=Sunday).

The registry:
${JSON.stringify(describeRegistry())}`

function sanitizeDraft(raw) {
  const warnings = []
  if (!raw || typeof raw !== 'object') throw new Error('The model returned something that is not a rule')
  const trigger = TRIGGERS[raw.triggerType]
  if (!trigger) throw new Error(`The model picked a trigger that does not exist (${raw.triggerType || 'none'}) - try rephrasing`)

  const fieldNames = new Set((trigger.fields || []).map((f) => f.name))
  const conditions = []
  for (const c of Array.isArray(raw.conditions) ? raw.conditions : []) {
    if (!c || typeof c !== 'object') continue
    if (!fieldNames.has(c.field)) { warnings.push(`Dropped a condition on unknown field "${c.field}"`); continue }
    const op = OPERATORS[c.op]
    if (!op) { warnings.push(`Dropped a condition with unknown operator "${c.op}"`); continue }
    const cond = { field: c.field, op: c.op }
    if (!op.unary) cond.value = c.value === undefined || c.value === null ? '' : String(c.value)
    conditions.push(cond)
  }

  const actions = []
  for (const a of Array.isArray(raw.actions) ? raw.actions : []) {
    const def = a && ACTIONS[a.type]
    if (!def) { warnings.push(`Dropped an unknown action "${a?.type}"`); continue }
    const allowed = new Set((def.configFields || []).map((f) => f.name))
    const config = {}
    for (const [k, v] of Object.entries(a.config && typeof a.config === 'object' ? a.config : {})) {
      if (allowed.has(k)) config[k] = typeof v === 'string' ? v : String(v)
      else warnings.push(`Dropped unknown "${k}" from the ${def.label} action`)
    }
    actions.push({ type: a.type, config })
  }
  if (actions.length === 0) throw new Error('The model produced no usable action - try rephrasing')

  const triggerConfig = {}
  const tcAllowed = new Set((trigger.triggerConfigFields || []).map((f) => f.name))
  for (const [k, v] of Object.entries(raw.triggerConfig && typeof raw.triggerConfig === 'object' ? raw.triggerConfig : {})) {
    if (tcAllowed.has(k)) triggerConfig[k] = v
  }

  return {
    rule: {
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : 'AI-drafted rule',
      triggerType: raw.triggerType,
      triggerConfig,
      conditions,
      actions,
    },
    warnings,
  }
}

/**
 * callModel is injectable for tests; the default speaks the same
 * chat/completions shape nlCatalog's own AI calls use.
 */
async function composeRule(prisma, accountId, text, decrypt, callModel = null) {
  const { resolveAiCredentials } = require('../nlCatalog')
  const creds = await resolveAiCredentials(prisma, accountId, decrypt)
  if (!creds) {
    const err = new Error('AI Services is not configured - add a key under Settings -> External API Keys -> AI Services')
    err.notConfigured = true
    throw err
  }
  const run = callModel || (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    try {
      const res = await fetch(`${creds.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
        body: JSON.stringify({
          model: creds.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT() },
            { role: 'user', content: String(text).slice(0, 500) },
          ],
          temperature: 0.2,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        let detail = ''
        try { const b = await res.json(); detail = b?.error?.message || b?.message || '' } catch {}
        throw new Error(`AI provider returned ${res.status}${detail ? `: ${detail}` : ''}`)
      }
      const data = await res.json()
      return data?.choices?.[0]?.message?.content || ''
    } finally { clearTimeout(timer) }
  })
  const content = await run()
  const cleaned = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  let parsed
  try { parsed = JSON.parse(cleaned) } catch { throw new Error('The model did not return valid JSON - try rephrasing') }
  return sanitizeDraft(parsed)
}

module.exports = { composeRule, sanitizeDraft, SYSTEM_PROMPT }
