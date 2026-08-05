'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { userAuth, UserInfo, UserApiError } from '@/lib/user-api';

const STORAGE_KEY = 'slicksync-user-auth';

type Provider = 'stremio' | 'nuvio';

// authKey holds the caller's own bearer credential for whichever provider:
// for Stremio, the real Stremio authKey; for Nuvio, a SlickSync-issued
// session token (never the raw Nuvio refresh token, which stays server-side
// only) obtained at login/validate. Previously Nuvio held nothing here at
// all - only userId + provider were needed to re-validate via
// /validate-nuvio, which meant a bare userId (visible to any other
// household member, or an admin) was sufficient to "restore" a session as
// literally anyone. Fixed to require real proof of possession, matching
// Stremio's existing model.
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
  deleteAccount: () => Promise<{ success: boolean; error?: string }>;
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
        // Both providers now require a real caller-held credential to
        // restore a session - a pre-fix Nuvio session with no stored token
        // can no longer be silently trusted, so it's dropped here same as
        // any other invalid stored session (falls through to a fresh login).
        if (!data.userId || !data.authKey) {
          localStorage.removeItem(STORAGE_KEY);
          setIsLoading(false);
          return;
        }

        // Validate the stored session
        const result = dataProvider === 'nuvio'
          ? await userAuth.validateNuvio(data.userId, data.authKey)
          : await userAuth.validate(data.authKey, data.userId);

        if (result.valid) {
          // Nuvio reissues a fresh session token on every successful
          // validate (sliding expiry) - use that going forward, not the
          // one that was just spent.
          const currentAuthKey = (dataProvider === 'nuvio' && result.sessionToken) ? result.sessionToken : data.authKey;
          setUserId(data.userId);
          setProvider(dataProvider);
          setAuthKey(currentAuthKey || null);
          setUserInfo(data.userInfo);

          // Refresh user info in background
          try {
            const freshInfo = await userAuth.getUserInfo(data.userId, currentAuthKey);
            setUserInfo(freshInfo);
            // Update storage with fresh info
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
              userId: data.userId,
              provider: dataProvider,
              authKey: currentAuthKey,
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

  // Login with a completed Nuvio device-code exchange. The exchange result
  // proves identity to the SERVER, which issues a SlickSync session token
  // in response - that token (not the raw Nuvio refresh token, which never
  // leaves the server) is what's held client-side from here on, the same
  // role Stremio's authKey plays.
  const loginNuvio = useCallback(async (code: string, deviceNonce: string, anonToken: string): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true);
    setError(null);
    setErrorCode(null);

    try {
      const result = await userAuth.authenticateNuvio(code, deviceNonce, anonToken);

      if (result.success && result.userId && result.userInfo && result.sessionToken) {
        setUserId(result.userId);
        setProvider('nuvio');
        setAuthKey(result.sessionToken);
        setUserInfo(result.userInfo);

        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          userId: result.userId,
          provider: 'nuvio',
          authKey: result.sessionToken,
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

  // Self-service "delete my account" - permanently removes only this user's
  // own row and data. logout()'s local cleanup runs regardless of provider
  // since there's nothing left server-side to keep a session valid against.
  const deleteAccount = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    if (!userId || !provider) {
      return { success: false, error: 'Not signed in' };
    }
    try {
      await userAuth.deleteAccount(userId, provider, authKey || undefined);
      logout();
      return { success: true };
    } catch (err) {
      const errorMsg = err instanceof UserApiError ? err.message : 'Failed to delete account';
      return { success: false, error: errorMsg };
    }
  }, [userId, provider, authKey, logout]);

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
    deleteAccount,
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
