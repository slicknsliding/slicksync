# Contributing to SlickSync

Thanks for wanting to help. SlickSync is a small project, so a short, focused pull request is the easiest kind to review.

## Before you start

- **Bug?** Open a [bug report](https://github.com/slicknsliding/slicksync/issues/new?template=bug_report.yml).
- **Idea?** Open a [feature request](https://github.com/slicknsliding/slicksync/issues/new?template=feature_request.yml) first, so we can agree on the shape before you spend time on it.
- **Stuck?** Use the [question form](https://github.com/slicknsliding/slicksync/issues/new?template=question.yml).
- **Vulnerability?** Don't open an issue. See [SECURITY.md](./SECURITY.md).

## Branches

Pull requests go against `beta`. New work is tried there first and promoted to `main` once it has been tested.

## Setting up

You need [Bun](https://bun.sh).

```bash
git clone https://github.com/slicknsliding/slicksync.git
cd slicksync
cp env.example .env
bun install
bun run dev:private
```

## Before you open the pull request

```bash
bun run test
bun run lint
```

The same two checks run automatically on every pull request.

## What makes a good pull request

- One change per pull request, with a description a user could read.
- If people will see the change (layout, spacing, buttons, wording), include a screenshot of it on a phone-width and a desktop-width window.
- A feature updates its in-app guide in the same pull request.
- Works on every provider it touches: Nuvio, Stremio, Jellyfin, AIOStreams and AIOMetadata.
- No passwords, keys, real hostnames, email addresses or other personal data anywhere: code, tests, screenshots or examples. Use placeholders such as `your-domain.example`.

## License

By contributing you agree that your contribution is released under the project's [MIT license](./LICENSE).
