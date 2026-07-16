import re

files = [
    "prisma/schema.sqlite.prisma",
    "prisma/schema.postgresql.prisma",  # skipped if it doesn't exist
]

for path in files:
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
    except FileNotFoundError:
        print(f"skip (not found): {path}")
        continue

    if re.search(r"model Addon \{[^}]*\bposition\b", content, re.S):
        print(f"already has position: {path}")
        continue

    new_content = content.replace(
        "model Addon {",
        "model Addon {\n  position Int @default(0)",
        1,
    )

    if new_content == content:
        print(f"WARNING: 'model Addon {{' not found in {path}, no change made")
        continue

    with open(path, "w", encoding="utf-8") as f:
        f.write(new_content)
    print(f"patched: {path}")
