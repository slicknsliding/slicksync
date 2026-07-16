import re

# --- Fix 1: sync.js - order-insensitive addon comparison ---
path1 = "server/utils/sync.js"
with open(path1, "r", encoding="utf-8") as f:
    content1 = f.read()

old1 = """    const currentKeys = userAddons.map(fingerprint)
    const desiredKeys = desiredAddons.map(fingerprint)
    const isSynced = currentKeys.length === desiredKeys.length && currentKeys.every((k, i) => k === desiredKeys[i])"""

new1 = """    const currentKeys = userAddons.map(fingerprint)
    const desiredKeys = desiredAddons.map(fingerprint)
    // Order-insensitive comparison: sort both key lists first so pure reordering
    // (e.g. user reordered addons in the Stremio app) doesn't falsely report
    // "unsynced" - only an actual difference in the addon set should.
    const sortedCurrent = [...currentKeys].sort()
    const sortedDesired = [...desiredKeys].sort()
    const isSynced = sortedCurrent.length === sortedDesired.length && sortedCurrent.every((k, i) => k === sortedDesired[i])"""

count1 = content1.count(old1)
if count1 == 0:
    print("WARNING (sync.js): pattern not found, no change made")
elif count1 > 1:
    print(f"WARNING (sync.js): pattern found {count1} times, refusing to guess")
else:
    content1 = content1.replace(old1, new1)
    with open(path1, "w", encoding="utf-8") as f:
        f.write(content1)
    print("patched: server/utils/sync.js (order-insensitive sync comparison)")

# --- Fix 2: users.js - library export filename should reflect provider ---
path2 = "server/routes/users.js"
with open(path2, "r", encoding="utf-8") as f:
    content2 = f.read()

old2 = """      // Generate filename: Stremio-Library-{email/username}-{timestamp}.json
      const userIdentifier = user.email || user.username || 'user'
      const timestamp = lastModified || Date.now()
      const filename = `Stremio-Library-${userIdentifier}-${timestamp}.json`"""

new2 = """      // Generate filename: {Provider}-Library-{email/username}-{timestamp}.json
      const userIdentifier = user.email || user.username || 'user'
      const timestamp = lastModified || Date.now()
      const providerLabel = (user.providerType || 'stremio') !== 'stremio' ? 'Nuvio' : 'Stremio'
      const filename = `${providerLabel}-Library-${userIdentifier}-${timestamp}.json`"""

count2 = content2.count(old2)
if count2 == 0:
    print("WARNING (users.js): pattern not found, no change made")
elif count2 > 1:
    print(f"WARNING (users.js): pattern found {count2} times, refusing to guess")
else:
    content2 = content2.replace(old2, new2)
    with open(path2, "w", encoding="utf-8") as f:
        f.write(content2)
    print("patched: server/routes/users.js (library export filename reflects provider)")
