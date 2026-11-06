# reti-ghost-sdk — dtalgorand branch

Fast Reti SDK that utilizes [ghost contracts](https://github.com/d13co/ghostkit) to batch fetch data.

**Status: Experimental.** This is the `dtalgorand` branch: a prerelease line of the SDK (`0.3.0-dt.*`, released to npm under the `beta` dist-tag) that can read the Reti registry as of any round since it was created, on a dtalgorand node. The stable SDK (`0.2.x`, dist-tag `latest`) lives on `main`.

**For SDK usage, see [`projects/sdk/README.md`](projects/sdk/README.md).**

## About this fork

Algorand's algod only serves the latest state, so a stock node can't answer "what did the registry look like at round R?". [dtalgorand](https://github.com/d13co/dt-algorand) is a fork of go-algorand that can: it simulates transactions as of a past round, and indexes when each box, account, app and asset changed. This branch builds the Reti SDK on top of it, so an app (the Reti UI's time travel) can render any page as of a past round, plus date → round lookups, change timelines and chart series.

Doing that needs a fork at every layer under the SDK. All of the forks are on npm:

| Layer | Fork | Version | Source | What it adds |
|---|---|---|---|---|
| Node | dtalgorand (go-algorand) | `v5.0.5-dt5` | [d13co/dt-algorand](https://github.com/d13co/dt-algorand), branch `dtalgorand` | Simulate at a past round, several groups per request (one round each; reads across rounds, or under the latest protocol, go through queries); `GET /v2/capabilities` (simulate and query limits, time travel); `/versions` change feeds for boxes, accounts, apps and assets; read-only TEAL queries (`POST /v2/query`) |
| algosdk | `dt-algosdk` | `3.9.0-dt.5.2.0.0` | fork of [algorand/js-algorand-sdk](https://github.com/algorand/js-algorand-sdk), branch `dtalgorand` | `DTAlgodClient`: past-round reads (checked against the node's `X-Algod-TT-Round` header), box and app versions, the extended simulate, the node's capabilities, `DTAlgodClient.query`; versions as of rounds, changed keys and key/prefix filters, asset holders; a fix for decoding ABI values from byte views |
| algokit-utils | `@d13co/dt-algokit-utils` | `9.2.3-dt.5.2.0.0` | fork of [algorandfoundation/algokit-utils-ts](https://github.com/algorandfoundation/algokit-utils-ts), branch `dtalgorand` | `algorand.dt`: detects a dtalgorand node and runs the composer's simulate through the extended simulate at a round, following the node's limits; `algorand.query`: runs composers' app calls as queries with a simulate fallback, chunked by the node's limits; request cancellation with an `AbortSignal`; versions iterators with key filters and rounds, asset holders; one retry policy for busy nodes, rate limits and network errors, which skips what a retry can't fix |
| ghostkit | `ghostkit` | `0.1.0-dt.8` | [d13co/ghostkit](https://github.com/d13co/ghostkit), tag `v0.1.0-dt.8` | Node detection from `GET /v2/capabilities` (one check tells a dtalgorand node from stock algod), a dtalgorand simulate backend, a query backend (the `auto` default when the node has queries), `prefetch()`, AVM 13, 4 KB app args, chunk tags that survive puya-ts, log decoding that copes with byte views, aborts that reject with the reason on every backend, `ghostkitChangeRounds`, and a build that refuses to run with a ghostkit other than the project's. Build time only: the generated SDK inlines its runtime |

On top of those, this branch changes the SDK itself:

- **Reader contract** (`projects/contracts/`): new read-only reader methods (registry, validator and pool totals, pool states, staker positions, account balances, asset holdings, round timestamps and a round scan for date lookups), each item one log so reads chunk to the node's limits. Ids not created yet at a round read as zeros instead of failing the simulate.
- **SDK** (`projects/sdk/`): reads go through read-only queries when the node has them, else simulate; every read takes `{ round }` (or `sdk.atRound(round)`) and an `AbortSignal`; `roundAt` / `timestampOf`; `getChangeRounds` timelines; series reads over many rounds; a staker's deposit and withdrawal history across every pool they were ever in; clear errors for rounds before the registry, past the node's tip, or too old for a stock node.

It still works against any algod for the latest state. With stock algosdk and algokit-utils, or on a stock node, reads at older rounds throw `TimeTravelUnavailableError`.

Workspace-wide `overrides` in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) make every package here use the forks of algosdk and algokit-utils from npm, so only one copy of each loads. A consumer needs the same; see the SDK README's Install section.

## Development Installation

For SDK development, run at project root:

```
algokit bootstrap all
```

Node.js 22+ is required (upstream puya-ts requirement, and the algokit-utils fork).

## Development Build

Run at project root:

```
algokit project run build
```

## Releasing a beta

The dt line is released to npm under the `beta` dist-tag: `npm install reti-ghost-sdk@beta` gets the latest dt release, and `npm install reti-ghost-sdk` keeps getting the stable SDK (`latest`, from `main`). Versions keep their `0.3.0-dt.N` names.

GitHub Actions does the release, with [`.github/workflows/dt.yml`](.github/workflows/dt.yml). On every push and pull request to `dtalgorand` it builds the contracts (puya-ts and ghostkit, no AlgoKit CLI needed) and the SDK, fails if that changed any committed file (stale artifacts or generated clients), runs the tests, and checks the release metadata. On a `v0.3.0-dt.N` tag it also publishes the packed SDK to npm under `beta`, with provenance, and creates a GitHub prerelease with the tarball.

1. Bump `version` in `projects/sdk/package.json` to the next `0.3.0-dt.N`.
2. If a fork changed, update its exact version in the `overrides` in `pnpm-workspace.yaml` and in the `devDependencies` of `projects/contracts` and `projects/sdk` (ghostkit only in `projects/contracts`; prerelease versions don't match `^` ranges, so pin them exactly), then run `node scripts/ci/dt-release.mjs update`, which sets them in the SDK README's install snippet and the table above.
3. `algokit project run build`, `pnpm --filter reti-ghost-sdk test`, and `node scripts/ci/dt-release.mjs check`, which fails if the version, the dist-tag (`publishConfig.tag`) or any fork version disagree, or a dependency is a local `file:` path.
4. Commit, and merge to `dtalgorand` (a pull request whose Test check passes; repository admins can push directly). Then tag the commit on `dtalgorand` and push the tag: `git tag v0.3.0-dt.N` and `git push origin v0.3.0-dt.N`.
5. The workflow checks that the tag is on `dtalgorand` and matches the version (`node scripts/ci/dt-release.mjs check v0.3.0-dt.N` runs the same check locally), runs the tests again, and publishes with `npm publish --tag beta`. If the version is already on npm, it doesn't publish it again and only creates the GitHub release.

`projects/sdk`'s `prepublishOnly` refuses a dt version under any dist-tag but `beta`, so a publish by hand can't replace `latest` either.

### One-time setup

- **Rulesets.** `scripts/ci/apply-rulesets.sh` creates the rulesets in [`.github/rulesets/`](.github/rulesets/), or updates them by name: changes reach `dtalgorand` only through merged pull requests that pass the Test check and never by force push (repository admins can bypass it), `dtalgorand` can't be deleted, and `v*-dt.*` tags can't be moved or deleted. It needs `gh` logged in as a repository admin. `main` stays the default branch.
- **Trusted publisher.** The workflow publishes only through npm trusted publishing. `reti-ghost-sdk` is already on npm, so add the publisher in the package's settings on npmjs.com (Trusted publishing → GitHub Actions: owner `d13co`, repository `reti-ghost-sdk`, workflow `dt.yml`, environment `npm`, publishing allowed), or with npm 11.5.1 or later: `npm trust github reti-ghost-sdk --file dt.yml --repo d13co/reti-ghost-sdk --env npm --allow-publish`. npm drops a new trusted publisher if nothing is published with it within 2 days, so set it up when the first release is close. Trusted publishing adds provenance to each version, and needs no token.
- **Approval (optional).** The publish job runs in the GitHub environment `npm`, which GitHub creates on the first run. To approve each release by hand, add required reviewers to it under Settings → Environments.

## Usage

See [`projects/sdk/README.md`](projects/sdk/README.md).
