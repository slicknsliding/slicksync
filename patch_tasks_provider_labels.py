path = "client/app/(admin)/tasks/page.tsx"

with open(path, "r", encoding="utf-8") as f:
    content = f.read()

changes = 0

# --- 1. Library selector <option> labels ---
old = """                  <option value="">Select a user...</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name || user.email || user.id}
                    </option>
                  ))}"""
new = """                  <option value="">Select a user...</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name || user.email || user.id} ({user.providerType === 'nuvio' ? 'Nuvio' : 'Stremio'})
                    </option>
                  ))}"""
c = content.count(old)
if c == 1:
    content = content.replace(old, new)
    changes += 1
    print("patched: library <option> labels")
else:
    print(f"WARNING: library <option> block matched {c} times, skipped")

# --- 2. History selector <option> labels ---
old = """                  <option value="all">All Users</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name || user.email || user.id}
                    </option>
                  ))}"""
new = """                  <option value="all">All Users</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name || user.email || user.id} ({user.providerType === 'nuvio' ? 'Nuvio' : 'Stremio'})
                    </option>
                  ))}"""
c = content.count(old)
if c == 1:
    content = content.replace(old, new)
    changes += 1
    print("patched: history <option> labels")
else:
    print(f"WARNING: history <option> block matched {c} times, skipped")

# --- 3. Library preview card: real avatar + provider badge ---
old = """              const user = users.find(u => u.id === selectedUserId);
              if (!user) return null;
              return (
                <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg border border-default bg-subtle">
                  <UserAvatar userId={user.id} name={user.name || user.email || 'U'} email={user.email} size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-default truncate">{user.name || user.email || user.id}</p>
                    {user.email && user.name && (
                      <p className="text-xs text-muted truncate">{user.email}</p>
                    )}
                  </div>
                </div>
              );"""
new = """              const user = users.find(u => u.id === selectedUserId);
              if (!user) return null;
              return (
                <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg border border-default bg-subtle">
                  <UserAvatar userId={user.id} name={user.name || user.email || 'U'} email={user.email} colorIndex={user.colorIndex} src={user.avatarUrl || undefined} size="sm" />
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-default truncate">{user.name || user.email || user.id}</p>
                      {user.email && user.name && (
                        <p className="text-xs text-muted truncate">{user.email}</p>
                      )}
                    </div>
                    <Badge variant={user.providerType === 'nuvio' ? 'nuvio' : 'stremio'} size="sm">
                      {user.providerType === 'nuvio' ? 'Nuvio' : 'Stremio'}
                    </Badge>
                  </div>
                </div>
              );"""
c = content.count(old)
if c == 1:
    content = content.replace(old, new)
    changes += 1
    print("patched: library preview card")
else:
    print(f"WARNING: library preview block matched {c} times, skipped")

# --- 4. History preview card: real avatar + provider badge ---
old = """              const user = users.find(u => u.id === selectedHistoryUserId);
              if (!user) return null;
              return (
                <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg border border-default bg-subtle">
                  <UserAvatar userId={user.id} name={user.name || user.email || 'U'} email={user.email} size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-default truncate">{user.name || user.email || user.id}</p>
                    {user.email && user.name && (
                      <p className="text-xs text-muted truncate">{user.email}</p>
                    )}
                  </div>
                </div>
              );"""
new = """              const user = users.find(u => u.id === selectedHistoryUserId);
              if (!user) return null;
              return (
                <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg border border-default bg-subtle">
                  <UserAvatar userId={user.id} name={user.name || user.email || 'U'} email={user.email} colorIndex={user.colorIndex} src={user.avatarUrl || undefined} size="sm" />
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-default truncate">{user.name || user.email || user.id}</p>
                      {user.email && user.name && (
                        <p className="text-xs text-muted truncate">{user.email}</p>
                      )}
                    </div>
                    <Badge variant={user.providerType === 'nuvio' ? 'nuvio' : 'stremio'} size="sm">
                      {user.providerType === 'nuvio' ? 'Nuvio' : 'Stremio'}
                    </Badge>
                  </div>
                </div>
              );"""
c = content.count(old)
if c == 1:
    content = content.replace(old, new)
    changes += 1
    print("patched: history preview card")
else:
    print(f"WARNING: history preview block matched {c} times, skipped")

if changes == 4:
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("=== ALL 4 PATCHES APPLIED, file written ===")
else:
    print(f"=== only {changes}/4 patches applied — file NOT written, investigate warnings above ===")
