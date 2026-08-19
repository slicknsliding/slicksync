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
   * Self-service "delete my account" - permanently removes this user and
   * their own data (watch history, watchlist state, group membership).
   * Does NOT touch account-wide resources (Vault, Catalogs, other users) -
   * that's the separate admin-level Settings > Danger Zone delete. Re-proves
   * the live session server-side, so Stremio users must pass their current
   * authKey; Nuvio users are re-validated by userId alone (mirrors validate/
   * validateNuvio above).
   */
  async deleteAccount(userId: string, provider: 'stremio' | 'nuvio', authKey?: string): Promise<{ deleted: boolean }> {
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
  };
  startTime: string;
  videoId?: string;
}

export interface UserActivityData {
  sessions: WatchSession[];
  episodeHistory: WatchSession[];
  stats: UserActivityStats;
  watchTimeByDay: WatchTimeByDay[];
  nowPlaying: NowPlayingItem[];
  mostWatched: MostWatchedItem | null;
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
  async getAtRiskStatus(userId: string): Promise<AtRiskStatus> {
    const params = new URLSearchParams({ userId });
    return request(`/public-library/at-risk-status?${params.toString()}`);
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
