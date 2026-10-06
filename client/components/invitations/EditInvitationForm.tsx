'use client';

import { useState } from 'react';
import { Button, Input, Select } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { api, Group } from '@/lib/api';
import { InviteJellyfinAccountPicker } from '@/components/jellyfin/InviteJellyfinAccountPicker';

/** What the edit form needs from an invitation - shared by the Invitations
 *  list and an invitation's own page, so both edit it the same way. */
export interface EditableInvitation {
  id: string;
  name?: string;
  code: string;
  groupId?: string;
  /** The group it names - shown when that group no longer exists. */
  groupName?: string;
  maxUses?: number;
  uses: number;
  membershipDuration?: number;
  syncOnJoin: boolean;
  jellyfinServerKey?: string | null;
}

export function EditInvitationForm({
  invitation,
  groups,
  onClose,
}: {
  invitation: EditableInvitation;
  groups: Group[];
  onClose: () => void;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: invitation.name || '',
    groupId: invitation.groupId || '',
    maxUses: invitation.maxUses?.toString() || '',
    membershipDuration: invitation.membershipDuration?.toString() || '',
    syncOnJoin: invitation.syncOnJoin,
  });
  const [jellyfinServerKey, setJellyfinServerKey] = useState<string | null>(invitation.jellyfinServerKey || null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const selectedGroup = groups.find(g => g.id === formData.groupId);
      await api.updateInvitation(invitation.id, {
        jellyfinServerKey,
        name: formData.name || undefined,
        groupId: formData.groupId || undefined,
        groupName: selectedGroup?.name || undefined,
        maxUses: formData.maxUses ? parseInt(formData.maxUses) : undefined,
        membershipDuration: formData.membershipDuration ? parseInt(formData.membershipDuration) : undefined,
        syncOnJoin: formData.syncOnJoin,
      });
      toast.success('Invitation updated successfully');
      onClose();
      // Refresh page to show updated invitation
      window.location.reload();
    } catch (err: unknown) {
      toast.error((err as Error)?.message || 'Failed to update invitation');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="p-4 rounded-xl bg-subtle border border-default">
        <p className="text-sm text-muted mb-1">Invite Code</p>
        <code className="text-lg font-mono text-primary">{invitation.code}</code>
      </div>

      <Input
        label="Invitation Name"
        placeholder="e.g., Friends & Family"
        value={formData.name}
        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
        hint="Optional. If empty, the invite code will be used as the name."
      />

      <Select
        label="Assign to Group"
        options={[
          { value: '', label: 'No group (assign later)' },
          ...groups.map(g => ({ value: g.id, label: g.name })),
        ]}
        value={formData.groupId}
        onChange={(value) => setFormData({ ...formData, groupId: value })}
      />
      {invitation.groupName && !invitation.groupId && !formData.groupId && (
        <p className="-mt-4 text-xs text-warning">
          Its group, {invitation.groupName}, was deleted. Pick another so people who join are put in one.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          label="Max Uses"
          type="number"
          placeholder="Unlimited"
          value={formData.maxUses}
          onChange={(e) => setFormData({ ...formData, maxUses: e.target.value })}
          hint="Leave empty for unlimited"
        />
        <div>
          <p className="text-sm font-medium mb-2 text-muted">Current Usage</p>
          <p className="text-default font-medium">{invitation.uses} uses</p>
        </div>
      </div>

      <Select
        label="Membership Duration"
        options={[
          { value: '', label: 'Permanent' },
          { value: '7', label: '7 days' },
          { value: '30', label: '30 days' },
          { value: '90', label: '90 days' },
          { value: '365', label: '1 year' },
        ]}
        value={formData.membershipDuration}
        onChange={(value) => setFormData({ ...formData, membershipDuration: value })}
      />

      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={formData.syncOnJoin}
          onChange={(e) => setFormData({ ...formData, syncOnJoin: e.target.checked })}
          className="w-5 h-5 rounded bg-subtle border-default accent-primary"
        />
        <div>
          <p className="font-medium text-default">Sync on Join</p>
          <p className="text-sm text-muted">Automatically sync addons when user joins</p>
        </div>
      </label>

      <InviteJellyfinAccountPicker value={jellyfinServerKey} onChange={setJellyfinServerKey} />

      <div className="flex gap-3 justify-end pt-4">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" isLoading={isLoading}>
          Save Changes
        </Button>
      </div>
    </form>
  );
}
