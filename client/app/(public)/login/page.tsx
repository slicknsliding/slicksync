'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  ArrowTopRightOnSquareIcon,
  ArrowPathIcon,
  ShieldCheckIcon,
  FingerPrintIcon,
} from '@heroicons/react/24/outline';
import { userOAuth, userAuth as userAuthApi } from '@/lib/user-api';
import { copyToClipboard } from '@/lib/clipboard';
import { PasswordToggleButton } from '@/components/ui/Input';
import { api } from '@/lib/api';
import { useUserAuth, UserAuthProvider } from '@/lib/hooks/useUserAuth';
import {
  PubFrame, PubLogo, PubCard, PubSeg, PubTile, PubButton, PubLink, PubBack, PubHeading,
  PubField, PubOr, PubError, PubWaiting, PubCode, PubQr, pubInputStyle,
} from '@/components/v2/PublicV2';
import JellyfinSignIn, { type JellyfinCredentials, type JellyfinSignInApi } from '@/components/jellyfin/JellyfinSignIn';

type LoginMode = 'user' | 'admin';

// The public admin sign-in through a Jellyfin-compatible server talks to
// /api/auth directly, like the 2FA step below - a session does not exist yet.
async function jellyfinAuthPost(path: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || 'Could not sign in') as Error & { pinNeeded?: boolean };
    error.pinNeeded = data?.pinNeeded === true;
    throw error;
  }
  return data;
}

// The answer of an admin sign-in route as an object. A rate limit or a proxy in
// front of the server can answer an error with plain text or a page of HTML,
// and that must not read as "cannot reach the server" - the status already says
// what happened (see failureLine). A success that is not JSON is another
// matter: it is not a sign-in at all, so it still counts as unreachable.
async function readAuthAnswer(response: Response): Promise<any> {
  const data = await response.json().catch(() => undefined);
  if (data && typeof data === 'object') return data;
  if (response.ok) throw new Error('Failed to connect to server');
  return {};
}

// What to tell the person when a sign-in step failed: the server's own words
// when it gave some, otherwise a line chosen by the status.
function failureLine(response: Response, data: any, fallback: string): string {
  if (typeof data?.message === 'string' && data.message) return data.message;
  if (response.status === 429) return 'Too many sign-in attempts. Please wait a few minutes and try again.';
  if (response.status >= 500) return 'The server ran into a problem. Please try again in a moment.';
  return fallback;
}

// Where an admin sign-in that went through the cookies lands. A bearer token
// left in storage by an earlier session is sent with every request and
// outranks the cookies the new sign-in just set, so signing in as another
// account would keep showing the previous one - it is dropped first.
function startAdminSession(token?: string) {
  api.clearToken();
  if (token) localStorage.setItem('slicksync-admin-token', token);
}

function LoginContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { login: userLogin, loginNuvio, loginJellyfin, isAuthenticated } = useUserAuth();

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
  const [adminLoginType, setAdminLoginType] = useState<'credentials' | 'stremio' | 'nuvio' | 'jellyfin'>(
    searchParams.get('linkStremio') === '1' && initialMode === 'admin' ? 'stremio'
      : searchParams.get('linkNuvio') === '1' && initialMode === 'admin' ? 'nuvio'
      : 'credentials'
  );
  // User-mode's own provider tab - separate from adminLoginType since a
  // managed User has no "credentials" option (no UUID/password), just
  // Stremio or Nuvio. Shares the same underlying nuvio*/oauth* state below
  // with the admin flows (start/poll mechanics are identical either way,
  // only the exchange step at the end differs by mode).
  // ?app=nuvio / ?app=jellyfin opens on that app - the link a household
  // sends someone whose sign-in needs renewing (signing in here renews it).
  const [userLoginType, setUserLoginType] = useState<'stremio' | 'nuvio' | 'jellyfin'>(
    searchParams.get('app') === 'nuvio' ? 'nuvio' : searchParams.get('app') === 'jellyfin' ? 'jellyfin' : 'stremio'
  );
  // Whether the person has picked a way in yet. The list of ways shows first,
  // and nothing starts (no Stremio link, no Nuvio code) until one is picked -
  // except from the ?app= link, which opens straight on that app.
  const [userPicked, setUserPicked] = useState(
    searchParams.get('app') === 'nuvio' || searchParams.get('app') === 'jellyfin' || searchParams.get('app') === 'stremio'
  );

  // Jellyfin-compatible servers: the person's portal signs in through
  // /public-library, an admin on a public instance through /public-auth.
  const userJellyfinApi: JellyfinSignInApi = userAuthApi.jellyfinSignIn;
  const adminJellyfinApi: JellyfinSignInApi = {
    probe: (serverUrl) => jellyfinAuthPost('/api/public-auth/jellyfin-probe', { serverUrl }),
    startQuickConnect: (serverUrl) => jellyfinAuthPost('/api/public-auth/jellyfin-quick-connect', { serverUrl }),
    quickConnectStatus: (params) => jellyfinAuthPost('/api/public-auth/jellyfin-quick-connect-status', params),
  };
  const handleUserJellyfin = async (credentials: JellyfinCredentials) => {
    const result = await loginJellyfin(credentials as unknown as Record<string, string>);
    if (!result.success) throw new Error(result.error || 'Could not sign in');
    router.push('/user');
  };
  const handleAdminJellyfin = async (credentials: JellyfinCredentials) => {
    const data = await jellyfinAuthPost('/api/public-auth/jellyfin-login', credentials);
    startAdminSession(data?.token);
    router.push('/');
  };
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
    // The sign-in finishes on the server and lands straight on the app, so
    // this is the last point where the old token can be dropped.
    api.clearToken();
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
    const shouldGenerate = (mode === 'user' && userPicked && userLoginType === 'stremio') || (mode === 'admin' && adminLoginType === 'stremio');
    if (!shouldGenerate) {
      stremioAutoStartedRef.current = false;
      return;
    }
    if (!oauthLink && !isGenerating && !stremioAutoStartedRef.current) {
      stremioAutoStartedRef.current = true;
      generateOAuthLink();
    }
  }, [mode, adminLoginType, userLoginType, userPicked, oauthLink, isGenerating, generateOAuthLink]);

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
    // New code while the old one is still being checked: stop that check first.
    stopNuvioPolling();
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
  }, [isNuvioGenerating, router, startNuvioCountdown, stopNuvioPolling, mode, loginNuvio]);

  // Auto-generate Nuvio OAuth session when its tab is selected (admin's own
  // tab, or the user-mode equivalent). Fires at most once per tab-selection -
  // see nuvioAutoStartedRef's own comment for why a plain !nuvioCode check
  // isn't safe here. A failed attempt leaves the manual "Generate a new
  // code" button (rendered below whenever nuvioError is set) as the retry
  // path instead.
  useEffect(() => {
    const shouldStart = (mode === 'admin' && adminLoginType === 'nuvio') || (mode === 'user' && userPicked && userLoginType === 'nuvio');
    if (!shouldStart) {
      nuvioAutoStartedRef.current = false;
      return;
    }
    if (!nuvioCode && !isNuvioGenerating && !nuvioAutoStartedRef.current) {
      nuvioAutoStartedRef.current = true;
      handleStartNuvioOAuth();
    }
  }, [mode, adminLoginType, userLoginType, userPicked, nuvioCode, isNuvioGenerating, handleStartNuvioOAuth]);

  // Clean up Nuvio timers on unmount
  useEffect(() => {
    return () => {
      if (nuvioPollIntervalRef.current) window.clearInterval(nuvioPollIntervalRef.current);
      if (nuvioTimerIntervalRef.current) window.clearInterval(nuvioTimerIntervalRef.current);
    };
  }, []);

  const copyNuvioCode = useCallback(() => {
    if (!nuvioCode) return;
    copyToClipboard(nuvioCode);
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
    copyToClipboard(oauthCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [oauthCode]);

  // Open OAuth link
  const openOAuthLink = useCallback(() => {
    if (!oauthLink) return;
    window.open(oauthLink, '_blank', 'noopener,noreferrer');
  }, [oauthLink]);

  // Passkey sign-in. Only offered once the server confirms a passkey exists
  // for THIS hostname - a passkey belongs to the address it was made on, so
  // offering the button everywhere would mean a prompt that can only fail.
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.PublicKeyCredential) return;
    fetch('/api/public-auth/passkey/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.available) setPasskeyAvailable(true); })
      .catch(() => {});
  }, []);

  const handlePasskeyLogin = async () => {
    setPasskeyLoading(true);
    setAdminError(null);
    try {
      const { startAuthentication } = await import('@simplewebauthn/browser');
      // A fresh challenge for the real attempt - the one fetched above was
      // only asking whether to show this button, and a challenge is
      // single-use.
      const optionsRes = await fetch('/api/public-auth/passkey/options', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const optionsData = await optionsRes.json();
      if (!optionsData?.available) {
        setAdminError('No passkey is registered for this address');
        return;
      }
      const credential = await startAuthentication({ optionsJSON: optionsData.options });
      const verifyRes = await fetch('/api/public-auth/passkey/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: optionsData.challengeId, credential }),
      });
      const data = await readAuthAnswer(verifyRes);
      if (verifyRes.ok && data.requiresTwoFactor && data.pendingToken) {
        setTwoFactorPendingToken(data.pendingToken);
        setTwoFactorCode('');
        return;
      }
      if (verifyRes.ok && (data.token || data.account)) {
        startAdminSession(data.token);
        router.push('/');
        return;
      }
      setAdminError(failureLine(verifyRes, data, 'That passkey was not accepted'));
    } catch (e: any) {
      // Cancelling the browser prompt is a choice, not an error.
      if (e?.name === 'NotAllowedError' || /cancel|abort/i.test(e?.message || '')) return;
      setAdminError(e?.message || 'Passkey sign-in failed');
    } finally {
      setPasskeyLoading(false);
    }
  };

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

      const data = await readAuthAnswer(response);

      if (response.ok && data.requiresTwoFactor && data.pendingToken) {
        setTwoFactorPendingToken(data.pendingToken);
        setTwoFactorCode('');
      } else if (response.ok && (data.token || data.account)) {
        // Store admin token and redirect
        // Backend returns token in different fields depending on route
        const token = data.token || response.headers.get('set-cookie');
        startAdminSession(data.token);
        router.push('/');
      } else {
        setAdminError(failureLine(response, data, 'Invalid credentials'));
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
      const data = await readAuthAnswer(response);
      if (response.ok && (data.token || data.account)) {
        startAdminSession(data.token);
        router.push('/');
      } else {
        setAdminError(failureLine(response, data, 'Incorrect code'));
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

  // The one way in that is open right now, or null while the choices are showing.
  const openMethod: 'stremio' | 'nuvio' | 'jellyfin' | null =
    mode === 'admin'
      ? (adminLoginType === 'credentials' ? null : adminLoginType)
      : (userPicked ? userLoginType : null);
  const inTwoFactor = openMethod === null && mode === 'admin' && !!twoFactorPendingToken;
  const methodName = openMethod === 'stremio' ? 'Stremio' : openMethod === 'nuvio' ? 'Nuvio' : 'Jellyfin';

  const goBackToChoices = () => {
    setAdminError(null);
    setUserError(null);
    setNuvioError(null);
    if (mode === 'admin') setAdminLoginType('credentials');
    else setUserPicked(false);
  };

  // Picking a way in: the same start-up the old tabs did.
  const pickStremio = () => {
    if (mode === 'admin') setAdminLoginType('stremio');
    else { setUserLoginType('stremio'); setUserPicked(true); }
    if (!oauthLink) generateOAuthLink();
  };
  const pickNuvio = () => {
    if (mode === 'admin') setAdminLoginType('nuvio');
    else { setUserLoginType('nuvio'); setUserPicked(true); }
    if (!nuvioCode) handleStartNuvioOAuth();
  };
  const pickJellyfin = () => {
    if (mode === 'admin') { setAdminLoginType('jellyfin'); setAdminError(null); }
    else { setUserLoginType('jellyfin'); setUserPicked(true); }
  };

  // Finishing in Stremio or Nuvio: the code, the link, a status line and the one button.
  const renderOAuthPanel = (provider: 'stremio' | 'nuvio') => {
    const isNuvio = provider === 'nuvio';
    const name = isNuvio ? 'Nuvio' : 'Stremio';
    const link = isNuvio ? nuvioWebUrl : oauthLink;
    const code = isNuvio ? nuvioCode : oauthCode;
    const expired = isNuvio ? nuvioTimeLeft === 'Expired' : isExpired;
    const authenticating = isNuvio ? isNuvioAuthenticating : isAuthenticating;
    const generating = isNuvio ? isNuvioGenerating : isGenerating;
    const err = isNuvio ? nuvioError : mode === 'admin' ? adminError : userError;
    const waiting = isNuvio
      ? isNuvioPolling && nuvioTimeLeft !== 'Expired' && !nuvioError && !isNuvioAuthenticating
      : isPolling && !isExpired && !err && !isAuthenticating;
    const disabled = !link || expired || authenticating;
    const line = isNuvio
      ? (mode === 'admin'
        ? <>Sign in to the <strong>admin dashboard</strong> with Nuvio, as an alternative to an account ID and password.</>
        : <>Sign in with <strong>your own</strong> Nuvio account to watch here and share it with your group.</>)
      : (mode === 'admin'
        ? 'Link your Stremio account to your administrator profile.'
        : 'Sign in with your Stremio account to access your library and settings.');
    const note = isNuvio
      ? (mode === 'admin'
        ? 'Looking to connect a user’s Nuvio library instead? Do that from Users, not here.'
        : 'This is for your personal viewing, not for admin dashboard access.')
      : null;
    const timer = isNuvio
      ? (nuvioTimeLeft ? (nuvioTimeLeft === 'Expired' ? 'Expired' : `Expires in ${nuvioTimeLeft}`) : null)
      : timeLeft;
    return (
      <div className="space-y-4 text-center">
        <PubHeading title={`Finish in ${name}`} line={line} />
        {note && <p className="text-xs -mt-2" style={{ color: 'var(--color-text-subtle)' }}>{note}</p>}
        {link && !expired && !authenticating && (
          <PubQr data={link} alt={`Scan with your phone to open ${name}`} />
        )}
        <div className="space-y-2">
          {!isNuvio && (
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              Or copy the code and paste it at{' '}
              <a href="https://link.stremio.com" target="_blank" rel="noopener noreferrer" className="underline hover:no-underline" style={{ color: 'var(--color-primary)' }}>
                link.stremio.com
              </a>
            </p>
          )}
          <PubCode
            code={code}
            copied={isNuvio ? nuvioCopied : copied}
            onCopy={isNuvio ? copyNuvioCode : copyCode}
          />
          {timer && (
            <p className="text-sm font-mono" style={{ color: isNuvio ? 'var(--color-text-subtle)' : getTimeColor() }}>{timer}</p>
          )}
          {expired && !isNuvio && <p className="text-sm" style={{ color: 'var(--color-text-subtle)' }}>That code has expired.</p>}
        </div>
        {err && <PubError>{err}</PubError>}
        {waiting && <PubWaiting tone="var(--color-success)">Waiting for you to approve it…</PubWaiting>}
        <div className="grid gap-2">
          <PubButton
            primary
            onClick={isNuvio ? openNuvioLink : openOAuthLink}
            disabled={disabled}
            icon={authenticating || generating
              ? <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
              : <ArrowTopRightOnSquareIcon className="w-5 h-5" />}
          >
            {authenticating
              ? (mode === 'admin' ? 'Verifying...' : 'Signing in...')
              : generating ? 'Generating Link...' : `Open ${name}`}
          </PubButton>
          <PubLink
            onClick={isNuvio ? handleStartNuvioOAuth : generateOAuthLink}
            disabled={generating}
            icon={<ArrowPathIcon className={`w-4 h-4 ${generating ? 'animate-spin' : ''}`} />}
            className="py-2"
          >
            {isNuvio ? 'New code' : 'Refresh'}
          </PubLink>
        </div>
      </div>
    );
  };

  const renderJellyfinPanel = () => (
    <div className="space-y-4">
      <PubHeading
        title="Sign in with Jellyfin"
        line={mode === 'admin'
          ? 'Sign in with your Jellyfin server, or the media server AIOStreams or AIOMetadata runs.'
          : 'Sign in with the server you watch on - Jellyfin, or the media server AIOStreams or AIOMetadata runs for your apps.'}
      />
      <JellyfinSignIn
        api={mode === 'admin' ? adminJellyfinApi : userJellyfinApi}
        onSubmit={mode === 'admin' ? handleAdminJellyfin : handleUserJellyfin}
        submitLabel="Sign in"
        compact
      />
    </div>
  );

  const renderTwoFactor = () => (
    <form onSubmit={handleVerify2fa} className="space-y-4">
      <PubHeading title="Two-step sign-in" line="Enter the 6-digit code from your authenticator app, or one of your backup codes." />
      <PubField label="Code" htmlFor="twoFactorCode">
        <input
          id="twoFactorCode"
          type="text"
          inputMode="numeric"
          autoFocus
          value={twoFactorCode}
          onChange={(e) => setTwoFactorCode(e.target.value.replace(/\s+/g, ''))}
          className="w-full px-4 py-3.5 rounded-xl text-2xl font-mono font-bold tracking-[0.35em] text-center transition-all"
          style={pubInputStyle}
          placeholder="123456"
          autoComplete="one-time-code"
        />
      </PubField>
      {adminError && <PubError>{adminError}</PubError>}
      <PubButton
        primary
        type="submit"
        disabled={twoFactorVerifying || twoFactorCode.trim().length < 6}
        icon={twoFactorVerifying ? <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" /> : undefined}
      >
        {twoFactorVerifying ? 'Verifying...' : 'Continue'}
      </PubButton>
      <div className="text-center">
        <PubLink onClick={() => { setTwoFactorPendingToken(null); setTwoFactorCode(''); setAdminError(null); }}>Back</PubLink>
      </div>
    </form>
  );

  const renderAdminCredentials = () => {
    const isPublic = INSTANCE_TYPE === 'public';
    const hasOthers = isPublic || passkeyAvailable || oidcConfigured;
    return (
      <form onSubmit={handleAdminLogin} className="space-y-4">
        <PubField label={isPublic ? 'Account ID' : 'Username'} htmlFor="username">
          <input
            id="username"
            type="text"
            value={adminUsername}
            onChange={(e) => setAdminUsername(e.target.value)}
            className="w-full px-4 py-3 rounded-xl text-sm transition-all"
            style={pubInputStyle}
            placeholder={isPublic ? 'Your account ID' : 'admin'}
            autoComplete={isPublic ? 'off' : 'username'}
          />
        </PubField>

        <PubField label="Password" htmlFor="password">
          <div className="relative">
            <input
              id="password"
              type={adminPasswordVisible ? 'text' : 'password'}
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              className="w-full pl-4 pr-12 py-3 rounded-xl text-sm transition-all"
              style={pubInputStyle}
              placeholder="********"
              autoComplete="current-password"
            />
            <PasswordToggleButton visible={adminPasswordVisible} onToggle={() => setAdminPasswordVisible((v) => !v)} />
          </div>
        </PubField>

        {adminError && <PubError>{adminError}</PubError>}

        <PubButton
          primary
          type="submit"
          disabled={adminLoading || !adminUsername || !adminPassword}
          icon={adminLoading ? <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" /> : undefined}
        >
          {adminLoading ? 'Signing in...' : 'Sign in'}
        </PubButton>

        {hasOthers && (
          <>
            <PubOr />
            <div className="grid gap-2">
              {passkeyAvailable && (
                <PubButton onClick={handlePasskeyLogin} disabled={passkeyLoading} icon={<FingerPrintIcon className="w-5 h-5" />}>
                  {passkeyLoading ? 'Waiting for your device...' : 'Use a passkey'}
                </PubButton>
              )}
              {isPublic && <PubButton onClick={pickStremio}>Stremio</PubButton>}
              {isPublic && <PubButton onClick={pickNuvio}>Nuvio</PubButton>}
              {isPublic && <PubButton onClick={pickJellyfin}>Jellyfin</PubButton>}
              {oidcConfigured && (
                <PubButton onClick={handleStartOidc} icon={<ShieldCheckIcon className="w-5 h-5" />}>
                  Continue with {oidcDisplayName}
                </PubButton>
              )}
            </div>
            {isPublic && <p className="text-xs text-center" style={{ color: 'var(--color-text-subtle)' }}>Jellyfin also covers AIOStreams and AIOMetadata.</p>}
          </>
        )}

        {isPublic && (
          <p className="text-sm text-center" style={{ color: 'var(--color-text-muted)' }}>
            No account yet?{' '}
            <button type="button" onClick={() => router.push('/register')} className="hover:underline font-semibold" style={{ color: 'var(--color-primary)' }}>
              Create one
            </button>
          </p>
        )}
      </form>
    );
  };

  const renderUserChoices = () => (
    <div className="space-y-2.5">
      <PubTile name="Stremio" line="Sign in with your Stremio account" color="linear-gradient(135deg,#8b5cf6,#6d28d9)" onClick={pickStremio} />
      <PubTile name="Nuvio" line="Sign in with your Nuvio account" color="linear-gradient(135deg,#6366f1,#a855f7)" onClick={pickNuvio} />
      <PubTile name="Jellyfin" line="A Jellyfin server, AIOStreams or AIOMetadata" color="#0b2447" onClick={pickJellyfin} />
      <p className="text-[12.5px] text-center pt-1.5" style={{ color: 'var(--color-text-muted)' }}>
        Use the same sign-in as your app. Nothing is changed in it.
      </p>
    </div>
  );

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

  const logoSub = inTwoFactor
    ? 'One more step'
    : openMethod
      ? `Signing in with ${methodName}`
      : mode === 'user'
        ? 'Sign in to see your library, your addons and what you’re watching'
        : 'Sign in to run SlickSync';

  return (
    <PubFrame>
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
        <PubLogo sub={logoSub} />

        <PubCard>
          {openMethod === null && !inTwoFactor && (
            <PubSeg
              value={mode}
              onChange={switchMode}
              options={[{ value: 'user', label: 'I watch here' }, { value: 'admin', label: 'I run this' }]}
            />
          )}
          {openMethod !== null && <PubBack onClick={goBackToChoices}>{mode === 'admin' ? 'Back to sign in' : 'All sign-in options'}</PubBack>}

          {openMethod === 'jellyfin' ? renderJellyfinPanel()
            : openMethod === 'stremio' ? renderOAuthPanel('stremio')
            : openMethod === 'nuvio' ? renderOAuthPanel('nuvio')
            : inTwoFactor ? renderTwoFactor()
            : mode === 'admin' ? renderAdminCredentials()
            : renderUserChoices()}
        </PubCard>
      </motion.div>
    </PubFrame>
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
