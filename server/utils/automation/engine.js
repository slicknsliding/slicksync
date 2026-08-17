// The automation engine: takes an event emitted from somewhere in the app,
// finds the rules listening for it, checks their conditions, and runs their
// actions - recording every firing in AutomationRun.
//
// Design rules that matter here:
//
//  * emitAutomationEvent() must NEVER throw into its caller. Every trigger
//    point is inside something more important than the automation (a health
//    check, an expiry sweep, an invite acceptance); an automation bug must not
//    take those down. Everything is wrapped and failures are logged only.
//
//  * A failing action does not abort the rest of the rule. Rules routinely
//    pair "do the thing" with "tell me about it" - losing the notification
//    because the group edit failed (or vice versa) is worse than partial
//    execution, and the run log records exactly which half worked.
//
//  * Rules are validated against the registry at execution time, not just at
//    save time. A rule referencing an action that no longer exists (removed in
//    a later version) is skipped and logged, never crashed on.

const { TRIGGERS, OPERATORS, ACTIONS } = require('./registry')

/**
 * ALL conditions must pass (AND). An empty/absent list means "always run" -
 * that's the common case for rules like "when an addon goes offline, tell me."
 */
function evaluateConditions(conditions, payload) {
  if (!Array.isArray(conditions) || conditions.length === 0) return true
  return conditions.every((c) => {
    const operator = OPERATORS[c?.op]
    if (!operator) return false // unknown operator fails closed
    const actual = payload ? payload[c.field] : undefined
    return operator.unary ? operator.apply(actual) : operator.apply(actual, c.value)
  })
}

function parseJson(raw, fallback) {
  if (raw === null || raw === undefined) return fallback
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(raw)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch { return fallback }
}

/**
 * Runs one rule's actions in order. Returns per-action results for the run log.
 * Never throws - a thrown action is captured as a failed result instead.
 */
async function runActions(prisma, accountId, rule, payload) {
  const actions = parseJson(rule.actions, [])
  const results = []

  for (const action of Array.isArray(actions) ? actions : []) {
    const definition = ACTIONS[action?.type]
    if (!definition) {
      results.push({ type: action?.type || 'unknown', ok: false, message: 'Unknown action type - skipped' })
      continue
    }
    try {
      const message = await definition.run({
        prisma,
        accountId,
        config: action.config && typeof action.config === 'object' ? action.config : {},
        payload: payload || {},
      })
      results.push({ type: action.type, ok: true, message: message || 'Done' })
    } catch (err) {
      results.push({ type: action.type, ok: false, message: err?.message || 'Action failed' })
    }
  }

  return results
}

/**
 * Fire an automation event. Safe to call from anywhere, including inside
 * schedulers and request handlers.
 *
 * @param {object} prisma
 * @param {string} accountId
 * @param {string} triggerType - a key from the registry's TRIGGERS
 * @param {object} payload - flat object matching that trigger's declared fields
 * @returns {Promise<{fired: number}>} how many rules actually ran (0 on any failure)
 */
async function emitAutomationEvent(prisma, accountId, triggerType, payload = {}) {
  try {
    if (!prisma || !accountId || !TRIGGERS[triggerType]) return { fired: 0 }

    const rules = await prisma.automationRule.findMany({
      where: { accountId, triggerType, enabled: true },
    })
    if (rules.length === 0) return { fired: 0 }

    let fired = 0
    for (const rule of rules) {
      try {
        if (!evaluateConditions(parseJson(rule.conditions, []), payload)) continue

        const results = await runActions(prisma, accountId, rule, payload)
        fired++

        await prisma.$transaction([
          prisma.automationRun.create({
            data: {
              accountId,
              ruleId: rule.id,
              triggerType,
              payload: JSON.stringify(payload || {}),
              results: JSON.stringify(results),
              ok: results.every((r) => r.ok),
            },
          }),
          prisma.automationRule.update({
            where: { id: rule.id },
            data: { lastRunAt: new Date(), runCount: { increment: 1 } },
          }),
        ])
      } catch (err) {
        console.warn(`[Automation] Rule "${rule?.name}" (${rule?.id}) failed:`, err?.message || err)
      }
    }

    if (fired > 0) console.log(`[Automation] ${triggerType}: ${fired} rule(s) fired`)
    return { fired }
  } catch (err) {
    // Deliberately swallowed - see the header comment. The caller is always
    // something more important than this.
    console.warn('[Automation] emit failed:', err?.message || err)
    return { fired: 0 }
  }
}

