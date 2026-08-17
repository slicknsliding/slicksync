'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  BoltIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  PlayIcon,
  CheckCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import { Card, Button, Badge, Modal, ConfirmModal, ToggleSwitch } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import type {
  AutomationRegistry, AutomationRule, AutomationRun, AutomationCondition, AutomationActionConfig,
} from '@/lib/api';

// A rule builder for the automation engine (server/utils/automation/) - every
// trigger/action/operator here is read live from GET /api/automation/registry
// rather than hardcoded, so a new one shows up without touching this file.
//
// Lives inside a Modal launched from the Tasks page rather than its own
// nav-level route - this is operator tooling (same category as backups,
// snapshots, disaster recovery kit already on that page), not a page most
// admins need parked in the sidebar every day.
export function AutomationPanel() {
  const [registry, setRegistry] = useState<AutomationRegistry | null>(null);
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [editingRule, setEditingRule] = useState<AutomationRule | 'new' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AutomationRule | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [reg, ruleList] = await Promise.all([
        api.getAutomationRegistry(),
        api.getAutomationRules(),
      ]);
      setRegistry(reg);
      setRules(ruleList);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load automation');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const loadRuns = useCallback(async () => {
    try {
      setRuns(await api.getAutomationRuns());
    } catch (err: any) {
      toast.error(err.message || 'Failed to load run history');
    }
  }, []);

  useEffect(() => { if (showHistory) loadRuns(); }, [showHistory, loadRuns]);

  const handleToggleEnabled = async (rule: AutomationRule, next: boolean) => {
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: next } : r)));
    try {
      await api.updateAutomationRule(rule.id, { enabled: next });
    } catch (err: any) {
      setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: !next } : r)));
      toast.error(err.message || 'Failed to update rule');
    }
  };

  const handleTest = async (rule: AutomationRule) => {
    setTestingId(rule.id);
    try {
      const { results } = await api.testAutomationRule(rule.id);
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        toast.success(`Test passed: ${results.map((r) => r.message).join('; ')}`);
      } else {
        toast.error(`Test found a problem: ${failed.map((r) => r.message).join('; ')}`);
      }
    } catch (err: any) {
      toast.error(err.message || 'Test failed');
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteAutomationRule(deleteTarget.id);
      setRules((prev) => prev.filter((r) => r.id !== deleteTarget.id));
      toast.success(`Deleted "${deleteTarget.name}"`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete rule');
    } finally {
      setDeleteTarget(null);
    }
  };

  const triggerLabel = (type: string) => registry?.triggers.find((t) => t.type === type)?.label || type;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <p className="text-sm text-muted">When something happens, do something about it - without shipping code for every combination.</p>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="secondary" size="sm" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Hide history' : 'Run history'}
          </Button>
          <Button variant="primary" size="sm" leftIcon={<PlusIcon className="w-4 h-4" />} onClick={() => setEditingRule('new')}>
            New rule
          </Button>
        </div>
      </div>

      {showHistory && (
        <Card padding="lg" className="mb-4">
          <h3 className="text-base font-semibold text-default mb-3">Recent activity</h3>
          {runs.length === 0 ? (
            <p className="text-sm text-muted">No rules have fired yet.</p>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <div key={run.id} className="flex items-start gap-3 p-3 rounded-xl bg-surface-hover">
                  {run.ok ? (
                    <CheckCircleIcon className="w-5 h-5 text-success shrink-0 mt-0.5" />
                  ) : (
                    <XCircleIcon className="w-5 h-5 text-error shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-default">
                      {run.ruleName}
                      {run.triggerType.startsWith('test:') && <Badge variant="muted" size="sm" className="ml-2">Test run</Badge>}
                    </p>
                    <p className="text-xs text-muted mt-0.5">
                      {run.results.map((r) => r.message).join(' · ')}
                    </p>
                  </div>
                  <span className="text-xs text-subtle shrink-0">{new Date(run.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {loading ? (
        <Card padding="lg"><p className="text-sm text-muted">Loading...</p></Card>
      ) : rules.length === 0 ? (
        <Card padding="lg">
          <div className="text-center py-8">
            <BoltIcon className="w-10 h-10 text-subtle mx-auto mb-3" />
            <p className="text-default font-medium mb-1">No automation rules yet</p>
            <p className="text-sm text-muted mb-4">e.g. &quot;when a vault credential expires, move those users to the free group.&quot;</p>
            <Button variant="primary" leftIcon={<PlusIcon className="w-4 h-4" />} onClick={() => setEditingRule('new')}>
              Create your first rule
            </Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <Card key={rule.id} padding="lg">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex items-start gap-3 min-w-0">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${rule.enabled ? 'bg-primary-muted' : 'bg-surface-hover'}`}>
                    <BoltIcon className={`w-5 h-5 ${rule.enabled ? 'text-primary' : 'text-subtle'}`} />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-default truncate">{rule.name}</p>
                    <p className="text-sm text-muted">
                      When <span className="text-default">{triggerLabel(rule.triggerType)}</span>
                      {rule.conditions.length > 0 && ` (${rule.conditions.length} condition${rule.conditions.length !== 1 ? 's' : ''})`}
                      {' -> '}{rule.actions.length} action{rule.actions.length !== 1 ? 's' : ''}
                    </p>
                    <p className="text-xs text-subtle mt-1">
                      {rule.lastRunAt
                        ? <>Last fired {new Date(rule.lastRunAt).toLocaleString()} · {rule.runCount} total</>
                        : 'Never fired yet'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button variant="ghost" size="sm" isLoading={testingId === rule.id} leftIcon={<PlayIcon className="w-4 h-4" />} onClick={() => handleTest(rule)}>
                    Test
                  </Button>
                  <Button variant="ghost" size="sm" leftIcon={<PencilIcon className="w-4 h-4" />} onClick={() => setEditingRule(rule)}>
                    Edit
                  </Button>
                  <button
                    onClick={() => setDeleteTarget(rule)}
                    className="p-2 rounded-lg text-muted hover:text-error hover:bg-error-muted transition-colors"
                    title="Delete rule"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                  <ToggleSwitch checked={rule.enabled} onChange={() => handleToggleEnabled(rule, !rule.enabled)} title={`Toggle ${rule.name}`} />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editingRule && registry && (
        <RuleEditorModal
          registry={registry}
          rule={editingRule === 'new' ? null : editingRule}
          onClose={() => setEditingRule(null)}
          onSaved={(saved) => {
            setRules((prev) => {
              const exists = prev.some((r) => r.id === saved.id);
              return exists ? prev.map((r) => (r.id === saved.id ? saved : r)) : [saved, ...prev];
            });
            setEditingRule(null);
          }}
        />
      )}

      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Rule"
        description={`Delete "${deleteTarget?.name}"? This can't be undone.`}
        confirmText="Delete Rule"
        variant="danger"
      />
    </div>
  );
}

// ---- Rule editor -----------------------------------------------------------

function RuleEditorModal({
  registry, rule, onClose, onSaved,
}: {
  registry: AutomationRegistry;
  rule: AutomationRule | null;
  onClose: () => void;
  onSaved: (rule: AutomationRule) => void;
}) {
  const [name, setName] = useState(rule?.name || '');
  const [triggerType, setTriggerType] = useState(rule?.triggerType || registry.triggers[0]?.type || '');
  const [triggerConfig, setTriggerConfig] = useState<Record<string, unknown>>(rule?.triggerConfig || {});
  const [conditions, setConditions] = useState<AutomationCondition[]>(rule?.conditions || []);
  const [actions, setActions] = useState<AutomationActionConfig[]>(rule?.actions || (registry.actions[0] ? [{ type: registry.actions[0].type, config: {} }] : []));
  const [saving, setSaving] = useState(false);

  const trigger = registry.triggers.find((t) => t.type === triggerType);

  // Changing the trigger invalidates any condition whose field belonged to the
  // old one - silently keeping a stale field around would save a rule that
  // fails validation the moment it's re-opened. Same for triggerConfig - a
  // leftover hour/minute from a previous time.daily selection has no meaning
  // once the trigger's changed to something else.
  const handleTriggerChange = (nextType: string) => {
    setTriggerType(nextType);
    setConditions([]);
    setTriggerConfig({});
  };

  const handleSave = async () => {
    if (!name.trim()) { toast.error('Give this rule a name'); return; }
    if (actions.length === 0) { toast.error('Add at least one action'); return; }
    for (const field of trigger?.triggerConfigFields || []) {
      if (field.required && (triggerConfig[field.name] === undefined || triggerConfig[field.name] === '')) {
        toast.error(`"${trigger?.label}" needs ${field.label}`);
        return;
      }
    }
    setSaving(true);
    try {
      const payload = { name: name.trim(), triggerType, triggerConfig, conditions, actions, enabled: rule?.enabled ?? true };
      const saved = rule
        ? await api.updateAutomationRule(rule.id, payload)
        : await api.createAutomationRule(payload);
      toast.success(rule ? 'Rule updated' : 'Rule created');
      onSaved(saved);
    } catch (err: any) {
      toast.error(err.message || 'Failed to save rule');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={rule ? 'Edit Rule' : 'New Rule'} size="lg">
      <div className="space-y-5">
        <div>
          <label className="block text-sm font-medium mb-2 text-muted">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='e.g. "Notify me when a vault credential expires"'
            className="w-full px-4 py-3 rounded-xl focus:outline-none"
            style={{ background: 'var(--color-surfaceHover)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2 text-muted">When</label>
          <select
            value={triggerType}
            onChange={(e) => handleTriggerChange(e.target.value)}
            className="w-full px-4 py-3 rounded-xl focus:outline-none"
            style={{ background: 'var(--color-surfaceHover)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
          >
            {registry.triggers.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
          </select>
          {trigger && <p className="text-xs text-muted mt-1.5">{trigger.description}</p>}
        </div>

        {/* Only time.daily has triggerConfigFields today - a schedule isn't
            a condition on an event's payload, it's the trigger's own
            configuration, so it gets its own small form here rather than
            living in ConditionBuilder below. */}
        {trigger && trigger.triggerConfigFields && trigger.triggerConfigFields.length > 0 && (
          <div className="flex gap-3">
            {trigger.triggerConfigFields.map((field) => (
              <div key={field.name} className="flex-1">
                <label className="block text-xs font-medium mb-1.5 text-muted">{field.label}</label>
                <input
                  type="number"
                  value={typeof triggerConfig[field.name] === 'number' ? (triggerConfig[field.name] as number) : ''}
                  onChange={(e) => setTriggerConfig({ ...triggerConfig, [field.name]: e.target.value === '' ? undefined : Number(e.target.value) })}
                  placeholder={field.label}
                  className="w-full px-4 py-2.5 rounded-xl focus:outline-none"
                  style={{ background: 'var(--color-surfaceHover)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
                />
              </div>
            ))}
          </div>
        )}

        {trigger && (
          <ConditionBuilder
            trigger={trigger}
            operators={registry.operators}
            conditions={conditions}
            onChange={setConditions}
          />
        )}

        <ActionBuilder
          registry={registry}
          actions={actions}
          onChange={setActions}
        />

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} isLoading={saving}>
            {rule ? 'Save Changes' : 'Create Rule'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ConditionBuilder({
  trigger, operators, conditions, onChange,
}: {
  trigger: AutomationRegistry['triggers'][number];
  operators: AutomationRegistry['operators'];
  conditions: AutomationCondition[];
  onChange: (next: AutomationCondition[]) => void;
}) {
  const addCondition = () => {
    const field = trigger.fields[0];
    if (!field) return;
    onChange([...conditions, { field: field.name, op: 'eq', value: '' }]);
  };
  const updateCondition = (i: number, patch: Partial<AutomationCondition>) => {
    onChange(conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  };
  const removeCondition = (i: number) => {
    onChange(conditions.filter((_, idx) => idx !== i));
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm font-medium text-muted">If (optional - leave empty to always run)</label>
        <Button variant="ghost" size="sm" leftIcon={<PlusIcon className="w-3.5 h-3.5" />} onClick={addCondition}>
          Add condition
        </Button>
      </div>
      {conditions.length === 0 ? (
        <p className="text-xs text-subtle">No conditions - this rule runs every time the trigger fires.</p>
      ) : (
        <div className="space-y-2">
          {conditions.map((c, i) => {
            const operator = operators.find((o) => o.op === c.op);
            return (
              <div key={i} className="flex items-center gap-2">
                <select
                  value={c.field}
                  onChange={(e) => updateCondition(i, { field: e.target.value })}
                  className="flex-1 px-3 py-2 rounded-lg text-sm focus:outline-none"
                  style={{ background: 'var(--color-surfaceHover)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
                >
                  {trigger.fields.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
                </select>
                <select
                  value={c.op}
                  onChange={(e) => updateCondition(i, { op: e.target.value })}
                  className="px-3 py-2 rounded-lg text-sm focus:outline-none"
                  style={{ background: 'var(--color-surfaceHover)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
                >
                  {operators.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                </select>
                {!operator?.unary && (
                  <input
                    value={String(c.value ?? '')}
                    onChange={(e) => updateCondition(i, { value: e.target.value })}
                    placeholder="value"
                    className="flex-1 px-3 py-2 rounded-lg text-sm focus:outline-none"
                    style={{ background: 'var(--color-surfaceHover)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
                  />
                )}
                <button onClick={() => removeCondition(i)} className="p-2 rounded-lg text-muted hover:text-error hover:bg-error-muted transition-colors shrink-0">
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActionBuilder({
  registry, actions, onChange,
}: {
  registry: AutomationRegistry;
  actions: AutomationActionConfig[];
  onChange: (next: AutomationActionConfig[]) => void;
}) {
  const addAction = () => {
    const first = registry.actions[0];
    if (!first) return;
    onChange([...actions, { type: first.type, config: {} }]);
  };
  const updateAction = (i: number, patch: Partial<AutomationActionConfig>) => {
    onChange(actions.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  };
  const removeAction = (i: number) => {
    onChange(actions.filter((_, idx) => idx !== i));
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm font-medium text-muted">Then</label>
        <Button variant="ghost" size="sm" leftIcon={<PlusIcon className="w-3.5 h-3.5" />} onClick={addAction}>
          Add action
        </Button>
      </div>
      <div className="space-y-3">
        {actions.map((action, i) => {
          const def = registry.actions.find((a) => a.type === action.type);
          return (
            <div key={i} className="p-3 rounded-xl bg-surface-hover space-y-2">
              <div className="flex items-center gap-2">
                <select
                  value={action.type}
                  onChange={(e) => updateAction(i, { type: e.target.value, config: {} })}
                  className="flex-1 px-3 py-2 rounded-lg text-sm focus:outline-none"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
                >
                  {registry.actions.map((a) => <option key={a.type} value={a.type}>{a.label}</option>)}
                </select>
                <button onClick={() => removeAction(i)} className="p-2 rounded-lg text-muted hover:text-error hover:bg-error-muted transition-colors shrink-0">
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
              {def?.description && <p className="text-xs text-muted">{def.description}</p>}
              {def?.configFields.map((field) => (
                <ActionConfigField
                  key={field.name}
                  field={field}
                  value={action.config[field.name] || ''}
                  onChange={(v) => updateAction(i, { config: { ...action.config, [field.name]: v } })}
                />
              ))}
            </div>
          );
        })}
        {actions.length === 0 && <p className="text-xs text-subtle">No actions yet - add at least one.</p>}
      </div>
    </div>
  );
}

function ActionConfigField({
  field, value, onChange,
}: {
  field: AutomationRegistry['actions'][number]['configFields'][number];
  value: string;
  onChange: (v: string) => void;
}) {
  const [options, setOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [loadingOptions, setLoadingOptions] = useState(field.type === 'addon' || field.type === 'group' || field.type === 'user');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        if (field.type === 'addon') {
          const addons = await api.getAddons();
          if (!cancelled) setOptions(addons.map((a) => ({ id: a.id, name: a.name })));
        } else if (field.type === 'group') {
          const groups = await api.getGroups();
          if (!cancelled) setOptions(groups.map((g) => ({ id: g.id, name: g.name })));
        } else if (field.type === 'user') {
          const users = await api.getUsers();
          if (!cancelled) setOptions(users.map((u) => ({ id: u.id, name: u.username || u.name || u.email || 'Unnamed user' })));
        }
      } catch { /* picker just shows empty - the text-level validation error on save still catches a missing required pick */ }
      finally { if (!cancelled) setLoadingOptions(false); }
    }
    if (field.type === 'addon' || field.type === 'group' || field.type === 'user') load();
    return () => { cancelled = true; };
  }, [field.type]);

  const inputStyle = { background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' };

  if (field.type === 'addon' || field.type === 'group' || field.type === 'user') {
    return (
      <div>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={loadingOptions}
          className="w-full px-3 py-2 rounded-lg text-sm focus:outline-none"
          style={inputStyle}
        >
          <option value="">{loadingOptions ? 'Loading...' : `Select ${field.label.toLowerCase()}...`}</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        {field.hint && <p className="text-xs text-subtle mt-1">{field.hint}</p>}
      </div>
    );
  }

  if (field.type === 'text') {
    return (
      <div>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.label}
          rows={2}
          className="w-full px-3 py-2 rounded-lg text-sm focus:outline-none resize-none"
          style={inputStyle}
        />
        {field.hint && <p className="text-xs text-subtle mt-1">{field.hint}</p>}
      </div>
    );
  }

  return (
    <div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.label}
        className="w-full px-3 py-2 rounded-lg text-sm focus:outline-none"
        style={inputStyle}
      />
      {field.hint && <p className="text-xs text-subtle mt-1">{field.hint}</p>}
    </div>
  );
}
