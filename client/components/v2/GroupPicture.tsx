'use client';

// A group's own picture in v2 (the one set with Change picture or colour),
// ringed in the group's colour; a group without one shows its colour and
// initials. Also the soft wash of the group's colour at the top of its cards.

import { Avatar, avatarColorFill } from '@/components/ui/Avatar';

const SIZE = { xs: 24, sm: 32, md: 40, lg: 48, xl: 64, '2xl': 96 } as const;

export function GroupPicture({ name, avatarUrl, colorIndex, size = 'lg', ring = true, dim = false }: {
  name: string;
  avatarUrl?: string | null;
  colorIndex?: number;
  size?: keyof typeof SIZE;
  /** A ring in the group's colour around the picture. */
  ring?: boolean;
  /** Switched-off groups are drawn faded. */
  dim?: boolean;
}) {
  const px = SIZE[size];
  const colour = avatarColorFill(colorIndex ?? 0);
  return (
    <span
      className="inline-flex shrink-0"
      style={{
        borderRadius: Math.round(px * 0.3),
        boxShadow: ring ? `0 0 0 2px var(--color-bg), 0 0 0 4px color-mix(in srgb, ${colour} 70%, transparent)` : undefined,
        opacity: dim ? 0.5 : 1,
      }}
    >
      <Avatar
        name={name}
        src={avatarUrl || undefined}
        colorIndex={colorIndex}
        size={size}
        className="!rounded-[30%]"
        avatarClassName="!rounded-[30%]"
      />
    </span>
  );
}

/** The soft wash of a group's colour at the top of a card. */
export function groupWash(colorIndex?: number): React.CSSProperties {
  const colour = avatarColorFill(colorIndex ?? 0);
  return { background: `linear-gradient(180deg, color-mix(in srgb, ${colour} 16%, var(--color-surface)) 0%, var(--color-surface) 46%)` };
}
