'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowTopRightOnSquareIcon,
  ClipboardIcon,
  CheckIcon,
  ArrowPathIcon,
  UserIcon,
  ShieldCheckIcon,
  ArrowRightIcon,
} from '@heroicons/react/24/outline';
import { userOAuth, userAuth as userAuthApi } from '@/lib/user-api';
import { SlickSyncLogo } from '@/components/ui/SlickSyncLogo';
import { PasswordToggleButton } from '@/components/ui/Input';
import { api } from '@/lib/api';
import { useUserAuth, UserAuthProvider } from '@/lib/hooks/useUserAuth';

type LoginMode = 'user' | 'admin';

function LoginContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { login: userLogin, loginNuvio, isAuthenticated } = useUserAuth();

  // Mode state
  const initialMode = (searchParams.get('mode') as LoginMode) || 'user';
  const [mode, setMode] = useState<LoginMode>(initialMode);
  const INSTANCE_TYPE = (process.env.NEXT_PUBLIC_INSTANCE_TYPE || 'private') as 'public' | 'private';

  // Admin login state
  const [adminUsername, setAdminUsername] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminPasswordVisible, setAdminPasswordVisible] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminLoading, setAdminLoading] = useState(false);
  // 2FA step - set only when /login or /private-login responds with
  // requiresTwoFactor (see server/utils/twoFactor.js). pendingToken is a
  // one-shot opaque token, not a session credential - it's useless for
  // anything except completing this one login via /verify-2fa.
  const [twoFactorPendingToken, setTwoFactorPendingToken] = useState<string | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [twoFactorVerifying, setTwoFactorVerifying] = useState(false);

  // OIDC/SSO - operator-configured via env vars (server/utils/oidc.js), so
  // the only client-side state is "is it configured at all" (from a public
  // config endpoint) plus whatever the callback redirect handed back.
  const [oidcConfigured, setOidcConfigured] = useState(false);
  const [oidcDisplayName, setOidcDisplayName] = useState('SSO');
  const [adminLoginType, setAdminLoginType] = useState<'credentials' | 'stremio' | 'nuvio'>(
    searchParams.get('linkStremio') === '1' && initialMode === 'admin' ? 'stremio'
      : searchParams.get('linkNuvio') === '1' && initialMode === 'admin' ? 'nuvio'
      : 'credentials'
  );
  // User-mode's own provider tab - separate from adminLoginType since a
  // managed User has no "credentials" option (no UUID/password), just
  // Stremio or Nuvio. Shares the same underlying nuvio*/oauth* state below
  // with the admin flows (start/poll mechanics are identical either way,
  // only the exchange step at the end differs by mode).
  const [userLoginType, setUserLoginType] = useState<'stremio' | 'nuvio'>('stremio');
  const [checkingAuth, setCheckingAuth] = useState(INSTANCE_TYPE !== 'public');

  // Nuvio admin OAuth state - separate from the Stremio OAuth state below
  // since Nuvio's device-code flow needs its own code/deviceNonce/anonToken
  // tracked across start -> poll -> login, unlike Stremio's single-code poll.
  const [nuvioCode, setNuvioCode] = useState<string>('');
  const [nuvioWebUrl, setNuvioWebUrl] = useState<string | null>(null);
  const [nuvioExpiresAt, setNuvioExpiresAt] = useState<string | null>(null);
  const [nuvioDeviceNonce, setNuvioDeviceNonce] = useState<string>('');
  const [nuvioAnonToken, setNuvioAnonToken] = useState<string>('');
  const [isNuvioGenerating, setIsNuvioGenerating] = useState(false);
  const [isNuvioPolling, setIsNuvioPolling] = useState(false);
  const [isNuvioAuthenticating, setIsNuvioAuthenticating] = useState(false);
  const [nuvioError, setNuvioError] = useState<string | null>(null);
  const [nuvioTimeLeft, setNuvioTimeLeft] = useState<string | null>(null);
  const [nuvioCopied, setNuvioCopied] = useState(false);
  const nuvioPollIntervalRef = useRef<number | null>(null);
  const nuvioTimerIntervalRef = useRef<number | null>(null);
  // Guards the auto-generate effect below against retry-storming: on a
  // failed generate (network hiccup, rate limit), isNuvioGenerating resets
  // to false while nuvioCode stays empty, so without this the effect's own
  // dependency change re-fires it immediately, forever, with no backoff -
  // confirmed hitting the rate limiter within seconds while testing this.
  const nuvioAutoStartedRef = useRef(false);
  // Same guard, same reason, for the Stremio auto-generate effect further
  // down - a failed generateOAuthLink() leaves oauthLink empty and
  // isGenerating false, so the effect would otherwise re-fire immediately
  // with no backoff. The always-visible "Refresh" button below is the
  // manual retry path once auto-generate has given up for this tab-visit.
  const stremioAutoStartedRef = useRef(false);

  // OIDC config + handling the redirect back from /api/auth/oidc/callback:
  // ?otp=<pendingToken> means the OIDC identity checked out but this
  // account also has 2FA enabled - drop straight into the code-entry step
  // rather than making them pick "Admin" and hit a password form they
  // don't need. ?oidcError=<message> surfaces a failure the same way a
  // failed password attempt would.
  useEffect(() => {
    fetch('/api/auth/oidc/config')
      .then((r) => r.json())
      .then((data) => {
        setOidcConfigured(!!data.configured);
        if (data.displayName) setOidcDisplayName(data.displayName);
      })
      .catch(() => {});

    const otp = searchParams.get('otp');
    const oidcError = searchParams.get('oidcError');
    if (otp) {
      setMode('admin');
      setAdminLoginType('credentials');
      setTwoFactorPendingToken(otp);
    } else if (oidcError) {
      setMode('admin');
      setAdminLoginType('credentials');
      setAdminError(oidcError);
    }
    // Strip these from the URL so a refresh doesn't resubmit/re-show them.
    if (otp || oidcError) {
      const cleaned = new URLSearchParams(searchParams.toString());
      cleaned.delete('otp');
      cleaned.delete('oidcError');
      router.replace(`/login${cleaned.toString() ? `?${cleaned.toString()}` : ''}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStartOidc = () => {
    window.location.href = '/api/auth/oidc/start';
  };

  // Check if auth is required for private instance
  useEffect(() => {
    if (INSTANCE_TYPE !== 'public' && mode === 'admin') {
      const checkAuth = async () => {
        try {
          // Try to access a protected endpoint
          // If it succeeds, auth is disabled
          const response = await fetch('/api/ext/account');
          if (response.ok) {
            router.push('/');
            return;
          }
        } catch (e) {
          // Ignore error, show login form
        } finally {
          setCheckingAuth(false);
        }
      };
      checkAuth();
    } else {
      setCheckingAuth(false);
    }
  }, [INSTANCE_TYPE, router, mode]);

  // User OAuth state
  const [oauthLink, setOAuthLink] = useState<string | null>(null);
  const [oauthCode, setOAuthCode] = useState<string>('');
  const [oauthExpiresAt, setOAuthExpiresAt] = useState<number | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<string | null>(null);

  // Refs for cleanup
  const pollIntervalRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<number | null>(null);

  // Check if OAuth is expired
  const isExpired = oauthExpiresAt ? oauthExpiresAt < Date.now() : false;

  // Redirect if already authenticated in user mode
  useEffect(() => {
    if (mode === 'user' && isAuthenticated) {
      router.push('/user');
    }
  }, [mode, isAuthenticated, router]);

  // Timer countdown
  useEffect(() => {
    // Timer applies to Stremio login only, in either mode
    const onStremioTab = mode === 'admin' ? adminLoginType === 'stremio' : userLoginType === 'stremio';
    if (!oauthExpiresAt || isExpired || !onStremioTab) {
      setTimeLeft(null);
      return;
    }

    const updateTimer = () => {
      const diff = Math.max(0, oauthExpiresAt - Date.now());
      if (diff === 0) {
        setTimeLeft('Expired');
        setIsPolling(false);
        return;
      }
      const minutes = Math.floor(diff / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      setTimeLeft(`${minutes}:${seconds.toString().padStart(2, '0')}`);
    };

    updateTimer();
    timerIntervalRef.current = window.setInterval(updateTimer, 1000);

    return () => {
      if (timerIntervalRef.current) {
        window.clearInterval(timerIntervalRef.current);
      }
    };
  }, [oauthExpiresAt, isExpired, mode]);

  // Poll for OAuth completion
  useEffect(() => {
    if (!isPolling || !oauthCode || isExpired || isAuthenticating) {
      return;
    }

    const poll = async () => {
      try {
        const pollResult = await userOAuth.poll(oauthCode);

        if (pollResult.success && pollResult.authKey) {
          setIsPolling(false);
          if (pollIntervalRef.current) {
            window.clearInterval(pollIntervalRef.current);
          }

          setIsAuthenticating(true);

          if (mode === 'admin') {
            // Admin Stremio Login
            try {
              const result = await api.stremioLogin(pollResult.authKey);
              if (result.token || result.account) {
                if (result.token) {
                  localStorage.setItem('slicksync-admin-token', result.token);
                }
                router.push('/');
              } else {
                setAdminError('Failed to link Stremio account to admin');
                setIsAuthenticating(false);
              }
            } catch (err: any) {
              setAdminError(err.message || 'Stremio login failed');
              setIsAuthenticating(false);
            }
          } else {
            // User Stremio Login
            const authResult = await userLogin(pollResult.authKey);
            if (authResult.success) {
              router.push('/user');
            } else {
              setUserError(authResult.error || 'Failed to authenticate. Please try again.');
              setIsAuthenticating(false);
            }
          }
        } else if (pollResult.error) {
          if (mode === 'admin') setAdminError(pollResult.error);
          else setUserError(pollResult.error);
        }
      } catch (err) {
        // Silently handle polling errors
      }
    };

    poll();
    pollIntervalRef.current = window.setInterval(poll, 3000);

    return () => {
      if (pollIntervalRef.current) {
        window.clearInterval(pollIntervalRef.current);
      }
    };
  }, [isPolling, oauthCode, isExpired, isAuthenticating, mode, userLogin, router]);

  // Generate OAuth link
  const generateOAuthLink = useCallback(async () => {
    if (isGenerating) return;

    setIsGenerating(true);
    setAdminError(null);
    setUserError(null);

    try {
      const result = await userOAuth.create();
      setOAuthLink(result.link);
      setOAuthCode(result.code);
      setOAuthExpiresAt(result.expiresAt);
      setIsPolling(true);
    } catch (err: any) {
      if (mode === 'admin') setAdminError(err?.message || 'Failed to generate link');
      else setUserError(err?.message || 'Failed to generate OAuth link');
    } finally {
      setIsGenerating(false);
    }
  }, [isGenerating, mode]);

  // Auto-generate OAuth link. Fires at most once per tab-selection - see
  // stremioAutoStartedRef's own comment for why a plain !oauthLink check
  // isn't safe here.
  useEffect(() => {
    // Generate if user mode on the stremio tab, OR admin mode on its stremio tab
    const shouldGenerate = (mode === 'user' && userLoginType === 'stremio') || (mode === 'admin' && adminLoginType === 'stremio');
    if (!shouldGenerate) {
      stremioAutoStartedRef.current = false;
      return;
    }
    if (!oauthLink && !isGenerating && !stremioAutoStartedRef.current) {
      stremioAutoStartedRef.current = true;
      generateOAuthLink();
    }
  }, [mode, adminLoginType, userLoginType, oauthLink, isGenerating, generateOAuthLink]);

  // Nuvio admin OAuth - kept as one self-contained function (start, countdown,
  // poll, login) rather than split across effects like the Stremio flow
  // above, matching how the same start/poll/exchange sequence is already
  // done in CreateUserModal's Nuvio OAuth step.
  const stopNuvioPolling = useCallback(() => {
    setIsNuvioPolling(false);
    if (nuvioPollIntervalRef.current) {
      window.clearInterval(nuvioPollIntervalRef.current);
      nuvioPollIntervalRef.current = null;
    }
  }, []);

  const startNuvioCountdown = useCallback((expiresAt: string) => {
    if (nuvioTimerIntervalRef.current) window.clearInterval(nuvioTimerIntervalRef.current);
    const update = () => {
      const diff = Math.max(0, new Date(expiresAt).getTime() - Date.now());
      if (diff === 0) {
        setNuvioTimeLeft('Expired');
        stopNuvioPolling();
        if (nuvioTimerIntervalRef.current) {
          window.clearInterval(nuvioTimerIntervalRef.current);
          nuvioTimerIntervalRef.current = null;
        }
        return;
      }
      const minutes = Math.floor(diff / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      setNuvioTimeLeft(`${minutes}:${seconds.toString().padStart(2, '0')}`);
    };
    update();
    nuvioTimerIntervalRef.current = window.setInterval(update, 1000);
  }, [stopNuvioPolling]);

  const handleStartNuvioOAuth = useCallback(async () => {
    if (isNuvioGenerating) return;
    setIsNuvioGenerating(true);
    setNuvioError(null);
    try {
      const result = mode === 'admin' ? await api.startNuvioAdminOAuth() : await userOAuth.createNuvio();
      setNuvioCode(result.code);
      setNuvioWebUrl(result.webUrl);
      setNuvioExpiresAt(result.expiresAt);
      setNuvioDeviceNonce(result.deviceNonce);
      setNuvioAnonToken(result.anonToken);
      setIsNuvioPolling(true);
      startNuvioCountdown(result.expiresAt);

      const intervalMs = Math.max(2, result.pollIntervalSeconds || 3) * 1000;
      nuvioPollIntervalRef.current = window.setInterval(async () => {
        try {
          const poll = mode === 'admin'
            ? await api.pollNuvioAdminOAuth({
                code: result.code,
                deviceNonce: result.deviceNonce,
                anonToken: result.anonToken,
              })
            : await userOAuth.pollNuvio(result.code, result.deviceNonce, result.anonToken);
          // Status is opaque (passed through from Nuvio's own session state) -
          // 'pending' means keep waiting; anything else, attempt the login.
          if (poll.status === 'pending') return;

          stopNuvioPolling();
          if (nuvioTimerIntervalRef.current) {
            window.clearInterval(nuvioTimerIntervalRef.current);
            nuvioTimerIntervalRef.current = null;
          }
          setIsNuvioAuthenticating(true);

          if (mode === 'admin') {
            try {
              const loginResult = await api.nuvioLogin({
                code: result.code,
                deviceNonce: result.deviceNonce,
                anonToken: result.anonToken,
              });
              if (loginResult.token || loginResult.account) {
                router.push('/');
              } else {
                setNuvioError('Failed to link Nuvio account to admin');
                setIsNuvioAuthenticating(false);
              }
            } catch (err: any) {
              setNuvioError(err.message || 'Nuvio login failed');
              setIsNuvioAuthenticating(false);
            }
          } else {
            // User Nuvio Login - the completed exchange itself is the proof
            // of identity (see getPublicUserNuvio server-side), unlike the
            // admin path which links/creates an AppAccount.
            const authResult = await loginNuvio(result.code, result.deviceNonce, result.anonToken);
            if (authResult.success) {
              router.push('/user');
            } else {
              setNuvioError(authResult.error || 'Failed to authenticate. Please try again.');
              setIsNuvioAuthenticating(false);
            }
          }
        } catch (err) {
          // Silently handle polling errors, same as the Stremio flow above
        }
      }, intervalMs);
    } catch (err: any) {
      setNuvioError(err?.message || 'Failed to start Nuvio login');
    } finally {
      setIsNuvioGenerating(false);
    }
  }, [isNuvioGenerating, router, startNuvioCountdown, stopNuvioPolling, mode, loginNuvio, userOAuth]);

  // Auto-generate Nuvio OAuth session when its tab is selected (admin's own
  // tab, or the user-mode equivalent). Fires at most once per tab-selection -
  // see nuvioAutoStartedRef's own comment for why a plain !nuvioCode check
  // isn't safe here. A failed attempt leaves the manual "Generate a new
  // code" button (rendered below whenever nuvioError is set) as the retry
  // path instead.
  useEffect(() => {
    const shouldStart = (mode === 'admin' && adminLoginType === 'nuvio') || (mode === 'user' && userLoginType === 'nuvio');
    if (!shouldStart) {
      nuvioAutoStartedRef.current = false;
      return;
    }
    if (!nuvioCode && !isNuvioGenerating && !nuvioAutoStartedRef.current) {
      nuvioAutoStartedRef.current = true;
      handleStartNuvioOAuth();
    }
  }, [mode, adminLoginType, userLoginType, nuvioCode, isNuvioGenerating, handleStartNuvioOAuth]);

  // Clean up Nuvio timers on unmount
  useEffect(() => {
    return () => {
      if (nuvioPollIntervalRef.current) window.clearInterval(nuvioPollIntervalRef.current);
      if (nuvioTimerIntervalRef.current) window.clearInterval(nuvioTimerIntervalRef.current);
    };
  }, []);

  const copyNuvioCode = useCallback(() => {
    if (!nuvioCode) return;
    navigator.clipboard.writeText(nuvioCode);
    setNuvioCopied(true);
    setTimeout(() => setNuvioCopied(false), 2000);
  }, [nuvioCode]);

  const openNuvioLink = useCallback(() => {
    if (!nuvioWebUrl) return;
    window.open(nuvioWebUrl, '_blank', 'noopener,noreferrer');
  }, [nuvioWebUrl]);

  // Handle auto-linking stremio
  useEffect(() => {
    if (searchParams.get('linkStremio') === '1' && oauthLink && !isAuthenticating) {
      window.open(oauthLink, '_blank', 'noopener,noreferrer'); // Redirect in a new tab so they don't lose the polling slicksync page
    }
  }, [searchParams, oauthLink, isAuthenticating]);

  // Copy code
  const copyCode = useCallback(() => {
    if (!oauthCode) return;
    navigator.clipboard.writeText(oauthCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [oauthCode]);

  // Open OAuth link
  const openOAuthLink = useCallback(() => {
    if (!oauthLink) return;
    window.open(oauthLink, '_blank', 'noopener,noreferrer');
  }, [oauthLink]);

  // Admin login
  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminUsername || !adminPassword) return;

    setAdminLoading(true);
    setAdminError(null);

    try {
      const isPublic = INSTANCE_TYPE === 'public';
      const endpoint = isPublic ? '/api/auth/login' : '/api/auth/private-login';
      const payload = isPublic
        ? { uuid: adminUsername, password: adminPassword }
        : { username: adminUsername, password: adminPassword };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (response.ok && data.requiresTwoFactor && data.pendingToken) {
        setTwoFactorPendingToken(data.pendingToken);
        setTwoFactorCode('');
      } else if (response.ok && (data.token || data.account)) {
        // Store admin token and redirect
        // Backend returns token in different fields depending on route
        const token = data.token || response.headers.get('set-cookie');
        if (data.token) {
          localStorage.setItem('slicksync-admin-token', data.token);
        }
        router.push('/');
      } else {
        setAdminError(data.message || 'Invalid credentials');
      }
    } catch (err) {
      setAdminError('Failed to connect to server');
    } finally {
      setAdminLoading(false);
    }
  };

  const handleVerify2fa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!twoFactorPendingToken || twoFactorCode.trim().length < 6) return;

    setTwoFactorVerifying(true);
    setAdminError(null);
    try {
      const response = await fetch('/api/auth/verify-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken: twoFactorPendingToken, code: twoFactorCode.trim() }),
      });
      const data = await response.json();
      if (response.ok && (data.token || data.account)) {
        if (data.token) {
          localStorage.setItem('slicksync-admin-token', data.token);
        }
        router.push('/');
      } else {
        setAdminError(data.message || 'Incorrect code');
        // An expired/consumed pendingToken can't be retried - back to the
        // password step rather than looping on a dead token.
        if (response.status === 401) {
          setTwoFactorPendingToken(null);
        }
      }
    } catch (err) {
      setAdminError('Failed to connect to server');
    } finally {
      setTwoFactorVerifying(false);
    }
  };

  // Time color based on urgency
  const getTimeColor = () => {
    if (!oauthExpiresAt) return 'var(--color-text-subtle)';
    const diff = oauthExpiresAt - Date.now();
    if (diff < 60000) return 'var(--color-error)';
    if (diff < 120000) return 'var(--color-warning)';
    return 'var(--color-text-subtle)';
  };

  // Switch mode
  const switchMode = (newMode: LoginMode) => {
    setMode(newMode);
    setAdminError(null);
    setUserError(null);
    setNuvioError(null);
    // Update URL while preserving other search params
    const newParams = new URLSearchParams(searchParams.toString());
    newParams.set('mode', newMode);
    router.replace(`/login?${newParams.toString()}`);
  };

  if (checkingAuth) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-6"
        style={{ background: 'var(--color-bg)' }}
      >
        <div className="w-8 h-8 border-2 border-current border-t-transparent rounded-full animate-spin" style={{ color: 'var(--color-primary)' }} />
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ background: 'var(--color-bg)' }}
    >
      {/* Background gradient */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div
          className="absolute -top-40 -right-40 w-[500px] h-[500px] rounded-full blur-[120px] opacity-30"
          style={{ background: 'var(--color-primaryMuted)' }}
        />
        <div
          className="absolute -bottom-40 -left-40 w-[400px] h-[400px] rounded-full blur-[100px] opacity-20"
          style={{ background: 'var(--color-secondaryMuted)' }}
        />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full relative"
        style={{ maxWidth: '448px' }}
      >
        {/* Logo */}
        <div className="text-center mb-8">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center"
            style={{ background: 'var(--color-primary)' }}
          >
            <SlickSyncLogo className="w-10 h-10" />
          </motion.div>
          <h1
            className="text-3xl font-bold font-display mb-2"
            style={{ color: 'var(--color-text)' }}
          >
            SlickSync
          </h1>
          <p style={{ color: 'var(--color-text-muted)' }}>
            Sign in to continue
          </p>
        </div>

        {/* Mode Toggle */}
        <div
          className="p-1 rounded-xl mb-6 flex"
          style={{ background: 'var(--color-surface)' }}
        >
          <button
            onClick={() => switchMode('user')}
            className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all flex items-center justify-center gap-2"
            style={{
              background: mode === 'user' ? 'var(--color-primary)' : 'transparent',
              color: mode === 'user' ? 'white' : 'var(--color-text-muted)',
            }}
          >
            <UserIcon className="w-4 h-4" />
            User
          </button>
          <button
            onClick={() => switchMode('admin')}
            className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-all flex items-center justify-center gap-2"
            style={{
              background: mode === 'admin' ? 'var(--color-primary)' : 'transparent',
              color: mode === 'admin' ? 'white' : 'var(--color-text-muted)',
            }}
          >
            <ShieldCheckIcon className="w-4 h-4" />
            Admin
          </button>
        </div>

        {/* Login Card */}
        <motion.div
          className="rounded-2xl overflow-hidden"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-surface-border)',
          }}
        >
          {/* Top accent */}
          <div
            className="h-1"
            style={{
              background: mode === 'user' ? 'var(--color-success)' : 'var(--color-primary)',
            }}
          />

          <div className="p-6">
            <AnimatePresence mode="wait">
              {mode === 'admin' ? (
                /* Admin Login Form */
                <motion.div
                  key="admin"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  className="space-y-4"
                >
                  {/* Admin Login Type Selector (Public Mode only) */}
                  {INSTANCE_TYPE === 'public' && (
                    <div className="flex gap-2 p-1 rounded-lg bg-bg-subtle mb-4">
                      <button
                        onClick={() => setAdminLoginType('credentials')}
                        className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-all ${adminLoginType === 'credentials'
                          ? 'bg-surface shadow-sm text-default'
                          : 'text-muted hover:text-default'
                          }`}
                      >
                        UUID / Pass
                      </button>
                      <button
                        onClick={() => {
                          setAdminLoginType('stremio');
                          if (!oauthLink) generateOAuthLink();
                        }}
                        className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-all ${adminLoginType === 'stremio'
                          ? 'bg-surface shadow-sm text-default'
                          : 'text-muted hover:text-default'
                          }`}
                      >
                        Stremio Login
                      </button>
                      <button
                        onClick={() => {
                          setAdminLoginType('nuvio');
                          if (!nuvioCode) handleStartNuvioOAuth();
                        }}
                        className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-all ${adminLoginType === 'nuvio'
                          ? 'bg-surface shadow-sm text-default'
                          : 'text-muted hover:text-default'
                          }`}
                      >
                        Nuvio Login
                      </button>
                    </div>
                  )}

                  {adminLoginType === 'credentials' && twoFactorPendingToken ? (
                    <form onSubmit={handleVerify2fa} className="space-y-4">
                      <p className="text-sm text-center" style={{ color: 'var(--color-text-muted)' }}>
                        Enter the 6-digit code from your authenticator app, or one of your backup codes.
                      </p>
                      <div>
                        <label
                          htmlFor="twoFactorCode"
                          className="block text-sm font-medium mb-2"
                          style={{ color: 'var(--color-text)' }}
                        >
                          Code
                        </label>
                        <input
                          id="twoFactorCode"
                          type="text"
                          inputMode="numeric"
                          autoFocus
                          value={twoFactorCode}
                          onChange={(e) => setTwoFactorCode(e.target.value.replace(/\s+/g, ''))}
                          className="w-full px-4 py-3 rounded-xl text-sm font-mono tracking-widest text-center transition-all"
                          style={{
                            background: 'var(--color-bg)',
                            border: '1px solid var(--color-surface-border)',
                            color: 'var(--color-text)',
                          }}
                          placeholder="123456"
                          autoComplete="one-time-code"
                        />
                      </div>

                      {adminError && (
                        <p className="text-sm text-center" style={{ color: 'var(--color-error)' }}>
                          {adminError}
                        </p>
                      )}

                      <button
                        type="submit"
                        disabled={twoFactorVerifying || twoFactorCode.trim().length < 6}
                        className="w-full py-3.5 rounded-xl font-medium transition-all flex items-center justify-center gap-2"
                        style={{
                          background: 'var(--color-primary)',
                          color: 'white',
                          opacity: twoFactorVerifying || twoFactorCode.trim().length < 6 ? 0.5 : 1,
                        }}
                      >
                        {twoFactorVerifying ? (
                          <>
                            <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                            Verifying...
                          </>
                        ) : (
                          <>
                            <ArrowRightIcon className="w-5 h-5" />
                            Verify
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => { setTwoFactorPendingToken(null); setTwoFactorCode(''); setAdminError(null); }}
                        className="w-full text-sm text-center hover:underline"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        Back
                      </button>
                    </form>
                  ) : adminLoginType === 'credentials' ? (
                    <form onSubmit={handleAdminLogin} className="space-y-4">
                      <div>
                        <label
                          htmlFor="username"
                          className="block text-sm font-medium mb-2"
                          style={{ color: 'var(--color-text)' }}
                        >
                          {INSTANCE_TYPE === 'public' ? 'UUID' : 'Username'}
                        </label>
                        <input
                          id="username"
                          type="text"
                          value={adminUsername}
                          onChange={(e) => setAdminUsername(e.target.value)}
                          className="w-full px-4 py-3 rounded-xl text-sm transition-all"
                          style={{
                            background: 'var(--color-bg)',
                            border: '1px solid var(--color-surface-border)',
                            color: 'var(--color-text)',
                          }}
                          placeholder={INSTANCE_TYPE === 'public' ? '00000000-0000-...' : 'admin'}
                          autoComplete={INSTANCE_TYPE === 'public' ? 'off' : 'username'}
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="password"
                          className="block text-sm font-medium mb-2"
                          style={{ color: 'var(--color-text)' }}
                        >
                          Password
                        </label>
                        <div className="relative">
                          <input
                            id="password"
                            type={adminPasswordVisible ? 'text' : 'password'}
                            value={adminPassword}
                            onChange={(e) => setAdminPassword(e.target.value)}
                            className="w-full pl-4 pr-12 py-3 rounded-xl text-sm transition-all"
                            style={{
                              background: 'var(--color-bg)',
                              border: '1px solid var(--color-surface-border)',
                              color: 'var(--color-text)',
                            }}
                            placeholder="********"
                            autoComplete="current-password"
                          />
                          <PasswordToggleButton visible={adminPasswordVisible} onToggle={() => setAdminPasswordVisible((v) => !v)} />
                        </div>
                      </div>

                      {adminError && (
                        <motion.p
                          initial={{ opacity: 0, y: -5 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="text-sm"
                          style={{ color: 'var(--color-error)' }}
                        >
                          {adminError}
                        </motion.p>
                      )}

                      <button
                        type="submit"
                        disabled={adminLoading || !adminUsername || !adminPassword}
                        className="w-full py-3.5 rounded-xl font-medium transition-all flex items-center justify-center gap-2"
                        style={{
                          background: 'var(--color-primary)',
                          color: 'white',
                          opacity: adminLoading || !adminUsername || !adminPassword ? 0.5 : 1,
                        }}
                      >
                        {adminLoading ? (
                          <>
                            <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                            Signing in...
                          </>
                        ) : (
                          <>
                            <ArrowRightIcon className="w-5 h-5" />
                            Sign in
                          </>
                        )}
                      </button>

                      {oidcConfigured && (
                        <>
                          <div className="flex items-center gap-3">
                            <div className="flex-1 h-px" style={{ background: 'var(--color-surface-border)' }} />
                            <span className="text-xs uppercase tracking-wider" style={{ color: 'var(--color-text-subtle)' }}>
                              or
                            </span>
                            <div className="flex-1 h-px" style={{ background: 'var(--color-surface-border)' }} />
                          </div>
                          <button
                            type="button"
                            onClick={handleStartOidc}
                            className="w-full py-3.5 rounded-xl font-medium transition-all flex items-center justify-center gap-2"
                            style={{
                              background: 'transparent',
                              border: '1px solid var(--color-surface-border)',
                              color: 'var(--color-text)',
                            }}
                          >
                            <ShieldCheckIcon className="w-5 h-5" />
                            Continue with {oidcDisplayName}
                          </button>
                        </>
                      )}

                      {INSTANCE_TYPE === 'public' && (
                        <p className="text-sm text-center" style={{ color: 'var(--color-text-muted)' }}>
                          Don&apos;t have an account?{' '}
                          <button
                            type="button"
                            onClick={() => router.push('/register')}
                            className="hover:underline"
                            style={{ color: 'var(--color-primary)' }}
                          >
                            Create one
                          </button>
                        </p>
                      )}
                    </form>
                  ) : adminLoginType === 'stremio' ? (
                    /* Admin Stremio Login UI */
                    <div className="space-y-4">
                      <p className="text-sm text-center mb-4" style={{ color: 'var(--color-text-muted)' }}>
                        Link your Stremio account to your administrator profile.
                      </p>

                      <button
                        onClick={openOAuthLink}
                        disabled={!oauthLink || isExpired || isAuthenticating}
                        className="w-full py-3.5 rounded-xl font-medium transition-all flex items-center justify-center gap-2"
                        style={{
                          background: 'var(--color-primary)',
                          color: 'white',
                          opacity: !oauthLink || isExpired || isAuthenticating ? 0.5 : 1,
                        }}
                      >
                        {isAuthenticating ? (
                          <>
                            <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                            Verifying...
                          </>
                        ) : isGenerating ? (
                          <>
                            <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                            Generating Link...
                          </>
                        ) : (
                          <>
                            <ArrowTopRightOnSquareIcon className="w-5 h-5" />
                            Open Stremio
                          </>
                        )}
                      </button>

                      {/* Manual code UI reused */}
                      <div className="text-center space-y-3 pt-2">
                        <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-text-subtle)' }}>
                          Verification Code
                        </p>
                        <button
                          onClick={copyCode}
                          disabled={!oauthCode}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg transition-all"
                          style={{
                            background: 'var(--color-bg)',
                            border: '1px solid var(--color-surface-border)',
                          }}
                        >
                          <span className="font-mono text-lg tracking-widest" style={{ color: 'var(--color-text)' }}>
                            {oauthCode || '----'}
                          </span>
                          {copied ? (
                            <CheckIcon className="w-4 h-4 text-success" />
                          ) : (
                            <ClipboardIcon className="w-4 h-4 text-muted" />
                          )}
                        </button>
                      </div>

                      {adminError && (
                        <p className="text-sm text-center" style={{ color: 'var(--color-error)' }}>
                          {adminError}
                        </p>
                      )}

                      {/* Polling indicator reused */}
                      {isPolling && !isExpired && !adminError && !isAuthenticating && (
                        <div className="flex items-center justify-center gap-2 pt-2">
                          <div className="flex gap-1">
                            {[0, 1, 2].map((i) => (
                              <motion.div
                                key={i}
                                className="w-1.5 h-1.5 rounded-full"
                                style={{ background: 'var(--color-success)' }}
                                animate={{ scale: [1, 1.3, 1], opacity: [0.4, 1, 0.4] }}
                                transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
                              />
                            ))}
                          </div>
                          <span className="text-xs" style={{ color: 'var(--color-text-subtle)' }}>
                            Waiting for authorization...
                          </span>
                        </div>
                      )}
                    </div>
                  ) : (
                    /* Admin Nuvio Login UI - same shape as the Stremio panel
                       above, but backed by Nuvio's own device-code fields */
                    <div className="space-y-4">
                      <p className="text-sm text-center" style={{ color: 'var(--color-text-muted)' }}>
                        Sign in to the <strong>admin dashboard</strong> with Nuvio, as an alternative to a UUID and password.
                      </p>
                      <p className="text-xs text-center mb-4" style={{ color: 'var(--color-text-subtle)' }}>
                        Looking to connect a user's Nuvio library instead? Do that from Users, not here.
                      </p>

                      <button
                        onClick={openNuvioLink}
                        disabled={!nuvioWebUrl || nuvioTimeLeft === 'Expired' || isNuvioAuthenticating}
                        className="w-full py-3.5 rounded-xl font-medium transition-all flex items-center justify-center gap-2"
                        style={{
                          background: 'var(--color-primary)',
                          color: 'white',
                          opacity: !nuvioWebUrl || nuvioTimeLeft === 'Expired' || isNuvioAuthenticating ? 0.5 : 1,
                        }}
                      >
                        {isNuvioAuthenticating ? (
                          <>
                            <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                            Verifying...
                          </>
                        ) : isNuvioGenerating ? (
                          <>
                            <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                            Generating Link...
                          </>
                        ) : (
                          <>
                            <ArrowTopRightOnSquareIcon className="w-5 h-5" />
                            Open Nuvio
                          </>
                        )}
                      </button>

                      <div className="text-center space-y-3 pt-2">
                        <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-text-subtle)' }}>
                          Verification Code
                        </p>
                        <button
                          onClick={copyNuvioCode}
                          disabled={!nuvioCode}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg transition-all"
                          style={{
                            background: 'var(--color-bg)',
                            border: '1px solid var(--color-surface-border)',
                          }}
                        >
                          <span className="font-mono text-lg tracking-widest" style={{ color: 'var(--color-text)' }}>
                            {nuvioCode || '----'}
                          </span>
                          {nuvioCopied ? (
                            <CheckIcon className="w-4 h-4 text-success" />
                          ) : (
                            <ClipboardIcon className="w-4 h-4 text-muted" />
                          )}
                        </button>
                        {nuvioTimeLeft && (
                          <p className="text-xs" style={{ color: 'var(--color-text-subtle)' }}>
                            {nuvioTimeLeft === 'Expired' ? 'Expired' : `Expires in ${nuvioTimeLeft}`}
                          </p>
                        )}
                      </div>

                      {nuvioError && (
                        <p className="text-sm text-center" style={{ color: 'var(--color-error)' }}>
                          {nuvioError}
                        </p>
                      )}

                      {(nuvioTimeLeft === 'Expired' || nuvioError) && !isNuvioGenerating && (
                        <button
                          type="button"
                          onClick={handleStartNuvioOAuth}
                          className="w-full text-sm text-center hover:underline"
                          style={{ color: 'var(--color-primary)' }}
                        >
                          Generate a new code
                        </button>
                      )}

                      {isNuvioPolling && nuvioTimeLeft !== 'Expired' && !nuvioError && !isNuvioAuthenticating && (
                        <div className="flex items-center justify-center gap-2 pt-2">
                          <div className="flex gap-1">
                            {[0, 1, 2].map((i) => (
                              <motion.div
                                key={i}
                                className="w-1.5 h-1.5 rounded-full"
                                style={{ background: 'var(--color-success)' }}
                                animate={{ scale: [1, 1.3, 1], opacity: [0.4, 1, 0.4] }}
                                transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
                              />
                            ))}
                          </div>
                          <span className="text-xs" style={{ color: 'var(--color-text-subtle)' }}>
                            Waiting for authorization...
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </motion.div>
              ) : (
                /* User OAuth */
                <motion.div
                  key="user"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-4"
                >
                  {/* Provider switcher */}
                  <div className="flex gap-2 p-1 rounded-lg bg-bg-subtle mb-4">
                    <button
                      onClick={() => {
                        setUserLoginType('stremio');
                        if (!oauthLink) generateOAuthLink();
                      }}
                      className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-all ${userLoginType === 'stremio'
                        ? 'bg-surface shadow-sm text-default'
                        : 'text-muted hover:text-default'
                        }`}
                    >
                      Stremio Login
                    </button>
                    <button
                      onClick={() => {
                        setUserLoginType('nuvio');
                        if (!nuvioCode) handleStartNuvioOAuth();
                      }}
                      className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-all ${userLoginType === 'nuvio'
                        ? 'bg-surface shadow-sm text-default'
                        : 'text-muted hover:text-default'
                        }`}
                    >
                      Nuvio Login
                    </button>
                  </div>

                  {userLoginType === 'stremio' ? (
                  <>
                  <p
                    className="text-sm text-center mb-4"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    Sign in with your Stremio account to access your library and settings.
                  </p>

                  {/* Open Stremio Button */}
                  <button
                    onClick={openOAuthLink}
                    disabled={!oauthLink || isExpired || isAuthenticating}
                    className="w-full py-3.5 rounded-xl font-medium transition-all flex items-center justify-center gap-2"
                    style={{
                      background: 'var(--color-primary)',
                      color: 'white',
                      opacity: !oauthLink || isExpired || isAuthenticating ? 0.5 : 1,
                    }}
                  >
                    {isAuthenticating ? (
                      <>
                        <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        Signing in...
                      </>
                    ) : isGenerating ? (
                      <>
                        <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        Generating Link...
                      </>
                    ) : (
                      <>
                        <ArrowTopRightOnSquareIcon className="w-5 h-5" />
                        Open Stremio
                      </>
                    )}
                  </button>

                  {/* Divider */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-px" style={{ background: 'var(--color-surface-border)' }} />
                    <span className="text-xs uppercase tracking-wider" style={{ color: 'var(--color-text-subtle)' }}>
                      or
                    </span>
                    <div className="flex-1 h-px" style={{ background: 'var(--color-surface-border)' }} />
                  </div>

                  {/* Manual code */}
                  <div className="text-center space-y-3">
                    <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                      Copy the code and paste it at{' '}
                      <a
                        href="https://link.stremio.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:no-underline"
                        style={{ color: 'var(--color-primary)' }}
                      >
                        link.stremio.com
                      </a>
                    </p>

                    <button
                      onClick={copyCode}
                      disabled={!oauthCode}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg transition-all"
                      style={{
                        background: 'var(--color-bg)',
                        border: '1px solid var(--color-surface-border)',
                      }}
                    >
                      <span
                        className="font-mono text-lg tracking-widest"
                        style={{ color: 'var(--color-text)' }}
                      >
                        {oauthCode || '----'}
                      </span>
                      {copied ? (
                        <CheckIcon className="w-4 h-4" style={{ color: 'var(--color-success)' }} />
                      ) : (
                        <ClipboardIcon className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                      )}
                    </button>
                  </div>

                  {/* Timer and refresh */}
                  <div className="flex items-center justify-center gap-4 pt-2">
                    {timeLeft && (
                      <span className="text-sm font-mono" style={{ color: getTimeColor() }}>
                        {timeLeft}
                      </span>
                    )}
                    <button
                      onClick={generateOAuthLink}
                      disabled={isGenerating}
                      className="text-sm flex items-center gap-1 hover:underline transition-all"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      <ArrowPathIcon className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`} />
                      Refresh
                    </button>
                  </div>

                  {/* Error */}
                  {userError && (
                    <motion.p
                      initial={{ opacity: 0, y: -5 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-sm text-center"
                      style={{ color: 'var(--color-error)' }}
                    >
                      {userError}
                    </motion.p>
                  )}

                  {/* Polling indicator */}
                  {isPolling && !isExpired && !userError && !isAuthenticating && (
                    <div className="flex items-center justify-center gap-2">
                      <div className="flex gap-1">
                        {[0, 1, 2].map((i) => (
                          <motion.div
                            key={i}
                            className="w-1.5 h-1.5 rounded-full"
                            style={{ background: 'var(--color-success)' }}
                            animate={{
                              scale: [1, 1.3, 1],
                              opacity: [0.4, 1, 0.4],
                            }}
                            transition={{
                              duration: 1,
                              repeat: Infinity,
                              delay: i * 0.2,
                            }}
                          />
                        ))}
                      </div>
                      <span className="text-xs" style={{ color: 'var(--color-text-subtle)' }}>
                        Waiting for authorization...
                      </span>
                    </div>
                  )}
                  </>
                  ) : (
                  <>
                  <p
                    className="text-sm text-center"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    Sign in with <strong>your own</strong> Nuvio account to watch here and share it with your group.
                  </p>
                  <p className="text-xs text-center mb-4" style={{ color: 'var(--color-text-subtle)' }}>
                    This is for your personal viewing, not for admin dashboard access.
                  </p>

                  <button
                    onClick={openNuvioLink}
                    disabled={!nuvioWebUrl || nuvioTimeLeft === 'Expired' || isNuvioAuthenticating}
                    className="w-full py-3.5 rounded-xl font-medium transition-all flex items-center justify-center gap-2"
                    style={{
                      background: 'var(--color-primary)',
                      color: 'white',
                      opacity: !nuvioWebUrl || nuvioTimeLeft === 'Expired' || isNuvioAuthenticating ? 0.5 : 1,
                    }}
                  >
                    {isNuvioAuthenticating ? (
                      <>
                        <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        Signing in...
                      </>
                    ) : isNuvioGenerating ? (
                      <>
                        <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        Generating Link...
                      </>
                    ) : (
                      <>
                        <ArrowTopRightOnSquareIcon className="w-5 h-5" />
                        Open Nuvio
                      </>
                    )}
                  </button>

                  <div className="text-center space-y-3 pt-2">
                    <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-text-subtle)' }}>
                      Verification Code
                    </p>
                    <button
                      onClick={copyNuvioCode}
                      disabled={!nuvioCode}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg transition-all"
                      style={{
                        background: 'var(--color-bg)',
                        border: '1px solid var(--color-surface-border)',
                      }}
                    >
                      <span className="font-mono text-lg tracking-widest" style={{ color: 'var(--color-text)' }}>
                        {nuvioCode || '----'}
                      </span>
                      {nuvioCopied ? (
                        <CheckIcon className="w-4 h-4 text-success" />
                      ) : (
                        <ClipboardIcon className="w-4 h-4 text-muted" />
                      )}
                    </button>
                    {nuvioTimeLeft && (
                      <p className="text-xs" style={{ color: 'var(--color-text-subtle)' }}>
                        {nuvioTimeLeft === 'Expired' ? 'Expired' : `Expires in ${nuvioTimeLeft}`}
                      </p>
                    )}
                  </div>

                  {nuvioError && (
                    <p className="text-sm text-center" style={{ color: 'var(--color-error)' }}>
                      {nuvioError}
                    </p>
                  )}

                  {(nuvioTimeLeft === 'Expired' || nuvioError) && !isNuvioGenerating && (
                    <button
                      type="button"
                      onClick={handleStartNuvioOAuth}
                      className="w-full text-sm text-center hover:underline"
                      style={{ color: 'var(--color-primary)' }}
                    >
                      Generate a new code
                    </button>
                  )}

                  {isNuvioPolling && nuvioTimeLeft !== 'Expired' && !nuvioError && !isNuvioAuthenticating && (
                    <div className="flex items-center justify-center gap-2 pt-2">
                      <div className="flex gap-1">
                        {[0, 1, 2].map((i) => (
                          <motion.div
                            key={i}
                            className="w-1.5 h-1.5 rounded-full"
                            style={{ background: 'var(--color-success)' }}
                            animate={{ scale: [1, 1.3, 1], opacity: [0.4, 1, 0.4] }}
                            transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
                          />
                        ))}
                      </div>
                      <span className="text-xs" style={{ color: 'var(--color-text-subtle)' }}>
                        Waiting for authorization...
                      </span>
                    </div>
                  )}
                  </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>

        {/* Footer */}
        <p className="text-center mt-6 text-sm" style={{ color: 'var(--color-text-subtle)' }}>
          {mode === 'user'
            ? 'Sign in to access your library and share with your group.'
            : 'Admin access for managing users, groups, and addons.'}
        </p>
      </motion.div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <UserAuthProvider>
      <Suspense fallback={
        <div
          className="min-h-screen flex items-center justify-center"
          style={{ background: 'var(--color-bg)' }}
        >
          <div className="w-8 h-8 border-2 border-current border-t-transparent rounded-full animate-spin" style={{ color: 'var(--color-primary)' }} />
        </div>
      }>
        <LoginContent />
      </Suspense>
    </UserAuthProvider>
  );
}
