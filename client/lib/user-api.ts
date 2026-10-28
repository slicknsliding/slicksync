/**
 * User Panel API Client
 * 
 * API methods for the user panel (non-admin). Uses Stremio OAuth for authentication.
 * All endpoints are under /public-library/* and don't require admin auth.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

// Custom error class for API errors
export class UserApiError extends Error {
  status: number;
  
  constructor(message: string, status: number) {
    super(message);
    this.name = 'UserApiError';
    this.status = status;
    // Fix prototype chain for proper instanceof checks in browsers
    Object.setPrototypeOf(this, UserApiError.prototype);
  }
}

// Helper to make API requests
async function request<T>(
  endpoint: string,
  options: RequestInit & { authKey?: string } = {}
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const { authKey, ...fetchOptions } = options;
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchOptions.headers as Record<string, string>),
  };

  if (authKey) {
    headers['x-stremio-auth'] = authKey;
  }
  
  const response = await fetch(url, {
    ...fetchOptions,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new UserApiError(error.message || `HTTP ${response.status}`, response.status);
  }

  return response.json();
}

// Types
export interface UserInfo {
  id: string;
  username: string;
  email: string;
  colorIndex?: number;
  /** Their own picture: an address, or /uploads/avatars/<file> for one uploaded here. */
  avatarUrl?: string | null;
  /** They switched Gravatar on, so their avatar may look their email up there. */
  useGravatar?: boolean;
  activityVisibility: 'public' | 'private';
  groupName?: string;
  groupId?: string;
  createdAt: string;
  expiresAt?: string;
  discordWebhookUrl?: string | null;
  notifyOnWatch?: boolean;
  publicStatsEnabled?: boolean;
  publicStatsSlug?: string | null;
}

export interface LibraryItem {
  _id: string;
  name: string;
  type: 'movie' | 'series';
  poster?: string;
  background?: string;
  state?: {
    timeOffset?: number;
    overallTimeWatched?: number;
    lastWatched?: string;
    video_id?: string;
    season?: number;
    episode?: number;
  };
  progress?: number;
}

export interface GroupAddon {
  id: string;
  name: string;
  description?: string;
  manifestUrl: string;
  logo?: string;
  isExcluded?: boolean;
  isProtected?: boolean;
}

export interface StremioAddon {
  transportUrl: string;
  transportName?: string;
  manifest: {
    id: string;
    name: string;
    description?: string;
    version?: string;
    logo?: string;
  };
  flags?: {
    official?: boolean;
    protected?: boolean;
  };
}

export interface Share {
  id: string;
  itemId: string;
  itemName: string;
  itemType: 'movie' | 'series';
  poster?: string;
  fromUserId: string;
  fromUsername?: string;
  toUserId: string;
  toUsername?: string;
  createdAt: string;
  viewedAt?: string;
}

export interface GroupMember {
  id: string;
  username: string;
  email: string;
  colorIndex?: number;
}

