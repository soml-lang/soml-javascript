# Maintaining

## Publish a new version

The [Release workflow](.github/workflows/release.yml) publishes the package with [trusted publishing](https://docs.npmjs.com/trusted-publishers), so there is no token to keep, and npm shows the provenance of each version. Set this up once on npmjs.com: in the package's settings, add a GitHub Actions trusted publisher with the owner `soml-lang`, the repository `soml-javascript`, the workflow `release.yml`, and no environment, and allow `npm publish`, which the workflow runs. The first release must be within 2 days, or the trusted publisher expires.

1. Bump the version: `npm version patch --no-git-tag-version` (or `minor` or `major`)
2. Commit and push: `git commit -am "1.2.3" && git push`
3. Run the Release workflow on `main` from the Actions tab, or with `gh workflow run release.yml`. It tests, publishes the package, and pushes the `v1.2.3` tag.
4. Create a release on GitHub.
