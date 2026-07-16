path = "client/app/(admin)/tasks/page.tsx"

with open(path, "r", encoding="utf-8") as f:
    content = f.read()

old = "  const [selectedHistoryUserId, setSelectedHistoryUserId] = useState('all');"
new = old + """

  // Fetch users for the library/history export selectors (was never being loaded)
  useEffect(() => {
    api.getUsers()
      .then(setUsers)
      .catch((e: any) => {
        console.error('Failed to load users for Tasks selectors:', e);
      });
  }, []);"""

count = content.count(old)
if count == 0:
    print("WARNING: pattern not found, no change made")
elif count > 1:
    print(f"WARNING: pattern found {count} times, refusing to guess which one")
else:
    content = content.replace(old, new)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("patched: tasks/page.tsx (users list now fetched on mount)")
