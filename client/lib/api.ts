// API client for connecting to SlickSync backend
// Use relative path if NEXT_PUBLIC_API_URL is not set (Next.js will proxy via rewrites)
// Otherwise use the explicit URL (useful for production or different ports)
export const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

interface FetchOptions extends RequestInit {
  token?: string;
}

// Helper to get CSRF token from cookies (for non-GET requests)
function getCsrfToken(): string | null {
  if (typeof window === 'undefined') return null;
  const cookies = document.cookie?.split(';') || [];
  const find = (name: string) => {
    const key = `${name}=`;
    const entry = cookies.find(c => c.trim().startsWith(key));
    return entry ? decodeURIComponent(entry.split('=')[1]) : '';
  };
  return find('__Host-sfm_csrf') || find('sfm_csrf') || null;
}

// Detail lookups for the poster-click modal, kept briefly so a hover can
// pay for the click that follows (see prefetchMediaDetails). Short on
// purpose: this is metadata that can change (ratings, episode lists), and
// the window only has to cover the distance between hovering a poster and
// opening it.
const MEDIA_DETAILS_TTL_MS = 90 * 1000;
const MEDIA_DETAILS_MAX = 60;
const mediaDetailsCache = new Map<string, { at: number; promise: Promise<MediaDetails | null> }>();

class ApiClient {
  private token: string | null = null;
  // Dedup + short-window cache for GETs. Several unrelated pages/components
  // independently poll the same couple of endpoints (getInvitations,
  // getMetrics - Dashboard, Activity, Invitations, Metrics, Users, Vault,
  // plus NotificationsDropdown's own always-running 30s poll, now persistent
  // across navigation) with no coordination between them, which on a single
  // page load fired ~15-20 near-simultaneous identical requests to the same
  // endpoint. Every request round-trips through Traefik's Authelia
  // forward-auth check (confirmed via the container's own routing labels),
  // and that burst was the likely source of an occasional real 404 seen
  // live under the concurrent load (data still loaded fine off the other
  // requests in the burst, so nothing user-visible broke - just wasteful,
  // and apparently not perfectly safe at that volume).
  //
  // Sharing only the exact in-flight promise (the original fix) caught
  // requests that overlap down to the millisecond, but independent 30s
  // intervals drift out of phase with each other and with whatever a page
  // fires on its own mount - most of the burst is "near-simultaneous," not
  // truly concurrent, so a pure in-flight dedup missed most of it and the
  // occasional 404 kept happening. Layering a short resolved-value cache on
  // top (same idea as SWR's own `dedupingInterval`, same default duration)
  // catches those near-misses too: a second caller within the window gets
  // the first caller's already-resolved data instantly, no network request
  // at all. Bounded to 2s specifically so it's invisible against this data's
  // own 30s natural refresh cadence - nothing here is ever meaningfully
  // stale. Failures are never cached (evicted immediately) so a transient
  // error can't get replayed onto callers that would've otherwise succeeded.
  private inFlightGets = new Map<string, Promise<any>>();
  private recentGets = new Map<string, { value: any; at: number }>();
  private static readonly DEDUPE_WINDOW_MS = 2000;

  // Instant navigation: the last successful response of every GET, kept for
  // the whole session and snapshotted to localStorage when the tab hides.
  // Pages initialize their state from peekGet() and skip their loading
  // spinner when it hits - the data shown is whatever this client last saw
  // (possibly minutes old), and the page's own normal fetch-on-mount then
  // refreshes it in place. A deliberate third layer next to the two above:
  // recentGets (2s) exists to coalesce request BURSTS and must stay short
  // so nothing reads meaningfully stale data as if it were fresh; this
  // layer is allowed to be arbitrarily stale precisely because it is only
  // ever read through peekGet by callers that immediately revalidate.
  // Failures never touch it, and mutations deliberately don't clear it -
  // the page that mutated refetches and overwrites it with the result.
  private lastKnown = new Map<string, unknown>();
  private lastKnownRestored = false;
  private static readonly LAST_KNOWN_STORAGE_KEY = 'slicksync-last-known';
  private static readonly LAST_KNOWN_MAX_BYTES = 3 * 1024 * 1024;

  private getKey(endpoint: string, token?: string | null): string {
    return `${endpoint}::${token || this.getToken() || ''}`;
  }

  private restoreLastKnown() {
    if (this.lastKnownRestored || typeof window === 'undefined') return;
    this.lastKnownRestored = true;
    try {
      const raw = localStorage.getItem(ApiClient.LAST_KNOWN_STORAGE_KEY);
      if (!raw) return;
      const entries: Array<[string, unknown]> = JSON.parse(raw);
      for (const [k, v] of entries) {
        if (!this.lastKnown.has(k)) this.lastKnown.set(k, v);
      }
    } catch {
      // Corrupt/oversized snapshot - drop it, pages just show spinners once.
      try { localStorage.removeItem(ApiClient.LAST_KNOWN_STORAGE_KEY); } catch {}
    }
  }

  private persistLastKnown() {
    if (typeof window === 'undefined') return;
    try {
      let entries = Array.from(this.lastKnown.entries());
      let raw = JSON.stringify(entries);
      // Size cap: drop the LARGEST entries first until it fits - one huge
      // metrics snapshot shouldn't evict twenty small lists.
      while (raw.length > ApiClient.LAST_KNOWN_MAX_BYTES && entries.length > 0) {
        let biggest = 0;
        for (let i = 1; i < entries.length; i++) {
          if (JSON.stringify(entries[i][1]).length > JSON.stringify(entries[biggest][1]).length) biggest = i;
        }
        entries = entries.filter((_, i) => i !== biggest);
        raw = JSON.stringify(entries);
      }
      localStorage.setItem(ApiClient.LAST_KNOWN_STORAGE_KEY, raw);
    } catch {
      // Quota/private mode - instant nav still works in-memory this session.
    }
  }

  /** Last successful response this client has seen for a GET endpoint, or
   * undefined if it has never succeeded. Callers MUST treat this as a
   * provisional first paint and still fetch fresh data - see lastKnown's
   * comment above. */
  peekGet<T>(endpoint: string): T | undefined {
    this.restoreLastKnown();
    return this.lastKnown.get(this.getKey(endpoint)) as T | undefined;
  }

