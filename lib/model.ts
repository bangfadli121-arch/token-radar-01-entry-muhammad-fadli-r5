// Comps-fitted valuation model for token-radar-01, round 5.
//
// The model is fitted from the sealed snapshot alone, at run time, by main.ts:
// nothing about any protocol is hard-coded, no fitted number is written in
// advance. The fit is a log-log OLS regression of the token-bearing comps:
//
//   log10(mcap) = a + b * log10(tvl) + g * growth + sum(catAdj[category])
//                 + ageCoef * (log10(ageYears + 1) - meanLogAge)
//
// * comps: protocols whose record carries a positive market cap and TVL.
//   (16 token-recorded protocols carry mcap <= 0 and cannot enter a log fit;
//   they are counted and named in the dashboard, not silently dropped.)
// * growth is the 7-day TVL change, clamped to [-15, +15] per cent, in units
//   of 1.0 = 100%: one wild week must not outweigh the size curve, and the
//   fitted slope in this snapshot is negative (the week was broadly down),
//   so the clamp also bounds how far that slope can move any one protocol.
// * a category gets its own adjustment only when at least 5 comps share it;
//   every other category rides the global intercept.
// * the age term is fitted in a second stage: stage A fits the equation
//   above without age on all comps, stage B regresses stage A's residuals
//   on centred log10(ageYears + 1) over the comps that carry a listed_at
//   date. A protocol with no listed_at uses the comps' median age.
// * walk-forward validation: comps are ordered by listed_at; fold 1 fits
//   the earliest 50% and tests the next 25%, fold 2 fits the earliest 75%
//   and tests the last 25%. A 5-fold split (by md5 of slug) is reported too.
//   All validation numbers are computed here and shown on the dashboard.

import { createHash } from 'node:crypto';

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const GROWTH_LO = -15;
const GROWTH_HI = 15;
const CAT_MIN_COMPS = 5;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function clampGrowth(pct: number): number {
  return Math.min(GROWTH_HI, Math.max(GROWTH_LO, pct)) / 100;
}

function logAge(ageDaysValue: number | null, fallbackYears: number): number {
  const years = ageDaysValue === null ? fallbackYears : ageDaysValue / 365.25;
  return Math.log10(Math.max(0, years) + 1);
}

/** Solve (X'X + lam I) b = X'y by Gaussian elimination with partial pivoting. */
export function ols(design: number[][], target: number[], ridge = 1e-6): number[] {
  const n = design[0]!.length;
  const a: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      let s = 0;
      for (let k = 0; k < design.length; k++) s += design[k]![i]! * design[k]![j]!;
      return s + (i === j ? ridge : 0);
    }),
  );
  const b: number[] = Array.from({ length: n }, (_, i) => {
    let s = 0;
    for (let k = 0; k < design.length; k++) s += design[k]![i]! * target[k]!;
    return s;
  });
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!) ) piv = r;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    const d = m[c]![c]!;
    if (Math.abs(d) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / d;
      for (let cc = c; cc <= n; cc++) m[r]![cc]! -= f * m[c]![cc]!;
    }
  }
  return m.map((row, i) => row[n]! / (Math.abs(row[i]!) < 1e-12 ? 1 : row[i]!));
}

function predictRow(row: number[], beta: number[]): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) s += row[i]! * beta[i]!;
  return s;
}

export interface FittedModel {
  intercept: number;
  betaTvl: number;
  betaGrowth: number;
  catAdj: Record<string, number>;
  catList: string[];
  ageCoef: number;
  meanLogAge: number;
  medianAgeYears: number;
  nComps: number;
  nTokenRecorded: number;
  nExcludedNonpositive: number;
  nDated: number;
  r2InSample: number;
  residSdLog: number;
  medianRatio: number;
}

export interface CompFit {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  fitted_usd: number;
  logErr: number;
}

export interface FoldResult {
  label: string;
  nTrain: number;
  nTest: number;
  r2Oos: number;
  mapeLog: number;
  mapeLevel: number;
  medianLevel: number;
}

export interface Validation {
  walkForward: FoldResult[];
  kfold: FoldResult;
  foldsNote: string;
}

export interface SizeBin {
  tvlMid: number;
  medianActual: number;
  medianFitted: number;
  n: number;
}

