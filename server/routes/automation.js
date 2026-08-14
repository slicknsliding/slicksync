const express = require('express');
const { describeRegistry } = require('../utils/automation/registry');
const { validateRule, runActions, samplePayloadFor } = require('../utils/automation/engine');

// Automation rules ("when X happens, do Y") - CRUD + test-fire + run history.
// See server/utils/automation/registry.js for what triggers/actions actually
// exist (the client builds its rule editor from GET /registry, never a
// hardcoded list, so a future trigger/action shows up here for free).
module.exports = ({ prisma, getAccountId }) => {
  const router = express.Router();

  const shape = (rule) => ({
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    triggerType: rule.triggerType,
    triggerConfig: safeParse(rule.triggerConfig, {}),
    conditions: safeParse(rule.conditions, []),
    actions: safeParse(rule.actions, []),
    lastRunAt: rule.lastRunAt,
    runCount: rule.runCount,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  });

  function safeParse(raw, fallback) {
    try { const v = JSON.parse(raw ?? ''); return v === null || v === undefined ? fallback : v; }
    catch { return fallback; }
  }

  // GET /api/automation/registry - the trigger/action/operator catalog the
  // rule builder is generated from. No account scoping needed - it's static.
  router.get('/registry', (req, res) => {
    res.json(describeRegistry());
  });

  // GET /api/automation - this account's rules, most recently updated first.
  router.get('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const rules = await prisma.automationRule.findMany({
        where: { accountId },
        orderBy: { updatedAt: 'desc' },
      });
      res.json(rules.map(shape));
    } catch (e) {
      console.error('Error listing automation rules:', e);
      res.status(500).json({ error: 'Failed to list automation rules' });
    }
  });

  // POST /api/automation - create a rule.
  router.post('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const result = validateRule(req.body);
      if (!result.ok) return res.status(400).json({ error: result.error });
      const rule = await prisma.automationRule.create({ data: { accountId, ...result.value } });
      res.status(201).json(shape(rule));
    } catch (e) {
      console.error('Error creating automation rule:', e);
      res.status(500).json({ error: 'Failed to create automation rule' });
    }
  });

  // PATCH /api/automation/:id - full replace of the editable fields (same
  // shape POST takes) - simpler and safer than a partial-field diff for a rule
  // whose pieces (conditions/actions) are each themselves arrays that a
  // partial update could easily corrupt.
  router.patch('/:id', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const existing = await prisma.automationRule.findFirst({ where: { id: req.params.id, accountId } });
      if (!existing) return res.status(404).json({ error: 'Rule not found' });

      // A bare `{ enabled }` toggle (the common case from the list view's
      // switch) skips full validation - re-validating triggerType/conditions/
      // actions on every enable/disable click would mean a rule saved before a
      // registry change (an action later removed) could never be turned back
      // off, which is exactly backwards for a safety toggle.
      if (Object.keys(req.body || {}).length === 1 && typeof req.body?.enabled === 'boolean') {
        const rule = await prisma.automationRule.update({ where: { id: existing.id }, data: { enabled: req.body.enabled } });
        return res.json(shape(rule));
      }

      const result = validateRule({
        name: req.body?.name ?? existing.name,
        triggerType: req.body?.triggerType ?? existing.triggerType,
        triggerConfig: req.body?.triggerConfig ?? safeParse(existing.triggerConfig, {}),
        conditions: req.body?.conditions ?? safeParse(existing.conditions, []),
        actions: req.body?.actions ?? safeParse(existing.actions, []),
        enabled: req.body?.enabled ?? existing.enabled,
      });
      if (!result.ok) return res.status(400).json({ error: result.error });

      const rule = await prisma.automationRule.update({ where: { id: existing.id }, data: result.value });
      res.json(shape(rule));
    } catch (e) {
      console.error('Error updating automation rule:', e);
      res.status(500).json({ error: 'Failed to update automation rule' });
    }
  });

  // DELETE /api/automation/:id
  router.delete('/:id', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const existing = await prisma.automationRule.findFirst({ where: { id: req.params.id, accountId } });
      if (!existing) return res.status(404).json({ error: 'Rule not found' });
      await prisma.automationRule.delete({ where: { id: existing.id } });
      res.json({ success: true });
    } catch (e) {
      console.error('Error deleting automation rule:', e);
      res.status(500).json({ error: 'Failed to delete automation rule' });
    }
  });

  // POST /api/automation/:id/test - runs this rule's actions right now against
  // synthetic sample data for its trigger type. Deliberately skips condition
  // evaluation (the point is "do my actions work," not "would sample data
  // happen to pass my condition") but the outcome is still written to the run
  // log, tagged so the UI can label it "Test run" rather than a real firing.
  router.post('/:id/test', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const rule = await prisma.automationRule.findFirst({ where: { id: req.params.id, accountId } });
      if (!rule) return res.status(404).json({ error: 'Rule not found' });

      const payload = samplePayloadFor(rule.triggerType);
      const results = await runActions(prisma, accountId, rule, payload);

      await prisma.automationRun.create({
        data: {
          accountId,
          ruleId: rule.id,
          triggerType: `test:${rule.triggerType}`,
          payload: JSON.stringify(payload),
          results: JSON.stringify(results),
          ok: results.every((r) => r.ok),
        },
      });

      res.json({ payload, results });
    } catch (e) {
      console.error('Error test-firing automation rule:', e);
      res.status(500).json({ error: 'Failed to test rule' });
    }
  });

  // GET /api/automation/runs - recent firings across every rule on this
  // account, for a shared activity view. ?ruleId= narrows to one rule.
  router.get('/runs', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const { ruleId } = req.query;
      const runs = await prisma.automationRun.findMany({
        where: { accountId, ...(ruleId ? { ruleId: String(ruleId) } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { rule: { select: { name: true } } },
      });
      res.json(runs.map((r) => ({
        id: r.id,
        ruleId: r.ruleId,
        ruleName: r.rule?.name || '(deleted rule)',
        triggerType: r.triggerType,
        payload: safeParse(r.payload, {}),
        results: safeParse(r.results, []),
        ok: r.ok,
        createdAt: r.createdAt,
      })));
    } catch (e) {
      console.error('Error listing automation runs:', e);
      res.status(500).json({ error: 'Failed to list automation runs' });
    }
  });

  return router;
};
