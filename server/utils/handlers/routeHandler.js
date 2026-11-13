/**
 * Common route handler patterns to reduce duplication
 */

/**
 * Wrapper for async route handlers with consistent error handling
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Create a standardized route handler with error handling
 */
function createRouteHandler(handler) {
  return asyncHandler(async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      console.error('Route handler error:', error);
      next(error);
    }
  });
}

/**
 * Common database transaction patterns
 */
class DatabaseTransactions {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Delete addon with all its relations
   */
  async deleteAddonWithRelations(addonId, accountId) {
    return await this.prisma.$transaction([
      this.prisma.groupAddon.deleteMany({ where: { addonId } }),
      this.prisma.addon.delete({ 
        where: { id: addonId, accountId }
      })
    ]);
  }
}

/**
 * Stremio API utilities
 */
class StremioAPIUtils {
  /**
   * Create standardized StremioAPIStore
   */
  static createAPIStore() {
    const { createStremioStore } = require('../helpers');
    return createStremioStore();
  }

  /**
   * Standardized Stremio authentication flow
   */
  static async authenticateWithStremio(email, password) {
    const { store, tempStorage } = this.createAPIStore();
    
    let authResult;
    let lastErr;
    
    for (const attempt of [
      () => store.login({ email, password }),
      () => store.login(email, password),
    ]) {
      try {
        authResult = await attempt();
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    
    if (!authResult && lastErr) {
      throw lastErr;
    }
    
    return { store, tempStorage, authResult };
  }
}

module.exports = {
  asyncHandler,
  createRouteHandler,
  DatabaseTransactions,
  StremioAPIUtils
};