function designRow(p: SnapshotProtocol, cats: string[]): number[] {
  const row: number[] = [1, Math.log10(p.tvl_usd), clampGrowth(finite(p.change_7d, 0))];
  for (const c of cats) row.push(p.category === c ? 1 : 0);
  return row;
}

/** Fit the two-stage model on the snapshot's comps. Returns model + per-comp fits. */
export function fitModel(snapshot: Snapshot): { model: FittedModel; comps: CompFit[]; bins: SizeBin[] } {
  const tokenRecorded = snapshot.protocols.filter((p) => p.mcap_usd !== null);
  const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const counts = new Map<string, number>();
  for (const p of comps) if (p.category) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  const cats = [...counts.entries()].filter(([, n]) => n >= CAT_MIN_COMPS).map(([c]) => c).sort();
  const design = comps.map((p) => designRow(p, cats));
  const target = comps.map((p) => Math.log10(p.mcap_usd!));
  const betaA = ols(design, target);
  const residA = comps.map((p, i) => target[i]! - predictRow(design[i]!, betaA));

  // Stage B: age slope on centred log-age, over comps with a listed date.
  const dated = comps.map((p, i) => ({ p, r: residA[i]!, age: ageDays(snapshot.as_of, p.listed_at) })).filter((d) => d.age !== null);
  const logAges = dated.map((d) => Math.log10(d.age! / 365.25 + 1));
  const meanLogAge = logAges.reduce((s, v) => s + v, 0) / Math.max(1, logAges.length);
  let ageCoef = 0;
  if (dated.length >= 10) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < dated.length; i++) {
      const x = logAges[i]! - meanLogAge;
      num += x * dated[i]!.r;
      den += x * x;
    }
    ageCoef = den > 1e-9 ? num / den : 0;
  }
  const allAges = snapshot.protocols
    .map((p) => ageDays(snapshot.as_of, p.listed_at))
    .filter((a): a is number => a !== null)
    .sort((a, b) => a - b);
  const medianAgeYears = allAges.length > 0 ? allAges[Math.floor(allAges.length / 2)]! / 365.25 : 1;

  const catAdj: Record<string, number> = {};
  cats.forEach((c, i) => {
    catAdj[c] = betaA[3 + i]!;
  });
  const model: FittedModel = {
    intercept: betaA[0]!,
    betaTvl: betaA[1]!,
    betaGrowth: betaA[2]!,
    catAdj,
    catList: cats,
    ageCoef,
    meanLogAge,
    medianAgeYears,
    nComps: comps.length,
    nTokenRecorded: tokenRecorded.length,
    nExcludedNonpositive: tokenRecorded.length - comps.length,
    nDated: dated.length,
    r2InSample: 0,
    residSdLog: 0,
    medianRatio: 0,
  };

  const fitted = comps.map((p, i) => {
    const logPred = predictRow(design[i]!, betaA) + ageCoef * (logAge(ageDays(snapshot.as_of, p.listed_at), medianAgeYears) - meanLogAge);
    const fittedUsd = Math.max(1, Math.round(10 ** logPred));
    return { p, fittedUsd, logErr: target[i]! - logPred };
  });
  const ys = target;
  const ym = ys.reduce((s, v) => s + v, 0) / ys.length;
  const ssTot = ys.reduce((s, v) => s + (v - ym) ** 2, 0);
  const ssRes = fitted.reduce((s, f) => s + f.logErr ** 2, 0);
  model.r2InSample = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  model.residSdLog = Math.sqrt(ssRes / Math.max(1, fitted.length - design[0]!.length));
  const ratios = comps.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  model.medianRatio = ratios[Math.floor(ratios.length / 2)]!;

  const compFits: CompFit[] = fitted.map((f) => ({
    slug: f.p.slug,
    name: f.p.name,
    category: f.p.category,
    tvl_usd: f.p.tvl_usd,
    mcap_usd: f.p.mcap_usd!,
    change_7d: f.p.change_7d,
    listed_at: f.p.listed_at,
    fitted_usd: f.fittedUsd,
    logErr: Math.round(f.logErr * 10000) / 10000,
  }));

  // Size curve: 8 log-TVL bins, median actual vs median fitted mcap per bin.
  const bins: SizeBin[] = [];
  const sorted = [...fitted].sort((a, b) => a.p.tvl_usd - b.p.tvl_usd);
  const per = Math.max(1, Math.floor(sorted.length / 8));
  for (let i = 0; i < 8; i++) {
    const part = sorted.slice(i * per, i === 7 ? sorted.length : (i + 1) * per);
    if (part.length === 0) continue;
    const med = (vs: number[]): number => {
      const s = [...vs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)]!;
    };
    bins.push({
      tvlMid: med(part.map((f) => f.p.tvl_usd)),
      medianActual: med(part.map((f) => f.p.mcap_usd!)),
      medianFitted: med(part.map((f) => f.fittedUsd)),
      n: part.length,
    });
  }
  return { model, comps: compFits, bins };
}