// OAuth API
export const userOAuth = {
  /**
   * Generate a new OAuth link for Stremio authentication
   */
  async create(): Promise<{ code: string; link: string; expiresAt: number }> {
    const result = await request<{ code: string; link: string; expiresAt: string }>(
      '/public-library/generate-oauth',
      { method: 'POST' }
    );
    return {
      code: result.code,
      link: result.link,
      expiresAt: new Date(result.expiresAt).getTime(),
    };
  },

  /**
   * Poll for OAuth completion
   */
  async poll(code: string): Promise<{ success: boolean; authKey: string | null; error?: string }> {
    return request('/public-library/poll-oauth', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  },

  /**
   * Start Nuvio's device-code login flow. Unlike Stremio's simple 2-step
   * link (code -> authKey), Nuvio needs a 3-step anon-Supabase-session
   * dance - the caller must hold onto anonToken/deviceNonce and pass them
   * back into pollNuvio/exchangeNuvio.
   */
  async createNuvio(): Promise<{
    code: string; webUrl: string; expiresAt: string; pollIntervalSeconds: number;
    anonToken: string; deviceNonce: string;
  }> {
    return request('/public-library/generate-oauth-nuvio', { method: 'POST' });
  },

  /**
   * Poll a Nuvio login session for approval status.
   */
  async pollNuvio(code: string, deviceNonce: string, anonToken: string): Promise<{
    success: boolean; status?: string; expiresAt?: string; pollIntervalSeconds?: number; error?: string;
  }> {
    return request('/public-library/poll-oauth-nuvio', {
      method: 'POST',
      body: JSON.stringify({ code, deviceNonce, anonToken }),
    });
  },
};

// User Authentication API
export const userAuth = {
  /**
   * Authenticate with Stremio auth key and get/create user
   */
  async authenticate(authKey: string): Promise<{
    success: boolean;
    userId: string;
    userInfo: UserInfo;
    isNewUser?: boolean;
    error?: string;
    errorCode?: string;
  }> {
    const response = await request<{
      success: boolean;
      user?: {
        id: string;
        username: string;
        email: string;
        colorIndex?: number;
        createdAt?: string;
        expiresAt?: string;
        groupId?: string;
        groupName?: string;
        activityVisibility?: 'public' | 'private';
      };
      isNewUser?: boolean;
      error?: string;
      errorCode?: string;
    }>('/public-library/authenticate', {
      method: 'POST',
      body: JSON.stringify({ authKey }),
    });

    // Transform response to expected format
    if (response.success && response.user) {
      return {
        success: true,
        userId: response.user.id,
        userInfo: {
          id: response.user.id,
          username: response.user.username,
          email: response.user.email,
          colorIndex: response.user.colorIndex,
          activityVisibility: response.user.activityVisibility || 'private',
          groupId: response.user.groupId,
          groupName: response.user.groupName,
          createdAt: response.user.createdAt || new Date().toISOString(),
          expiresAt: response.user.expiresAt,
        },
        isNewUser: response.isNewUser,
      };
    }

    return {
      success: false,
      userId: '',
      userInfo: {} as UserInfo,
      error: response.error || 'Authentication failed',
      errorCode: response.errorCode,
    };
  },

  /**
   * Validate user session
   */
  async validate(authKey: string, userId: string): Promise<{
    valid: boolean;
    userId?: string;
    sessionToken?: string;
    error?: string;
    errorCode?: string;
  }> {
    const response = await request<{
      valid?: boolean;
      success?: boolean;
      userId?: string;
      error?: string;
      errorCode?: string;
    }>('/public-library/validate', {
      method: 'POST',
      body: JSON.stringify({ authKey, userId }),
    });

    return {
      valid: response.valid ?? response.success ?? false,
      userId: response.userId,
      error: response.error,
      errorCode: response.errorCode,
    };
  },

  /**
   * Exchange a completed Nuvio device-code login for a session (mirrors
   * `authenticate` above, but Nuvio's exchange result - not a client-held
   * credential - is itself the proof of identity).
   */
  async authenticateNuvio(code: string, deviceNonce: string, anonToken: string): Promise<{
    success: boolean;
    userId: string;
    userInfo: UserInfo;
    sessionToken: string;
    error?: string;
    errorCode?: string;
  }> {
    const response = await request<{
      success: boolean;
      sessionToken?: string;
      user?: {
        id: string;
        username: string;
        email: string;
        colorIndex?: number;
        createdAt?: string;
        expiresAt?: string;
      };
      error?: string;
      message?: string;
    }>('/public-library/authenticate-nuvio', {
      method: 'POST',
      body: JSON.stringify({ code, deviceNonce, anonToken }),
    });

    if (response.success && response.user && response.sessionToken) {
      return {
        success: true,
        userId: response.user.id,
        sessionToken: response.sessionToken,
        userInfo: {
          id: response.user.id,
          username: response.user.username,
          email: response.user.email,
          colorIndex: response.user.colorIndex,
          activityVisibility: 'private',
          createdAt: response.user.createdAt || new Date().toISOString(),
          expiresAt: response.user.expiresAt,
        },
      };
    }

    return {
      success: false,
      userId: '',
      userInfo: {} as UserInfo,
      sessionToken: '',
      error: response.message || response.error || 'Authentication failed',
      errorCode: response.error,
    };
  },

  /**
   * Re-validate a Nuvio user's stored session (mirrors `validate` above).
   * Requires the caller's own previously-issued session token - proof of
   * possession, not just a bare userId (which used to be sufficient to
   * "restore" a session as literally anyone, since nothing checked the
   * caller actually held any credential of their own). Returns a freshly
   * reissued token on success (sliding expiry), same pattern as
   * refreshUserInfo elsewhere in this file.
   */
  async validateNuvio(userId: string, sessionToken?: string): Promise<{
    valid: boolean;
    userId?: string;
    sessionToken?: string;
    error?: string;
    errorCode?: string;
  }> {
    const response = await request<{
      valid?: boolean;
      success?: boolean;
      sessionToken?: string;
      user?: { id: string };
      error?: string;
      message?: string;
    }>('/public-library/validate-nuvio', {
      method: 'POST',
      body: JSON.stringify({ userId }),
      authKey: sessionToken,
    });

    return {
      valid: response.valid ?? response.success ?? false,
      userId: response.user?.id,
      sessionToken: response.sessionToken,
      error: response.message || response.error,
      errorCode: response.error,
    };
  },

  /**
   * Sign in through a Jellyfin-compatible server (a real Jellyfin, or the
   * media server AIOStreams or AIOMetadata runs). The server signs in with
   * what the person typed - or an approved Quick Connect secret - and hands
   * back a SlickSync session token, the role Stremio's authKey plays.
   */
  async authenticateJellyfin(credentials: Record<string, string>): Promise<{
    success: boolean;
    userId: string;
    userInfo: UserInfo;
    sessionToken: string;
    error?: string;
    errorCode?: string;
  }> {
    const response = await request<{
      success: boolean;
      sessionToken?: string;
      user?: { id: string; username: string; email: string; colorIndex?: number; createdAt?: string; expiresAt?: string };
      error?: string;
      message?: string;
    }>('/public-library/authenticate-jellyfin', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
    if (response.success && response.user && response.sessionToken) {
      return {
        success: true,
        userId: response.user.id,
        sessionToken: response.sessionToken,
        userInfo: {
          id: response.user.id,
          username: response.user.username,
          email: response.user.email,
          colorIndex: response.user.colorIndex,
          activityVisibility: 'private',
          createdAt: response.user.createdAt || new Date().toISOString(),
          expiresAt: response.user.expiresAt,
        },
      };
    }
    return {
      success: false,
      userId: '',
      userInfo: {} as UserInfo,
      sessionToken: '',
      error: response.message || response.error || 'Authentication failed',
      errorCode: response.error,
    };
  },

  /** Re-validate a stored Jellyfin session (mirrors validateNuvio). */
  async validateJellyfin(userId: string, sessionToken?: string): Promise<{
    valid: boolean;
    userId?: string;
    sessionToken?: string;
    error?: string;
    errorCode?: string;
  }> {
    const response = await request<{
      valid?: boolean;
      success?: boolean;
      sessionToken?: string;
      user?: { id: string };
      error?: string;
      message?: string;
    }>('/public-library/validate-jellyfin', {
      method: 'POST',
      body: JSON.stringify({ userId }),
      authKey: sessionToken,
    });
    return {
      valid: response.valid ?? response.success ?? false,
      userId: response.user?.id,
      sessionToken: response.sessionToken,
      error: response.message || response.error,
      errorCode: response.error,
    };
  },

  /** The steps before a Jellyfin sign-in: checking the address and Quick Connect. */
  jellyfinSignIn: {
    probe: (serverUrl: string) => request<any>('/public-library/jellyfin-probe', { method: 'POST', body: JSON.stringify({ serverUrl }) }),
    startQuickConnect: (serverUrl: string) => request<any>('/public-library/jellyfin-quick-connect', { method: 'POST', body: JSON.stringify({ serverUrl }) }),
    quickConnectStatus: (params: { serverUrl: string; secret: string; device: string }) => request<any>('/public-library/jellyfin-quick-connect-status', { method: 'POST', body: JSON.stringify(params) }),
  },

  /**
   * Self-service "delete my account" - permanently removes this user and
   * their own data (watch history, watchlist state, group membership).
   * Does NOT touch account-wide resources (Vault, Catalogs, other users) -
   * that's the separate admin-level Settings > Danger Zone delete. Re-proves
   * the live session server-side, so Stremio users must pass their current
   * authKey; Nuvio users are re-validated by userId alone (mirrors validate/
   * validateNuvio above).
   */
  async deleteAccount(userId: string, provider: 'stremio' | 'nuvio' | 'jellyfin', authKey?: string): Promise<{ deleted: boolean }> {
    return request('/public-library/delete-account', {
      method: 'POST',
      body: JSON.stringify({ userId, provider }),
      authKey,
    });
  },

  /**
   * Get current user's info
   */
  async getUserInfo(userId: string, authKey?: string): Promise<UserInfo> {
    const params = new URLSearchParams({ userId });
    return request(`/public-library/user-info?${params.toString()}`, { authKey });
  },

  /**
   * Update activity visibility
   */
  async updateActivityVisibility(
    userId: string,
    authKey: string,
    visibility: 'public' | 'private'
  ): Promise<{ success: boolean }> {
    return request('/public-library/activity-visibility', {
      method: 'PATCH',
      body: JSON.stringify({ userId, activityVisibility: visibility }),
      authKey,
    });
  },

  /**
   * Enable/disable the public, unauthenticated stats share link. Enabling
   * returns the slug (not the full URL) - the caller builds the shareable
   * link from it. Distinct from activityVisibility above (household-only).
   */
  async enablePublicStats(userId: string, authKey: string): Promise<{ slug: string }> {
    return request('/public-library/public-stats/enable', {
      method: 'POST',
      body: JSON.stringify({ userId }),
      authKey,
    });
  },
  async disablePublicStats(userId: string, authKey: string): Promise<{ success: boolean }> {
    return request('/public-library/public-stats/disable', {
      method: 'POST',
      body: JSON.stringify({ userId }),
      authKey,
    });
  },
};

// Activity types
export interface WatchSession {
  id: string;
  type: 'session' | 'episode';
  userId: string;
  username: string;
  userEmail?: string;
  userColorIndex?: number;
  itemId: string;
  videoId?: string;
  itemName: string;
  itemType: 'movie' | 'series';
  season?: number;
  episode?: number;
  poster?: string;
  startTime: string;
  endTime?: string;
  durationSeconds: number;
  isActive: boolean;
  isSynthetic?: boolean;
}

export interface UserActivityStats {
  totalWatchTimeSeconds: number;
  totalWatchTimeHours: number;
  watchTimeTodaySeconds: number;
  watchTimeTodayHours: number;
  watchedTodayCount: number;
  moviesCount: number;
  seriesCount: number;
  recentItemsCount: number;
  totalSessions: number;
  currentStreak: number;
  longestStreak: number;
  avgWatchTimeSeconds: number;
  avgWatchTimeHours: number;
}

export interface WatchTimeByDay {
  date: string;
  hours: number;
  minutes: number;
  movies: number;
  series: number;
  total: number;
}

export interface MostWatchedItem {
  id: string;
  name: string;
  type: string;
  poster?: string;
  count: number;
  totalDuration: number;
}

export interface BingeWatch {
  name: string;
  poster?: string;
  episodeCount: number;
  totalDuration: number;
  date: string;
}

export interface NowPlayingItem {
  item: {
    id: string;
    name: string;
    type: string;
    poster?: string;
    season?: number;
    episode?: number;
    // A proxy stream whose title isn't known yet - name is plain words.
    titlePending?: boolean;
    episodeTitle?: string;
  };
  startTime: string;
  videoId?: string;
  // For the freshness line (lib/playbackFreshness.ts): where the row comes
  // from, when it was last reconfirmed / saved (ms), and a pause the player
  // itself reported.
  source?: string;
  elapsedFrozen?: boolean;
  reportedAtTimestamp?: number;
  paused?: boolean;
  playingUntilTimestamp?: number;
  // Where playback stands (ms), and when it stood there (live rows), for the
  // banner's "About 41:12 of 1:06:30".
  lastPosition?: number | null;
  totalDuration?: number | null;
  positionAt?: number | null;
  // Estimated from when it started and the title's runtime (the app hasn't said).
  positionEstimated?: boolean;
  durationEstimated?: boolean;
  // Resume links once it is paused (Stremio and Nuvio).
  stremioAppUrl?: string;
  nuvioAppUrl?: string;
}

/** One entry of Recently watched: a film, or back-to-back episodes of one show. */
export interface RecentlyWatchedGroup {
  id: string;
  type: 'movie' | 'series';
  name: string;
  poster: string | null;
  season: number | null;
  fromEpisode: number | null;
  toEpisode: number | null;
  count: number;
  watchedAt: string;
}

export interface UserActivityData {
  sessions: WatchSession[];
  episodeHistory: WatchSession[];
  stats: UserActivityStats;
  watchTimeByDay: WatchTimeByDay[];
  nowPlaying: NowPlayingItem[];
  mostWatched: MostWatchedItem | null;
  /** Top five, most watched first. */
  mostWatchedList?: MostWatchedItem[];
  recentlyWatched?: RecentlyWatchedGroup[];
  /** The Nuvio (or AIOStreams) profile they watch under, if known. */
  profileLabel?: string | null;
  bingeWatches: BingeWatch[];
  user: {
    id: string;
    username: string;
    email: string;
    colorIndex?: number;
  };
}

// Activity API
export const userActivity = {
  /**
   * Get user's activity (watch sessions and stats)
   */
  async getActivity(userId: string, authKey?: string, limit = 100): Promise<UserActivityData> {
    const params = new URLSearchParams({ userId, limit: String(limit) });
    return request(`/public-library/activity?${params.toString()}`, { authKey });
  },
};

// Data export
export interface UserExportData {
  exportedAt: string;
  user: { username: string; email: string };
  movieHistory: { itemId: string; itemName: string; poster: string | null; watchedAt: string }[];
  episodeHistory: {
    showId: string;
    showName: string;
    videoId: string;
    season: number | null;
    episode: number | null;
    poster: string | null;
    watchedAt: string;
  }[];
  watchlist: { itemId: string; itemType: string; name: string; poster: string | null; addedAt: string }[];
}

export const userExport = {
  /**
   * Download this user's own watch history + household watchlist as JSON
   */
  async getExport(userId: string, authKey?: string): Promise<UserExportData> {
    const params = new URLSearchParams({ userId });
    return request(`/public-library/export?${params.toString()}`, { authKey });
  },
};

// Sync API
export interface AtRiskStatus {
  userId: string;
  riskLevel: 'healthy' | 'warning' | 'critical';
  riskReason: string | null;
  lastActivity: string | null;
  daysSinceActivity: number | null;
  syncStatus: string | null;
  syncErrorMessage: string | null;
  lastSyncedAt: string | null;
}

export const userSync = {
  /**
   * Sync user's addons
   */
  async sync(userId: string, authKey?: string): Promise<{ success: boolean; message: string; details?: any }> {
    return request('/public-library/sync', {
      method: 'POST',
      body: JSON.stringify({ userId }),
      authKey,
    });
  },

  /**
   * Get user's at-risk status
   */
  async getAtRiskStatus(userId: string, authKey?: string): Promise<AtRiskStatus> {
    const params = new URLSearchParams({ userId });
    return request(`/public-library/at-risk-status?${params.toString()}`, { authKey });
  },
};

// Library API
export const userLibrary = {
  /**
   * Get user's library
   */
  async getLibrary(userId: string, authKey?: string): Promise<{
    library: LibraryItem[];
    count: number;
  }> {
    const params = new URLSearchParams({ userId });
    // Pass requestingUserId as same user to indicate self-access
    params.append('requestingUserId', userId);
    return request(`/public-library/library?${params.toString()}`, { authKey });
  },

  /**
   * Delete a library item
   */
  async deleteItem(userId: string, itemId: string, authKey?: string): Promise<{ success: boolean }> {
    const params = new URLSearchParams({ userId });
    params.append('requestingUserId', userId);
    return request(`/public-library/library/${encodeURIComponent(itemId)}?${params.toString()}`, {
      method: 'DELETE',
      authKey,
    });
  },
};

// Addons API
export const userAddons = {
  /**
   * Get user's addons (group addons and Stremio addons)
   */
  async getAddons(userId: string, authKey?: string): Promise<{
    groupAddons: GroupAddon[];
    stremioAddons: StremioAddon[];
    excludedAddonIds: string[];
    protectedAddonNames: string[];
  }> {
    const params = new URLSearchParams({ userId });
    return request(`/public-library/addons?${params.toString()}`, { authKey });
  },

  /**
   * Add an addon to Stremio and protect it
   */
  async addAddon(userId: string, addonUrl: string, manifestData?: any, authKey?: string): Promise<{
    success: boolean;
    message: string;
  }> {
    return request('/public-library/add-addon', {
      method: 'POST',
      body: JSON.stringify({ userId, addonUrl, manifestData }),
      authKey,
    });
  },

  /**
   * Exclude a group addon (don't sync to user)
   */
  async excludeAddon(userId: string, addonId: string, authKey?: string): Promise<{ success: boolean }> {
    return request('/public-library/exclude-addon', {
      method: 'POST',
      body: JSON.stringify({ userId, addonId }),
      authKey,
    });
  },

  /**
   * Include a group addon (sync to user)
   */
  async includeAddon(userId: string, addonId: string, authKey?: string): Promise<{ success: boolean }> {
    return request('/public-library/include-addon', {
      method: 'POST',
      body: JSON.stringify({ userId, addonId }),
      authKey,
    });
  },

  /**
   * Toggle addon protection status
   */
  async toggleProtect(userId: string, addonName: string, unsafe = false, authKey?: string): Promise<{
    success: boolean;
    protected: boolean;
  }> {
    return request(`/public-library/protect-addon${unsafe ? '?unsafe=true' : ''}`, {
      method: 'POST',
      body: JSON.stringify({ userId, name: addonName }),
      authKey,
    });
  },

  /**
   * Remove an addon from Stremio
   */
  async removeAddon(userId: string, addonName: string, unsafe = false, authKey?: string): Promise<{
    success: boolean;
  }> {
    return request(
      `/public-library/stremio-addons/${encodeURIComponent(addonName)}?userId=${userId}${unsafe ? '&unsafe=true' : ''}`,
      { method: 'DELETE', authKey }
    );
  },
};

// Shares API
export const userShares = {
  /**
   * Get user's shares (sent and received)
   */
  async getShares(userId: string, authKey?: string): Promise<{ sent: Share[]; received: Share[] }> {
    const params = new URLSearchParams({ userId });
    return request(`/public-library/shares?${params.toString()}`, { authKey });
  },

  /**
   * Get group members for sharing
   */
  async getGroupMembers(userId: string, authKey?: string): Promise<{ members: GroupMember[] }> {
    const params = new URLSearchParams({ userId });
    return request(`/public-library/group-members?${params.toString()}`, { authKey });
  },

  /**
   * Share items with other users
   */
  async shareItems(
    userId: string,
    items: Array<{ itemId: string; itemName?: string; itemType?: string; poster?: string }>,
    targetUserIds: string[]
  ): Promise<{ success: boolean; shareCount: number }> {
    return request(`/users/${userId}/shares`, {
      method: 'POST',
      body: JSON.stringify({ items, targetUserIds }),
    });
  },

  /**
   * Remove a share
   */
  async removeShare(userId: string, shareId: string): Promise<{ success: boolean }> {
    return request(`/users/${userId}/shares/${shareId}`, { method: 'DELETE' });
  },

  /**
   * Mark a share as viewed
   */
  async markAsViewed(userId: string, shareId: string): Promise<{ success: boolean }> {
    return request(`/users/${userId}/shares/${shareId}/viewed`, { method: 'PUT' });
  },
};

/**
 * Notifications on the person's own devices (PersonPushSubscription on the
 * server) - off until they turn them on, and never the admin's devices.
 */
/** Whether this person is paused right now by a daily limit or bedtime. */
export async function getOwnScreenTime(userId: string, authKey: string): Promise<{ paused: { untilLabel: string; reason: 'limit' | 'bedtime' } | null }> {
  return request(`/public-library/screen-time?${new URLSearchParams({ userId })}`, { authKey });
}

export const userPush = {
  async status(userId: string, authKey: string, endpoint?: string): Promise<{ enabled: boolean; publicKey: string | null; subscribed: boolean }> {
    const q = new URLSearchParams({ userId, ...(endpoint ? { endpoint } : {}) });
    return request(`/public-library/push/status?${q}`, { authKey });
  },
  async subscribe(userId: string, authKey: string, subscription: PushSubscriptionJSON): Promise<{ success: boolean }> {
    return request('/public-library/push/subscribe', {
      method: 'POST',
      authKey,
      body: JSON.stringify({ userId, subscription, userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null }),
    });
  },
  async unsubscribe(userId: string, authKey: string, endpoint: string): Promise<{ success: boolean }> {
    return request('/public-library/push/unsubscribe', { method: 'POST', authKey, body: JSON.stringify({ userId, endpoint }) });
  },
  /** Every device that gets this person's alerts. `endpoint` (this browser's own) marks which one is "this device". */
  async devices(userId: string, authKey: string, endpoint?: string): Promise<{ devices: PersonPushDevice[] }> {
    return request('/public-library/push/devices', { method: 'POST', authKey, body: JSON.stringify({ userId, endpoint }) });
  },
  async renameDevice(userId: string, authKey: string, id: string, label: string): Promise<{ success: boolean }> {
    return request(`/public-library/push/devices/${encodeURIComponent(id)}`, { method: 'PATCH', authKey, body: JSON.stringify({ userId, label }) });
  },
  async removeDevice(userId: string, authKey: string, id: string): Promise<{ success: boolean }> {
    return request(`/public-library/push/devices/${encodeURIComponent(id)}`, { method: 'DELETE', authKey, body: JSON.stringify({ userId }) });
  },
};

export interface PersonPushDevice {
  id: string;
  label: string | null;
  userAgent: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  /** This browser's own registration. */
  current: boolean;
}

/** The person's own picture. */
export const userAvatar = {
  async update(userId: string, authKey: string, change: { avatarUrl?: string | null; colorIndex?: number }): Promise<{ success: boolean; avatarUrl: string | null; colorIndex: number }> {
    return request('/public-library/avatar', { method: 'PATCH', authKey, body: JSON.stringify({ userId, ...change }) });
  },
  /** Uploads a picture and makes it theirs in one step. */
  async upload(userId: string, authKey: string, file: File): Promise<{ success: boolean; avatarUrl: string }> {
    const form = new FormData();
    form.append('avatar', file);
    const response = await fetch(`${API_BASE}/public-library/avatar/upload?${new URLSearchParams({ userId })}`, {
      method: 'POST',
      headers: { 'x-stremio-auth': authKey },
      body: form,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Upload failed' }));
      throw new UserApiError(error.message || `HTTP ${response.status}`, response.status);
    }
    return response.json();
  },
  /** nuvio.tv's cover gallery - a Nuvio sign-in only. */
  async nuvioCovers(userId: string, authKey: string, opts: { page?: number; search?: string } = {}): Promise<NuvioCoversPage> {
    const q = new URLSearchParams({ userId, limit: '24', sort: 'recent' });
    if (opts.page) q.set('page', String(opts.page));
    if (opts.search) q.set('search', opts.search);
    return request(`/public-library/nuvio-covers?${q}`, { authKey });
  },
};

export interface NuvioCoversPage {
  items: { id: number; image_url: string; title: string }[];
  pagination?: { hasNextPage?: boolean };
}

/** Moving between the profiles of one's own Nuvio login. */
export interface NuvioProfileTile {
  id: string;
  name: string;
  profileNumber: number;
  avatarUrl: string | null;
  colorIndex: number;
  current: boolean;
  needsReconnect: boolean;
}
export const userNuvioProfiles = {
  async list(userId: string, authKey: string): Promise<{ profiles: NuvioProfileTile[] }> {
    return request(`/public-library/nuvio-profiles?${new URLSearchParams({ userId })}`, { authKey });
  },
  async switchTo(userId: string, authKey: string, targetId: string): Promise<{ userId: string; sessionToken: string; user: Partial<UserInfo> & { id: string } }> {
    return request('/public-library/switch-nuvio-profile', { method: 'POST', authKey, body: JSON.stringify({ userId, targetId }) });
  },
};

/** The person's own Continue Watching row. */
export interface ContinueWatchingCardData {
  showId: string;
  contentType: 'series' | 'movie';
  name: string;
  poster: string | null;
  background: string | null;
  thumbnail: string | null;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
  resume: boolean;
  progressPercent: number | null;
  remainingMinutes: number | null;
  lastWatchedAt: string;
  providerType: string;
  /** Nuvio: the profile it is watched under. */
  profileLabel?: string | null;
  /** Opens their app on the title - Stremio and Nuvio only. */
  appUrl: string | null;
  /** The title's page. */
  webUrl: string | null;
}
export interface UpcomingEpisodeItem {
  showId: string;
  showName: string | null;
  poster: string | null;
  season: number;
  episode: number;
  title: string | null;
  airDate: string;
}
export const userUpcoming = {
  async list(userId: string, authKey: string): Promise<{ items: UpcomingEpisodeItem[] }> {
    return request(`/public-library/upcoming?${new URLSearchParams({ userId })}`, { authKey });
  },
};

/** How this person arranged their own Home (lib/arrange.tsx). */
export const userHomeArrange = {
  async get(userId: string, authKey: string): Promise<{ arrange: import('./arrange-core').Arrangement | null }> {
    return request(`/public-library/home-arrange?${new URLSearchParams({ userId })}`, { authKey });
  },
  async save(userId: string, authKey: string, arrange: import('./arrange-core').Arrangement | null): Promise<{ arrange: unknown }> {
    return request('/public-library/home-arrange', { method: 'PUT', authKey, body: JSON.stringify({ userId, arrange }) });
  },
};

export const userContinueWatching = {
  async list(userId: string, authKey: string): Promise<{ items: ContinueWatchingCardData[] }> {
    return request(`/public-library/continue-watching?${new URLSearchParams({ userId })}`, { authKey });
  },
  async dismiss(userId: string, authKey: string, showId: string): Promise<{ success: boolean }> {
    return request('/public-library/continue-watching/dismiss', { method: 'POST', authKey, body: JSON.stringify({ userId, showId }) });
  },
};

/**
 * "Resume in your app" on a Continue Watching card: the person's own server,
 * user id and the title's id there (what lib/openWith.ts builds links from),
 * and - on a real Jellyfin - their own devices to start it on.
 */
export const userOpenTargets = {
  async get(userId: string, authKey: string, id: string, type: 'movie' | 'series'): Promise<import('./openWith').OpenTargets> {
    return request(`/public-library/open-targets?${new URLSearchParams({ userId, id, type })}`, { authKey });
  },
  async playOn(userId: string, authKey: string, body: { sessionId: string; itemId: string }): Promise<{ success: boolean }> {
    return request('/public-library/open-targets/play-on', { method: 'POST', authKey, body: JSON.stringify({ userId, ...body }) });
  },
};

/**
 * The person's own API key. Their sign-in goes in the header like every other
 * call here - never the address, which ends up in access logs and history.
 */
export async function getUserApiKey(userId: string, authKey: string): Promise<{ hasKey: boolean; apiKey: string | null }> {
  return request(`/public-library/user-api-key?${new URLSearchParams({ userId })}`, { authKey });
}

// Convenience export
export const userApi = {
  oauth: userOAuth,
  auth: userAuth,
  library: userLibrary,
  activity: userActivity,
  addons: userAddons,
  shares: userShares,
  sync: userSync,
  export: userExport,
};

/** What one watch-history file holds, or what importing it did. */
export interface HistoryImportFileResult {
  /** Preview only: true. */
  dryRun?: boolean;
  /** Titles put in (preview: that would be). */
  added: number;
  /** Titles the person already had. */
  alreadyThere: number;
  skipped: number;
  skippedEpisodes: number;
  totalRows: number;
  truncated: boolean;
  unresolvedTitles: string[];
  /** Titles with no IMDb id past the household's lookup allowance were left unresolved. */
  lookupsCapped: boolean;
  /** Preview only: the first titles that would be added. */
  titles?: { id: string; name: string; watchedAt: string }[];
  /** Preview only: every title that would be added / is already there, to add several files up exactly. */
  ids?: string[];
  existingIds?: string[];
}

/** The person's own watch-history import: a preview, then the import. Their own history only. */
export const userHistoryImport = {
  async send(kind: 'preview' | 'import', userId: string, authKey: string, file: File): Promise<HistoryImportFileResult> {
    const form = new FormData();
    form.append('file', file);
    const route = kind === 'preview' ? '/public-library/history-import/preview' : '/public-library/history-import';
    const response = await fetch(`${API_BASE}${route}?${new URLSearchParams({ userId })}`, {
      method: 'POST',
      headers: { 'x-stremio-auth': authKey },
      body: form,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Import failed' }));
      throw new UserApiError(error.message || error.error || `HTTP ${response.status}`, response.status);
    }
    return response.json();
  },
};
