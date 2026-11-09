'use client';

import { createContext, useContext, useState, useCallback, useMemo, ReactNode } from 'react';
import { api } from '@/lib/api';

interface UserData {
  id: string;
  name: string;
  email?: string;
  colorIndex?: number;
  /** Their own picture, so places that only know the id show it too. */
  avatarUrl?: string | null;
  useGravatar?: boolean;
}

interface UserCacheContextType {
  getUser: (userId: string) => UserData | undefined;
  fetchUser: (userId: string) => Promise<UserData | undefined>;
}

const UserCacheContext = createContext<UserCacheContextType | undefined>(undefined);

export function UserCacheProvider({ children }: { children: ReactNode }) {
  const [userCache, setUserCache] = useState<Map<string, UserData>>(new Map());

  const getUser = useCallback((userId: string) => {
    return userCache.get(userId);
  }, [userCache]);

  const fetchUser = useCallback(async (userId: string): Promise<UserData | undefined> => {
    // Return cached user if available
    if (userCache.has(userId)) {
      return userCache.get(userId);
    }

    try {
      // Fetch user from API
      const user = await api.getUser(userId);
      if (user) {
        const userData: UserData = {
          id: user.id,
          name: user.username || user.name || 'Unknown',
          email: user.email,
          colorIndex: user.colorIndex,
          avatarUrl: user.avatarUrl ?? null,
          useGravatar: user.useGravatar === true,
        };
        
        // Cache the user data
        setUserCache(prev => {
          const newCache = new Map(prev);
          newCache.set(userId, userData);
          return newCache;
        });
        
        return userData;
      }
    } catch (error) {
      console.warn(`[UserCache] Failed to fetch user ${userId}:`, error);
    }
    
    return undefined;
  }, [userCache]);

  // The same object until the cache itself changes - a new one on every
  // render of the app's root re-rendered everything reading it.
  const value = useMemo(() => ({ getUser, fetchUser }), [getUser, fetchUser]);

  return (
    <UserCacheContext.Provider value={value}>
      {children}
    </UserCacheContext.Provider>
  );
}

export function useUserCache() {
  const context = useContext(UserCacheContext);
  if (!context) {
    throw new Error('useUserCache must be used within a UserCacheProvider');
  }
  return context;
}
