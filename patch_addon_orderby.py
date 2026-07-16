path = "server/routes/addons.js"

with open(path, "r", encoding="utf-8") as f:
    content = f.read()

old = "orderBy: { id: 'asc' }"
new = "orderBy: [{ position: 'asc' }, { id: 'asc' }]"

count = content.count(old)
if count == 0:
    print("WARNING: pattern not found, no change made")
elif count > 1:
    print(f"WARNING: pattern found {count} times, refusing to guess which one — manual fix needed")
else:
    content = content.replace(old, new)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("patched: server/routes/addons.js (GET /addons now orders by position, falling back to id for ties)")
