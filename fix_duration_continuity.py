#!/usr/bin/env python3
"""
Fixes a duration-reset bug introduced by the title-grouping fix: seeking
creates a new connection with a new (later) startTime, and the group's
"representative" (freshest lastSeenAt) was also being used for startTime -
so "Watching for Xm" would drop back toward 0 after every seek instead of
counting continuously from when viewing actually began.

Fix: report the EARLIEST startTime across all connections in the group
(true original watch-start) as `startTime`/`watchedAt` for duration
purposes - but ALSO keep the most recent connection's own start time as a
separate `lastConnectionStartTime` field, rather than discarding it. Not
currently used by the frontend, but available if a future UI wants to show
something like "resumed 2m ago" alongside the total watch duration.

Run on WINDOWS, from inside the repo directory.
"""
import sys
from pathlib import Path

path = Path.cwd() / "server" / "utils" / "proxyNowPlaying.js"
if not path.exists():
    print(f"ERROR: {path} not found")
    sys.exit(1)

content = path.read_text(encoding="utf-8")

if "earliestStartTime" in content or "lastConnectionStartTime" in content:
    print(f"SKIP: {path} already fixed")
    sys.exit(0)

OLD = """    // Use the most recently active row in the group as the representative
    // for display fields (startTime, poster, etc.) - the freshest one is
    // most likely the real current connection, not a stale leftover.
    const representative = group.reduce((latest, p) =>
      p.lastSeenAt > latest.lastSeenAt ? p : latest
    )"""

if OLD not in content:
    print(f"ERROR: could not find the expected representative-selection block in {path}")
    sys.exit(1)

NEW = """    // Use the most recently active row in the group as the representative
    // for display fields (poster, displayName, liveness) - the freshest one
    // is most likely the real current connection, not a stale leftover.
    const representative = group.reduce((latest, p) =>
      p.lastSeenAt > latest.lastSeenAt ? p : latest
    )
    // Earliest startTime across the whole group is used for the reported
    // watch duration - a seek creates a new connection with a new (later)
    // startTime, and using the representative's own startTime alone would
    // make "Watching for Xm" reset toward 0 after every seek instead of
    // counting continuously from when viewing actually began. The
    // representative's own startTime is kept too (lastConnectionStartTime,
    // below) rather than discarded, in case a future UI wants to show
    // something like "resumed 2m ago" alongside the total duration.
    const earliestStartTime = group.reduce((earliest, p) =>
      p.startTime < earliest ? p.startTime : earliest
    , representative.startTime)"""

content = content.replace(OLD, NEW, 1)

content = content.replace(
    "watchedAt: representative.startTime.toISOString(),\n      watchedAtTimestamp: representative.startTime.getTime(),\n      startTime: representative.startTime,",
    "watchedAt: earliestStartTime.toISOString(),\n      watchedAtTimestamp: earliestStartTime.getTime(),\n      startTime: earliestStartTime,\n      // Most recent connection's own start time (e.g. when the last seek\n      // happened) - kept separately, not used for duration display.\n      lastConnectionStartTime: representative.startTime.toISOString(),"
)

path.write_text(content, encoding="utf-8")
print(f"OK: fixed duration continuity in {path}, keeping both start times available")