  constructor() {
    // Snapshot the last-known store whenever the tab goes to the
    // background - covers both plain navigation away and the PWA being
    // swiped closed, without paying a localStorage write per request.
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.persistLastKnown());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.persistLastKnown();
      });
    }
  }

  setToken(token: string) {
    this.token = token;
    if (typeof window !== 'undefined') {
      localStorage.setItem('slicksync_token', token);
    }
  }

  getToken(): string | null {
    if (this.token) return this.token;
    if (typeof window !== 'undefined') {
      this.token = localStorage.getItem('slicksync_token');
    }
    return this.token;
  }

  clearToken() {
    this.token = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem('slicksync_token');
      // Logout hygiene: last-known responses are account data - don't leave
      // them readable (or restorable) for whoever logs in next on this
      // machine.
      this.lastKnown.clear();
      try { localStorage.removeItem(ApiClient.LAST_KNOWN_STORAGE_KEY); } catch {}
    }
  }

  private getAuthHeaders(method: string = 'GET'): Record<string, string> {
    const headers: Record<string, string> = {};
    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const csrfToken = getCsrfToken();
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }
    }
    return headers;
  }

  private fetch<T>(endpoint: string, options: FetchOptions = {}): Promise<T> {
    const method = (options.method || 'GET').toUpperCase();
    // Only GETs are safe to dedup - a mutating request needs to actually
    // happen every time it's called, and two callers might not even mean
    // the same body. Keyed on endpoint + token, since a mid-flight token
    // change (e.g. login) shouldn't hand an anonymous caller someone else's
    // in-flight authenticated response or vice versa.
    //
    // Any mutation drops the whole GET cache once it settles. The common
    // "delete/create, then immediately re-fetch the list to show the
    // result" pattern (e.g. Invitations' handleDeleteSingle) would
    // otherwise risk being served a pre-mutation snapshot straight out of
    // the 2s cache below instead of the fresh data it's explicitly asking
    // for - confirmed this exact call shape exists before shipping the
    // cache. Cleared on settle (not before starting) so a GET that lands
    // mid-mutation and caches its own snapshot doesn't leave a stale entry
    // behind for the caller's own post-mutation refetch to pick up -
    // clearing only up front would miss exactly that window. Cleared on
    // both success and failure for simplicity; a failed mutation didn't
    // change server state so this is a few extra requests at worst, never
    // a stale read. Blunt (a mutation to one resource evicts unrelated
    // cached GETs too) but safe by construction.
    if (method !== 'GET') {
      return this.fetchImpl<T>(endpoint, options).finally(() => {
        this.recentGets.clear();
      });
    }
    const key = `${endpoint}::${options.token || this.getToken() || ''}`;

    const inFlight = this.inFlightGets.get(key);
    if (inFlight) return inFlight;

    const recent = this.recentGets.get(key);
    if (recent && Date.now() - recent.at < ApiClient.DEDUPE_WINDOW_MS) {
      return Promise.resolve(recent.value);
    }

    const promise = this.fetchImpl<T>(endpoint, options)
      .then((value) => {
        this.recentGets.set(key, { value, at: Date.now() });
        this.lastKnown.set(key, value);
        return value;
      })
      .finally(() => {
        this.inFlightGets.delete(key);
      });
    this.inFlightGets.set(key, promise);
    return promise;
  }

  private async fetchImpl<T>(endpoint: string, options: FetchOptions = {}): Promise<T> {
    const token = options.token || this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    // Add CSRF token for state-changing requests
    const method = (options.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const csrfToken = getCsrfToken();
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }
    }

    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        cache: 'no-store',
        credentials: 'include',
        ...options,
        headers,
      });

      if (!response.ok) {
        let errorData: any;
        try {
          errorData = await response.json();
        } catch (parseError) {
          errorData = { message: `HTTP ${response.status}: ${response.statusText}` };
        }

        const errorMessage = errorData.message || errorData.error || `HTTP ${response.status}`;
        const apiError = new Error(errorMessage) as any;
        apiError.response = { data: errorData, status: response.status };
        // Attach the original error data for easier access
        apiError.data = errorData;

        // Global 401 Redirect handler for client-side. Excludes /superadmin
        // same as /login - it's a public page with its own entirely separate
        // auth (a distinct sfm_superadmin cookie, never a tenant login), but
        // global providers that wrap every page (ThemeProvider fetching
        // /settings/theme-pref in particular) still fire their own
        // tenant-scoped requests there and 401 - without this exclusion that
        // 401 hijacked the page to /login?mode=admin before the superadmin
        // login form ever got a chance to render.
        if (
          response.status === 401 &&
          typeof window !== 'undefined' &&
          !window.location.pathname.startsWith('/login') &&
          !window.location.pathname.startsWith('/superadmin')
        ) {
          // Do not redirect if the failure happened during an active auth attempt/management,
          // or came from /ext/* - that prefix runs its own API-key auth (see server/routes/
          // externalApi.js), entirely separate from the tenant session cookie. getAccountStats()
          // hits /ext/account on every Dashboard/Settings/topbar/sidebar mount, and a brand new
          // account has no API key configured yet - a legitimate, expected 401 that has nothing
          // to do with whether the tenant session itself is valid. Treating it as "logged out"
          // force-redirected a freshly registered (and fully signed-in) account straight back to
          // the login page.
          const isAuthEndpoint = [
            '/auth/login',
            '/auth/stremio-login',
            '/auth/private-login',
            '/auth/unlink-stremio',
            '/auth/set-credentials'
          ].some(route => endpoint.startsWith(route)) || endpoint.startsWith('/ext/');

          if (!isAuthEndpoint) {
            this.clearToken();
            const isUserRoute = window.location.pathname.startsWith('/user') || window.location.pathname.startsWith('/invite');
            window.location.href = `/login?mode=${isUserRoute ? 'user' : 'admin'}`;
          }
        }

        throw apiError;
      }

      return response.json();
    } catch (fetchError: any) {
      // Handle network errors, CORS errors, etc.
      if (fetchError.name === 'TypeError' && fetchError.message.includes('fetch')) {
        const networkError = new Error('Network error: Unable to reach the server') as any;
        networkError.response = { status: 0, data: { message: 'Network error' } };
        networkError.originalError = fetchError;
        throw networkError;
      }

      // If it's already our API error, re-throw it
      if (fetchError.response) {
        throw fetchError;
      }

      // Otherwise, wrap it
      const wrappedError = new Error(fetchError.message || 'Request failed') as any;
      wrappedError.originalError = fetchError;
      wrappedError.response = { status: 0, data: { message: fetchError.message || 'Unknown error' } };
      throw wrappedError;
    }
  }

  // Auth
  async login(username: string, password: string) {
    const data = await this.fetch<{ token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ uuid: username, password }), // Backend expects 'uuid' for public login
    });
    this.setToken(data.token);
    return data;
  }

  // Public-mode (multi-tenant) self-registration. The uuid isn't user-chosen -
  // it's generated server-side (generateAccountUuid) and doubles as the login
  // identifier, since public mode has no separate username/email requirement.
  async generateAccountUuid() {
    return this.fetch<{ success: boolean; uuid: string }>('/auth/generate-uuid');
  }

  async register(uuid: string, password: string) {
    const data = await this.fetch<{ token: string; account: { id: string; uuid: string; email: string | null } }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ uuid, password }),
    });
    this.setToken(data.token);
    return data;
  }

  async stremioLogin(authKey: string) {
    const data = await this.fetch<{ token: string; account: any }>('/auth/stremio-login', {
      method: 'POST',
      body: JSON.stringify({ authKey }),
    });
    if (data.token) {
      this.setToken(data.token);
    }
    return data;
  }

  // Nuvio admin login (public mode only) - unlike Stremio's single authKey,
  // Nuvio needs its own start/poll device-code round trip before there's
  // anything to log in with.
  async startNuvioAdminOAuth() {
    return this.fetch<{
      code: string; webUrl: string; expiresAt: string;
      pollIntervalSeconds: number; anonToken: string; deviceNonce: string;
    }>('/auth/nuvio-start-oauth', { method: 'POST', body: JSON.stringify({}) });
  }

  async pollNuvioAdminOAuth(params: { code: string; deviceNonce: string; anonToken: string }) {
    return this.fetch<{ status: string; expiresAt: string; pollIntervalSeconds: number }>(
      '/auth/nuvio-poll-oauth', { method: 'POST', body: JSON.stringify(params) }
    );
  }

  async nuvioLogin(params: { code: string; deviceNonce: string; anonToken: string }) {
    const data = await this.fetch<{ token: string; account: any }>('/auth/nuvio-login', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    if (data.token) {
      this.setToken(data.token);
    }
    return data;
  }

  async unlinkStremio(password: string) {
    return this.fetch<{ message: string; uuid: string }>('/auth/unlink-stremio', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  }

  async unlinkUuid() {
    return this.fetch<{ message: string }>('/auth/unlink-uuid', {
      method: 'POST',
    });
  }

  async setCredentials(password: string) {
    return this.fetch<{ message: string; uuid: string }>('/auth/set-credentials', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  }

  // Session check for the admin auth gate - resolves with { account: null } when
  // auth is disabled (private mode) or a real account when a session is valid,
  // and 401s (triggering the global redirect handler above) when it isn't.
  async getSession() {
    return this.fetch<{ account: { id: string; uuid: string; email: string | null } | null; message?: string }>('/auth/me');
  }

  // Users
  async getUsers() {
    return this.fetch<User[]>('/users');
  }

  async getUser(id: string) {
    return this.fetch<User>(`/users/${id}`);
  }

  // Account merge (Stremio<->Nuvio, same real person) - see
  // server/utils/userMerge.js for the full design.
  async getMergePreview(id: string, donorId: string) {
    return this.fetch<MergePreview>(`/users/${id}/merge-preview?donorId=${encodeURIComponent(donorId)}`);
  }
  async mergeUsers(id: string, donorId: string) {
    return this.fetch<{ success: boolean } & MergePreview & { archivePath: string }>(`/users/${id}/merge`, {
      method: 'POST',
      body: JSON.stringify({ donorId }),
    });
  }
  async getMergeInfo(id: string) {
    return this.fetch<{ info: MergeInfo | null }>(`/users/${id}/merge-info`);
  }
  async undoMerge(id: string) {
    return this.fetch<{ success: boolean; donorUsername: string; donorProviderType: 'stremio' | 'nuvio' }>(`/users/${id}/undo-merge`, {
      method: 'POST',
    });
  }

  async createUser(data: CreateUserData) {
    return this.fetch<User>('/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateUser(id: string, data: Partial<User>) {
    return this.fetch<User>(`/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async toggleUserStatus(id: string, isActive: boolean) {
    return this.fetch<{ message: string; isActive: boolean }>(`/users/${id}/toggle-status`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
  }

  async deleteUser(id: string) {
    return this.fetch(`/users/${id}`, { method: 'DELETE' });
  }

  async syncUser(id: string) {
    return this.fetch(`/users/${id}/sync`, { method: 'POST' });
  }

  async connectUserStremio(id: string, data: { email: string; password: string; username?: string }) {
    return this.fetch(`/users/${id}/connect-stremio`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async connectUserStremioWithAuthKey(id: string, authKey: string) {
    return this.fetch(`/users/${id}/connect-stremio-authkey`, {
      method: 'POST',
      body: JSON.stringify({ authKey }),
    });
  }

  async startSimklPin(id: string) {
    return this.fetch<{ userCode: string; verificationUrl: string; expiresIn: number; pollIntervalSeconds: number }>(`/users/${id}/simkl/start`, { method: 'POST' });
  }

  async pollSimklPin(id: string, userCode: string) {
    return this.fetch<{ status: 'pending' | 'authorized'; username?: string }>(`/users/${id}/simkl/poll`, {
      method: 'POST',
      body: JSON.stringify({ userCode }),
    });
  }

  async disconnectSimkl(id: string) {
    return this.fetch(`/users/${id}/simkl/disconnect`, { method: 'POST' });
  }

  async getUserWatchTime(id: string, period: 'day' | 'week' | 'month' | 'year' = 'week') {
    return this.fetch<WatchTimeData>(`/users/${id}/watch-time?period=${period}`);
  }

  async getUserTopItems(id: string, limit = 10) {
    return this.fetch<TopItem[]>(`/users/${id}/top-items?limit=${limit}`);
  }

  async getUserStreaks(id: string) {
    return this.fetch<StreakData>(`/users/${id}/streaks`);
  }

  async getUserVelocity(id: string) {
    return this.fetch<VelocityData>(`/users/${id}/velocity`);
  }

  async getUserSyncStatus(id: string, groupId?: string) {
    const url = groupId
      ? `/users/${id}/sync-status?groupId=${groupId}`
      : `/users/${id}/sync-status`;
    return this.fetch<any>(url);
  }

  async getUserSyncPlan(id: string) {
    return this.fetch<{
      alreadySynced: boolean;
      current: { name: string; transportUrl: string; fingerprint: string }[];
      desired: { name: string; transportUrl: string; fingerprint: string }[];
      currentCount: number;
      desiredCount: number;
    }>(`/users/${id}/sync-plan`);
  }

  async getGroupSyncStatus(id: string) {
    // Server aggregates every member's status in one pass (see
    // server/routes/groups.js `/:id/sync-status`) - avoids the N+1 of
    // fetching each member's own sync-status individually, which is what
    // used to blow through the API rate limit on groups with several users.
    return this.fetch<{ groupStatus: 'synced' | 'unsynced'; userStatuses: Array<{ userId: string; status?: string; isSynced?: boolean; message?: string }> }>(`/groups/${id}/sync-status`);
  }

  async getUserStremioAddons(id: string) {
    const response = await this.fetch<{ userId: string; count: number; addons: any[] }>(`/users/${id}/stremio-addons`);
    // Normalize the response - backend returns manifestUrl but we need transportUrl
    const normalized = (response.addons || []).map((addon: any) => ({
      ...addon,
      transportUrl: addon.transportUrl || addon.manifestUrl || addon.url || '',
      manifest: addon.manifest || {
        id: addon.id || 'unknown',
        name: addon.name || 'Unknown',
        version: addon.version || 'unknown',
        description: addon.description || '',
        logo: addon.iconUrl || addon.logo || null,
        resources: addon.resources || [],
        types: addon.types || [],
      },
    }));
    return normalized as StremioAddon[];
  }

  // Nuvio Collections (admin) — pull/edit/push a Nuvio profile's own
  // home-screen Collections. Distinct from this app's local "Catalogs".
  async getNuvioProfiles(userId: string) {
    return this.fetch<{ profiles: NuvioProfile[] }>(`/users/${encodeURIComponent(userId)}/nuvio-profiles`);
  }

  async getNuvioCollections(userId: string, profileId: number) {
    return this.fetch<{ collections: NuvioCollection[] }>(
      `/users/${encodeURIComponent(userId)}/nuvio-collections/${profileId}`
    );
  }

  async setNuvioCollections(userId: string, profileId: number, collections: NuvioCollection[]) {
    return this.fetch<{ success: boolean; collections: NuvioCollection[] }>(
      `/users/${encodeURIComponent(userId)}/nuvio-collections/${profileId}`,
      { method: 'PUT', body: JSON.stringify({ collections }) }
    );
  }

  /** Collections Guard: profiles whose Nuvio collections or home-row layout look externally overwritten. */
  async getCollectionsGuardAlarms() {
    return this.fetch<{ alarms: Array<{ kind: 'collections' | 'layout'; userId: string; username: string | null; profileId: number; currentCount: number; lastGoodCount: number | null; lastGoodAt: string | null; detectedAt: string; preview: string[]; previewTotal: number }> }>(
      '/users/collections-guard/alarms'
    );
  }

  async restoreCollectionsSnapshot(userId: string, profileId: number, kind: 'collections' | 'layout' = 'collections') {
    return this.fetch<{ success: boolean; restoredCount?: number; restoredItems?: number; from: string }>('/users/collections-guard/restore', {
      method: 'POST', body: JSON.stringify({ userId, profileId, kind }),
    });
  }

  async acceptCollectionsState(userId: string, profileId: number, kind: 'collections' | 'layout' = 'collections') {
    return this.fetch<{ success: boolean; acceptedCount?: number; acceptedItems?: number }>('/users/collections-guard/accept', {
      method: 'POST', body: JSON.stringify({ userId, profileId, kind }),
    });
  }

  /** Smart Catalogs: store the criteria a catalog keeps re-evaluating (null clears it). */
  async setSmartRule(listId: string, rule: SmartCatalogRule | null, autoRefresh = true) {
    return this.fetch<{ success: boolean; rule: SmartCatalogRule | null; description: string }>(
      `/lists/${encodeURIComponent(listId)}/smart-rule`,
      { method: 'PUT', body: JSON.stringify({ rule, autoRefresh }) }
    );
  }
  async refreshSmartCatalog(listId: string) {
    return this.fetch<{ success: boolean; id: string; name: string; count: number }>(
      `/lists/${encodeURIComponent(listId)}/smart-refresh`, { method: 'POST' }
    );
  }

  /** The household's own titles (watchlist + recent history), for instant local matches. */
  async getLocalIndex() {
    return this.fetch<{ items: Array<{ id: string; name: string; type: 'movie' | 'series'; poster: string | null }> }>('/discover/local-index');
  }

  /** A series' episode list grouped by season, with watched state. Lazy -
   *  the detail modal only asks when someone expands the season list. */
  async getMediaEpisodes(itemId: string) {
    return this.fetch<{ seasons: SeriesSeason[] }>(`/users/media-episodes?itemId=${encodeURIComponent(itemId)}`);
  }

  /** Tip-of-the-tongue search: a plot description -> real, TMDb-verified titles. */
  async searchByDescription(description: string, type?: 'movie' | 'series') {
    return this.fetch<{ items: DiscoverItem[]; candidates: number; filteredByType: 'movie' | 'series' | null }>('/discover/describe', {
      method: 'POST', body: JSON.stringify({ description, type }),
    });
  }

  /** Followed people and shows, muted ones included. */
  async getFollows() {
    return this.fetch<FollowedSubject[]>('/follows');
  }
  /** Follow a person (TMDb id) or a show (tt id); following again un-mutes. */
  async followSubject(kind: 'person' | 'show', subjectId: string, name: string, poster?: string | null) {
    return this.fetch<FollowedSubject>('/follows', {
      method: 'POST', body: JSON.stringify({ kind, subjectId, name, poster }),
    });
  }
  async muteFollow(id: string, muted: boolean) {
    return this.fetch<{ success: boolean; muted: boolean }>(`/follows/${encodeURIComponent(id)}/mute`, {
      method: 'PUT', body: JSON.stringify({ muted }),
    });
  }
  async unfollowSubject(id: string) {
    return this.fetch<{ success: boolean }>(`/follows/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** This season's airing anime (AniList, no key required). */
  async getSeasonalAnime() {
    return this.fetch<{ items: SeasonalAnime[] }>('/anime/seasonal');
  }
  /** Attaches AniList data (episode count, airing countdown) to a known title. */
  async lookupAnime(title: string, year?: number) {
    const params = new URLSearchParams({ title });
    if (year) params.set('year', String(year));
    return this.fetch<{ found: boolean; anilistId?: number; malId?: number | null; name?: string; episodes?: number | null; status?: string | null; nextEpisode?: { episode: number; airingAt: string; label: string } | null; siteUrl?: string | null }>(
      `/anime/lookup?${params.toString()}`
    );
  }
  /** Franchise watch order - main line, side stories and movies kept apart. */
  async getAnimeWatchOrder(anilistId: number) {
    return this.fetch<{ mainLine: AnimeEntry[]; sideStories: AnimeEntry[]; movies: AnimeEntry[] }>(`/anime/${anilistId}/watch-order`);
  }

  /** The profile's home-screen row arrangement, labelled with real addon/catalog names. */
  async getNuvioHomeLayout(userId: string, profileId: number) {
    return this.fetch<{ items: NuvioHomeRow[]; unarranged: NuvioHomeRow[]; sourcePlatform: string | null; buckets: string[] }>(
      `/users/${encodeURIComponent(userId)}/home-layout/${profileId}`
    );
  }

  /** Writes the arrangement back - array order becomes the on-device row order. */
  async saveNuvioHomeLayout(userId: string, profileId: number, items: NuvioHomeRow[]) {
    return this.fetch<{ success: boolean; rows: number; buckets: number }>(
      `/users/${encodeURIComponent(userId)}/home-layout/${profileId}`,
      { method: 'PUT', body: JSON.stringify({ items }) }
    );
  }

  /** Copy one Nuvio profile's whole home-row arrangement onto another profile (overwrites the target's). */
  async copyHomeLayout(userId: string, fromProfileId: number, toProfileId: number) {
    return this.fetch<{ success: boolean; copiedItems: number }>('/users/home-layout/copy', {
      method: 'POST', body: JSON.stringify({ userId, fromProfileId, toProfileId }),
    });
  }

  async getNuvioCommunityCovers(userId: string, opts: { sort?: string; orientation?: string; format?: string; page?: number; limit?: number; search?: string } = {}) {
    const params = new URLSearchParams();
    if (opts.sort) params.set('sort', opts.sort);
    if (opts.orientation) params.set('orientation', opts.orientation);
    if (opts.format) params.set('format', opts.format);
    if (opts.page) params.set('page', String(opts.page));
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.search) params.set('search', opts.search);
    const qs = params.toString();
    return this.fetch<NuvioCommunityCoversResponse>(
      `/users/${encodeURIComponent(userId)}/nuvio-covers${qs ? `?${qs}` : ''}`
    );
  }

  async getNuvioCatalogPreview(userId: string, addonUrl: string, type: string, catalogId: string, genre?: string) {
    const params = new URLSearchParams({ addonUrl, type, catalogId });
    if (genre && genre !== 'none') params.set('genre', genre);
    return this.fetch<{ items: { id: string; type: string; name: string; poster: string | null }[] }>(
      `/users/${encodeURIComponent(userId)}/nuvio-catalog-preview?${params.toString()}`
    );
  }

  // Import user addons to a new group (copied from old UI)
  async importUserAddons(id: string) {
    // Fetch live addons from Stremio for this user first
    const stremioResponse = await this.fetch<{ userId: string; count: number; addons: any[] }>(`/users/${id}/stremio-addons`);
    const addons: any[] = Array.isArray(stremioResponse?.addons)
      ? stremioResponse.addons
      : [];

    // Post the collected addons to the import endpoint
    return this.fetch<{ importedCount: number; message: string }>(`/users/${id}/import-addons`, {
      method: 'POST',
      body: JSON.stringify({ addons }),
    });
  }

  async getUserGroupAddons(id: string) {
    const response = await this.fetch<{ addons: Addon[] }>(`/users/${id}/group-addons`);
    return response.addons || [];
  }

  async updateUserExcludedAddons(id: string, excludedAddons: string[]) {
    return this.fetch(`/users/${id}/excluded-addons`, {
      method: 'PUT',
      body: JSON.stringify({ excludedAddons }),
    });
  }

  async reorderUserStremioAddons(id: string, orderedAddonNames: string[]) {
    return this.fetch(`/users/${id}/stremio-addons/reorder`, {
      method: 'POST', // Changed from PUT to POST to match backend
      body: JSON.stringify({ orderedNames: orderedAddonNames }), // Changed from orderedAddonNames to orderedNames
    });
  }

  async toggleUserProtectedAddon(id: string, addonName: string) {
    return this.fetch<{ isProtected: boolean; message: string }>(`/users/${id}/protect-addon`, {
      method: 'POST',
      body: JSON.stringify({ name: addonName }), // Changed from addonName to name
    });
  }

  async removeUserStremioAddon(id: string, addonName: string) {
    return this.fetch(`/users/${id}/stremio-addons/${encodeURIComponent(addonName)}`, {
      method: 'DELETE',
    });
  }

  // Groups
  async getGroups() {
    return this.fetch<Group[]>('/groups');
  }

  async getGroup(id: string) {
    return this.fetch<Group>(`/groups/${id}`);
  }

  async createGroup(data: CreateGroupData) {
    return this.fetch<Group>('/groups', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateGroup(id: string, data: Partial<Group>) {
    return this.fetch<Group>(`/groups/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async toggleGroupStatus(id: string, isActive: boolean) {
    return this.fetch<Group>(`/groups/${id}/toggle-status`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
  }

  async deleteGroup(id: string) {
    return this.fetch(`/groups/${id}`, { method: 'DELETE' });
  }

  async syncGroup(id: string) {
    return this.fetch(`/groups/${id}/sync`, { method: 'POST' });
  }

  async getGroupAddons(id: string) {
    // Backend returns { addons: [...] } with a slightly different shape
    const response = await this.fetch<{ addons: any[] }>(`/groups/${id}/addons`);
    const rawAddons = Array.isArray(response?.addons) ? response.addons : [];

    // Normalize to the Addon type used by the UI
    return rawAddons
      .filter((a) => {
        // Ensure we have a valid ID
        if (!a.id) {
          console.warn('Addon without ID from backend:', a);
          return false;
        }
        return true;
      })
      .map((a) => {
        const manifest = a.manifest || {};
        // Get logo from multiple sources
        const logo = a.customLogo ||
          manifest.logo ||
          (manifest.id && `https://stremio-addon.netlify.app/${manifest.id}/icon.png`) ||
          undefined;
        return {
          id: a.id, // This is guaranteed to exist after filter
          name: a.name || manifest.name || 'Unnamed Addon',
          description: a.description || manifest.description || '',
          manifestUrl: a.transportUrl || '',
          stremioAddonId: manifest.id,
          version: manifest.version,
          logo,
          resources: Array.isArray(manifest.resources)
            ? manifest.resources.map((r: any) => (typeof r === 'string' ? r : r.name)).filter(Boolean)
            : [],
          catalogs: Array.isArray(manifest.catalogs) ? manifest.catalogs : [],
          createdAt: '',
          updatedAt: '',
        } as Addon;
      });
  }

  async addAddonToGroup(groupId: string, addonId: string) {
    return this.fetch(`/groups/${groupId}/addons/${addonId}`, { method: 'POST' });
  }

  async removeAddonFromGroup(groupId: string, addonId: string) {
    return this.fetch(`/groups/${groupId}/addons/${addonId}`, { method: 'DELETE' });
  }

  async reorderGroupAddons(groupId: string, orderedAddonIds: string[]) {
    try {
      return await this.fetch(`/groups/${groupId}/addons/reorder`, {
        method: 'POST',
        body: JSON.stringify({ orderedAddonIds }),
      });
    } catch (error: any) {
      // Log error details separately to avoid serialization issues
      console.error('API reorderGroupAddons error - message:', error?.message);
      if (error?.data) {
        console.error('API reorderGroupAddons error - data:', error.data);
      }
      console.error('API reorderGroupAddons error - type:', typeof error);
      console.error('API reorderGroupAddons error - response data:', error?.response?.data);
      console.error('API reorderGroupAddons error - response status:', error?.response?.status);
      console.error('API reorderGroupAddons error - groupId:', groupId);
      console.error('API reorderGroupAddons error - orderedAddonIds:', orderedAddonIds);
      if (error?.response?.data?.details?.availableAddonIds) {
        console.error('API reorderGroupAddons error - available addon IDs from backend:', error.response.data.details.availableAddonIds);
      }
      console.error('API reorderGroupAddons error - full error:', error);
      throw error;
    }
  }

  async addUserToGroup(groupId: string, userId: string) {
    return this.fetch(`/groups/${groupId}/users/${userId}`, { method: 'POST' });
  }

  async removeUserFromGroup(groupId: string, userId: string) {
    return this.fetch(`/groups/${groupId}/users/${userId}`, { method: 'DELETE' });
  }

  // Addons
  async getAddons() {
    return this.fetch<Addon[]>('/addons');
  }

  async getAddon(id: string) {
    return this.fetch<Addon>(`/addons/${id}`);
  }

  /** Browse the public Stremio addon directory (proxied + cached by
   * server/routes/addonDirectory.js). Read-only: installing one of these
   * goes through createAddon below, which re-fetches the manifest from the
   * addon's own URL rather than trusting the directory listing. */
  async browseAddonDirectory(opts: { page?: number; search?: string; category?: string } = {}) {
    const params = new URLSearchParams();
    if (opts.page) params.set('page', String(opts.page));
    if (opts.search) params.set('search', opts.search);
    if (opts.category) params.set('category', opts.category);
    const qs = params.toString();
    return this.fetch<{
      addons: Array<{
        id: string | null;
        name: string;
        description: string;
        version: string | null;
        logo: string | null;
        manifestUrl: string;
        configureUrl: string | null;
        stars: number;
        types: string[];
        resources: string[];
        categories: string[];
      }>;
      pagination: { page: number; totalPages: number; total: number; hasNextPage: boolean; hasPreviousPage: boolean };
      cached?: boolean;
    }>(`/addon-directory${qs ? `?${qs}` : ''}`);
  }

  async createAddon(data: CreateAddonData) {
    // Backend expects 'url' but we use 'manifestUrl' in the interface
    const payload: any = { ...data };
    if (payload.manifestUrl && !payload.url) {
      payload.url = payload.manifestUrl;
      delete payload.manifestUrl;
    }
    // If manifestData is provided, extract name from it if name is not provided
    // This ensures the backend always has a name field (required for duplicate check)
    if (payload.manifestData && payload.manifestData.name && !payload.name) {
      payload.name = payload.manifestData.name;
    }
    // Keep manifestData if provided (for pre-fetched manifests)
    if (payload.manifestData) {
      // manifestData is already in the payload
    }
    const result = await this.fetch<any>('/addons', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    // Backend sometimes wraps addon in { addon, message }
    return (result?.addon || result) as Addon;
  }

  async updateAddon(id: string, data: Partial<Addon>) {
    // Backend expects 'url' but we use 'manifestUrl' in the interface
    const payload: any = { ...data };
    if (payload.manifestUrl && !payload.url) {
      payload.url = payload.manifestUrl;
      delete payload.manifestUrl;
    }
    return this.fetch<Addon>(`/addons/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  async toggleAddonStatus(id: string, isActive: boolean) {
    return this.fetch<Addon>(`/addons/${id}/toggle-status`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
  }

  /** Returns trashId when the addon was archived first, so the caller can
   * offer an immediate Undo - see server/utils/trash.js. */
  async deleteAddon(id: string) {
    return this.fetch<{ message?: string; trashId?: string | null }>(`/addons/${id}`, { method: 'DELETE' });
  }

  async moveAddonToVault(id: string, category: string): Promise<{ success: boolean; vaultEntryId: string; removedFromGroups: number }> {
    return this.fetch(`/addons/${id}/move-to-vault`, {
      method: 'POST',
      body: JSON.stringify({ category }),
    });
  }

  async reloadAddon(id: string) {
    return this.fetch(`/addons/${id}/reload`, { method: 'POST' });
  }

  async getAddonHealthHistory(id: string, limit = 50) {
    return this.fetch<{
      addonId: string;
      addonName: string;
      history: Array<{
        id: string;
        isOnline: boolean;
        error: string | null;
        checkedAt: string;
        responseTimeMs: number | null;
      }>;
    }>(`/addons/${id}/health-history?limit=${limit}`);
  }

  // AI incident summary of recent health-check history - null when the
  // history is clean (nothing to summarize) or no AI key is configured.
  async getAddonHealthSummary(id: string) {
    return this.fetch<{ summary: string | null }>(`/addons/${id}/health-summary`);
  }

  // Backup Management
  async getAddonBackup(id: string) {
    return this.fetch<{
      addonId: string;
      addonName: string;
      usingBackup: boolean;
      backup: {
        id: string;
        manifestUrl: string;
        stremioAddonId: string | null;
        name: string | null;
        isOnline: boolean;
        lastCheck: string | null;
        checkError: string | null;
        createdAt: string;
        updatedAt: string;
      } | null;
    }>(`/addons/${id}/backup`);
  }

  async setAddonBackup(id: string, backupAddonId: string) {
    return this.fetch<{
      message: string;
      backupAddon: {
        id: string;
        name: string;
        isActive: boolean;
        isOnline: boolean;
      };
    }>(`/addons/${id}/backup`, {
      method: 'PUT',
      body: JSON.stringify({ backupAddonId }),
    });
  }

  async deleteAddonBackup(id: string) {
    return this.fetch<{ message: string }>(`/addons/${id}/backup`, {
      method: 'DELETE',
    });
  }

  async getAddonBackupActive(id: string) {
    return this.fetch<{
      chain: Array<{
        id: string;
        name: string;
        isActive: boolean;
        isOnline: boolean;
        lastHealthCheck: string | null;
      }>;
      activeAddon: {
        id: string;
        name: string;
        isActive: boolean;
        isOnline: boolean;
        lastHealthCheck: string | null;
      };
      isUsingBackup: boolean;
      totalChainLength: number;
      message: string;
    }>(`/addons/${id}/backup/active`);
  }

  // Proxy
  // These three routes answer through responseUtils.success, which wraps the
  // payload as { success, message, data } - so the fields live under .data,
  // NOT at the top level. The declared return types used to claim otherwise,
  // which meant every caller read `result.proxyUuid` as undefined: the proxy
  // was enabled correctly server-side, but the page then rendered "Not
  // generated" until a manual reload. Unwrapped here so callers keep the
  // flat shape they always expected.
  private async proxyAction(id: string, action: 'enable' | 'disable' | 'regenerate') {
    const res = await this.fetch<{ success?: boolean; data?: ProxyActionResult } & Partial<ProxyActionResult>>(
      `/addons/${id}/proxy/${action}`,
      { method: 'POST' }
    );
    // Tolerates both shapes, so this cannot break again if a route is ever
    // changed to answer flat.
    return (res?.data ?? res) as ProxyActionResult;
  }

  async enableProxy(id: string): Promise<ProxyActionResult> {
    return this.proxyAction(id, 'enable');
  }

  async disableProxy(id: string): Promise<ProxyActionResult> {
    return this.proxyAction(id, 'disable');
  }

  async regenerateProxyUuid(id: string): Promise<ProxyActionResult> {
    return this.proxyAction(id, 'regenerate');
  }

  async getProxyLogs(id: string, limit?: number, offset?: number): Promise<{ logs: any[], total: number, limit: number, offset: number }> {
    const params = new URLSearchParams();
    if (limit) params.append('limit', limit.toString());
    if (offset) params.append('offset', offset.toString());
    const query = params.toString() ? `?${params.toString()}` : '';
    const response = await this.fetch<{ success: boolean; data: { logs: any[], total: number, limit: number, offset: number } }>(`/addons/${id}/proxy-logs${query}`);
    return response.data;
  }

  async getAllProxyLogs(limit?: number, offset?: number, addonId?: string): Promise<{ logs: any[], total: number, limit: number, offset: number }> {
    const params = new URLSearchParams();
    if (limit) params.append('limit', limit.toString());
    if (offset) params.append('offset', offset.toString());
    if (addonId) params.append('addonId', addonId);
    const query = params.toString() ? `?${params.toString()}` : '';
    const response = await this.fetch<{ success: boolean; data: { logs: any[], total: number, limit: number, offset: number } }>(`/addons/proxy-logs/all${query}`);
    return response.data;
  }

  // Invitations
  async getInvitations() {
    return this.fetch<Invitation[]>('/invitations');
  }

  async createInvitation(data: CreateInvitationData) {
    // Map frontend field names to backend field names
    // IMPORTANT: Use null instead of undefined so JSON.stringify includes the key
    // Backend treats null/undefined as unlimited (0)
    const payload: any = {
      name: data.name || null,
      groupName: data.groupName || null,
      // Explicitly send null for unlimited (backend treats null as 0 = unlimited)
      maxUses: data.maxUses ?? null,
      expiresAt: data.expiresAt || null,
      // Backend expects membershipDurationDays, not membershipDuration
      membershipDurationDays: data.membershipDuration ?? null,
      syncOnJoin: data.syncOnJoin ?? false,
    };
    const result = await this.fetch<any>('/invitations', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return (result?.invitation || result) as Invitation;
  }

  async updateInvitation(id: string, data: Partial<CreateInvitationData>) {
    // Map frontend field names to backend field names
    // Use null instead of undefined so JSON.stringify includes the key
    const payload: any = {};
    if (data.name !== undefined) payload.name = data.name || null;
    if (data.groupName !== undefined) payload.groupName = data.groupName || null;
    // Explicitly send null for unlimited (backend treats null as 0 = unlimited)
    if (data.maxUses !== undefined) payload.maxUses = data.maxUses ?? null;
    if (data.expiresAt !== undefined) payload.expiresAt = data.expiresAt || null;
    if (data.membershipDuration !== undefined) payload.membershipDurationDays = data.membershipDuration ?? null;
    if (data.syncOnJoin !== undefined) payload.syncOnJoin = data.syncOnJoin;

    return this.fetch<Invitation>(`/invitations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }

  async toggleInvitationStatus(id: string, isActive: boolean) {
    return this.fetch<Invitation>(`/invitations/${id}/toggle-status`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
  }

  async refreshInvitationOAuth(requestId: string) {
    return this.fetch<{ oauthCode: string; oauthLink: string; oauthExpiresAt: string }>(`/invitations/requests/${requestId}/refresh-oauth`, {
      method: 'POST',
    });
  }

  async deleteInvitation(id: string) {
    return this.fetch(`/invitations/${id}`, { method: 'DELETE' });
  }

  async getInvitationRequests(id: string) {
    return this.fetch<InviteRequest[]>(`/invitations/${id}/requests`);
  }

  async acceptInviteRequest(requestId: string) {
    return this.fetch(`/invitations/requests/${requestId}/accept`, { method: 'POST' });
  }

  async rejectInviteRequest(requestId: string) {
    return this.fetch(`/invitations/requests/${requestId}/reject`, { method: 'POST' });
  }

  // Account/Stats
  async getAccountStats() {
    return this.fetch<AccountStats>('/ext/account');
  }

  // Identity of the signed-in account, over the ordinary session cookie.
  // Deliberately not getAccountStats() for this: that hits /ext/*, which
  // authenticates with an API key, and a freshly registered account hasn't
  // configured one yet - it 401s for exactly the new accounts that need
  // identifying most.
  async getAccountIdentity() {
    return this.fetch<{ id: string; uuid: string | null }>('/settings/account-info');
  }

  async updateAccountAvatar(avatarUrl: string | null) {
    return this.fetch<{ avatarUrl: string | null }>('/settings/account-avatar', {
      method: 'PUT',
      body: JSON.stringify({ avatarUrl }),
    });
  }

  async updateAccountDisplayName(displayName: string | null) {
    return this.fetch<{ displayName: string | null }>('/settings/account-display-name', {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    });
  }

  // Settings
  async getSyncSettings() {
    return this.fetch<SyncSettings>('/settings/account-sync');
  }

  async updateSyncSettings(data: Partial<SyncSettings>) {
    return this.fetch<SyncSettings>('/settings/account-sync', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // Self-service, irreversible, public-instance-only - see the server
  // route's own comment for why this never accepts an id (always the
  // caller's own account, resolved server-side from the session).
  async deleteMyAccount() {
    return this.fetch<{ deleted: boolean }>('/settings/delete-account', { method: 'POST' });
  }

  /** Asks a self-hosted Nuvio backend to describe itself via /.well-known/nuvio. */
  async discoverNuvioBackend(url: string) {
    return this.fetch<{ ok: boolean; url?: string; anonKey?: string; error?: string }>('/settings/account-sync/discover-nuvio', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  }

  async testWebhook(webhookUrl: string) {
    return this.fetch('/settings/account-sync/test-webhook', {
      method: 'POST',
      body: JSON.stringify({ webhookUrl }),
    });
  }

  async generateMosaicNow(month?: string) {
    return this.fetch<{ posted: boolean; reason?: string | null; count: number; month?: string }>('/settings/mosaic/generate-now', {
      method: 'POST',
      body: JSON.stringify(month ? { month } : {}),
    });
  }

  async getApiKeyStatus() {
    return this.fetch<{ hasKey: boolean; apiKey?: string }>('/settings/account-api');
  }

  async generateApiKey() {
    return this.fetch<{ apiKey: string }>('/settings/account-api-key', {
      method: 'POST',
    });
  }

  async rotateApiKey() {
    return this.fetch<{ apiKey: string }>('/settings/account-api-key', {
      method: 'PUT',
    });
  }

  // AI Services - powers natural-language Catalog building (Catalogs ->
  // "Describe a catalog"). Stored as a Vault entry underneath, but this is
  // the focused Settings-native form for it - see server/routes/settings.js's
  // account-ai-services comment for why.
  async getAiServicesStatus() {
    return this.fetch<{ configured: boolean; baseUrl?: string | null; model?: string | null; lastCheckStatus?: 'ok' | 'error' | null; lastCheckMessage?: string | null }>('/settings/account-ai-services');
  }
  // The real stored key, for the eye icon's reveal - same underlying
  // VaultEntry secret as vault.js's own /:id/reveal.
  async revealAiServicesKey() {
    return this.fetch<{ secret: string }>('/settings/account-ai-services/reveal', { method: 'POST' });
  }
  // Saving always re-verifies with a real request (see settings.js's own
  // comment) - the response's lastCheckStatus/Message reflect that just-run
  // check, not merely "something got saved."
  async setAiServices(data: { apiKey?: string; baseUrl?: string; model?: string }) {
    return this.fetch<{ configured: boolean; lastCheckStatus: 'ok' | 'error'; lastCheckMessage: string | null }>('/settings/account-ai-services', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }
  // Live model list from the provider itself, not a hardcoded guess - see
  // settings.js's own comment on why (model names go stale fast). apiKey
  // blank falls back to whatever's already saved.
  async listAiModels(data: { apiKey?: string; baseUrl?: string }) {
    return this.fetch<{ models: string[] }>('/settings/account-ai-services/list-models', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }
  async removeAiServices() {
    return this.fetch<{ configured: boolean }>('/settings/account-ai-services', {
      method: 'DELETE',
    });
  }

  // Two-factor auth (TOTP) - opt-in, per account. See server/utils/twoFactor.js.
  async get2faStatus() {
    return this.fetch<{ enabled: boolean }>('/settings/account-2fa');
  }
  async setup2fa() {
    return this.fetch<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string }>('/settings/account-2fa/setup', {
      method: 'POST',
    });
  }
  async enable2fa(secret: string, code: string) {
    return this.fetch<{ enabled: boolean; backupCodes: string[] }>('/settings/account-2fa/enable', {
      method: 'POST',
      body: JSON.stringify({ secret, code }),
    });
  }
  async disable2fa(code: string) {
    return this.fetch<{ enabled: boolean }>('/settings/account-2fa/disable', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }
  async regenerate2faBackupCodes(code: string) {
    return this.fetch<{ backupCodes: string[] }>('/settings/account-2fa/backup-codes', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }

  async getBackupFrequency() {
    return this.fetch<{ days: number }>('/settings/backup-frequency');
  }

  async setBackupFrequency(days: number) {
    return this.fetch('/settings/backup-frequency', {
      method: 'PUT',
      body: JSON.stringify({ days }),
    });
  }

  async runBackupNow() {
    return this.fetch('/settings/backup-now', { method: 'POST' });
  }

  async listBackups() {
    return this.fetch<BackupFile[]>('/settings/backups');
  }

  async getDbSizeReport() {
    return this.fetch<DbSizeReport>('/settings/db-size');
  }

  async downloadBackup(filename: string) {
    const response = await fetch(`${API_BASE}/settings/backups/${encodeURIComponent(filename)}/download`, {
      credentials: 'include',
      headers: this.getAuthHeaders(),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Download failed' }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // DESTRUCTIVE - replaces all current users/groups/addons with the
  // backup's contents. Caller is responsible for confirming with the user
  // first; this just performs the restore.
  /** What restoring this backup would change - names only, computed before
   * anything is touched. Feeds the confirmation dialog. */
  async diffBackup(filename: string) {
    return this.fetch<{
      backupDate: string | null;
      addons: { added: string[]; removed: string[]; changed: string[] };
      users: { added: string[]; removed: string[] };
      groups: { added: string[]; removed: string[] };
      counts: { backup: { addons: number; users: number; groups: number }; current: { addons: number; users: number; groups: number } };
    }>(`/settings/backups/${encodeURIComponent(filename)}/diff`);
  }

  /** One-code migration: mint a single-use 15-minute code carrying this
   * instance's whole household to a new server. */
  async offerMigration() {
    return this.fetch<{ code: string; expiresInMinutes: number }>('/settings/migration/offer', { method: 'POST' });
  }

  /** Paste the code on the NEW instance - fetches and restores everything.
   * Destructive: replaces this instance's data. */
  async receiveMigration(code: string) {
    return this.fetch<Record<string, unknown>>('/settings/migration/receive', { method: 'POST', body: JSON.stringify({ code }) });
  }

  async restoreBackup(filename: string) {
    return this.fetch<ImportConfigResult>(`/settings/backups/${encodeURIComponent(filename)}/restore`, {
      method: 'POST',
    });
  }

  async deleteBackup(filename: string) {
    return this.fetch(`/settings/backups/${encodeURIComponent(filename)}`, { method: 'DELETE' });
  }

  // Disaster Recovery Kit - unlike the regular config backup above (Users/
  // Groups/Addons only), this also bundles every Vault secret, re-encrypted
  // under the passphrase supplied here instead of this instance's own
  // ENCRYPTION_KEY, so the file is portable to a brand-new instance.
  async exportDisasterRecoveryKit(passphrase: string) {
    return this.fetch<DisasterRecoveryKit>('/settings/disaster-recovery-kit/export', {
      method: 'POST',
      body: JSON.stringify({ passphrase }),
    });
  }

  async importDisasterRecoveryKit(passphrase: string, kit: DisasterRecoveryKit) {
    return this.fetch<{ restoredVaultCount: number; counts: { users: number; groups: number; addons: number } }>(
      '/settings/disaster-recovery-kit/import',
      { method: 'POST', body: JSON.stringify({ passphrase, kit }) },
    );
  }

  // Addon Snapshots ("Templates") - save a user's/group's current addon
  // set as a named, reusable template; deploy it onto any user later.
  async getSnapshots() {
    return this.fetch<AddonSnapshot[]>('/snapshots');
  }

  async getSnapshot(id: string) {
    return this.fetch<AddonSnapshotDetail>(`/snapshots/${id}`);
  }

  async createSnapshot(data: { name: string; description?: string; sourceType: 'user' | 'group'; sourceId: string }) {
    return this.fetch<{ id: string; name: string; addonCount: number }>('/snapshots', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // --- Backup targets, DB maintenance, updates (private mode) ---
  async getBackupTargets() {
    return this.fetch<BackupTargets>('/settings/backup-targets');
  }
  async saveBackupTargets(data: Partial<BackupTargets>) {
    return this.fetch<BackupTargets>('/settings/backup-targets', { method: 'PUT', body: JSON.stringify(data) });
  }
  async testBackupTarget() {
    return this.fetch<{ ok: boolean; location?: string; error?: string }>('/settings/backup-targets/test', { method: 'POST' });
  }
  /** Full-data backups: real database snapshots, the only lane carrying watch history. */
  async getDataBackup() {
    return this.fetch<DataBackupSettings>('/settings/data-backup');
  }
  async saveDataBackup(data: Partial<Pick<DataBackupSettings, 'enabled' | 'offsite' | 'frequencyDays' | 'keepLocal'>>) {
    return this.fetch<DataBackupSettings>('/settings/data-backup', { method: 'PUT', body: JSON.stringify(data) });
  }
  async runDataBackup() {
    return this.fetch<{ filename: string; sizeBytes: number; encrypted: boolean; verified: boolean | null; users: number | null; upload?: { skipped?: string; ok?: boolean } }>(
      '/settings/data-backup/run', { method: 'POST' }
    );
  }
  async deleteDataSnapshot(filename: string) {
    return this.fetch<{ success: boolean }>(`/settings/data-backup/${encodeURIComponent(filename)}`, { method: 'DELETE' });
  }
  /** Downloads a snapshot to disk - it is the file scripts/restore-data-snapshot.js takes. */
  async downloadDataSnapshot(filename: string) {
    const response = await fetch(`${API_BASE}/settings/data-backup/${encodeURIComponent(filename)}/download`, {
      credentials: 'include',
      headers: this.getAuthHeaders(),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async getDbMaintenance() {
    return this.fetch<DbMaintenanceSettings>('/settings/db-maintenance');
  }
  async saveDbMaintenance(data: Partial<DbMaintenanceSettings>) {
    return this.fetch<DbMaintenanceSettings>('/settings/db-maintenance', { method: 'PUT', body: JSON.stringify(data) });
  }
  async runDbMaintenance(action: 'integrity' | 'vacuum' | 'prune' | 'pruneNotifications') {
    return this.fetch<Record<string, unknown>>('/settings/db-maintenance/run', { method: 'POST', body: JSON.stringify({ action }) });
  }
  async getUpdateCapability() {
    return this.fetch<UpdateCapability>('/settings/update-capability');
  }
  async applyUpdate() {
    return this.fetch<{ started: boolean; note: string }>('/settings/update-apply', { method: 'POST' });
  }
  /** Restart onto the image recorded before the last self-update. */
  async rollbackUpdate() {
    return this.fetch<{ started: boolean; rollingBackTo: string; note: string }>('/settings/update-rollback', { method: 'POST' });
  }

  /** Create a template directly from an addon list (share-code import) -
   * the server encrypts the manifest URLs at rest with ITS key. */
  async importSnapshot(data: { name: string; description?: string; addons: Array<{ name: string; manifestUrl: string | null; stremioAddonId?: string | null; version?: string | null }> }) {
    return this.fetch<{ id: string; name: string; addonCount: number }>('/snapshots/import', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async deploySnapshot(id: string, targetUserId: string) {
    return this.fetch<{ deployed: number; failed: number; targetUserId: string }>(`/snapshots/${id}/deploy`, {
      method: 'POST',
      body: JSON.stringify({ targetUserId }),
    });
  }

  async deleteSnapshot(id: string) {
    return this.fetch(`/snapshots/${id}`, { method: 'DELETE' });
  }

  // New-episode alerts (fired server-side by the episodeAlerts poller)
  async getEpisodeAlerts(days = 14) {
    return this.fetch<EpisodeAlert[]>(`/users/episode-alerts?days=${days}`);
  }

  // Addon online<->offline transitions (fired server-side by addonHealthCheck.js)
  async getAddonHealthAlerts(days = 14) {
    return this.fetch<AddonHealthAlert[]>(`/addons/health-alerts?days=${days}`);
  }

  // Persistent in-app bell notifications - written server-side from the same
  // dispatch path as push/Discord (notificationStore.js), with server-side
  // read state so the bell is consistent across devices.
  async getNotifications(days = 14) {
    return this.fetch<StoredNotification[]>(`/users/notifications?days=${days}`);
  }

  // Mark notifications read - specific ids, or all when omitted.
  async markNotificationsRead(ids?: string[]) {
    return this.fetch('/users/notifications/mark-read', {
      method: 'POST',
      body: JSON.stringify(ids ? { ids } : {}),
    });
  }

  // Delete notifications - specific ids, or all when omitted (Clear).
  async dismissNotifications(ids?: string[]) {
    return this.fetch('/users/notifications/dismiss', {
      method: 'POST',
      body: JSON.stringify(ids ? { ids } : {}),
    });
  }

  // PWA web-push
  async getPushVapidKey() {
    return this.fetch<{ enabled: boolean; publicKey: string | null }>('/push/vapid-key');
  }

  async savePushSubscription(sub: PushSubscriptionJSON, userAgent?: string) {
    return this.fetch('/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ ...sub, userAgent }),
    });
  }

  async removePushSubscription(endpoint: string) {
    return this.fetch('/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    });
  }

  async getPushDevices() {
    return this.fetch<PushDevice[]>('/push/devices');
  }

  async renamePushDevice(id: string, label: string | null) {
    return this.fetch<PushDevice>(`/push/devices/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ label }),
    });
  }

  async revokePushDevice(id: string) {
    return this.fetch<{ success: boolean }>(`/push/devices/${id}`, { method: 'DELETE' });
  }

  async repairAddons() {
    return this.fetch<{ inspected: number; updated: number }>('/settings/repair-addons', {
      method: 'POST',
    });
  }

  // Addon Health Check
  async getAddonHealthCheckSettings() {
    return this.fetch<{ enabled: boolean; intervalMinutes: number }>('/settings/addon-health-check');
  }

  async setAddonHealthCheckInterval(intervalMinutes: number) {
    return this.fetch('/settings/addon-health-check', {
      method: 'PUT',
      body: JSON.stringify({ intervalMinutes }),
    });
  }

  async runAddonHealthCheckNow() {
    return this.fetch('/settings/addon-health-check/now', { method: 'POST' });
  }

  /** Validity check for whichever of the four metadata-provider keys
   * (TMDb/OMDb/MDBList/RPDB) are actually configured for this account -
   * see server/utils/metadataKeyHealth.js. Returns the merged keyHealth
   * map, same shape SyncSettings.keyHealth carries. */
  /** What this instance has and hasn't been configured with yet, in one
   * call - see server/routes/settings.js's setup-status route. */
  async getSetupStatus() {
    return this.fetch<{
      users: { done: boolean; count: number };
      addons: { done: boolean; count: number };
      notifications: { done: boolean; pushDevices: number };
      vault: { done: boolean; count: number };
      offsiteBackup: { done: boolean };
      recoveryKit: { done: boolean; lastExportAt: string | null };
      automation: { done: boolean; count: number };
      timezone: { done: boolean };
    }>('/settings/setup-status');
  }

  /** Read-only scan for provably-wrong watch history rows. Never writes -
   * see server/utils/historyDoctor.js. */
  async scanHistory() {
    return this.fetch<{
      findings: Array<{ id: string; kind: string; summary: string; detail: string }>;
      counts: { cross_provider_duplicate: number; orphaned: number; total: number };
      scannedAt: string;
    }>('/settings/history-scan');
  }

  /** Deletes what a fresh server-side scan identifies. */
  async repairHistory(kinds?: string[]) {
    return this.fetch<{ removed: number; examined: number }>('/settings/history-repair', {
      method: 'POST',
      body: JSON.stringify({ kinds: kinds || null }),
    });
  }

  /** Recently deleted catalogs and addons, restorable for 30 days.
   * See server/utils/trash.js for why this is an archive rather than
   * deletedAt columns. */
  async getTrash() {
    return this.fetch<Array<{
      id: string; kind: string; label: string; deletedAt: string; expiresInDays: number;
    }>>('/settings/trash');
  }

  async restoreFromTrash(trashId: string) {
    return this.fetch<{ kind: string; label: string }>(`/settings/trash/${encodeURIComponent(trashId)}/restore`, { method: 'POST' });
  }

  /** Permanent - the one delete with nothing behind it. */
  async purgeTrashItem(trashId: string) {
    return this.fetch<{ success: boolean }>(`/settings/trash/${encodeURIComponent(trashId)}`, { method: 'DELETE' });
  }

  /** No argument checks all four keys; a provider name checks just that one
   * (the save-time verification for a single edited field). */
  async checkProviderKeys(provider?: 'tmdb' | 'omdb' | 'mdblist' | 'rpdb'): Promise<{ keyHealth: SyncSettings['keyHealth'] }> {
    const res = await this.fetch<{ data?: { keyHealth: SyncSettings['keyHealth'] } } & Partial<{ keyHealth: SyncSettings['keyHealth'] }>>(
      '/settings/check-keys',
      { method: 'POST', body: JSON.stringify(provider ? { provider } : {}) }
    );
    return (res?.data ?? res) as { keyHealth: SyncSettings['keyHealth'] };
  }

  // Bulk Operations
  async syncAllUsers() {
    const users = await this.getUsers();
    const results = { success: 0, failed: 0 };
    for (const user of users) {
      try {
        await this.syncUser(user.id);
        results.success++;
      } catch {
        results.failed++;
      }
    }
    return results;
  }

  async syncAllGroups() {
    return this.fetch<{
      syncedGroups: number;
      failedGroups: number;
      totalUsersSynced: number;
      totalUsersFailed: number;
    }>('/groups/sync-all', { method: 'POST' });
  }

  async deleteAllUsers() {
    const users = await this.getUsers();
    const results = { success: 0, failed: 0 };
    for (const user of users) {
      try {
        await this.deleteUser(user.id);
        results.success++;
      } catch {
        results.failed++;
      }
    }
    return results;
  }

  async deleteAllGroups() {
    const groups = await this.getGroups();
    const results = { success: 0, failed: 0 };
    for (const group of groups) {
      try {
        await this.deleteGroup(group.id);
        results.success++;
      } catch {
        results.failed++;
      }
    }
    return results;
  }

  // Metrics Migration
  async getMetricsMigrationPreview() {
    return this.fetch<{
      migrationStatus: { hasExistingData: boolean; alreadyMigrated: boolean; sessionsCount: number; episodesCount: number; activitiesCount: number };
      users: { userId: string; username: string; movies: number; shows: number; watchTimeHours: number; dateRange: { earliest: string; latest: string } | null }[];
      totals: { users: number; movies: number; shows: number; watchTimeHours: number; pendingMigration: boolean };
    }>('/users/metrics-migration-preview');
  }

  async runMetricsMigration() {
    return this.fetch<{ migrated: boolean; sessionsCreated: number; episodesCreated: number; reason?: string }>('/users/metrics-migration', { method: 'POST' });
  }

  async deleteAllAddons() {
    const addons = await this.getAddons();
    const results = { success: 0, failed: 0 };
    for (const addon of addons) {
      try {
        await this.deleteAddon(addon.id);
        results.success++;
      } catch {
        results.failed++;
      }
    }
    return results;
  }

  async clearAllUserAddons() {
    const users = await this.getUsers();
    const results = { success: 0, failed: 0 };
    for (const user of users) {
      try {
        await this.fetch(`/users/${user.id}/stremio-addons/clear`, { method: 'POST' });
        results.success++;
      } catch {
        results.failed++;
      }
    }
    return results;
  }

  async reloadAllAddons() {
    return this.fetch<{ reloaded: number }>('/addons/reload-all', { method: 'POST' });
  }

  // Import/Export
  async exportAddons() {
    return this.fetch<Addon[]>('/public-auth/addon-export');
  }

  async exportConfig() {
    return this.fetch<ExportedConfig>('/public-auth/config-export');
  }

  async importAddons(file: File) {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch(`${API_BASE}/public-auth/addon-import`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers: this.getAuthHeaders('POST'),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Import failed' }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }
    return response.json() as Promise<{ successful: number; failed: number; redundant: number }>;
  }

  async importConfig(file: File, passphrase?: string) {
    const formData = new FormData();
    formData.append('file', file);
    // Only needed for .enc files from a passphrase-protected off-site
    // target - the server answers code PASSPHRASE_REQUIRED when one is
    // missing, and the Tasks page prompts and retries.
    if (passphrase) formData.append('passphrase', passphrase);
    const response = await fetch(`${API_BASE}/public-auth/config-import`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers: this.getAuthHeaders('POST'),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Import failed' }));
      const err = new Error(error.message || `HTTP ${response.status}`) as Error & { code?: string };
      err.code = error.code;
      throw err;
    }
    return response.json() as Promise<ImportConfigResult>;
  }

  /** Enable/disable the SlickTrax Addon for a user - the per-user Stremio
   * addon serving Continue Watching / Watchlist / Catalogs inside the apps.
   * rotate: true issues a fresh URL token, killing the old URL everywhere. */
  async setTraxAddon(userId: string, enabled: boolean, rotate = false) {
    return this.fetch<{ enabled: boolean; manifestUrl: string; autoInstall: boolean }>(
      `/users/${encodeURIComponent(userId)}/trax-addon`,
      { method: 'POST', body: JSON.stringify({ enabled, rotate }) },
    );
  }

  /** In-player actions (mark watched / watchlist inside Stremio-Nuvio). */
  async setTraxInPlayerActions(userId: string, enabled: boolean, inPlayerActions: boolean) {
    return this.fetch<{ enabled: boolean; manifestUrl: string; autoInstall: boolean }>(
      `/users/${encodeURIComponent(userId)}/trax-addon`,
      { method: 'POST', body: JSON.stringify({ enabled, inPlayerActions }) },
    );
  }

  // Watch-history CSV import (IMDb/Letterboxd/loose-Trakt-export compatible -
  // see server/utils/csvHistoryImport.js) for one household member.
  /** Vault-inject an addon: its embedded secrets become {{vault:id}}
   * placeholders that only the server-side proxy resolves, so the real key
   * never again appears in the stored URL or on any device. */
  async vaultifyAddon(addonId: string) {
    return this.fetch<{ data?: { vaultified: boolean; entries: string[]; proxyManifestUrl: string; note: string } } & { message?: string }>(
      `/addons/${encodeURIComponent(addonId)}/vaultify`, { method: 'POST' });
  }

  async unvaultifyAddon(addonId: string) {
    return this.fetch<{ data?: { vaultified: boolean } } & { message?: string }>(
      `/addons/${encodeURIComponent(addonId)}/unvaultify`, { method: 'POST' });
  }

  async importUserHistory(userId: string, file: File) {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch(`${API_BASE}/users/${encodeURIComponent(userId)}/import-history`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers: this.getAuthHeaders('POST'),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Import failed' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    return response.json() as Promise<{ imported: number; skipped: number; skippedEpisodes?: number; totalRows: number; truncated: boolean; unresolvedTitles: string[] }>;
  }

  // Letterboxd-import-compatible CSV export for one household member - a
  // raw text fetch (not JSON), so the caller builds a download Blob from
  // it, same pattern as every other "export my data" flow in this app
  // (a plain <a href> to the API URL would bypass the auth headers this
  // request needs).
  async exportUserHistory(userId: string): Promise<string> {
    const response = await fetch(`${API_BASE}/users/${encodeURIComponent(userId)}/export-history.csv`, {
      credentials: 'include',
      headers: this.getAuthHeaders('GET'),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Export failed' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    return response.text();
  }

  async resetConfig() {
    return this.fetch('/public-auth/reset', { method: 'POST' });
  }

  async backupUserLibrary(userId: string) {
    const response = await fetch(`${API_BASE}/users/${userId}/library/backup`, {
      credentials: 'include',
      headers: this.getAuthHeaders(),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Export failed' }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }
    const data = await response.json();
    // Download as file
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${date}-library-export.json`;
    a.click();
    URL.revokeObjectURL(url);
    return data;
  }

  // History export/import
  async exportHistory(userId?: string) {
    const queryParam = userId && userId !== 'all' ? `?userId=${userId}` : '?userId=all';
    const response = await fetch(`${API_BASE}/users/history/export${queryParam}`, {
      credentials: 'include',
      headers: this.getAuthHeaders(),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Export failed' }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }
    const data = await response.json();
    // Download as file
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const suffix = userId && userId !== 'all' ? '-user' : '-all';
    const a = document.createElement('a');
    a.href = url;
    a.download = `${date}-history${suffix}.json`;
    a.click();
    URL.revokeObjectURL(url);
    return data;
  }

  async importHistory(file: File, targetUserId?: string): Promise<{
    message: string;
    results: {
      watchSessions: { imported: number; skipped: number };
      episodeWatchHistory: { imported: number; skipped: number };
      watchActivity: { imported: number; skipped: number };
      watchSnapshots: { imported: number; skipped: number };
    };
  }> {
    const text = await file.text();
    const data = JSON.parse(text);
    if (targetUserId) {
      data.targetUserId = targetUserId;
    }
    return this.fetch('/users/history/import', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async clearUserHistory(userId: string): Promise<{
    message: string;
    deleted: {
      watchSessions: number;
      episodeWatchHistory: number;
      watchActivity: number;
      watchSnapshots: number;
    };
  }> {
    return this.fetch(`/users/${userId}/history`, {
      method: 'DELETE',
    });
  }

  async clearUserLibrary(userId: string): Promise<{
    message: string;
    deleted: number;
  }> {
    return this.fetch(`/users/${userId}/library`, {
      method: 'DELETE',
    });
  }

  async decodeWatchedBitfield(watched: string): Promise<{
    lastVideoId: string;
    lastLength: number;
    serializedBuf: string;
    watchedEpisodes: { episode: number; watched: boolean }[];
    watchedCount: number;
  }> {
    return this.fetch('/users/decode-watched', {
      method: 'POST',
      body: JSON.stringify({ watched }),
    });
  }

  // Stremio OAuth (admin-side helpers)
  async generateStremioOAuth() {
    // Uses public-library router to create an OAuth link and code
    return this.fetch<{
      success?: boolean;
      code: string;
      link: string;
      expiresAt: string;
    }>('/public-library/generate-oauth', {
      method: 'POST',
    });
  }

  async pollStremioOAuth(code: string) {
    // Polls public-library for OAuth completion and returns an authKey when ready
    return this.fetch<{
      success: boolean;
      authKey: string | null;
      error?: string;
    }>('/public-library/poll-oauth', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }

  async verifyStremioAuthKey(payload: { authKey: string; username?: string; email?: string }) {
    // Lightweight verification + user info fetch; does NOT create or persist a user
    return this.fetch<{
      authKey: string;
      user?: { username?: string; email?: string };
    }>('/stremio/connect-authkey', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async createUserWithStremio(data: {
    authKey: string;
    username: string;
    email: string;
    groupName?: string;
    colorIndex?: number;
  }) {
    // Mirrors old UI behavior by delegating user creation to /stremio/connect-authkey
    const payload = {
      authKey: data.authKey,
      username: data.username,
      email: data.email,
      groupName: data.groupName,
      colorIndex: data.colorIndex,
      create: true,
    };

    const result = await this.fetch<any>('/stremio/connect-authkey', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    // Normalize to plain User
    return (result?.user || result) as User;
  }

  async createUserWithCredentials(data: {
    email: string;
    password: string;
    username: string;
    groupName?: string;
    colorIndex?: number;
    registerNew?: boolean;
  }) {
    const payload = {
      email: data.email,
      password: data.password,
      username: data.username,
      groupName: data.groupName,
      colorIndex: data.colorIndex,
      registerNew: data.registerNew,
    };

    const endpoint = data.registerNew ? '/stremio/register' : '/stremio/connect';
    const result = await this.fetch<any>(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return (result?.user || result) as User;
  }

  // --- Nuvio provider ---
  // Mirrors the Stremio pattern above: /nuvio/connect-authkey with create:true
  // is the actual "create a new SlickSync user" endpoint. /nuvio/connect is for
  // reconnecting an *existing* user (requires userId) — not used here.

  async createUserWithNuvioCredentials(data: {
    email: string;
    password: string;
    username: string;
    groupName?: string;
    colorIndex?: number;
  }) {
    const result = await this.fetch<any>('/nuvio/connect-authkey', {
      method: 'POST',
      body: JSON.stringify({ ...data, create: true }),
    });
    return (result?.user || result) as User;
  }

  async startNuvioOAuth() {
    // Returns { code, webUrl, expiresAt, pollIntervalSeconds, anonToken, deviceNonce }
    return this.fetch<{
      code: string; webUrl: string; expiresAt: string;
      pollIntervalSeconds: number; anonToken: string; deviceNonce: string;
    }>('/nuvio/start-oauth', { method: 'POST', body: JSON.stringify({}) });
  }

  async pollNuvioOAuth(params: { code: string; deviceNonce: string; anonToken: string }) {
    // Returns { status, expiresAt, pollIntervalSeconds } — status is opaque, passed
    // through from Nuvio's own session state (e.g. pending until approved on the device)
    return this.fetch<{ status: string; expiresAt: string; pollIntervalSeconds: number }>(
      '/nuvio/poll-oauth', { method: 'POST', body: JSON.stringify(params) }
    );
  }

  async exchangeNuvioOAuth(params: { code: string; deviceNonce: string; anonToken: string }) {
    // Returns { success, user: { id, email }, refreshToken } once the session is approved
    return this.fetch<{ success: boolean; user: { id: string; email: string }; refreshToken: string }>(
      '/nuvio/exchange-oauth', { method: 'POST', body: JSON.stringify(params) }
    );
  }

  async createUserWithNuvioOAuth(data: {
    providerUserId: string;
    refreshToken: string;
    username: string;
    email?: string;
    groupName?: string;
    colorIndex?: number;
  }) {
    const result = await this.fetch<any>('/nuvio/connect-authkey', {
      method: 'POST',
      body: JSON.stringify({ ...data, create: true }),
    });
    return (result?.user || result) as User;
  }

  // --- Avatars ---

  async uploadAvatar(file: File): Promise<{ url: string }> {
    const formData = new FormData();
    formData.append('avatar', file);

    const token = this.getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const csrfToken = getCsrfToken();
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

    // Deliberately NOT using this.fetch() here — it forces Content-Type: application/json,
    // which breaks multipart uploads (the browser needs to set its own boundary header).
    const response = await fetch(`${API_BASE}/avatars/upload`, {
      method: 'POST',
      credentials: 'include',
      headers, // no Content-Type — fetch sets the multipart boundary automatically for FormData
      body: formData,
    });

    if (!response.ok) {
      let errorData: any;
      try { errorData = await response.json(); } catch { errorData = { message: `HTTP ${response.status}` }; }
      throw new Error(errorData.message || errorData.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  // --- Vault ---

  async getVaultEntries(category?: string) {
    const qs = category ? `?category=${encodeURIComponent(category)}` : '';
    return this.fetch<VaultListResponse>(`/vault${qs}`);
  }

  async getVaultEntry(id: string) {
    return this.fetch<VaultEntry>(`/vault/${id}`);
  }

  async revealVaultSecret(id: string) {
    // POST (not GET): reveal is CSRF-gated + not cacheable + never in referer.
    return this.fetch<{ secret: string }>(`/vault/${id}/reveal`, { method: 'POST' });
  }
  async snoozeVaultEntry(id: string) {
    return this.fetch<VaultEntry>(`/vault/${id}/snooze`, { method: 'POST' });
  }
  // Live Real-Debrid/TorBox usage (active downloads, premium days left) -
  // usage is null for a non-debrid entry or if the live provider call failed.
  async getVaultEntryUsage(id: string) {
    return this.fetch<{ usage: { premiumDaysLeft: number | null; activeDownloads: number | null } | null }>(`/vault/${id}/usage`);
  }

  async createVaultEntry(data: VaultEntryInput) {
    return this.fetch<{ id: string; name: string }>('/vault', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateVaultEntry(id: string, data: Partial<VaultEntryInput> & { isActive?: boolean; backupEntryId?: string | null }): Promise<{ success: boolean; rotation?: { addonsUpdated: { id: string; name: string }[]; usersSynced: number; userFailures: { username: string; error: string }[] } | null }> {
    return this.fetch(`/vault/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteVaultEntry(id: string) {
    return this.fetch(`/vault/${id}`, { method: 'DELETE' });
  }

  async reorderVaultEntries(category: string, orderedIds: string[]) {
    return this.fetch<{ success: boolean }>('/vault/reorder', {
      method: 'PUT',
      body: JSON.stringify({ category, orderedIds }),
    });
  }
  async reorderAddons(orderedIds: string[]) {
    return this.fetch<{ success: boolean }>('/addons/reorder', {
      method: 'PUT',
      body: JSON.stringify({ orderedIds }),
    });
  }
  async reorderUsers(orderedIds: string[]) {
    return this.fetch<{ success: boolean }>('/users/reorder', {
      method: 'PUT',
      body: JSON.stringify({ orderedIds }),
    });
  }
  async reorderGroups(orderedIds: string[]) {
    return this.fetch<{ success: boolean }>('/groups/reorder', {
      method: 'PUT',
      body: JSON.stringify({ orderedIds }),
    });
  }
  // Custom addon tags — drag-to-recategorize, parallel to Vault's categories.
  async getAddonTags() {
    return this.fetch<{ tags: string[]; tagColors: Record<string, string> }>('/addons/tags');
  }
  async createAddonTag(name: string) {
    return this.fetch<{ tags: string[] }>('/addons/tags', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }
  async deleteAddonTag(name: string) {
    return this.fetch<{ tags: string[] }>(`/addons/tags/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  }
  async setAddonTag(addonId: string, tag: string | null) {
    return this.fetch<{ customTag: string | null }>(`/addons/${addonId}/tag`, {
      method: 'PUT',
      body: JSON.stringify({ tag }),
    });
  }
  async setAddonTagColor(name: string, color: string | null) {
    return this.fetch<{ tagColors: Record<string, string> }>(`/addons/tags/${encodeURIComponent(name)}/color`, {
      method: 'PUT',
      body: JSON.stringify({ color }),
    });
  }
  async setAddonProtected(addonId: string, protectedFlag: boolean, unsafe?: boolean) {
    const qs = unsafe ? '?unsafe=true' : '';
    return this.fetch<{ isProtected: boolean }>(`/addons/${addonId}/protect${qs}`, {
      method: 'POST',
      body: JSON.stringify({ protected: protectedFlag }),
    });
  }

  async testVaultEntry(id: string) {
    return this.fetch<{ ok: boolean | null; message: string; checkedAt: string }>(`/vault/${id}/test`, {
      method: 'POST',
    });
  }

  // Metrics
  async getMetrics(period: string = '30d') {
    return this.fetch<MetricsData>(`/users/metrics?period=${period}`);
  }
  async getYearInReview(year?: number) {
    const q = year ? `?year=${year}` : '';
    return this.fetch<YearInReview>(`/users/year-in-review${q}`);
  }

  async getContinueWatching() {
    return this.fetch<ContinueWatchingItem[]>('/users/continue-watching');
  }

  /** Shows started then dropped - the population Continue Watching's own
   * 120-day window has stopped showing entirely. Burying one reuses
   * dismissContinueWatching below (same table, same meaning). */
  async getAbandonedShows() {
    return this.fetch<Array<{
      userId: string;
      username: string;
      providerType: string | null;
      showId: string;
      showName: string;
      poster: string | null;
      lastSeason: number;
      lastEpisode: number;
      episodesWatched: number;
      lastWatchedAt: string;
      daysSince: number;
    }>>('/users/abandoned-shows');
  }

  /** The Graveyard: every buried show (Continue Watching dismissals rest
   * here too - both gestures mean "done with this"). */
  async getBuriedShows() {
    return this.fetch<{
      userId: string; username: string; showId: string; showName: string;
      poster: string | null; lastSeason: number | null; lastEpisode: number | null;
      lastWatchedAt: string | null; episodesWatched: number; buriedAt: string;
    }[]>('/users/graveyard');
  }

  /** The permanent exit: erases the show's entire watch history for that
   * user plus the burial. Irreversible - the UI confirms with the count. */
  // Per-user restore - Time Machine scoped to one person. preview:true
  // returns the per-user diff without applying anything.
  async restoreBackupUser(filename: string, userId: string, preview = false) {
    return this.fetch<{
      preview?: boolean;
      applied?: boolean;
      username: string;
      changedFields: string[];
      groupsJoin: string[];
      groupsLeave: string[];
      missingGroups: string[];
      nothingToDo: boolean;
    }>(`/settings/backups/${encodeURIComponent(filename)}/restore-user`, {
      method: 'POST', body: JSON.stringify({ userId, preview }),
    });
  }

  // Device claims - per-person attribution on a shared provider login.
  // A claim pins a proxy client IP to a managed user, beating the learned
  // affinity guess; `guess` is what the guesser currently thinks when no
  // claim stands.
  async getDeviceClaims() {
    return this.fetch<{
      devices: Array<{
        clientIp: string;
        lastSeenAt: string | null;
        lastTitle: string | null;
        streams: number;
        claim: { userId: string; username: string | null; label: string | null } | null;
        guess: { userId: string; username: string | null } | null;
      }>;
      users: Array<{ id: string; username: string }>;
    }>('/users/device-claims');
  }

  async saveDeviceClaim(clientIp: string, userId: string, label?: string) {
    return this.fetch<{ success: boolean }>('/users/device-claims', {
      method: 'POST', body: JSON.stringify({ clientIp, userId, label }),
    });
  }

  async deleteDeviceClaim(clientIp: string) {
    return this.fetch<{ success: boolean }>(`/users/device-claims/${encodeURIComponent(clientIp)}`, {
      method: 'DELETE',
    });
  }

  // Finish the Saga - franchises the household is mid-way through, closest
  // to finished first. `unwatched` are the members still to watch.
  async getFinishTheSaga() {
    return this.fetch<Array<{
      collectionId: number;
      name: string;
      watchedCount: number;
      total: number;
      unwatched: Array<{ id: string; title: string; poster: string | null; releaseYear: string | null }>;
    }>>('/users/finish-the-saga');
  }

  // Watch-ahead protection - "watching together" pacts (see
  // server/utils/watchTogether.js). Frontier = furthest episode EVERYONE in
  // the pact has seen; null until every member has started the show.
  async getWatchTogether() {
    return this.fetch<Array<{
      showId: string;
      showName: string;
      members: Array<{ userId: string; username: string; colorIndex?: number; avatarUrl?: string | null; furthest: { season: number; episode: number } | null }>;
      frontier: { season: number; episode: number } | null;
      waitingOn: string[];
      createdAt: string;
    }>>('/watch-together');
  }

  async saveWatchTogether(showId: string, showName: string, userIds: string[]) {
    return this.fetch<{ success: boolean }>('/watch-together', {
      method: 'POST', body: JSON.stringify({ showId, showName, userIds }),
    });
  }

  async deleteWatchTogether(showId: string) {
    return this.fetch<{ success: boolean }>(`/watch-together/${encodeURIComponent(showId)}`, {
      method: 'DELETE',
    });
  }

  // Account Guard - see server/utils/accountGuard.js
  async acceptGuardChange(userId: string) {
    return this.fetch<{ success: boolean }>('/users/guard/accept', {
      method: 'POST', body: JSON.stringify({ userId }),
    });
  }

  async runGuardSweep() {
    return this.fetch<{ success: boolean; checked: number; alerted: number; adopted: number; skipped: number }>('/users/guard/sweep', {
      method: 'POST', body: JSON.stringify({}),
    });
  }

  async wipeBuriedShow(userId: string, showId: string, removeFromDevice?: boolean) {
    return this.fetch<{ success: boolean; episodesDeleted: number; moviesDeleted?: number; deviceRemoved?: boolean }>('/users/graveyard/wipe', {
      method: 'POST', body: JSON.stringify({ userId, showId, removeFromDevice: !!removeFromDevice }),
    });
  }

  /** Dig a show back up - it returns to Continue Watching or the unfinished list. */
  async unburyShow(userId: string, showId: string) {
    return this.fetch<{ success: boolean }>('/users/graveyard/unbury', {
      method: 'POST', body: JSON.stringify({ userId, showId }),
    });
  }

  async dismissContinueWatching(userId: string, showId: string) {
    return this.fetch<{ success: boolean }>('/users/continue-watching/dismiss', {
      method: 'POST',
      body: JSON.stringify({ userId, showId }),
    });
  }

  async getThemePref() {
    return this.fetch<{ themePref: ThemePref | null }>('/settings/theme-pref');
  }
  async saveThemePref(themePref: ThemePref | null) {
    return this.fetch<{ themePref: ThemePref | null }>('/settings/theme-pref', {
      method: 'PUT',
      body: JSON.stringify({ themePref }),
    });
  }

  // Personal watchlist — SlickSync's own bookmark list.
  /** Saves a manual watchlist ranking - array order is the order, first is "up next". */
  async setWatchlistOrder(itemIds: string[]) {
    return this.fetch<{ success: boolean; ranked: number }>('/watchlist/order', {
      method: 'PUT', body: JSON.stringify({ itemIds }),
    });
  }

  async getWatchlist() {
    return this.fetch<WatchlistItem[]>('/watchlist');
  }
  async addToWatchlist(item: { itemId: string; itemType: 'movie' | 'series'; name: string; poster?: string | null }) {
    return this.fetch<WatchlistItem>('/watchlist', {
      method: 'POST',
      body: JSON.stringify(item),
    });
  }
  async removeFromWatchlist(itemId: string) {
    return this.fetch<{ success: boolean }>(`/watchlist/${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
    });
  }
  // Batch check whether these ids have any watch history on this account.
  // POST (not GET) because id lists can be 100+ entries and don't belong in URLs.
  async getWatchedStatus(ids: string[]) {
    if (ids.length === 0) return {};
    return this.fetch<Record<string, boolean>>('/watchlist/watched-status', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  }
  // Manual watched-status override — force an item to appear watched or
  // unwatched regardless of what the poller has observed.
  async markWatched(itemId: string, watched: boolean) {
    return this.fetch<{ id: string; itemId: string; watched: boolean; markedAt: string }>(
      '/watchlist/mark',
      { method: 'POST', body: JSON.stringify({ itemId, watched }) },
    );
  }
  async clearWatchedOverride(itemId: string) {
    return this.fetch<{ success: boolean }>(`/watchlist/mark/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
  }

  // Custom lists — named collections of titles (the tier above the single
  // watchlist above).
  async getLists() {
    return this.fetch<CustomList[]>('/lists');
  }
  async createList(name: string, description?: string) {
    return this.fetch<CustomList>('/lists', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    });
  }
  // Natural-language catalog building - see server/utils/nlCatalog.js.
  // Preview never touches the database; save takes the exact items the
  // preview already returned rather than re-running the pipeline.
  async previewDescribedCatalog(description: string) {
    return this.fetch<DescribedCatalogPreview>('/lists/describe-preview', {
      method: 'POST',
      body: JSON.stringify({ description }),
    });
  }
  async saveDescribedCatalog(data: { name: string; description: string; items: CustomListItem[] }) {
    return this.fetch<CustomList>('/lists/from-description', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }
  async updateList(id: string, data: { name?: string; description?: string; coverImageUrl?: string | null; coverColorIndex?: number | null; pinned?: boolean; autoRefresh?: boolean; autoRefreshFrequency?: 'daily' | 'weekly'; shared?: boolean }) {
    return this.fetch<CustomList>(`/lists/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }
  /** Returns trashId when the catalog was archived first (Undo). */
  async deleteList(id: string) {
    return this.fetch<{ success: boolean; trashId?: string | null }>(`/lists/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  // Automation rules ("when X happens, do Y") - see server/utils/automation/registry.js.
  /** The AI rule-writer: plain English -> a validated rule draft for the
   * editor. Server-side the model only proposes; the registry validates. */
  async composeAutomationRule(text: string) {
    return this.fetch<{ rule: { name: string; triggerType: string; triggerConfig: Record<string, unknown>; conditions: AutomationCondition[]; actions: AutomationActionConfig[] }; warnings: string[] }>(
      '/automation/compose', { method: 'POST', body: JSON.stringify({ text }) });
  }

  async getAutomationRegistry() {
    return this.fetch<AutomationRegistry>('/automation/registry');
  }
  async getAutomationRules() {
    return this.fetch<AutomationRule[]>('/automation');
  }
  async createAutomationRule(data: AutomationRuleInput) {
    return this.fetch<AutomationRule>('/automation', { method: 'POST', body: JSON.stringify(data) });
  }
  async updateAutomationRule(id: string, data: Partial<AutomationRuleInput>) {
    return this.fetch<AutomationRule>(`/automation/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) });
  }
  async deleteAutomationRule(id: string) {
    return this.fetch<{ success: boolean }>(`/automation/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  async testAutomationRule(id: string) {
    return this.fetch<{ payload: Record<string, unknown>; results: AutomationActionResult[] }>(`/automation/${encodeURIComponent(id)}/test`, { method: 'POST' });
  }
  async getAutomationRuns(ruleId?: string) {
    const qs = ruleId ? `?ruleId=${encodeURIComponent(ruleId)}` : '';
    return this.fetch<AutomationRun[]>(`/automation/runs${qs}`);
  }
  // Content rating is now a destructive allowlist (server/utils/
  // contentRating.js) - preview shows what a candidate list would do
  // without changing anything; apply actually removes non-matching items
  // (and snapshots for undo); restore undoes the single most recent apply.
  // What's currently in the catalog by rating, independent of any candidate
  // policy - shown before anyone checks a box, so "what's actually in here"
  // doesn't stay hidden until after picking ratings and hitting Preview.
  async getContentRatingBreakdown(id: string) {
    return this.fetch<{ counts: Record<string, number>; unknownCount: number; checked: number }>(
      `/lists/${encodeURIComponent(id)}/content-rating-breakdown`
    );
  }
  async previewContentRating(id: string, keptRatings: string[]) {
    const qs = keptRatings.length ? `?keep=${encodeURIComponent(keptRatings.join(','))}` : '';
    return this.fetch<{ keep: CustomListItem[]; remove: (CustomListItem & { rated: string })[]; unknown: CustomListItem[]; checked: number }>(
      `/lists/${encodeURIComponent(id)}/preview-content-rating${qs}`
    );
  }
  async applyContentRating(id: string, keptRatings: string[]) {
    return this.fetch<CustomList & { removedCount: number }>(`/lists/${encodeURIComponent(id)}/apply-content-rating`, {
      method: 'POST',
      body: JSON.stringify({ keptRatings }),
    });
  }
  async restoreContentRatingRemoval(id: string) {
    return this.fetch<CustomList>(`/lists/${encodeURIComponent(id)}/restore-content-rating`, { method: 'POST' });
  }
  async addToList(id: string, item: { id: string; type: 'movie' | 'series'; name: string; poster?: string | null; year?: number | string | null }) {
    return this.fetch<CustomList>(`/lists/${encodeURIComponent(id)}/items`, {
      method: 'POST',
      body: JSON.stringify(item),
    });
  }

  /** One write for many titles - share-code imports use this instead of
   * hammering the single-item route once per title. */
  async addToListBulk(id: string, items: Array<{ id: string; type: 'movie' | 'series'; name: string; poster?: string | null; year?: number | string | null }>) {
    return this.fetch<CustomList & { added: number }>(`/lists/${encodeURIComponent(id)}/items/bulk`, {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }
  async removeFromList(id: string, itemId: string) {
    return this.fetch<CustomList>(`/lists/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
    });
  }
  // Persist a manual drag-reorder - orderedIds must be the list's current
  // item ids, same set, in the new order (server rejects a stale/partial set).
  async reorderListItems(id: string, orderedIds: string[]) {
    return this.fetch<CustomList>(`/lists/${encodeURIComponent(id)}/items/reorder`, {
      method: 'PATCH',
      body: JSON.stringify({ orderedIds }),
    });
  }
  // Creates a brand-new MDBList list from this catalog's current items -
  // does not touch the catalog itself, and doesn't wire the result into any
  // addon (that's a manual step in the addon's own config afterward).
  async exportListToMdblist(id: string) {
    return this.fetch<{ id: string; name: string; slug: string | null; url: string | null; added: number | null; existing: number | null; notFound: number | null }>(
      `/lists/${encodeURIComponent(id)}/export-mdblist`,
      { method: 'POST' }
    );
  }
  // Import a TMDb or MDBList list (auto-detected from the URL) into a new list.
  // --- Catalog federation -------------------------------------------------
  // Publishing is per-catalog and revocable. The returned `path` is deliberately
  // origin-less: the server can't reliably know its own externally reachable
  // hostname behind a reverse proxy, so the caller joins it onto the origin it
  // is being viewed from.
  async getCatalogShareLink(id: string) {
    return this.fetch<{ published: boolean; federationToken?: string; path?: string }>(`/lists/${id}/federation`);
  }
  // Called again on an already-published catalog, this ROTATES the token and
  // immediately invalidates the previous URL.
  async publishCatalog(id: string) {
    return this.fetch<{ federationToken: string; rotated: boolean; path: string }>(`/lists/${id}/federation`, {
      method: 'POST',
    });
  }
  // Stops future pulls. Anyone already subscribed keeps whatever they last
  // pulled - this cannot reach into another instance and delete their copy.
  async unpublishCatalog(id: string) {
    return this.fetch<{ ok: true }>(`/lists/${id}/federation`, { method: 'DELETE' });
  }

  async importList(url: string, name?: string) {
    return this.fetch<CustomList & { truncated: boolean; totalAvailable: number }>('/lists/import', {
      method: 'POST',
      body: JSON.stringify({ url, name }),
    });
  }
  // Managed users in this account who've linked a personal SIMKL account -
  // the picker for import/export-to-SIMKL below, since SIMKL has no named
  // Custom Lists API (see server/utils/simklLists.js): both flows act on a
  // specific user's Plan to Watch, not an account-wide list.
  async getSimklLinkedUsers() {
    return this.fetch<Array<{ id: string; username: string; avatarUrl: string | null; colorIndex: number | null }>>('/lists/simkl-users');
  }
  // Import a linked user's SIMKL Plan to Watch into a new catalog.
  async importListFromSimkl(userId: string, name?: string) {
    return this.fetch<CustomList & { totalAvailable: number }>('/lists/import-simkl', {
      method: 'POST',
      body: JSON.stringify({ userId, name }),
    });
  }
  // Add this catalog's items to a linked user's SIMKL Plan to Watch.
  async exportListToSimkl(id: string, userId: string) {
    return this.fetch<{ added: number; notFound: number; existing: number; username: string }>(
      `/lists/${encodeURIComponent(id)}/export-simkl`,
      { method: 'POST', body: JSON.stringify({ userId }) }
    );
  }
  // Re-pull an already-imported catalog's own source URL. Without `apply`,
  // only returns the added/removed/unchanged diff so the caller can show a
  // confirm step before this destructively replaces the catalog's items.
  async refreshList(id: string, apply = false) {
    return this.fetch<CustomList & { added: number; removed: number; unchanged: number; applied?: boolean }>(
      `/lists/${encodeURIComponent(id)}/refresh`,
      { method: 'POST', body: JSON.stringify({ apply }) }
    );
  }
  // Propose titles for a catalog by theme (TMDb keyword search) - read-only,
  // never adds anything itself. query defaults server-side to the catalog's
  // own name if omitted.
  async suggestCatalogTitles(id: string, query?: string) {
    const qs = query ? `?query=${encodeURIComponent(query)}` : '';
    return this.fetch<{ suggestions: CatalogSuggestion[]; query: string }>(`/lists/${encodeURIComponent(id)}/suggest${qs}`);
  }

  // System Health board - one aggregated read of Sync/Addons/Vault/Proxy
  // status, all sourced from state existing background monitors already
  // maintain (no live calls made by this request itself).
  async getHealthStatus() {
    return this.fetch<HealthStatus>('/health');
  }

  // Hides a known, accepted failure from the Health page's Attention list
  // and its notifications - for something like an indexer that blocks this
  // server's IP, where the admin doesn't want repeated pinging about it.
  async setVaultHealthIgnored(id: string, healthIgnored: boolean) {
    return this.fetch(`/vault/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ healthIgnored }),
    });
  }

  async setAddonHealthIgnored(id: string, healthIgnored: boolean) {
    return this.fetch<{ success: boolean; data: { id: string; healthIgnored: boolean } }>(`/addons/${id}/health-ignore`, {
      method: 'PATCH',
      body: JSON.stringify({ healthIgnored }),
    });
  }

  /** Per-addon health-check overrides - empty/omitted fields clear back to
   * the global defaults (manifest probe, 1 failure, global interval). */
  async setAddonHealthConfig(id: string, cfg: { probeUrl?: string; failureThreshold?: number | string; intervalMinutes?: number | string }) {
    return this.fetch<{ success: boolean; data: { id: string; healthConfig: AddonHealthConfig | null } }>(`/addons/${id}/health-config`, {
      method: 'PATCH',
      body: JSON.stringify(cfg),
    });
  }

  async setUserHealthIgnored(id: string, healthIgnored: boolean) {
    return this.fetch<{ success: boolean; data: { id: string; healthIgnored: boolean } }>(`/users/${id}/health-ignore`, {
      method: 'PATCH',
      body: JSON.stringify({ healthIgnored }),
    });
  }

  // Proxy has no per-item entity (one shared connectivity check) - the mute
  // lives on the account itself instead of a /:id route.
  async setProxyHealthIgnored(healthIgnored: boolean) {
    return this.fetch<{ healthIgnored: boolean }>('/health/proxy-ignore', {
      method: 'PATCH',
      body: JSON.stringify({ healthIgnored }),
    });
  }

  async getRecommendations(opts?: { mode?: 'personal' | 'shared'; userId?: string; userId2?: string; type?: 'movie' | 'series' }) {
    const params = new URLSearchParams();
    if (opts?.mode) params.set('mode', opts.mode);
    if (opts?.userId) params.set('userId', opts.userId);
    if (opts?.userId2) params.set('userId2', opts.userId2);
    if (opts?.type) params.set('type', opts.type);
    const qs = params.toString();
    return this.fetch<{ rows: RecommendationRow[] }>(`/discover/recommendations${qs ? `?${qs}` : ''}`);
  }
  async getTasteOverlap() {
    return this.fetch<{ pairs: TasteOverlapPair[] }>('/discover/taste-overlap');
  }
  // Per-user taste profile (extends the flat overlap into a real profile).
  async getTasteProfile() {
    return this.fetch<{ profiles: TasteProfile[] }>('/discover/taste-profile');
  }
  // Household picks: unwatched-by-everyone titles in genres the whole house
  // likes. Empty items when recommendations are off or there's no signal yet.
  async getHouseholdPicks(type: 'movie' | 'series') {
    return this.fetch<{ items: DiscoverItem[]; genres: string[]; memberCount: number; sharedAppeal: boolean }>(`/discover/household-picks?type=${type}`);
  }
  // Person search (needs a TMDb key): type an actor/director's name, get their
  // titles of the requested type. Returns null on 503 (no key) so callers hide
  // the feature. Results carry tmdbId/mediaType for click-through resolution.
  async searchPerson(query: string, type: 'movie' | 'series') {
    try {
      return await this.fetch<{ person: { id: number; name: string; profile: string | null } | null; results: Array<{ tmdbId: number; mediaType: 'movie' | 'tv'; title: string; year: string | null; poster: string | null; role: string | null }> }>(`/discover/search-person?query=${encodeURIComponent(query)}&type=${type}`);
    } catch {
      return null;
    }
  }
  // "More Like This" for the detail popup - real household affinity biases
  // which genre(s) get searched, but every returned item is always a fresh
  // Cinemeta pull filtered against the whole household's watch history
  // (never an affinity neighbor directly - see the route's own comment for
  // why that would just recommend already-watched titles back).
  async getSimilarItems(id: string, type: 'movie' | 'series') {
    const params = new URLSearchParams({ id, type });
    try {
      return await this.fetch<{ items: DiscoverItem[]; hasRealSignal: boolean }>(`/discover/similar?${params.toString()}`);
    } catch {
      return { items: [], hasRealSignal: false };
    }
  }
  async markNotInterested(itemId: string, itemType: 'movie' | 'series') {
    return this.fetch<{ success: boolean }>('/discover/not-interested', {
      method: 'POST',
      body: JSON.stringify({ itemId, itemType }),
    });
  }

  // SlickTrax reactions (thumbs up/down) - feeds /recommendations scoring, see
  // server/utils/recommendationEngine.js's computeSignedAdjustments.
  // Deliberately binary, not a 3-tier like/love/dislike - see
  // server/utils/titleFeedback.js's REACTIONS comment for why.
  async setReaction(itemId: string, itemType: 'movie' | 'series', reaction: 'happy' | 'sad', itemName?: string, poster?: string | null) {
    return this.fetch<{ reaction: string }>('/discover/react', {
      method: 'POST',
      body: JSON.stringify({ itemId, itemType, reaction, itemName, poster }),
    });
  }
  async clearReaction(itemId: string) {
    return this.fetch<{ success: boolean }>(`/discover/react/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
  }
  async getReactions(ids: string[]) {
    const qs = ids.length ? `?ids=${ids.map(encodeURIComponent).join(',')}` : '';
    return this.fetch<{ reactions: Record<string, 'happy' | 'sad'> }>(`/discover/reactions${qs}`);
  }

  // SlickTrax personal ratings (1-10) - season omitted/0 = overall (the only
  // kind movies use; a series may carry an overall rating AND independent
  // per-season ratings at once).
  async setRating(itemId: string, itemType: 'movie' | 'series', rating: number, season?: number, itemName?: string, poster?: string | null) {
    return this.fetch<{ season: number; rating: number }>('/discover/rate', {
      method: 'POST',
      body: JSON.stringify({ itemId, itemType, rating, season, itemName, poster }),
    });
  }
  async clearRating(itemId: string, season?: number) {
    const qs = season !== undefined ? `?season=${season}` : '';
    return this.fetch<{ success: boolean }>(`/discover/rate/${encodeURIComponent(itemId)}${qs}`, { method: 'DELETE' });
  }
  async getRatings(itemId: string) {
    return this.fetch<{ ratings: Record<string, number> }>(`/discover/ratings/${encodeURIComponent(itemId)}`);
  }
  async getSeasonNumbers(itemId: string) {
    return this.fetch<{ seasons: number[] }>(`/discover/${encodeURIComponent(itemId)}/seasons?type=series`);
  }

  async getUpcomingEpisodes() {
    return this.fetch<UpcomingEpisode[]>('/users/upcoming-episodes');
  }
  async dismissUpcomingEpisode(showId: string, season: number, episode: number) {
    return this.fetch<{ success: boolean }>('/users/upcoming-episodes/dismiss', {
      method: 'POST',
      body: JSON.stringify({ showId, season, episode }),
    });
  }
  async muteShow(showId: string, showName?: string, poster?: string) {
    return this.fetch<{ success: boolean }>('/users/upcoming-episodes/mute', {
      method: 'POST',
      body: JSON.stringify({ showId, showName, poster }),
    });
  }
  async unmuteShow(showId: string) {
    return this.fetch<{ success: boolean }>('/users/upcoming-episodes/unmute', {
      method: 'POST',
      body: JSON.stringify({ showId }),
    });
  }
  async getMutedShows() {
    return this.fetch<MutedShow[]>('/users/upcoming-episodes/muted');
  }

  // Rotten Tomatoes/Metacritic/IMDb ratings for a batch of IMDb IDs, for grid
  // views (Discover, Activity) that render many poster cards at once. Pass
  // only the deduplicated IDs actually on screen - server caps the batch size.
  async getRatingsBatch(imdbIds: string[]) {
    if (imdbIds.length === 0) return { ratings: {} };
    return this.fetch<{ ratings: Record<string, RatingsBatchEntry> }>('/users/ratings-batch', {
      method: 'POST',
      body: JSON.stringify({ imdbIds }),
    });
  }

  // Cinemeta detail lookup (cast/rating/genres/etc) for the poster-click modal.
  // Returns null (rather than throwing) when there's no metadata - proxy-parsed
  // filename titles have no real IMDb ID to look up, and that's an expected,
  // non-error state the UI should just render an empty state for.
  async getMediaDetails(itemId: string, type: string, videoId?: string | null) {
    const key = `${itemId}|${type}|${videoId || ''}`;
    const hit = mediaDetailsCache.get(key);
    if (hit && Date.now() - hit.at < MEDIA_DETAILS_TTL_MS) return hit.promise;

    const params = new URLSearchParams({ itemId, type });
    if (videoId) params.set('videoId', videoId);
    const promise = this.fetch<MediaDetails>(`/users/media-details?${params.toString()}`).catch(() => null);
    mediaDetailsCache.set(key, { at: Date.now(), promise });
    // Oldest-first eviction; Map keeps insertion order. A grid can be
    // hovered across faster than anyone opens things, so this is bounded
    // rather than left to grow with the session.
    if (mediaDetailsCache.size > MEDIA_DETAILS_MAX) {
      for (const k of mediaDetailsCache.keys()) {
        mediaDetailsCache.delete(k);
        if (mediaDetailsCache.size <= MEDIA_DETAILS_MAX) break;
      }
    }
    return promise;
  }

  /**
   * Starts the detail fetch before it is asked for - called when a pointer
   * settles on a poster, so the request is already in flight (often already
   * finished) by the time the click opens the modal. The modal's own
   * getMediaDetails then hits the same entry instead of starting over, so
   * the popup opens on content rather than a spinner.
   *
   * Deliberately fire-and-forget and deliberately silent: a prefetch that
   * fails changes nothing, because the real call repeats it after the TTL.
   * Callers must only fire this for a real mouse - prefetching on touch
   * would spend someone's data on titles they merely scrolled past.
   */
  prefetchMediaDetails(itemId: string, type: string, videoId?: string | null) {
    if (!itemId || !type) return;
    const key = `${itemId}|${type}|${videoId || ''}`;
    const hit = mediaDetailsCache.get(key);
    if (hit && Date.now() - hit.at < MEDIA_DETAILS_TTL_MS) return;
    void this.getMediaDetails(itemId, type, videoId);
  }

  // Cast/crew deep-dive (optional; needs a TMDb key server-side). Returns a
  // person's filmography, or null when no key is configured (503) so the UI
  // hides the feature gracefully.
  async getPersonCredits(personId: number | string) {
    try {
      return await this.fetch<{ person: { id: number; name: string | null }; credits: Array<{ tmdbId: number; mediaType: 'movie' | 'tv'; title: string; year: string | null; poster: string | null; role: string | null }> }>(`/discover/person/${personId}`);
    } catch {
      return null;
    }
  }

  // Resolve a TMDb title to its IMDb id so a person-credit click can open the
  // existing Cinemeta-backed detail modal. Returns null on any failure.
  async resolveImdbId(tmdbId: number | string, mediaType: 'movie' | 'tv') {
    try {
      return await this.fetch<{ imdbId: string | null; type: 'movie' | 'series' }>(`/discover/imdb-id?tmdbId=${tmdbId}&type=${mediaType}`);
    } catch {
      return null;
    }
  }

  // Discover - browse/search Cinemeta's real catalogs (Popular/New/Featured).
  async discoverBrowse(type: 'movie' | 'series', options?: { catalog?: string; genre?: string; skip?: number }) {
    const params = new URLSearchParams({ type });
    if (options?.catalog) params.set('catalog', options.catalog);
    if (options?.genre) params.set('genre', options.genre);
    if (options?.skip) params.set('skip', String(options.skip));
    try {
      return await this.fetch<DiscoverItem[]>(`/discover/browse?${params.toString()}`);
    } catch {
      return [];
    }
  }

  // Discover row backed by SIMKL's public Trending/Most Anticipated feeds -
  // needs only a SIMKL Client ID (Settings -> External API Keys), not a
  // linked user. Returns [] rather than throwing on any failure (missing
  // key, SIMKL down) so callers can render nothing instead of an error
  // state for what's a bonus row, not core functionality.
  async getSimklDiscoverRow(list: 'trending' | 'anticipated', type: 'movies' | 'shows') {
    try {
      const result = await this.fetch<{ items: SimklDiscoverItem[] }>(`/lists/simkl-discover?list=${list}&type=${type}`);
      return result.items || [];
    } catch {
      return [];
    }
  }

  async discoverSearch(type: 'movie' | 'series', query: string) {
    const params = new URLSearchParams({ type, query });
    try {
      return await this.fetch<DiscoverItem[]>(`/discover/search?${params.toString()}`);
    } catch {
      return [];
    }
  }

  // Manual sync (same as scheduled 5‑minute sync, but on demand)
  async triggerSyncNow() {
    return this.fetch<{ message: string; result?: any }>('/settings/sync-now', {
      method: 'POST',
    });
  }

  // Activity
  async getActivityLibrary() {
    return this.fetch<ActivityLibraryData>('/users/activity/library');
  }
}

export const api = new ApiClient();

// Types
export interface User {
  id: string;
  username: string;
  name?: string; // Legacy field, prefer username
  email?: string;
  providerType?: 'stremio' | 'nuvio';
  /** SlickTrax Addon - per-user Stremio addon toggle + its URL token. */
  traxAddonEnabled?: boolean;
  /** In-player actions in the SlickTrax addon (opt-in per user). */
  traxInPlayerActions?: boolean;
  traxToken?: string | null;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string | null;
  groupIds?: string[];
  groupId?: string; // Single group ID (legacy)
  groups?: string[]; // Group names array
  excludedAddons?: string[];
  protectedAddons?: string[];
  discordWebhook?: string;
  activityVisibility?: 'public' | 'private';
  isActive?: boolean;
  status?: 'active' | 'inactive';
  addons?: number;
  stremioAddonsCount?: number;
  hasStremioConnection?: boolean;
  simklConnected?: boolean;
  simklConnectedAt?: string | null;
  colorIndex?: number;
  avatarUrl?: string | null;
  inviteCode?: string;
  // When this user's addons were last successfully synced, and the state of
  // that sync. Null until the first sync completes - these columns existed
  // for a long time before anything wrote them, which (together with the
  // response allowlist dropping them) is why the Users list showed a
  // hardcoded 'Unknown'.
  lastSyncedAt?: string | null;
  syncStatus?: string | null;
  // Account Guard: non-null when this user's provider account was changed by
  // something other than SlickSync since our last write - carries the diff
  // for display. Cleared by a sync (re-assert) or by accepting the change.
  guardExternal?: {
    provider: 'stremio' | 'nuvio';
    detectedAt: string;
    added: Array<{ url: string; name: string }>;
    removed: Array<{ url: string; name: string }>;
  } | null;
}

export interface MergeCandidate {
  id: string;
  username: string;
  providerType: 'stremio' | 'nuvio';
  avatarUrl?: string | null;
  colorIndex?: number;
  email?: string;
}

export interface MergePreview {
  survivor: { id: string; username: string; providerType: 'stremio' | 'nuvio' };
  donor: { id: string; username: string; providerType: 'stremio' | 'nuvio' };
  movieCount: number;
  episodeCount: number;
  sessionCount: number;
  snapshotCount: number;
  survivorGroupName: string | null;
  donorGroupName: string | null;
  groupsDiffer: boolean;
}

export interface MergeInfo {
  providerType: 'stremio' | 'nuvio';
  donorUsername: string | null;
  donorEmail: string | null;
  donorAvatarUrl: string | null;
  donorColorIndex: number | null;
  undoable: boolean;
}

export interface CreateUserData {
  name: string;
  email?: string;
  authKey?: string;
}

export interface Group {
  id: string;
  name: string;
  description?: string;
  color?: string;
  userIds: string[] | string; // Can be array or JSON string
  users?: number; // Count of active users
  addons?: number; // Count of active addons
  // Both nullable, and both were typed as required `string` while the API
  // returned neither - so `group.createdAt` type-checked but was always
  // undefined at runtime, which is what made the detail page show a permanent
  // "Created: Unknown". createdAt is now recovered server-side from the cuid
  // primary key; it is null only for a group whose id isn't a cuid.
  createdAt?: string | null;
  updatedAt?: string | null;
  // Most recent sync across the group's members - a group has no sync of its
  // own. null when no member has ever synced.
  lastSyncedAt?: string | null;
  colorIndex?: number;
  avatarUrl?: string | null;
  isActive?: boolean;
}

export interface CreateGroupData {
  name: string;
  description?: string;
  color?: string;
}

export type VaultCategory =
  | 'debrid' | 'usenet_provider' | 'usenet_indexer' | 'stremio' | 'nuvio'
  | 'metadata' | 'ai' | 'vpn' | 'aiostreams' | 'custom';

export type VaultTestType = 'manual' | 'generic_http' | 'real_debrid' | 'torbox' | 'newznab_caps' | 'tcp_reachability' | 'stremio_auth' | 'nuvio_auth' | 'openai_compatible';

export interface VaultEntry {
  id: string;
  name: string;
  category: VaultCategory;
  provider?: string | null;
  secretLabel: string;
  dashboardUrl?: string | null;
  cost?: number | null;
  costCycle?: 'monthly' | 'yearly';
  expiresAt?: string | null;
  notifyDaysBefore: number;
  lastCheckedAt?: string | null;
  lastCheckStatus?: 'ok' | 'error' | 'unknown' | null;
  lastCheckMessage?: string | null;
  snoozedUntil?: string | null;
  isActive: boolean;
  testType: VaultTestType;
  testConfig?: Record<string, any> | null;
  updatedAt: string;
  position?: number;
  // real_debrid/torbox only - daily sweep that deletes a finished torrent
  // from the provider's own account once it's sat idle this many days.
  autoRemoveEnabled?: boolean;
  autoRemoveAfterDays?: number;
  /** Failover partner - used when this entry's own health check is failing. */
  backupEntryId?: string | null;
}

export interface PushDevice {
  id: string;
  userAgent: string | null;
  label: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface VaultListResponse {
  total: number;
  categories: Record<string, number>;
  currency?: string;
  entries: VaultEntry[];
}

export interface VaultEntryInput {
  name: string;
  category: VaultCategory;
  provider?: string;
  secretLabel?: string;
  secret: string;
  testType?: VaultTestType;
  testConfig?: Record<string, any>;
  dashboardUrl?: string;
  cost?: number;
  costCycle?: 'monthly' | 'yearly';
  expiresAt?: string;
  notifyDaysBefore?: number;
  autoRemoveEnabled?: boolean;
  autoRemoveAfterDays?: number;
}

export interface BackupTargets {
  type: 'none' | 's3' | 'webdav';
  /** How many local backup files to keep. 0 = keep everything. */
  keepLocal: number;
  s3: { endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey: string };
  webdav: { url: string; username: string; password: string };
  /** Optional - set to encrypt uploads (.enc); empty uploads plain JSON. Comes back masked. */
  encryptPassphrase: string;
}

export interface DataBackupSnapshot {
  filename: string;
  sizeBytes: number;
  createdAt: string;
  encrypted: boolean;
}

export interface DataBackupSettings {
  available?: boolean;
  /** True when an off-site passphrase is set - required before snapshots may leave the box. */
  hasPassphrase?: boolean;
  enabled: boolean;
  frequencyDays: number;
  keepLocal: number;
  offsite: boolean;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  lastSizeBytes: number | null;
  lastVerified: boolean | null;
  snapshots?: DataBackupSnapshot[];
}

export interface DbMaintenanceSettings {
  available?: boolean;
  vacuumEnabled: boolean;
  lastVacuumAt: string | null;
  integrityCheckEnabled: boolean;
  lastIntegrityCheckAt: string | null;
  lastIntegrityOk: boolean | null;
  pruneLogsEnabled: boolean;
  lastPruneAt: string | null;
  pruneNotificationsEnabled: boolean;
  pruneNotificationsDays: number;
  lastNotificationsPruneAt: string | null;
}

export interface UpdateCapability {
  socketAvailable: boolean;
  canSelfUpdate: boolean;
  image: string | null;
  composeProject: string | null;
  reason: string;
}

export interface ProxyActionResult {
  id: string;
  name?: string;
  proxyEnabled?: boolean;
  proxyUuid?: string | null;
  proxyManifestUrl?: string | null;
}

export interface AddonHealthConfig {
  probeUrl?: string;
  failureThreshold?: number;
  intervalMinutes?: number;
}

export interface Addon {
  id: string;
  name: string;
  manifestUrl: string;
  healthConfig?: AddonHealthConfig | null;
  stremioAddonId?: string;
  version?: string;
  description?: string;
  logo?: string;
  resources: string[];
  catalogs: Array<string | { type: string; id: string; search?: boolean }>;
  createdAt: string;
  updatedAt: string;
  // Health check fields
  isOnline?: boolean;
  lastHealthCheck?: string;
  healthCheckError?: string;
  // Backup fields
  backupAddonId?: string;
  hasBackup?: boolean;
  backupAddon?: {
    id: string;
    name: string;
    isActive: boolean;
    isOnline: boolean;
    lastHealthCheck?: string;
  };
  // Set by getGroupAddons when primary is offline and backup is used
  isBackup?: boolean;
  primaryAddonId?: string;
  primaryAddonName?: string;
  // Account-wide protection (by name, across every user — see
  // routes/addons.js's /:id/protect) and the user-defined custom tag.
  isProtected?: boolean;
  customTag?: string | null;
}

export interface CreateAddonData {
  manifestUrl: string;
  name?: string;
  manifestData?: any; // Optional pre-fetched manifest data
}

export interface Invitation {
  id: string;
  // Backend currently returns inviteCode + various legacy fields; keep this flexible
  name?: string;
  code?: string; // legacy field (old UI)
  inviteCode?: string; // canonical backend field
  groupId?: string;
  groupName?: string;
  maxUses?: number | null;
  uses?: number; // legacy
  currentUses?: number;
  expiresAt?: string | null;
  membershipDuration?: number | null;
  membershipDurationDays?: number | null;
  syncOnJoin: boolean;
  createdAt: string;
  isActive?: boolean;
  requests?: InviteRequest[];
}

export interface CreateInvitationData {
  name?: string;
  groupId?: string;
  groupName?: string;
  maxUses?: number;
  expiresAt?: string;
  membershipDuration?: number;
  syncOnJoin?: boolean;
}

export interface InviteRequest {
  id: string;
  invitationId: string;
  email: string;
  username: string;
  status: 'pending' | 'accepted' | 'rejected' | 'joined';
  createdAt: string;
  respondedAt?: string;
  respondedBy?: string;
  oauthCode?: string;
  oauthLink?: string;
}

export interface WatchTimeData {
  totalWatchTimeSeconds: number;
  totalWatchTimeHours: number;
  byDate: {
    date: string;
    watchTimeSeconds: number;
    watchTimeHours: number;
    itemsCount: number;
    movies: number;
    shows: number;
  }[];
}

export interface TopItem {
  id: string;
  name: string;
  type: 'movie' | 'series';
  poster?: string;
  watchTime: number;
}

export interface StreakData {
  currentStreak: number;
  longestStreak: number;
  lastWatchDate?: string;
}

export interface VelocityData {
  daily: number;
  weekly: number;
  monthly: number;
  trend: 'up' | 'down' | 'stable';
}

export interface StremioAddon {
  transportUrl: string;
  name?: string;
  manifest: {
    id: string;
    name: string;
    version: string;
    description?: string;
    logo?: string;
    resources: string[];
    types: string[];
    catalogs?: { id: string; type: string; name?: string; extra?: { name: string; options?: string[]; isRequired?: boolean }[] }[];
  };
}

export interface AccountStats {
  totalUsers: number;
  totalGroups: number;
  totalAddons: number;
  pendingInvites: number;
  uuid?: string | null;
  email?: string | null;
  linkedProvider?: 'stremio' | 'nuvio' | null;
  avatarUrl?: string | null;
  displayName?: string | null;
}

export interface SyncSettings {
  mode: 'normal' | 'advanced';
  safe: boolean;
  enabled: boolean;
  frequency: string;
  webhookUrl?: string;
  useCustomFields?: boolean;
  notifyOnActivity?: boolean;
  notifyOnSync?: boolean;
  notifyOnInvite?: boolean;
  notifyOnVault?: boolean;
  notifyOnAddonHealth?: boolean;
  notifyOnNewDevice?: boolean;
  notifyOnBackup?: boolean;
  notifyOnProxyHealth?: boolean;
  notifyOnUpdateAvailable?: boolean;
  /** Opt-in nudge when the Disaster Recovery Kit is stale/missing while the
   * Vault holds credentials. Nothing is ever uploaded - see
   * server/utils/recoveryKitReminder.js. */
  notifyOnRecoveryKitStale?: boolean;
  /** Read-only: stamped when a kit is actually exported. */
  lastRecoveryKitExportAt?: string | null;
  notifyOnMosaic?: boolean;
  notifyDigestEnabled?: boolean;
  notifyDigestFrequency?: 'daily' | 'weekly';
  accountTimezone?: string;
  accountTimezoneIsDefault?: boolean;
  vaultCurrency?: string;
  // Personal-features opt-outs (v1.31+). Default true when absent.
  enableWatchlist?: boolean;
  enableWatchedIndicators?: boolean;
  /** Watching Together (watch-ahead protection) - the show-detail section
   * and its alerts. On by default; per-show pacts are still the real
   * opt-in, this hides the whole feature. */
  enableWatchTogether?: boolean;
  enableRecommendations?: boolean;
  enableAutoplayTrailer?: boolean;
  autoplayTrailerStartMuted?: boolean;
  enablePosterRatings?: boolean;
  enableReactions?: boolean;
  enableWatchProviders?: boolean;
  // Opt-in (default false, unlike the toggles above) - see settings.js's own comment.
  enableAutoThemedCatalogs?: boolean;
  notifyOnAutomation?: boolean;
  tmdbApiKey?: string;
  mdblistApiKey?: string;
  rpdbApiKey?: string;
  omdbApiKey?: string;
  /** Failover keys - used automatically when the matching primary above is
   * found failing or rate-limited by the health check. */
  tmdbApiKeyBackup?: string;
  mdblistApiKeyBackup?: string;
  rpdbApiKeyBackup?: string;
  /** Key Pool extras beyond the primary/backup pair. When any exist, lookups
   * rotate across every healthy key instead of always using the primary. */
  tmdbApiKeyPool?: string[];
  omdbApiKeyPool?: string[];
  mdblistApiKeyPool?: string[];
  rpdbApiKeyPool?: string[];
  omdbApiKeyBackup?: string;
  /** Result of the last validity check per provider - see checkProviderKeys()
   * and server/utils/metadataKeyHealth.js. Absent for a provider that's
   * never been checked. */
  keyHealth?: Record<string, {
    ok: boolean; message: string; rateLimited: boolean; checkedAt: string;
    /** MDBList only - the one provider that actually exposes live quota
     * usage (confirmed against their own OpenAPI spec). TMDb has no rate
     * limit to show, OMDb and RPDB expose no usage endpoint at all. */
    usage?: { used: number; limit: number; percentUsed: number; plan: string | null; approximate?: boolean };
  }>;
  notifyOnKeyHealth?: boolean;
  /** Opt-in scheduled self-update (private instances with the socket
   * mounted): checks daily at autoUpdateHour, backs up, updates, and the
   * watchdog rolls back automatically on a failed health check. */
  autoUpdateEnabled?: boolean;
  autoUpdateHour?: number;
  /** Key Pool, opt-in: spread requests toward the pool key with the most
   * remaining quota (providers that report usage only - MDBList today). */
  keyPoolQuotaWeighting?: boolean;
  /** Opt-in: background enrichment stands down past the daily quota threshold. */
  quotaAutopilot?: boolean;
  quotaAutopilotPercent?: number;
  /** Opt-in "Airing this season" anime row in Discover (AniList). */
  animeSeasonalRow?: boolean;
  /** Key Pool, opt-in: a pool EXTRA failing for 3 straight days is removed
   * from the pool automatically, with one notification. */
  keyPoolAutoRetire?: boolean;

  simklClientId?: string;
  /** Public Trakt list import (client id only - not an account connection). */
  traktClientId?: string;
  malClientId?: string;
  /** Self-hosted Nuvio backend URL, e.g. https://backend.example.com. Blank uses api.nuvio.tv. */
  nuvioServerUrl?: string;
  /** Anon key for that backend. Only takes effect alongside nuvioServerUrl. */
  nuvioAnonKey?: string;
}

export interface ThemePref {
  themeId: string;
  // New list shape (v1.25+): multiple saved custom themes, each with its own
  // id + display name. Server accepts either this OR the legacy `custom`
  // single-slot shape below, which is auto-migrated on load.
  customThemes?: Array<{
    id: string;
    name: string;
    base: string;
    primary: string;
    secondary: string;
    text?: string | null;
    textMuted?: string | null;
    background?: string | null;
    surface?: string | null;
    bgMuted?: string | null;
    border?: string | null;
    fontDisplay?: string | null;
    radius?: string | null;
  }>;
  // Legacy pre-v1.25 single-slot shape (kept for one-way read compat).
  custom?: {
    base: string;
    primary: string;
    secondary: string;
    text?: string | null;
    fontDisplay?: string | null;
  } | null;
}

export interface RecommendationRow {
  reason: string;
  genre: string;
  seedId: string;
  seedType: 'movie' | 'series';
  // True when the item-item affinity map has real neighbors for this row's
  // seed - i.e. actual cross-item viewing behavior backs this row, not just
  // the seed's own decayed watch-time score in isolation. See the /similar
  // route's own comment for the fuller reasoning behind this distinction.
  hasRealSignal?: boolean;
  items: DiscoverItem[];
}

export interface TasteOverlapUser {
  id: string;
  username: string;
  avatarUrl?: string | null;
  useGravatar?: boolean;
  colorIndex?: number | null;
  email?: string;
}

export interface TasteOverlapSharedItem {
  key: string;
  name: string | null;
  poster: string | null;
  type: 'movie' | 'series';
}

export interface TasteOverlapPair {
  userA: TasteOverlapUser;
  userB: TasteOverlapUser;
  similarity: number;
  sharedCount: number;
  shared: TasteOverlapSharedItem[];
}

export interface TasteProfile {
  user: TasteOverlapUser;
  totalSeconds: number;
  titleCount: number;
  movieCount: number;
  seriesCount: number;
  topTitles: Array<{ key: string; name: string; poster: string | null; type: 'movie' | 'series'; seconds: number }>;
  topGenres: Array<{ genre: string; count: number }>;
  tasteTwin: { user: TasteOverlapUser; similarity: number } | null;
}

export interface WatchlistItem {
  id: string;
  itemId: string;
  itemType: 'movie' | 'series';
  name: string;
  poster: string | null;
  addedAt: string;
  /** Manual rank; null when never reordered (falls to the newest-first tail). */
  sortOrder?: number | null;
}

export interface CustomListItem {
  id: string;
  type: 'movie' | 'series';
  name: string;
  poster?: string | null;
  year?: number | string | null;
}

// The structured query nlCatalog.js parsed a description into - shown back
// to the admin as "here's what I understood" before they commit to saving.
export interface DescribedCatalogQuery {
  type: 'movie' | 'series' | null;
  genres: string[];
  yearFrom: number | null;
  yearTo: number | null;
  maxRuntimeMinutes: number | null;
  keywords: string[];
}
export interface DescribedCatalogPreview {
  items: CustomListItem[];
  query: DescribedCatalogQuery;
  usedAi: boolean;
  // Set only when an AI key IS configured but the call itself failed (wrong
  // model/baseUrl pairing, invalid key, provider outage) - null whenever no
  // AI key is configured at all, since that's not an error, just the
  // expected zero-setup path. Lets the UI say *why* it fell back instead of
  // leaving a configured-looking key silently unused with no explanation.
  aiError: string | null;
  mediaType: 'movie' | 'tv';
}

export interface CatalogSuggestion {
  id: string;
  type: 'movie' | 'series';
  name: string;
  poster?: string | null;
  year?: number | string | null;
}

export interface CustomList {
  id: string;
  name: string;
  description: string | null;
  items: CustomListItem[];
  coverImageUrl: string | null;
  coverColorIndex: number | null;
  importSourceUrl: string | null;
  autoRefresh: boolean;
  autoRefreshFrequency: 'daily' | 'weekly';
  /** Set when this catalog is a Smart Catalog - the stored criteria it re-evaluates. */
  smartRuleJson?: string | null;
  lastAutoRefreshAt: string | null;
  pinned: boolean;
  // Owner-set opt-in - visible (read-only) to every other account on this
  // instance when true. isOwner is computed server-side per viewer, not
  // stored - a shared catalog you don't own comes back with isOwner: false
  // and the client must hide every mutating affordance for it.
  shared: boolean;
  // Published to OTHER SlickSync instances to subscribe to. A different
  // audience from `shared` above (which is other accounts on THIS instance),
  // hence a separate opt-in. Boolean only - the share URL's token is never
  // in this payload; read it with getCatalogShareLink.
  federationPublished: boolean;
  // Content-rating ALLOWLIST - OMDb "Rated" values to KEEP, e.g. a "Kids"
  // catalog set to ["G","PG"]. Empty = no policy (nothing touched). Only
  // changes via applyContentRating, which also performs the removal - see
  // server/utils/contentRating.js.
  keptRatings: string[];
  // When a content-rating removal is undoable via restoreContentRatingRemoval -
  // null means nothing to restore (never applied, or already restored).
  lastRemovalAt: string | null;
  // True for a catalog server/utils/autoThemedCatalogs.js created from a
  // detected taste cluster (Settings -> SlickTrax -> Auto-generated
  // catalogs). Purely informational client-side - deleting it works the
  // same as any other catalog (the server records the dismissal so it
  // doesn't come back).
  autoGenerated: boolean;
  isOwner: boolean;
  createdAt: string;
  updatedAt: string;
}

// Automation rules ("when X happens, do Y") - server/utils/automation/registry.js
// is the single source of truth these types mirror; the rule builder UI reads
// AutomationRegistry live from the server rather than hardcoding this shape a
// second time, so a new trigger/action shows up without a client release.
export interface AutomationField {
  name: string;
  label: string;
  // 'weekdays' only ever appears in triggerConfigFields, never in a trigger's
  // payload `fields` - it is the day picker on a scheduled trigger, stored as
  // an array of 0-6 (0 = Sunday).
  type: 'string' | 'number' | 'boolean' | 'weekdays';
  required?: boolean;
  hint?: string;
}
export interface AutomationTriggerDef {
  type: string;
  label: string;
  description: string;
  fields: AutomationField[];
  // Only schedule-driven triggers (time.daily) have this - the rule
  // builder shows a config form (writing into rule.triggerConfig) instead
  // of/alongside the normal condition builder when present.
  triggerConfigFields?: AutomationField[];
}
export interface AutomationOperatorDef {
  op: string;
  label: string;
  unary: boolean;
}
export interface AutomationConfigField {
  name: string;
  label: string;
  // 'select' carries its own fixed `options`; addon/group/user load their
  // choices from the account's data instead.
  type: 'string' | 'text' | 'addon' | 'group' | 'user' | 'select';
  required?: boolean;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
}
export interface AutomationActionDef {
  type: string;
  label: string;
  description: string;
  configFields: AutomationConfigField[];
}
export interface AutomationRegistry {
  triggers: AutomationTriggerDef[];
  operators: AutomationOperatorDef[];
  actions: AutomationActionDef[];
}
export interface AutomationCondition {
  field: string;
  op: string;
  value?: string | number;
}
export interface AutomationActionConfig {
  type: string;
  config: Record<string, string>;
}
export interface AutomationRuleInput {
  name: string;
  triggerType: string;
  triggerConfig?: Record<string, unknown>;
  conditions?: AutomationCondition[];
  actions: AutomationActionConfig[];
  enabled?: boolean;
}
export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  conditions: AutomationCondition[];
  actions: AutomationActionConfig[];
  lastRunAt: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface AutomationActionResult {
  type: string;
  ok: boolean;
  message: string;
}
export interface AutomationRun {
  id: string;
  ruleId: string;
  ruleName: string;
  triggerType: string;
  payload: Record<string, unknown>;
  results: AutomationActionResult[];
  ok: boolean;
  createdAt: string;
}

// Nuvio's own native "Collections" (home-screen folder/catalog-source
// organizer), pulled/pushed live from the account itself — not this app's
// local CustomList above. Index signatures preserve fields this app's v1
// editor doesn't expose (pinToTop, viewMode, coverImageUrl, etc.) untouched
// through a load-edit-save round trip, rather than silently dropping a real
// user's existing settings for those.
export interface NuvioProfile {
  id: string;
  user_id: string;
  profile_index: number;
  name: string;
  avatar_color_hex?: string | null;
  uses_primary_addons?: boolean;
  uses_primary_plugins?: boolean;
  avatar_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface NuvioCatalogSource {
  addonId: string;
  type: string;
  catalogId: string;
  // Present when this source is one broad catalog filtered down to a
  // specific genre (the catalog's own "genre" extra parameter value) -
  // most addons expose genres as a filter on one catalog, not as separate
  // catalogs per genre. "none" (as seen on real, non-genre-filtered
  // sources) or absent both mean "no genre filter."
  genre?: string;
  [key: string]: any;
}

export interface NuvioCollectionFolder {
  id: string;
  title: string;
  catalogSources?: NuvioCatalogSource[];
  // Confirmed live (2026-08-06): Nuvio's real client only picks up a BRAND
  // NEW folder on its first sync if these are present - a folder missing
  // them entirely (not just falsy) never renders, even after a full app
  // restart, despite the write/read round-tripping correctly everywhere
  // else. Every folder this app creates must set them (see
  // newFolderDefaults() in the Nuvio Collections page).
  tileShape?: 'LANDSCAPE' | 'SQUARE' | 'POSTER';
  hideTitle?: boolean;
  focusGifEnabled?: boolean;
  // The actual field Nuvio's home-row rendering checks to decide whether to
  // animate a folder's cover - separate from coverImageUrl (the static
  // fallback used everywhere else, e.g. folder detail). coverImageUrl alone,
  // even with a real .gif URL and focusGifEnabled true, never animates -
  // confirmed by reading Nuvio's own HomeCollectionRowSection.kt:
  // isAnimatedCollectionFolderImage() only checks focusGifUrl, and
  // collectionFolderCardImageUrl() only prefers it over coverImageUrl when
  // set. Keep this equal to coverImageUrl whenever that's a .gif, null
  // otherwise.
  focusGifUrl?: string | null;
  [key: string]: any;
}

export interface NuvioCollection {
  id: string;
  title: string;
  folders?: NuvioCollectionFolder[];
  [key: string]: any;
}

export interface SeriesSeason {
  season: number;
  watchedCount: number;
  episodes: Array<{ season: number; episode: number; title: string | null; released: string | null; watched: boolean }>;
}

export interface SmartCatalogRule {
  type: 'movie' | 'series' | null;
  genres: string[];
  yearFrom: number | null;
  yearTo: number | null;
  maxRuntimeMinutes: number | null;
  keywords: string[];
  minRating: number | null;
  /** Excludes anything anyone in the household has already watched. */
  unwatchedOnly: boolean;
  limit: number;
}

export interface FollowedSubject {
  id: string;
  kind: 'person' | 'show';
  subjectId: string;
  name: string;
  poster: string | null;
  muted: boolean;
  createdAt: string;
  lastCheckedAt: string | null;
}

export interface AnimeEntry {
  anilistId: number;
  name: string;
  episodes: number | null;
  year: number | null;
  format: string | null;
}

export interface SeasonalAnime {
  anilistId: number;
  name: string;
  poster: string | null;
  episodes: number | null;
  format: string | null;
  status: string | null;
  score: number | null;
  genres: string[];
  nextEpisode: { episode: number; airingAt: string; label: string } | null;
  siteUrl: string | null;
}

/** One row of a Nuvio profile's home screen (server/utils/nuvioHomeLayout.js). */
export interface NuvioHomeRow {
  addon_id: string;
  type: string;
  catalog_id: string;
  enabled: boolean;
  custom_title: string;
  collection_id: string;
  is_collection: boolean;
  /** False for catalogs the saved arrangement has never mentioned. */
  arranged: boolean;
  addonName: string;
  catalogName: string;
  /** True when the row's addon is no longer installed on the account. */
  orphaned: boolean;
}

export interface NuvioCommunityCover {
  id: number;
  image_url: string;
  mime_type: string;
  orientation: 'landscape' | 'portrait' | string;
  title: string;
  likes_count: number;
}

export interface NuvioCommunityCoversResponse {
  items: NuvioCommunityCover[];
  pagination: { page: number; limit: number; total: number; hasNextPage: boolean };
}

export interface YearInReviewTitle {
  id: string;
  name: string;
  poster: string | null;
  type: 'movie' | 'series';
  episodeCount?: number;
  rewatchCount?: number;
}

export interface YearInReview {
  year: number;
  totalWatchTimeSeconds: number;
  movieWatchTimeSeconds: number;
  seriesWatchTimeSeconds: number;
  moviesWatched: number;
  completedMovies: number;
  episodesWatched: number;
  showsWatched: number;
  byMonth: number[]; // 12 entries, seconds per month (Jan..Dec)
  busiestMonth: number; // 0-11
  topShows: YearInReviewTitle[];
  mostRewatched: YearInReviewTitle[];
  perUser: Array<{ userId: string; username: string; seconds: number }>;
  hasData: boolean;
}

export interface HealthStatus {
  overall: 'healthy' | 'attention';
  checkedAt: string;
  sync: {
    usersTracked: number;
    driftCount: number;
    drifted: Array<{ userId: string; title: string; body: string; url: string | null; since: string }>;
    ignored: Array<{ userId: string; title: string; since: string | null }>;
  };
  addons: {
    total: number;
    checked: number;
    offlineCount: number;
    offline: Array<{ id: string; name: string; error: string | null; lastChecked: string | null }>;
    ignored: Array<{ id: string; name: string }>;
    uptime: Array<{ id: string; name: string; uptime7d: number; uptime30d: number }>;
  };
  vault: {
    total: number;
    failingCount: number;
    failing: Array<{ id: string; name: string; provider: string | null; message: string | null; lastChecked: string | null }>;
    expiringCount: number;
    expiring: Array<{ id: string; name: string; provider: string | null; expiresAt: string }>;
    ignored: Array<{ id: string; name: string; provider: string | null }>;
  };
  // null on public multi-tenant instances - the AIOStreams proxy monitor is
  // a private-mode, single-shared-instance concept with no per-account
  // Settings field, so there's nothing real to report for a given tenant.
  proxy: { ok: boolean | null; at: string | null; error: string | null; configured: boolean; healthIgnored: boolean } | null;
  mismatchCount: number;
  version: { running: string; latestRelease: string | null; updateAvailable: boolean };
  timeline: Array<{
    id: string;
    source: 'addon' | 'vault' | 'proxy';
    status: 'up' | 'down';
    title: string;
    detail: string | null;
    at: string;
  }>;
}

export interface UpcomingEpisode {
  showId: string;
  showName: string | null;
  poster: string | null;
  season: number;
  episode: number;
  title: string | null;
  airDate: string;
}

export interface MutedShow {
  id: string;
  showId: string;
  showName: string | null;
  poster: string | null;
  createdAt: string;
}

export interface ExportedConfig {
  users: User[];
  groups: Group[];
  addons: Addon[];
  invitations: Invitation[];
}

export interface ImportConfigResult {
  users: { created: number; reused: number };
  groups: { created: number; reused: number };
  addons: { created: number; reused: number };
}

export interface BackupValidation {
  valid: boolean;
  issues: string[];
  counts: { users: number; groups: number; addons: number } | null;
}

export interface BackupFile {
  filename: string;
  size: number;
  createdAt: string;
  validation?: BackupValidation | null;
}

export interface DbSizeReport {
  supported: boolean;
  currentBytes?: number | null;
  growthBytesPerDay?: number | null;
  projectedDaysUntilFull?: number | null;
  samples?: Array<{ bytes: number; createdAt: string }>;
}

export interface DisasterRecoveryKit {
  salt: string;
  payload: string;
  exportedAt: string;
  counts: { users: number; groups: number; addons: number; vaultEntries: number };
}

export interface AddonSnapshot {
  id: string;
  name: string;
  description: string | null;
  sourceType: 'user' | 'group';
  sourceId: string;
  addonCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AddonSnapshotDetail extends AddonSnapshot {
  addons: Array<{ name: string; manifestUrl: string | null; stremioAddonId: string | null; version: string | null }>;
}

export interface EpisodeAlert {
  id: string;
  showId: string;
  showName: string;
  season: number;
  episode: number;
  title: string | null;
  poster: string | null;
  createdAt: string;
}

export interface AddonHealthAlert {
  id: string;
  addonId: string;
  addonName: string;
  event: 'offline' | 'online';
  backupAddonId: string | null;
  backupAddonName: string | null;
  groupCount: number;
  errorMessage: string | null;
  createdAt: string;
}

// Persistent in-app bell notification (notifications table). Written from the
// same dispatch path as push/Discord; read state is server-side.
export interface StoredNotification {
  id: string;
  type: 'activity' | 'sync' | 'invite' | 'vault' | 'task' | 'mismatch';
  title: string;
  body: string;
  poster: string | null;
  url: string | null;
  data: string | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface ContinueWatchingItem {
  userId: string;
  username: string;
  providerType?: string;
  // 'movie' entries are in-progress movies (resume always true, nextEpisode/
  // lastWatched always null). For 'series', nextEpisode is the episode the
  // card opens - the in-progress one when resume=true, the next unwatched
  // one otherwise (field name kept from when it was always the latter).
  contentType: 'series' | 'movie';
  showId: string;
  showName: string;
  poster: string | null;
  background?: string | null;
  lastWatched: { season: number; episode: number } | null;
  nextEpisode: { season: number; episode: number; title: string | null; thumbnail: string | null } | null;
  resume?: boolean;
  progressPercent?: number | null;
  lastWatchedAt: string;
  appUrl?: string;
  webUrl?: string;
  imdbRating: string | null;
  rottenTomatoes: string | null;
  metacritic: string | null;
}

export interface DiscoverItem {
  id: string;
  type: 'movie' | 'series';
  name: string;
  poster: string | null;
  releaseInfo: string | null;
  imdbRating: string | null;
  genres: string[];
  // Merged in client-side after a separate ratings-batch call - Discover's
  // own catalog fetch is Cinemeta-only and has no Rotten Tomatoes/Metacritic.
  rottenTomatoes?: string | null;
  metacritic?: string | null;
}

// getSimklDiscoverRow's item shape - deliberately lighter than DiscoverItem
// (no genres/imdbRating - SIMKL's trending/anticipated payload doesn't
// carry either), matches PosterCardItem's actual minimum requirements.
export interface SimklDiscoverItem {
  id: string;
  type: 'movie' | 'series';
  name: string;
  poster: string | null;
  year: string | null;
}

export interface RatingsBatchEntry {
  imdbRating: string | null;
  rottenTomatoes: string | null;
  metacritic: string | null;
}

export interface MediaDetails {
  title: string | null;
  poster: string | null;
  background: string | null;
  // TMDb backdrop (server/routes/users.js's /media-details) - preferred over
  // `background` (Cinemeta's own field) when available, generally higher
  // quality/more consistently present. Free at any TMDb tier, unlike RPDB's
  // equivalent which needs a paid Tier 2+ key. Null when no TMDb key is
  // configured or TMDb has nothing for this title.
  backdrop: string | null;
  description: string | null;
  cast: Array<{ name: string; character: string | null; photo: string | null; tmdbId?: number | string | null }>;
  director: string[];
  genres: string[];
  imdbRating: string | null;
  rottenTomatoes: string | null;
  metacritic: string | null;
  // Content/age rating (MPAA "PG-13"/"R" or TV parental guidelines
  // "TV-14"/"TV-MA"), NOT a quality score - see server/utils/omdb.js's own
  // comment on why "Not Rated" is kept as a real value distinct from null.
  rated: string | null;
  runtime: string | null;
  releaseInfo: string | null;
  country: string | null;
  awards: string | null;
  // OMDb's own field, distinct from Awards - a movie's theatrical gross.
  // Virtually always null for TV (no theatrical release to report).
  boxOffice: string | null;
  imdb_id: string | null;
  moviedb_id: number | null;
  trailers: string[];
  episode?: {
    title: string | null;
    released: string | null;
    overview: string | null;
    thumbnail: string | null;
  };
  // TMDb "belongs_to_collection" grouping (e.g. Dune -> Dune Collection) -
  // movies only, null for TV and for any movie not part of one.
  collection?: {
    id: number;
    name: string;
    parts: Array<{ id: string; title: string; poster: string | null; releaseYear: string | null }>;
  } | null;
  // TMDb watch/providers (JustWatch data), US region - subscription/free
  // tiers only (rent/buy excluded, see server's own comment). `link` is
  // TMDb's required JustWatch attribution page for this title.
  watchProviders?: {
    link: string | null;
    providers: Array<{ name: string; logo: string | null }>;
  } | null;
  // MDBList's own blended score (0-100, weighted across multiple rating
  // sources) - null when no MDBList key is configured or MDBList has
  // nothing for this title, same as every other optional field here.
  mdblistScore?: number | null;
}

export interface MetricsData {
  // The account's current calendar day (YYYY-MM-DD) in its configured
  // timezone - use this instead of computing "today" client-side (browser
  // local time or UTC) when looking up an entry in watchTime.byDay /
  // watchActivity.byDay, since those arrays are keyed by account-day.
  today?: string;
  summary: {
    totalUsers: number;
    activeUsers: number;
    totalMovies: number;
    totalShows: number;
    totalWatched: number;
    totalWatchTimeHours: number;
  };
  watchTime: {
    byDay: Array<{ date: string; hours: number }>;
    trend?: {
      percentage: number;
      direction: 'up' | 'down';
    };
  };
  watchActivity: {
    byDay: Array<{ date: string; movies: number; shows: number; total: number }>;
    byUser: Array<{
      id: string;
      username: string;
      email?: string; // Added email
      avatarUrl?: string | null;
      useGravatar?: boolean;
      movies: number;
      shows: number;
      total: number;
      watchTimeHours: number;
      watchTimeMoviesHours: number;
      watchTimeShowsHours: number;
      streak?: number;
    }>;
  };
  nowPlaying: Array<{
    user: { id: string; username: string; email: string; colorIndex: number; avatarUrl?: string | null; useGravatar?: boolean };
    item: { id: string; name: string; type: string; year?: number; poster?: string; season?: number; episode?: number };
    videoId?: string | null; // videoId for series items (used for session matching)
    watchedAt: string;
    watchedAtTimestamp?: number; // Stable session startTime in ms (used for duration calculation)
    source?: string; // 'aiostreams-proxy' for proxy-detected live entries; absent for native
    // Playback position (ms), for the "resume here" quick-launch - native
    // only, a direct snapshot (see server/utils/metricsBuilder.js's comment).
    // Absent/null when unknown, e.g. a title the native pipeline hasn't
    // checkpointed yet.
    lastPosition?: number | null;
    totalDuration?: number | null;
    // Pre-built episode-aware deep links (server/utils/appLinks.js, same
    // builder Continue Watching uses) - absent when we don't have a real
    // item id to link to (e.g. an unmatched proxy-only entry).
    stremioAppUrl?: string;
    nuvioAppUrl?: string;
    // Proxy-sourced entries only: elapsed watch time we can actually stand
    // behind (seconds), frozen once proxy traffic goes quiet rather than
    // climbing forever off raw wall-clock time - see the comment in
    // server/utils/proxyNowPlaying.js for why. Use this (with elapsedFrozen)
    // instead of computing `now - watchedAtTimestamp` for proxy entries.
    elapsedSeconds?: number;
    elapsedFrozen?: boolean;
  }>;
  startedPlaying: Array<{
    user: { id: string; username: string; email: string; colorIndex: number };
    item: { id: string; name: string; type: string; year?: number; poster?: string; season?: number; episode?: number };
    startedAt: string;
  }>;
  recentActivity?: Array<{
    user: { id: string; username: string; email?: string; colorIndex: number; avatarUrl?: string | null; useGravatar?: boolean };
    item: { id: string; name: string; type: string; poster?: string; season?: number | null; episode?: number | null };
    videoId: string | null;
    profileLabel?: string | null;
    // Episode title from Cinemeta, when known - series entries only. See
    // EpisodeWatchHistory.episodeName in the schema for how this gets filled.
    episodeName?: string | null;
    // Real completion: true = genuinely finished (played to ~end), false =
    // started but dropped, null = unknown. See the schema comment.
    completed?: boolean | null;
    // Movies only: times watched to the end AGAIN after first completion
    // (0 = first watch). See MovieWatchHistory.rewatchCount in the schema.
    rewatchCount?: number;
    watchedAt: string;
    watchedAtTimestamp: number;
    // Only present when backfilled from a matching native WatchSession -
    // this feed has no per-event duration of its own (see metricsBuilder.js
    // mergeCrossPipelineDuplicates).
    durationSeconds?: number;
    // Only present when this watch was confidently correlated to a stream
    // seen by the AIOStreams proxy AND its resolved URL matched a known
    // debrid pattern (server/utils/debridDetection.js). e.g. "torbox".
    // Absent doesn't mean "not debrid" - it means not confidently detected.
    debridService?: string;
  }>;
  recentEpisodes?: Array<{
    user: { id: string; username: string; email?: string; colorIndex: number };
    item: { id: string; name: string; type: string; poster?: string; season?: number | null; episode?: number | null };
    videoId: string;
    watchedAt: string;
  }>;
  watchSessions?: Array<{
    id: string;
    user: { id: string; username: string; email?: string; colorIndex: number; avatarUrl?: string | null; useGravatar?: boolean };
    item: { id: string; name: string; type: string; poster?: string; season?: number | null; episode?: number | null };
    videoId?: string | null;
    startTime: string;
    endTime?: string | null;
    durationSeconds: number;
    requestCount?: number | null;
    isActive: boolean;
    isSynthetic?: boolean;
  }>;
  userJoins?: {
    byDay: Array<{ date: string; count: number }>;
    byWeek: Array<{ week: string; count: number }>;
    byMonth: Array<{ month: string; count: number }>;
  };
  period: string;
  admin?: AdminMetrics;
}

// Admin Analytics Types (Phase 1 + Phase 2)
export interface AdminMetrics {
  userLifecycle: {
    retention: {
      total: number;
      active7d: number;
      active30d: number;
      active90d: number;
      rate7d: number;
      rate30d: number;
      rate90d: number;
    };
    atRisk: AtRiskUser[];
    criticalRisk: AtRiskUser[];
  };
  topContent: {
    movies: TopContentItem[];
    series: TopContentItem[];
    trending: TopContentItem[];
  };
  engagement: {
    hourlyActivity: HourlyActivity[];
    averageSessionMinutes: number;
    totalSessions: number;
    bingeSessions: number;
    peakHour: number;
  };
  alerts: {
    critical: Alert[];
    warnings: Alert[];
    operational: OperationalAlert[];
    total: number;
    hasCritical: boolean;
  };
  // Phase 2: Addon Analytics
  addonAnalytics: {
    totalAddons: number;
    activeAddons: number;
    topAddons: AddonStat[];
    underutilized: AddonStat[];
    byResource: ResourceStat[];
  };
  // Phase 2: Server Health
  serverHealth: {
    status: 'healthy' | 'warning' | 'critical';
    checks: {
      syncQueue?: HealthCheck;
      storage?: HealthCheck;
      database?: HealthCheck;
      activity?: HealthCheck;
    };
    metrics: {
      activeSessions: number;
      serverTime: string;
    };
  };
  // Phase 3: Enhanced Metrics
  topItems: {
    movies: TopItemWithUsers[];
    series: TopItemWithUsers[];
  };
  watchVelocity: WatchVelocityItem[];
  interestingMetrics: {
    avgWatchTimePerUser: number;
    mostActiveHour: number;
    weekendWatchPercentage: number;
    completionRate: number;
    totalBingeSessions: number;
    avgSessionDuration: number;
  };
}

export interface OperationalAlert {
  type: string;
  message: string;
  severity: 'critical' | 'warning' | 'info';
  count?: number;
  sizeMB?: number;
  addons?: string[];
}

export interface AddonStat {
  id: string;
  name: string;
  manifestUrl: string;
  iconUrl?: string;
  isActive: boolean;
  totalGroups: number;
  enabledGroups: number;
  userCount: number;
  usageRate: number;
  resources: string[];
  catalogs: any[];
}

export interface ResourceStat {
  name: string;
  count: number;
}

export interface HealthCheck {
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  message: string;
  totalUsers?: number;
  staleUsers?: number;
  sizeMB?: number;
  fileCount?: number;
  activeSessions?: number;
}

export interface AtRiskUser {
  id: string;
  username: string;
  email: string;
  lastActivity: string | null;
  daysInactive: number;
  totalWatchTimeHours: number;
  neverWatched?: boolean;
}

export interface TopContentItem {
  id: string;
  name: string;
  type: 'movie' | 'series';
  poster: string;
  watchCount: number;
  uniqueViewers: string[];
  completionRate: number;
  avgWatchTimeMinutes: number;
  recentVelocity: number;
}

export interface TopItemWithUsers {
  itemId: string;
  name: string;
  type: 'movie' | 'series';
  poster?: string;
  totalWatchTimeSeconds: number;
  totalWatchTimeHours: number;
  userCount: number;
  users: Array<{
    userId: string;
    username: string;
    email?: string;
    avatarUrl?: string | null;
    colorIndex?: number;
    watchTimeSeconds: number;
    watchTimeHours: number;
    episodesWatched?: number;
  }>;
}

export interface WatchVelocityItem {
  itemId: string;
  name: string;
  poster?: string;
  episodesPerDay: number;
  episodesPerWeek: number;
  estimatedEpisodes: number;
  daysActive: number;
  totalWatchTimeHours: number;
}

export interface HourlyActivity {
  hour: number;
  watchTimeMinutes: number;
  sessions: number;
}

export interface Alert {
  type: string;
  message: string;
  count: number;
  severity: 'critical' | 'warning';
  users?: string[];
}

export interface ActivityLibraryData {
  library: Array<{
    user: { id: string; username: string; email: string; colorIndex: number };
    item: {
      _id?: string;
      id?: string;
      name: string;
      type: string;
      year?: number;
      poster?: string;
      state?: {
        overallTimeWatched?: number;
        timeOffset?: number;
        lastWatched?: string;
      };
      _mtime?: string;
    };
  }>;
  count: number;
}