/** The fitted log10 implied value of one protocol, plus its dex breakdown. */
export function valueOf(p: SnapshotProtocol, snapshot: Snapshot, model: FittedModel): {
  logValue: number;
  implied: number;
  parts: { intercept: number; tvl: number; growth: number; category: number; age: number };
  ageDaysValue: number | null;
  growthPct: number;
} {
  const age = ageDays(snapshot.as_of, p.listed_at);
  const growthPct = Math.min(GROWTH_HI, Math.max(GROWTH_LO, finite(p.change_7d, 0)));
  const parts = {
    intercept: model.intercept,
    tvl: model.betaTvl * Math.log10(p.tvl_usd),
    growth: model.betaGrowth * (growthPct / 100),
    category: p.category !== null ? model.catAdj[p.category] ?? 0 : 0,
    age: model.ageCoef * (logAge(age, model.medianAgeYears) - model.meanLogAge),
  };
  const logValue = parts.intercept + parts.tvl + parts.growth + parts.category + parts.age;
  return { logValue, implied: Math.max(1, Math.round(10 ** logValue)), parts, ageDaysValue: age, growthPct };
}

/** Refit the two-stage model on a subset of comps (used inside validation folds). */
function refitOn(subset: SnapshotProtocol[], snapshot: Snapshot, cats: string[]): (p: SnapshotProtocol) => number {
  const design = subset.map((p) => designRow(p, cats));
  const target = subset.map((p) => Math.log10(p.mcap_usd!));
  const betaA = ols(design, target);
  const dated = subset
    .map((p, i) => ({ age: ageDays(snapshot.as_of, p.listed_at), r: target[i]! - predictRow(design[i]!, betaA) }))
    .filter((d) => d.age !== null);
  const logAges = dated.map((d) => Math.log10(d.age! / 365.25 + 1));
  const meanLogAge = logAges.length > 0 ? logAges.reduce((s, v) => s + v, 0) / logAges.length : 0;
  let ageCoef = 0;
  if (dated.length >= 10) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < dated.length; i++) {
      const x = logAges[i]! - meanLogAge;
      num += x * dated[i]!.r;
      den += x * x;
    }
    ageCoef = den > 1e-9 ? num / den : 0;
  }
  const medianAgeYears = 1;
  return (p: SnapshotProtocol) => {
    const row = designRow(p, cats);
    const age = ageDays(snapshot.as_of, p.listed_at);
    return predictRow(row, betaA) + ageCoef * (logAge(age, medianAgeYears) - meanLogAge);
  };
}

function foldMetrics(label: string, train: SnapshotProtocol[], test: SnapshotProtocol[], snapshot: Snapshot, cats: string[]): FoldResult {
  const predict = refitOn(train, snapshot, cats);
  const errs: number[] = [];
  const ys: number[] = [];
  let levelSum = 0;
  for (const p of test) {
    const y = Math.log10(p.mcap_usd!);
    const err = y - predict(p);
    errs.push(err);
    ys.push(y);
    levelSum += Math.abs(p.mcap_usd! - 10 ** predict(p)) / p.mcap_usd!;
  }
  const ym = ys.reduce((s, v) => s + v, 0) / Math.max(1, ys.length);
  const ssTot = ys.reduce((s, v) => s + (v - ym) ** 2, 0);
  const ssRes = errs.reduce((s, e) => s + e * e, 0);
  const levelErrs = test.map((p) => Math.abs(p.mcap_usd! - 10 ** predict(p)) / p.mcap_usd!).sort((a, b) => a - b);
  return {
    label,
    nTrain: train.length,
    nTest: test.length,
    r2Oos: ssTot > 0 ? 1 - ssRes / ssTot : 0,
    mapeLog: errs.reduce((s, e) => s + Math.abs(e), 0) / Math.max(1, errs.length),
    mapeLevel: levelSum / Math.max(1, test.length),
    medianLevel: levelErrs.length > 0 ? levelErrs[Math.floor(levelErrs.length / 2)]! : 0,
  };
}

