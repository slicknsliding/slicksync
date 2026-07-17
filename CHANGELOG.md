# Changelog

SlickSync's changelog lives in [`client/public/changelog.json`](./client/public/changelog.json)
and renders in the app under **Changelog** in the sidebar.

This file previously carried the changelog inherited from upstream
[Syncio](https://github.com/iamneur0/syncio). It stopped at `1.2.0`, and its
compare links pointed at a repository that doesn't exist. It's kept as a
pointer so it isn't mistaken for current.

## Cutting a release

Releases are cut by pushing a version tag — no release bot is involved:

1. Add an entry to the top of `client/public/changelog.json`.
2. Bump `version` in `package.json` to match.
3. Tag and push:

   ```bash
   git tag v1.9.76
   git push origin v1.9.76
   ```

Pushing a `v*.*.*` tag triggers [`private-release.yml`](./.github/workflows/private-release.yml)
and [`public-release.yml`](./.github/workflows/public-release.yml), which build
and push the Docker images to `ghcr.io/slicknsliding/slicksync`.
