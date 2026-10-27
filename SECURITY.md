# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** ([direct link](https://github.com/slicknsliding/slicksync/security/advisories/new)).
3. Describe what you found, how to reproduce it, and what it could let someone do.

Only the maintainer can see the report. You'll get a reply there, and a fix is released before the details are made public. You'll be credited in the advisory if you'd like.

## What helps

- The SlickSync version and install type (private, public, beta).
- The smallest set of steps that shows the problem.
- Whether it needs a signed-in user, and which kind.

Please don't include real passwords, keys or other people's data in a report.

## Supported versions

Fixes go into the latest release. Update with `docker compose -f docker-compose.private.yml pull && docker compose -f docker-compose.private.yml up -d` (use the public compose file for a public install).