/** Walk-forward (2 time folds) + 5-fold validation, all computed from the snapshot. */
export function validateModel(snapshot: Snapshot, model: FittedModel): Validation {
  const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const cats = model.catList;
  const dated = comps.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const walkForward: FoldResult[] = [];
  if (dated.length >= 20) {
    const c1 = Math.floor(dated.length * 0.5);
    const c2 = Math.floor(dated.length * 0.75);
    walkForward.push(foldMetrics('Fold 1: fit earliest 50%, test next 25%', dated.slice(0, c1), dated.slice(c1, c2), snapshot, cats));
    walkForward.push(foldMetrics('Fold 2: fit earliest 75%, test newest 25%', dated.slice(0, c2), dated.slice(c2), snapshot, cats));
  }
  // 5-fold by md5(slug): deterministic, order-free.
  const folds: SnapshotProtocol[][] = [[], [], [], [], []];
  for (const p of comps) {
    const h = createHash('md5').update(p.slug).digest();
    folds[h[0]! % 5]!.push(p);
  }
  const errs: number[] = [];
  const ys: number[] = [];
  const levelErrs: number[] = [];
  let levelSum = 0;
  for (let i = 0; i < 5; i++) {
    const test = folds[i]!;
    const train = folds.flatMap((f, j) => (j === i ? [] : f));
    const predict = refitOn(train, snapshot, cats);
    for (const p of test) {
      const y = Math.log10(p.mcap_usd!);
      const pr = predict(p);
      errs.push(y - pr);
      ys.push(y);
      const le = Math.abs(p.mcap_usd! - 10 ** pr) / p.mcap_usd!;
      levelErrs.push(le);
      levelSum += le;
    }
  }
  const ym = ys.reduce((s, v) => s + v, 0) / Math.max(1, ys.length);
  const ssTot = ys.reduce((s, v) => s + (v - ym) ** 2, 0);
  const ssRes = errs.reduce((s, e) => s + e * e, 0);
  levelErrs.sort((a, b) => a - b);
  const kfold: FoldResult = {
    label: '5-fold (md5 of slug)',
    nTrain: comps.length,
    nTest: comps.length,
    r2Oos: ssTot > 0 ? 1 - ssRes / ssTot : 0,
    mapeLog: errs.reduce((s, e) => s + Math.abs(e), 0) / Math.max(1, errs.length),
    mapeLevel: levelSum / Math.max(1, ys.length),
    medianLevel: levelErrs.length > 0 ? levelErrs[Math.floor(levelErrs.length / 2)]! : 0,
  };
  return {
    walkForward,
    kfold,
    foldsNote: 'Walk-forward folds use only the dated comps (listed_at present); the 5-fold uses all fitted comps.',
  };
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

// ---------------------------------------------------------------- farm plans

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 300;
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 120;
  return 60;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 540) return 60;
  return 30;
}

function coreAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp')) return `Lend $${capital} of USDC into ${name} on ${chain} and leave the deposit earning for the full hold.`;
  if (c.includes('dex') || c.includes('amm')) return `Add $${capital} of liquidity to the busiest pool of ${name} on ${chain} and keep the LP position open.`;
  if (c.includes('yield') || c.includes('vault') || c.includes('allocator') || c.includes('curator')) return `Deposit $${capital} into the flagship vault of ${name} on ${chain} and hold the vault shares.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC into ${chain} through ${name}, then put the bridged funds to work in its app.`;
  if (c.includes('stak') || c.includes('restak')) return `Stake $${capital} through ${name} on ${chain} and keep the staking receipt in the same wallet.`;
  if (c.includes('perpetual') || c.includes('deriv')) return `Post $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('rwa')) return `Mint $${capital} of the yield-bearing asset of ${name} on ${chain} and hold it.`;
  if (c.includes('stable')) return `Mint or hold $${capital} of the stable asset issued through ${name} on ${chain}.`;
  if (c.includes('prediction')) return `Fund ${name} with $${capital} and take one small position on a market that closes soon.`;
  if (c.includes('farm')) return `Stake $${capital} of LP tokens in the main farm of ${name} on ${chain}.`;
  return `Use $${capital} inside ${name} on ${chain}: deposit, swap or lend once, and keep the position open.`;
}

/**
 * Seven concrete farm steps for one protocol. Every step carries its cost
 * and its time; the capital, hold length and core action follow the
 * protocol's own TVL, age, category and chains.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const steps = [
    `Open a fresh wallet that holds only farming funds, write its recovery phrase on paper, and fund it with $${capital + 20} on ${chain}. Cost: about $2 of gas to fund. Time: 10 minutes.`,
    `${coreAction(p, capital, chain)} Cost: $${capital} of capital plus about $5 of gas. Time: 20 minutes to set up.`,
    `Do one real action every week on ${chain}: a swap, a deposit, a borrow or a vote inside ${p.name}, never the same empty transaction twice. Cost: about $2 of gas a week. Time: 15 minutes a week.`,
    `Hold the position for at least ${hold} days so the activity spans several snapshots instead of one weekend. Cost: the $${capital} stays locked in the position. Time: ${hold} days.`,
    `Join the protocol's official community channel and finish any profile, quest or points task it lists for ${p.name}. Cost: free, never pay for a task. Time: 30 minutes.`,
    `Before withdrawing, open the points or rewards page linked from the protocol's own site and check what your wallet earned. Cost: free to check, and a claim never asks for a fee upfront. Time: 10 minutes.`,
    `Log the wallet, the dates and every transaction hash in a farm journal, then unwind or roll the $${capital} into the next protocol on the board. Cost: nothing but the journal. Time: 10 minutes.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 597)}...` : s));
}

// ---------------------------------------------------------------- board

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  watchlist: boolean;
  breakdown: { intercept: number; tvl: number; growth: number; category: number; age: number };
  farm_steps: string[];
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: FittedModel;
  validation: Validation;
  bins: SizeBin[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  totalTvlBoard: number;
  rows: Array<{
    rank: number;
    slug: string;
    name: string;
    category: string | null;
    chains: string[];
    tvl_usd: number;
    change_7d: number | null;
    listed_at: string | null;
    age_days: number | null;
    implied_value_usd: number;
    watchlist: boolean;
    breakdown: { intercept: number; tvl: number; growth: number; category: number; age: number };
    farm_steps: string[];
  }>;
  live: Array<{ slug: string; name: string; category: string | null; chains: string[]; tvl_usd: number; mcap_usd: number; change_7d: number | null; ratio: number }>;
  comps: CompFit[];
}

const BOARD_TARGET = 200;

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { model, comps, bins } = fitModel(snapshot);
  const validation = validateModel(snapshot, model);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .map((p) => ({ p, v: valueOf(p, snapshot, model).implied }))
    .sort((a, b) => b.v - a.v || (a.p.slug < b.p.slug ? -1 : 1))
    .slice(0, Math.max(0, BOARD_TARGET - chosen.size));
  for (const e of early) chosen.set(e.p.slug, e.p);

  const scored = [...chosen.values()].map((p) => {
    const v = valueOf(p, snapshot, model);
    return { p, v };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  // Force strictly decreasing implied values so the ranking is a ranking.
  let prev = Number.POSITIVE_INFINITY;
  const board: BoardRow[] = scored.map((s, i) => {
    let implied = s.v.implied;
    if (implied >= prev) implied = Math.max(1, prev - 1);
    prev = implied;
    const r4 = (n: number): number => Math.round(n * 10000) / 10000;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      age_days: s.v.ageDaysValue,
      implied_value_usd: implied,
      watchlist: snapshot.watchlist.includes(s.p.slug),
      breakdown: {
        intercept: r4(s.v.parts.intercept),
        tvl: r4(s.v.parts.tvl),
        growth: r4(s.v.parts.growth),
        category: r4(s.v.parts.category),
        age: r4(s.v.parts.age),
      },
      farm_steps: farmSteps(s.p, s.v.ageDaysValue),
    };
  });

  const live = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0))
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      ratio: Math.round((p.mcap_usd! / p.tvl_usd) * 1000) / 1000,
    }));

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: 'comps-loglog-v5',
    model,
    validation,
    bins,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    totalTvlBoard: board.reduce((s, r) => s + r.tvl_usd, 0),
    rows: board,
    live,
    comps,
  };
  return { board, radar };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'all rows share the same implied value';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
