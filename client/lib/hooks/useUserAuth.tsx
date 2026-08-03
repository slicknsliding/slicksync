'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { userAuth, UserInfo, UserApiError } from '@/lib/user-api';

const STORAGE_KEY = 'slicksync-user-auth';

type Provider = 'stremio' | 'nuvio';

// authKey is only present for Stremio - Nuvio's credential (a refresh
// token) is never held client-side, only userId + provider are needed to
// re-validate later via /validate-nuvio, which takes just userId.
interface StoredAuth {
  userId: string;
  provider: Provider;
  authKey?: string;
  userInfo: UserInfo;
}

interface UserAuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  userId: string | null;
  provider: Provider | null;
  authKey: string | null;
  userInfo: UserInfo | null;
  error: string | null;
  errorCode: string | null;
  login: (authKey: string) => Promise<{ success: boolean; error?: string }>;
  loginNuvio: (code: string, deviceNonce: string, anonToken: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  refreshUserInfo: () => Promise<void>;
}

const UserAuthContext = createContext<UserAuthContextType | null>(null);

interface UserAuthProviderProps {
  children: ReactNode;
}

export function UserAuthProvider({ children }: UserAuthProviderProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [authKey, setAuthKey] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // Load stored auth on mount
  useEffect(() => {
    const loadStoredAuth = async () => {
      if (typeof window === 'undefined') {
        setIsLoading(false);
        return;
      }

      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) {
        setIsLoading(false);
        return;
      }

      try {
        const data: StoredAuth = JSON.parse(stored);
        // Older sessions predate the provider field - treat as Stremio,
        // same as the server's own `providerType || 'stremio'` default.
        const dataProvider: Provider = data.provider || 'stremio';
        if (!data.userId || (dataProvider === 'stremio' && !data.authKey)) {
          localStorage.removeItem(STORAGE_KEY);
          setIsLoading(false);
          return;
        }

        // Validate the stored session
        const result = dataProvider === 'nuvio'
          ? await userAuth.validateNuvio(data.userId)
          : await userAuth.validate(data.authKey!, data.userId);

        if (result.valid) {
          setUserId(data.userId);
          setProvider(dataProvider);
          setAuthKey(data.authKey || null);
          setUserInfo(data.userInfo);

          // Refresh user info in background
          try {
            const freshInfo = await userAuth.getUserInfo(data.userId, data.authKey);
            setUserInfo(freshInfo);
            // Update storage with fresh info
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
              userId: data.userId,
              provider: dataProvider,
              authKey: data.authKey,
              userInfo: freshInfo,
            }));
          } catch {
            // Use cached info if refresh fails
          }
        } else {
          // Invalid session - clear storage
          localStorage.removeItem(STORAGE_KEY);
          setError(result.error || 'Session expired');
          setErrorCode(result.errorCode || null);
        }
      } catch (err) {
        // Failed to validate - clear storage
        localStorage.removeItem(STORAGE_KEY);
        if (err instanceof UserApiError) {
          setError(err.message);
        }
      } finally {
        setIsLoading(false);
      }
    };

    loadStoredAuth();
  }, []);

  // Login with Stremio auth key
  const login = useCallback(async (newAuthKey: string): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true);
    setError(null);
    setErrorCode(null);

    try {
      const result = await userAuth.authenticate(newAuthKey);

      if (result.success && result.userId && result.userInfo) {
        setUserId(result.userId);
        setProvider('stremio');
        setAuthKey(newAuthKey);
        setUserInfo(result.userInfo);

        // Store in localStorage
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          userId: result.userId,
          provider: 'stremio',
          authKey: newAuthKey,
          userInfo: result.userInfo,
        }));

        return { success: true };
      } else {
        const errorMsg = result.error || 'Authentication failed';
        setError(errorMsg);
        setErrorCode(result.errorCode || null);
        return { success: false, error: errorMsg };
      }
    } catch (err) {
      let errorMsg = 'Authentication failed';
      if (err instanceof UserApiError) {
        errorMsg = err.message;
        setError(errorMsg);
      } else {
        setError(errorMsg);
      }
      return { success: false, error: errorMsg };
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Login with a completed Nuvio device-code exchange - unlike Stremio,
  // there's no client-held credential to store; the exchange result
  // itself is the proof of identity (see getPublicUserNuvio server-side).
  const loginNuvio = useCallback(async (code: string, deviceNonce: string, anonToken: string): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true);
    setError(null);
    setErrorCode(null);

    try {
      const result = await userAuth.authenticateNuvio(code, deviceNonce, anonToken);

      if (result.success && result.userId && result.userInfo) {
        setUserId(result.userId);
        setProvider('nuvio');
        setAuthKey(null);
        setUserInfo(result.userInfo);

        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          userId: result.userId,
          provider: 'nuvio',
          userInfo: result.userInfo,
        }));

        return { success: true };
      } else {
        const errorMsg = result.error || 'Authentication failed';
        setError(errorMsg);
        setErrorCode(result.errorCode || null);
        return { success: false, error: errorMsg };
      }
    } catch (err) {
      let errorMsg = 'Authentication failed';
      if (err instanceof UserApiError) {
        errorMsg = err.message;
        setError(errorMsg);
      } else {
        setError(errorMsg);
      }
      return { success: false, error: errorMsg };
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Logout
  const logout = useCallback(() => {
    setUserId(null);
    setProvider(null);
    setAuthKey(null);
    setUserInfo(null);
    setError(null);
    setErrorCode(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  // Refresh user info
  const refreshUserInfo = useCallback(async () => {
    if (!userId) return;

    try {
      const freshInfo = await userAuth.getUserInfo(userId, authKey || undefined);
      setUserInfo(freshInfo);

      // Update storage
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        userId,
        provider: provider || 'stremio',
        authKey,
        userInfo: freshInfo,
      }));
    } catch (err) {
      console.error('Failed to refresh user info:', err);
    }
  }, [userId, provider, authKey]);

  const value: UserAuthContextType = {
    isAuthenticated: !!userId && (provider === 'nuvio' || !!authKey),
    isLoading,
    userId,
    provider,
    authKey,
    userInfo,
    error,
    errorCode,
    login,
    loginNuvio,
    logout,
    refreshUserInfo,
  };

  return (
    <UserAuthContext.Provider value={value}>
      {children}
    </UserAuthContext.Provider>
  );
}

export function useUserAuth() {
  const context = useContext(UserAuthContext);
  if (!context) {
    throw new Error('useUserAuth must be used within a UserAuthProvider');
  }
  return context;
}

// Helper hook to get auth headers for API calls
export function useUserAuthHeaders() {
  const { userId, authKey, provider } = useUserAuth();

  return {
    userId,
    authKey,
    provider,
    isReady: !!userId,
  };
}
