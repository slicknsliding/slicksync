'use client';

// Referral badge next to the admin panel switcher (NebulaTopbar + Sidebar) -
// admin-only by design, not shown in the managed-user self-service panel
// (UserSidebar), since a referral code has no business being shown to every
// family member logging into their own account.
export function TorBoxBadge({ size = 36 }: { size?: number }) {
  return (
    <a
      href="https://torbox.app/subscription?referral=790ccd5b-646d-43d7-9072-aef7a6eb1de8"
      target="_blank"
      rel="noopener noreferrer"
      title="TorBox"
      className="flex items-center justify-center rounded-lg shrink-0 transition-transform hover:scale-105"
      style={{ width: size, height: size }}
    >
      <img src="https://torbox.app/assets/logo-bb7a9579.svg" alt="TorBox" className="w-full h-full" />
    </a>
  );
}
