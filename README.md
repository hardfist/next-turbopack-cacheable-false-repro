# Turbopack ignores `this.cacheable(false)` on unrelated recompilations

A minimal Next.js development-server reproduction with a webpack control.

On Next.js **16.4.3** and **16.5.0-canary.32**, webpack reruns a loader marked `this.cacheable(false)` when another imported module changes. Turbopack keeps its original loader result. Editing the loader's own input refreshes the result in both bundlers.

## Reproduce

Use Node.js 20.9 or later on macOS or Linux. The runner uses POSIX process groups to stop its development servers.

```sh
npm ci
npm run repro
```

The lockfile pins Next.js 16.4.3 and React 19.2.0. To run the tested canary without changing the lockfile:

```sh
npm install --no-save --package-lock=false next@16.5.0-canary.32
npm run repro
```

To return to the pinned stable version, run `npm ci`.

The runner starts webpack and Turbopack sequentially on free loopback ports, polls the API response until the edited module is visible, and records each phase. It stops the servers and restores the edited fixtures. Run one copy at a time. The runner removes this reproduction's `.next` and `.repro` directories before each bundler.

`npm run repro` succeeds when the controls and direct-input invalidation checks pass. It prints whether each bundler honors `cacheable(false)` and writes the observations to `results/<installed-next-version>/`.

For an assertion of webpack-compatible behavior:

```sh
npm run test:contract
```

This command is expected to exit **1** on the tested versions because Turbopack does not refresh the non-cacheable loader. It saves the report before failing.

## Experiment

[`pages/api/probe.js`](pages/api/probe.js) imports three `.probe` files and a separate `trigger.js` module. The same [`probe.cjs`](loaders/probe.cjs) loader handles all three files:

| Input | Cache declaration |
| --- | --- |
| `no-cache.probe` | `this.cacheable(false)` |
| `cacheable.probe` | `this.cacheable(true)` |
| `default.probe` | No call to `cacheable` |

Each invocation reads `.repro/external.txt` with Node's `fs.readFileSync`, exports its value, and appends an invocation record to `.repro/loader.jsonl`. The external file is deliberately **not** registered with `addDependency`. This makes the explicit opt-out observable.

The `cacheable(true)` and default variants deliberately use that same unregistered input as negative controls. They are not examples of correctly written cacheable loaders. The experiment tests the effect of the opt-out while holding the loader implementation constant.

The runner performs these steps:

1. Request `/api/probe` with the external value set to `external-v1`.
2. Change only the external file to `external-v2`. Request the API again and verify that no new value is served. `cacheable(false)` does not mean rerunning on every HTTP request.
3. Set the external value to `external-v3` and edit the imported `trigger.js`. Wait until the API returns `trigger-1` before inspecting the loader output.
4. Repeat with `external-v4` and `trigger-2`.
5. Set the external value to `external-v5` and edit all three `.probe` inputs. Verify that all three outputs refresh.

## Observed result

Both tested Next.js versions produced this result:

| Phase | Current external value | webpack, `cacheable(false)` | Turbopack, `cacheable(false)` |
| --- | --- | --- | --- |
| Initial request | v1 | v1 | v1 |
| External file only | v2 | v1 | v1 |
| Unrelated edit 1 | v3 | v3 | **v1** |
| Unrelated edit 2 | v4 | v4 | **v1** |
| Direct input edit | v5 | v5 | v5 |

After the two unrelated edits, the non-cacheable loader's invocation count was **3** under webpack and **1** under Turbopack, including the initial invocation. The API already returned `trigger-2`, so this was not an HTTP response cached before the edit. Both cacheable controls kept v1 until their own inputs changed.

Raw evidence is committed for each version:

- [Next.js 16.4.3 report](results/16.4.3/report.json).
- [Next.js 16.5.0-canary.32 report](results/16.5.0-canary.32/report.json).
- Each report directory also contains the server logs and loader invocation records for both bundlers.

The reports record the actual Node.js, Next.js, React, OS, and architecture. Extra loader invocations during direct input edits are recorded without an exactly-once assertion.

## Expected behavior and scope

The [webpack loader contract](https://webpack.js.org/api/loaders/#thiscacheable) says that `this.cacheable(false)` marks the entire module's build result as non-cacheable, so subsequent compilations rebuild it even when its inputs and dependencies have not changed.

This reproduction tests that behavior in `next dev`. It does not test `next build`, persistent-cache restores, browser HMR, every loader API, or arbitrary side-effect guarantees.

Source inspection is consistent with the observation. At Next.js source commit `299c2f48d3b5dd7d7e8e2fcb1b14a6912bfed397`, the [Turbopack loader-runner callback](https://github.com/vercel/next.js/blob/299c2f48d3b5dd7d7e8e2fcb1b14a6912bfed397/turbopack/crates/turbopack-node/js/src/transforms/webpack-loaders.ts#L583-L667) forwards dependencies and transformed source, but does not consume `result.cacheable`. That source snapshot is context, not a claim that either tested npm package exactly matches that commit.
