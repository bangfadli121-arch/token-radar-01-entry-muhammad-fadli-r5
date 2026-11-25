# Token Radar — Valuation Desk (round 5)

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/bangfadli121-arch/token-radar-01-entry-muhammad-fadli-r5/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/bangfadli121-arch/token-radar-01-entry-muhammad-fadli-r5/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for the [make.fun token-radar-01 bounty](https://make.fun/bounty/token-radar-01?ref=8y9pksda): 200 pre-token protocols ranked by fitted implied value, each with a 7-step farm plan. Referral: `8y9pksda`.

## The angle

The implied value is **fitted from the comps, at run time** — no hard-coded list, no hard-coded fitted numbers. `lib/model.ts` runs an OLS log-log regression on the snapshot's token-bearing protocols:

```
log10(mcap) = a + b·log10(TVL) + g·growth + catAdj[category] + ageCoef·(log10(age+1) − meanLogAge)
```

- **Comps:** 128 protocols with a positive market cap (of 144 token-recorded; 16 carry mcap ≤ 0 and cannot enter a log fit).
- **Category adjustments** only for categories with ≥5 comps; the rest ride the global intercept.
- **Age term** fitted in a second stage on the residuals of the dated comps.
- **Validation, shown honestly on the dashboard:** walk-forward folds (fit on older listings, test on newer ones) plus a 5-fold split, with R² out-of-sample and MAPE in log and level scales. The curve is a central tendency — individual tokens trade far around it, and the dashboard says so.
- **Size curve:** the fitted curve is drawn as an SVG with the comps scattered around it; every detail drawer shows where that protocol sits on the curve, its nearest neighbours by size, and the nearest comps with fitted-vs-actual.

## What it ships

- `main.ts` — Node 22, stdlib only. Reads `/input/snapshot.json`, writes `/output/board.json`, `/output/data.js`, copies `dashboard/` + `screenshots/`, writes `/output/dossier.json` via `vendor/makefun-board.ts`.
- `lib/model.ts` — the fit, the walk-forward validation, the board builder, the farm plans.
- `dashboard/` — `index.html` + `app.css` + `app.js`: navy-and-gold valuation desk. Sortable board (implied value, TVL, growth, age, implied/TVL, name), search + category/chain/watchlist filters, detail drawer per protocol with a live recompute of the model breakdown, live-token comps tab, model & calibration tab, CSV export, hash deep links (`#detail=<slug>`, `#filter=…`).
- `screenshots/` — board, detail, filtered view (1440×900).

## Run it locally

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Then open `out/dashboard/index.html`. The program runs twice in grading and both runs must be byte-identical — it is deterministic: no clocks, no randomness, no network.

## Notes

- A protocol on the board **records no token** in the snapshot; that is what the data says, never proof it has none.
- Implied value is this entry's own claim from the sealed snapshot, never a prediction that a token will be issued or what it will trade at.

## License

MIT — see `LICENSE`.
