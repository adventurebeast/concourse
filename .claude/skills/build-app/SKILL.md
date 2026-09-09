---
name: build-app
description: Build, install, verify, and release Concourse's packaged macOS app. Use for build-app, local installation, or /release requests; use npm run dev for the development server.
---

# Build and release Concourse

Produce a verified app at `/Applications/Concourse.app`, record source and version
through a branch and PR, and complete the requested release workflow. Public macOS
artifacts must be built, Developer ID-signed, notarized, stapled, and verified by
GitHub Actions. Local installation and public publication are separate outcomes.

The current `scripts/release.mjs`, `scripts/install-local.mjs`,
`scripts/clean-build.mjs`, `.github/workflows/build-mac.yml`,
`.github/workflows/build-win.yml`, and `test/release-distribution-policy.test.mjs`
are authoritative. Do not bypass their distribution trust requirements.

## Prepare source and version

1. Inspect the working tree and preserve unrelated user changes. Work on a feature
   or release branch, never commit directly to `main`.
2. Run `npm run bump` once for a new release version. Verify `package.json` and
   `package-lock.json` agree. Build, pack, install, and release commands do **not**
   bump automatically; rebuilding an already selected version needs no second bump.
3. Run `npm run preflight` for the lint/test gate used by PR CI. Run
   `npm run smoke:application` to build and exercise an isolated profile/workspace
   with synthetic terminal input. Fix failures before continuing. This POSIX smoke
   requires a C compiler and does not establish Windows runtime compatibility.
4. Commit the intended changes and version bump with a `Co-Authored-By` trailer.
   Push the branch, create a PR, wait for CI green, and merge through the PR.
   Verify the intended source/version on the default branch before public tagging.

Local installation can proceed while PR checks run. Public publication waits for
reviewed, CI-green source to merge. The release script does not enforce this Git
workflow and its `gh release create` call does not pin an explicit target SHA.
Verify the default branch contains the intended release before creating its tag.

## Build and install

Use `npm run install:local` for local-only installation. Use `npm run release` for
an authorized release: it invokes the same installer before checking GitHub access
or distribution credentials. Running `npm run dist` first is unnecessary.

The installer runs preflight, vendors the optional llama runtime, cleans outputs,
builds with electron-vite, and packages `release/mac-arm64/Concourse.app`. Its
local-only overrides are `--config.mac.identity=-` and
`--config.mac.notarize=false`. This ad-hoc signature is for this Mac; never copy
these overrides into public build configuration or upload this local app as a
public installer.

The installer checks signature and version, uses `ditto` to stage a complete copy
in `/Applications`, clears that local copy's quarantine, and verifies it before
replacement. It moves the previous app to the user's Trash and restores it if
replacement fails. Do not manually delete the installed app.

`npm run clean` moves existing `out/` and `release/` directories into a unique
`.build-archive/<stamp>/` on the same filesystem. Archives are ignored by Git and
retained for recovery. Cleanup does not permanently remove them. Do not replace
this with recursive forced deletion or silently remove old archives.

If Concourse is already running, the installer preserves its processes/agents and
reports that a restart is needed. Replacing the bundle does not update already
loaded windows. Never terminate the user's agents to load a new build.

## Verify the packaged app

Verify installed signature/version and confirm a newly launched packaged instance
boots and stays alive. `npm run smoke` verifies the bundle version, creates a fresh
temporary profile, launches with `open -n` and `--user-data-dir`, compares new PIDs,
and checks fresh crash reports. This keeps profile locks, migrations, and shell
init cleanup separate from existing agents. The temporary profile is retained.

An old running process is not proof the new build booted. Preserve existing user
windows. The integrated application smoke and this
packaged boot check serve different purposes; compilation alone proves neither.

## Complete the public release

After local installation, `npm run release` checks GitHub authentication and these
five GitHub Actions secret **names**:

- `MAC_CSC_LINK`
- `MAC_CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Never print/request credential values in chat or place them in commands, notes, or
the repository. Missing authentication or secret names means local installation
succeeds and public publication is skipped. Report that distinction; do not upload
a workstation DMG or weaken signing requirements to claim completion.

With credentials and source/CI gates satisfied, the script creates or updates
release notes for `v<version>`. Its tag triggers native workflows. The macOS upload
must follow strict codesign verification, Developer ID authority verification,
notarization/stapling, Gatekeeper assessment, and DMG verification. Windows artifacts
come from the native Windows runner. Wait for the relevant workflows and verify
assets for the expected version before saying public downloads are ready.

```bash
npm run release -- --notes /absolute/path/to/release-notes.md
npm run release -- --draft
npm run release -- --dry-run
```

`--dry-run` previews notes without installing/publishing; previous-tag discovery
may still fetch a Git tag. `--draft` still installs locally and requires public
credentials. Re-running a version updates its notes; never move a published tag
to change its source.

Finish with the version, installed path/restart status, PR/CI outcome, packaged
smoke result, and either verified public assets or the reason publication skipped.