/**
 * Validates a rule body coming from the API against the registry.
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
function validateRule(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return { ok: false, error: 'A rule name is required' }

  const triggerType = body?.triggerType
  if (!TRIGGERS[triggerType]) return { ok: false, error: `Unknown trigger "${triggerType}"` }

  // Only time.daily has this today - see registry.js's own comment on why
  // triggerConfigFields is separate from the payload/condition `fields`.
  const triggerConfig = body?.triggerConfig && typeof body.triggerConfig === 'object' ? body.triggerConfig : {}
  for (const field of TRIGGERS[triggerType].triggerConfigFields || []) {
    const value = triggerConfig[field.name]
    if (field.required && (value === undefined || value === null || value === '')) {
      return { ok: false, error: `"${TRIGGERS[triggerType].label}" needs ${field.label}` }
    }
    if (field.type === 'number' && value !== undefined && value !== null && !Number.isFinite(Number(value))) {
      return { ok: false, error: `${field.label} must be a number` }
    }
  }
  if (triggerType === 'time.daily') {
    const hour = Number(triggerConfig.hour)
    const minute = Number(triggerConfig.minute)
    if (!(hour >= 0 && hour <= 23)) return { ok: false, error: 'Hour must be between 0 and 23' }
    if (!(minute >= 0 && minute <= 59)) return { ok: false, error: 'Minute must be between 0 and 59' }
  }

  const conditions = Array.isArray(body?.conditions) ? body.conditions : []
  const validFields = new Set(TRIGGERS[triggerType].fields.map((f) => f.name))
  for (const c of conditions) {
    if (!validFields.has(c?.field)) return { ok: false, error: `"${c?.field}" isn't a field on this trigger` }
    if (!OPERATORS[c?.op]) return { ok: false, error: `Unknown operator "${c?.op}"` }
    if (!OPERATORS[c.op].unary && (c.value === undefined || c.value === null || c.value === '')) {
      return { ok: false, error: `A value is required for "${c.field} ${OPERATORS[c.op].label}"` }
    }
  }

  const actions = Array.isArray(body?.actions) ? body.actions : []
  if (actions.length === 0) return { ok: false, error: 'A rule needs at least one action' }
  for (const a of actions) {
    const definition = ACTIONS[a?.type]
    if (!definition) return { ok: false, error: `Unknown action "${a?.type}"` }
    const config = a.config && typeof a.config === 'object' ? a.config : {}
    for (const field of definition.configFields || []) {
      // `required` here means "required unless the trigger can supply it" -
      // the addon/user targeting fields intentionally fall back to the event
      // payload, which is what makes a rule like "disable whichever addon just
      // went offline" expressible at all.
      const fallsBackToPayload = field.hint && field.hint.includes('Leave blank')
      if (field.required && !fallsBackToPayload && !config[field.name]) {
        return { ok: false, error: `"${definition.label}" needs ${field.label}` }
      }
    }
  }

  return {
    ok: true,
    value: {
      name,
      triggerType,
      triggerConfig: JSON.stringify(triggerConfig),
      conditions: JSON.stringify(conditions),
      actions: JSON.stringify(actions),
      enabled: body?.enabled === undefined ? true : !!body.enabled,
    },
  }
}

/** Sample payload for a trigger, so "Test rule" can run without waiting for the real event. */
function samplePayloadFor(triggerType) {
  const trigger = TRIGGERS[triggerType]
  if (!trigger) return {}
  const sample = {}
  for (const field of trigger.fields) {
    if (field.type === 'number') sample[field.name] = 1
    else if (field.type === 'boolean') sample[field.name] = false
    else sample[field.name] = `test-${field.name}`
  }
  return sample
}

module.exports = { emitAutomationEvent, evaluateConditions, runActions, validateRule, samplePayloadFor, parseJson }
