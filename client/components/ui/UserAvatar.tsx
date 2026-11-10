'use client';

import { useEffect, useState } from 'react';
import { Avatar } from '@/components/ui';
import { useUserCache } from '@/components/providers/UserCacheProvider';

interface UserAvatarProps {
  userId: string;
  name?: string;
  email?: string;
  src?: string;
  useGravatar?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  showRing?: boolean;
  status?: 'online' | 'offline' | 'away';
  colorIndex?: number;
  className?: string;
  imgClassName?: string;
  avatarClassName?: string;
}

export function UserAvatar({ 
  userId, 
  name, 
  email: providedEmail, 
  src,
  useGravatar,
  size = 'md',
  showRing = false, 
  status,
  colorIndex: providedColorIndex,
  className,
  imgClassName,
  avatarClassName
}: UserAvatarProps) {
  const { getUser, fetchUser } = useUserCache();
  const [userData, setUserData] = useState<{ name: string; email?: string; colorIndex?: number; avatarUrl?: string | null; useGravatar?: boolean } | null>(null);
  const [isLoading, setIsLoading] = useState(!providedEmail);

  useEffect(() => {
    // If email is provided, use it directly
    if (providedEmail) {
      setUserData({ 
        name: name || 'Unknown', 
        email: providedEmail,
        colorIndex: providedColorIndex 
      });
      setIsLoading(false);
      return;
    }

    // Otherwise, try to get from cache or fetch
    const loadUser = async () => {
      // Check cache first
      const cached = getUser(userId);
      if (cached) {
        setUserData(cached);
        setIsLoading(false);
        return;
      }

      // Fetch from API
      const fetched = await fetchUser(userId);
      if (fetched) {
        setUserData(fetched);
      } else {
        // Fallback to provided name or unknown
        setUserData({ 
          name: name || 'Unknown', 
          email: undefined,
          colorIndex: providedColorIndex 
        });
      }
      setIsLoading(false);
    };

    loadUser();
  }, [userId, name, providedEmail, providedColorIndex, getUser, fetchUser]);

  const displayName = userData?.name || name || 'Unknown';
  const email = userData?.email || providedEmail;
  const colorIdx = userData?.colorIndex ?? providedColorIndex;

  return (
    <Avatar 
      name={displayName} 
      email={email} 
      // A caller that passes only the id still gets the person's own picture.
      src={src ?? ((useGravatar ?? userData?.useGravatar) ? undefined : (userData?.avatarUrl || undefined))}
      useGravatar={useGravatar ?? userData?.useGravatar}
      size={size}
      showRing={showRing}
      status={status}
      colorIndex={colorIdx}
      className={className}
      imgClassName={imgClassName}
      avatarClassName={avatarClassName}
    />
  );
}
