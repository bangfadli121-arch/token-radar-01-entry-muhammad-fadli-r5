/* Token Radar — valuation desk. One valuation function, shared with main.ts:
   log10(implied) = intercept + betaTvl*log10(TVL) + betaGrowth*clampedGrowth
                    + catAdj[category] + ageCoef*(log10(ageYears+1) - meanLogAge)
   All parameters come from window.RADAR.model, fitted at run time by lib/model.ts.
   No network, no fetch: the data arrives as ../data.js. */
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) { document.getElementById('mastMeta').textContent = 'data.js did not load.'; return; }
  var M = D.model, V = D.validation, ROWS = D.rows, LIVE = D.live, COMPS = D.comps;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var fmt$ = function (n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  };
  var fmtInt = function (n) { return Math.round(n).toLocaleString('en-US'); };
  var clampG = function (pct) { return Math.min(15, Math.max(-15, pct == null ? 0 : pct)) / 100; };
  var ageYears = function (r) { return r.age_days == null ? M.medianAgeYears : r.age_days / 365.25; };
  var logAge = function (r) { return Math.log10(ageYears(r) + 1); };

  /* The valuation function: the same function main.ts runs. Recompute live. */
  function valueOf(r) {
    var cat = r.category ? (M.catAdj[r.category] || 0) : 0;
    var parts = {
      intercept: M.intercept,
      tvl: M.betaTvl * Math.log10(r.tvl_usd),
      growth: M.betaGrowth * clampG(r.change_7d),
      category: cat,
      age: M.ageCoef * (logAge(r) - M.meanLogAge)
    };
    var logV = parts.intercept + parts.tvl + parts.growth + parts.category + parts.age;
    return { logV: logV, implied: Math.max(1, Math.round(Math.pow(10, logV))), parts: parts };
  }
  function breakdown(r) { return r.breakdown || valueOf(r).parts; }

  /* ---- header + hero ---- */
  var top = ROWS[0];
  $('mastMeta').innerHTML = 'Snapshot ' + esc(D.as_of) + ' · ' + D.watchlist_size + ' watchlist · ' +
    ROWS.length + ' board rows · ' + M.nComps + ' comps fitted · model ' + esc(D.model_version);
  $('equation').textContent = 'log10(implied) = ' + M.intercept.toFixed(3) + ' + ' + M.betaTvl.toFixed(3) +
    '·log10(TVL) + ' + M.betaGrowth.toFixed(3) + '·growth + catAdj + ' + M.ageCoef.toFixed(3) + '·(log10(age+1) − ' + M.meanLogAge.toFixed(3) + ')';
  $('eqNote').textContent = 'Fitted by OLS on ' + M.nComps + ' token-bearing comps (of ' + M.nTokenRecorded +
    ' token-recorded; ' + M.nExcludedNonpositive + ' carry mcap ≤ 0 and cannot enter a log fit). ' +
    'Category adjustments for ' + M.catList.length + ' categories with ≥5 comps: ' +
    M.catList.map(function (c) { return c + ' ' + (M.catAdj[c] >= 0 ? '+' : '') + M.catAdj[c].toFixed(2); }).join(', ') +
    '. Median mcap/TVL among comps: ' + M.medianRatio.toFixed(3) + '.';
  function stat(k, v) { return '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>'; }
  $('heroStats').innerHTML =
    stat('Board rows', ROWS.length) + stat('Top implied', fmt$(top.implied_value_usd)) +
    stat('Board TVL', fmt$(D.totalTvlBoard)) + stat('Comps fitted', M.nComps) +
    stat('R² in-sample', M.r2InSample.toFixed(3)) + stat('Resid SD (dex)', M.residSdLog.toFixed(3));
  var wf = V.walkForward, kf = V.kfold;
  $('trustLine').textContent = 'Walk-forward R² out-of-sample: ' +
    wf.map(function (f) { return f.r2Oos.toFixed(2); }).join(' / ') + ' · 5-fold R² ' + kf.r2Oos.toFixed(2) +
    '. The curve is honest about its spread — read the fitted-vs-actual table before trusting any single number.';
  $('trustStats').innerHTML =
    stat('WF MAPE (log)', wf.map(function (f) { return f.mapeLog.toFixed(2); }).join(' / ') + ' dex') +
    stat('WF median err', wf.map(function (f) { return Math.round(f.medianLevel * 100) + '%'; }).join(' / ') + ' level') +
    stat('5-fold median', Math.round(kf.medianLevel * 100) + '% level');
  $('footNote').textContent = 'Source: ' + D.source + ' · floor $' + fmtInt(D.floor_usd) +
    ' · ' + M.nDated + ' dated comps used for the walk-forward folds. ' + V.foldsNote;

  /* ---- size curve (SVG) ---- */
  (function curve() {
    var W = 1120, H = 420, PL = 70, PR = 20, PT = 18, PB = 44;
    var x0 = 6.7, x1 = 11.1, y0 = 5.0, y1 = 11.0;
    var X = function (lt) { return PL + (lt - x0) / (x1 - x0) * (W - PL - PR); };
    var Y = function (lm) { return PT + (y1 - lm) / (y1 - y0) * (H - PT - PB); };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Size curve: market cap against TVL">';
    s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#0b1226"/>';
    for (var g = 6; g <= 11; g++) {
      s += '<line x1="' + X(g) + '" y1="' + PT + '" x2="' + X(g) + '" y2="' + (H - PB) + '" stroke="#22315c"/>' +
        '<text x="' + X(g) + '" y="' + (H - 26) + '" fill="#93a1c2" font-size="12" text-anchor="middle">10^' + g + '</text>';
    }
    for (var m = 5; m <= 11; m++) {
      s += '<line x1="' + PL + '" y1="' + Y(m) + '" x2="' + (W - PR) + '" y2="' + Y(m) + '" stroke="#22315c"/>' +
        '<text x="' + (PL - 8) + '" y="' + (Y(m) + 4) + '" fill="#93a1c2" font-size="12" text-anchor="end">10^' + m + '</text>';
    }
    s += '<text x="' + (W / 2) + '" y="' + (H - 6) + '" fill="#93a1c2" font-size="12" text-anchor="middle">TVL (USD, log10)</text>';
    s += '<text x="18" y="' + (H / 2) + '" fill="#93a1c2" font-size="12" transform="rotate(-90 18 ' + (H / 2) + ')" text-anchor="middle">Market cap (USD, log10)</text>';
    var curvePts = '', bandTop = '', bandBot = '';
    for (var lt = x0; lt <= x1 + 0.001; lt += 0.05) {
      var lm = M.intercept + M.betaTvl * lt;
      curvePts += (lt === x0 ? 'M' : 'L') + X(lt).toFixed(1) + ' ' + Y(lm).toFixed(1) + ' ';
      bandTop += (lt === x0 ? 'M' : 'L') + X(lt).toFixed(1) + ' ' + Y(lm + M.residSdLog).toFixed(1) + ' ';
      bandBot = 'L' + X(lt).toFixed(1) + ' ' + Y(lm - M.residSdLog).toFixed(1) + ' ' + bandBot;
    }
    s += '<path d="' + bandTop + bandBot + 'Z" fill="#d9a441" opacity="0.12"/>';
    s += '<path d="' + curvePts + '" fill="none" stroke="#d9a441" stroke-width="3"/>';
    s += '<text x="' + (W - PR - 8) + '" y="' + (Y(M.intercept + M.betaTvl * 10.6) - 10) + '" fill="#f2c96b" font-size="13" text-anchor="end">fitted size curve · β = ' + M.betaTvl.toFixed(2) + '</text>';
    COMPS.forEach(function (c) {
      var cx = X(Math.log10(c.tvl_usd)), cy = Y(Math.log10(c.mcap_usd));
      s += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="3.4" fill="#7fb3ff" opacity="0.85"><title>' +
        esc(c.name) + ' — actual ' + fmt$(c.mcap_usd) + ', fitted ' + fmt$(c.fitted_usd) + '</title></circle>';
    });
    ROWS.slice(0, 12).forEach(function (r) {
      s += '<circle cx="' + X(Math.log10(r.tvl_usd)).toFixed(1) + '" cy="' + Y(Math.log10(r.implied_value_usd)).toFixed(1) +
        '" r="5" fill="none" stroke="#f2c96b" stroke-width="1.6"><title>#' + r.rank + ' ' + esc(r.name) + ' — implied ' + fmt$(r.implied_value_usd) + '</title></circle>';
    });
    s += '</svg>';
    $('curveWrap').innerHTML = s;
    $('bins').innerHTML = D.bins.map(function (b) {
      return '<div><b>TVL ≈ ' + fmt$(b.tvlMid) + '</b>n = ' + b.n + ' comps<br>median actual ' + fmt$(b.medianActual) + '<br>median fitted ' + fmt$(b.medianFitted) + '</div>';
    }).join('');
  })();

  /* ---- filters ---- */
  var cats = [], chains = [];
  ROWS.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort(); chains.sort();
  cats.forEach(function (c) { $('cat').innerHTML += '<option>' + esc(c) + '</option>'; });
  chains.forEach(function (c) { $('chain').innerHTML += '<option>' + esc(c) + '</option>'; });

  function filtered() {
    var q = $('q').value.trim().toLowerCase(), cat = $('cat').value, ch = $('chain').value, wo = $('watchOnly').checked;
    var list = ROWS.filter(function (r) {
      if (wo && !r.watchlist) return false;
      if (cat && r.category !== cat) return false;
      if (ch && r.chains.indexOf(ch) < 0) return false;
      if (q && (r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0)) return false;
      return true;
    });
    var sort = $('sort').value;
    var key = { value: 'implied_value_usd', tvl: 'tvl_usd', growth: 'change_7d', age: 'age_days' }[sort];
    if (sort === 'name') list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    else if (sort === 'ratio') list.sort(function (a, b) { return b.implied_value_usd / b.tvl_usd - a.implied_value_usd / a.tvl_usd; });
    else list.sort(function (a, b) { return (b[key] == null ? -1e18 : b[key]) - (a[key] == null ? -1e18 : a[key]); });
    return list;
  }
  function pct(r) { return r.change_7d == null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%'; }
  function ageTxt(r) {
    if (r.age_days == null) return '—';
    if (r.age_days < 365) return Math.round(r.age_days / 30) + ' mo';
    return (r.age_days / 365).toFixed(1) + ' y';
  }
  function renderBoard() {
    var list = filtered();
    $('boardCount').textContent = list.length + ' of ' + ROWS.length + ' rows';
    $('rows').innerHTML = list.map(function (r) {
      var g = r.change_7d == null ? '' : (r.change_7d >= 0 ? 'pos' : 'neg');
      return '<tr data-slug="' + esc(r.slug) + '"><td>#' + r.rank + '</td><td><span class="nm">' + esc(r.name) + '</span>' +
        '<span class="sub">' + esc(r.slug) + (r.watchlist ? ' <span class="wl">★ watchlist</span>' : '') + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td><td>' + esc(r.chains.slice(0, 2).join(', ')) + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>' +
        '<td class="num">' + fmt$(r.tvl_usd) + '</td><td class="num ' + g + '">' + pct(r) + '</td>' +
        '<td class="num">' + ageTxt(r) + '</td><td class="num"><b>' + fmt$(r.implied_value_usd) + '</b></td>' +
        '<td class="num">' + (r.implied_value_usd / r.tvl_usd).toFixed(2) + '×</td></tr>';
    }).join('');
    $('boardNote').textContent = 'Top 5 by implied value: ' + ROWS.slice(0, 5).map(function (r) { return '#' + r.rank + ' ' + r.name + ' ' + fmt$(r.implied_value_usd); }).join(' · ') + '.';
  }
  $('liveRows').innerHTML = LIVE.map(function (p) {
    return '<tr data-slug="' + esc(p.slug) + '"><td><span class="nm">' + esc(p.name) + '</span><span class="sub">' + esc(p.slug) + '</span></td>' +
      '<td>' + esc(p.category || '—') + '</td><td class="num">' + fmt$(p.tvl_usd) + '</td><td class="num"><b>' + fmt$(p.mcap_usd) + '</b></td>' +
      '<td class="num">' + p.ratio.toFixed(2) + '×</td><td class="num">' + (p.change_7d == null ? '—' : p.change_7d.toFixed(1) + '%') + '</td></tr>';
  }).join('');
  $('wfRows').innerHTML = wf.map(function (f) {
    return '<tr><td>' + esc(f.label) + '</td><td class="num">' + f.nTrain + '</td><td class="num">' + f.nTest + '</td>' +
      '<td class="num">' + f.r2Oos.toFixed(3) + '</td><td class="num">' + f.mapeLog.toFixed(3) + '</td><td class="num">' + Math.round(f.mapeLevel * 100) + '%</td><td class="num">' + Math.round(f.medianLevel * 100) + '%</td></tr>';
  }).join('') + '<tr><td>' + esc(kf.label) + '</td><td class="num">' + kf.nTrain + '</td><td class="num">' + kf.nTest + '</td>' +
    '<td class="num">' + kf.r2Oos.toFixed(3) + '</td><td class="num">' + kf.mapeLog.toFixed(3) + '</td><td class="num">' + Math.round(kf.mapeLevel * 100) + '%</td><td class="num">' + Math.round(kf.medianLevel * 100) + '%</td></tr>';
  var compsSorted = COMPS.slice().sort(function (a, b) { return Math.abs(b.logErr) - Math.abs(a.logErr); });
  $('compRows').innerHTML = compsSorted.map(function (c) {
    return '<tr><td><span class="nm">' + esc(c.name) + '</span><span class="sub">' + esc(c.slug) + '</span></td><td>' + esc(c.category || '—') + '</td>' +
      '<td class="num">' + fmt$(c.tvl_usd) + '</td><td class="num">' + fmt$(c.mcap_usd) + '</td><td class="num">' + fmt$(c.fitted_usd) + '</td>' +
      '<td class="num ' + (c.logErr >= 0 ? 'pos' : 'neg') + '">' + (c.logErr >= 0 ? '+' : '') + c.logErr.toFixed(2) + '</td></tr>';
  }).join('');

  /* worked example: rank 1, recomputed live, numbers substituted */
  (function worked() {
    var r = ROWS[0], v = valueOf(r), b = v.parts;
    $('worked').innerHTML = '<b>#' + r.rank + ' ' + esc(r.name) + ':</b> log10(TVL) = ' + Math.log10(r.tvl_usd).toFixed(3) +
      ', growth clamped to ' + (clampG(r.change_7d) * 100).toFixed(1) + '%, age ' + ageTxt(r) +
      '. So log10(implied) = ' + b.intercept.toFixed(3) + ' + ' + b.tvl.toFixed(3) + ' (TVL) + ' + b.growth.toFixed(3) +
      ' (growth) + ' + b.category.toFixed(3) + ' (category) + ' + b.age.toFixed(3) + ' (age) = ' + v.logV.toFixed(3) +
      ', and 10^' + v.logV.toFixed(3) + ' = <b>' + fmt$(v.implied) + '</b> — the board shows ' + fmt$(r.implied_value_usd) +
      ' for the same row. Change any input above and the drawer recomputes the same way.';
  })();

  /* ---- detail drawer ---- */
  function neighbours(r, pool, n) {
    var lt = Math.log10(r.tvl_usd);
    return pool.filter(function (x) { return x.slug !== r.slug; })
      .map(function (x) { return { x: x, d: Math.abs(Math.log10(x.tvl_usd) - lt) }; })
      .sort(function (a, b) { return a.d - b.d; }).slice(0, n).map(function (o) { return o.x; });
  }
  function openDetail(slug) {
    var r = ROWS.filter(function (x) { return x.slug === slug; })[0];
    if (!r) return;
    var v = valueOf(r), b = v.parts;
    var maxAbs = Math.max(Math.abs(b.intercept), Math.abs(b.tvl), Math.abs(b.growth), Math.abs(b.category), Math.abs(b.age), 0.01);
    function bar(label, val) {
      var w = Math.abs(val) / maxAbs * 100;
      return '<div>' + label + ': <b>' + (val >= 0 ? '+' : '') + val.toFixed(3) + ' dex</b><div class="bar"><i class="' + (val < 0 ? 'neg' : '') + '" style="width:' + Math.max(2, w).toFixed(0) + '%"></i></div></div>';
    }
    var nb = neighbours(r, ROWS, 5);
    var nc = neighbours(r, COMPS, 5);
    $('drawerBody').innerHTML =
      '<p class="tag">#' + r.rank + ' · ' + (r.watchlist ? '★ watchlist' : 'early find below the floor') + ' · ' + esc(r.category || 'uncategorised') + '</p>' +
      '<h2>' + esc(r.name) + '</h2><p class="fine">' + esc(r.slug) + ' · ' + esc(r.chains.join(', ')) + ' · listed ' + esc(r.listed_at || 'unknown') + '</p>' +
      '<p>Implied value <span class="big">' + fmt$(r.implied_value_usd) + '</span> &nbsp;·&nbsp; TVL ' + fmt$(r.tvl_usd) + ' · 7d ' + pct(r) + ' · age ' + ageTxt(r) + '</p>' +
      '<p class="panel-sub">Where it sits on the size curve: log10(TVL) ' + Math.log10(r.tvl_usd).toFixed(2) + ' → fitted log10(mcap) ' + v.logV.toFixed(2) +
      ', against a comps median mcap/TVL of ' + M.medianRatio.toFixed(2) + '×. The curve says a protocol this size usually carries a token worth about ' +
      fmt$(Math.pow(10, M.intercept + M.betaTvl * Math.log10(r.tvl_usd))) + ' before growth, category and age adjustments.</p>' +
      '<h3>Model breakdown (dex, log10)</h3><div class="bars">' +
      bar('Intercept', b.intercept) + bar('TVL · β ' + M.betaTvl.toFixed(3), b.tvl) +
      bar('Growth · ' + (clampG(r.change_7d) * 100).toFixed(1) + '%', b.growth) +
      bar('Category · ' + (r.category && M.catAdj[r.category] != null ? r.category : 'shared, no own adj'), b.category) + bar('Age · ' + ageTxt(r), b.age) + '</div>' +
      '<p class="fine">Recomputed live in this drawer by valueOf() from the fitted parameters — the same function that priced the board. Sum: ' + v.logV.toFixed(3) + ' dex → ' + fmt$(v.implied) + '.</p>' +
      '<h3>Nearest by size — board</h3><p class="neigh">' + nb.map(function (x) { return '<b>#' + x.rank + ' ' + esc(x.name) + '</b> ' + fmt$(x.implied_value_usd); }).join(' · ') + '</p>' +
      '<h3>Nearest by size — comps (fitted vs actual)</h3><p class="neigh">' + nc.map(function (x) { return '<b>' + esc(x.name) + '</b> fitted ' + fmt$(x.fitted_usd) + ' vs actual ' + fmt$(x.mcap_usd); }).join(' · ') + '</p>' +
      '<h3>Farm plan — 7 steps</h3><ol class="steps">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p class="fine">This protocol records no token in the snapshot. Nothing here promises a token, an airdrop or a price.</p>';
    $('drawer').hidden = false;
    $('drawer').scrollTop = 0;
  }
  $('drawerClose').addEventListener('click', function () { $('drawer').hidden = true; setHash({ detail: null }); });
  document.addEventListener('click', function (e) {
    var tr = e.target.closest ? e.target.closest('tr[data-slug]') : null;
    if (tr) openDetail(tr.getAttribute('data-slug'));
  });

  /* ---- tabs ---- */
  var tabs = document.querySelectorAll('.tab');
  function showTab(name) {
    tabs.forEach(function (t) { t.classList.toggle('on', t.getAttribute('data-tab') === name); });
    $('tabBoard').hidden = name !== 'board';
    $('tabLive').hidden = name !== 'live';
    $('tabModel').hidden = name !== 'model';
    $('controls').style.display = name === 'board' ? '' : 'none';
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { showTab(t.getAttribute('data-tab')); setHash({ tab: t.getAttribute('data-tab') }); }); });

  /* ---- hash deep links ---- */
  function parseHash() {
    var h = location.hash.replace(/^#/, ''), out = {};
    h.split('&').forEach(function (kv) { var p = kv.split('='); if (p[0]) out[p[0]] = decodeURIComponent(p[1] || ''); });
    return out;
  }
  function setHash(patch) {
    var h = parseHash();
    Object.keys(patch).forEach(function (k) { if (patch[k] == null || patch[k] === '') delete h[k]; else h[k] = patch[k]; });
    var s = Object.keys(h).map(function (k) { return k + '=' + encodeURIComponent(h[k]); }).join('&');
    history.replaceState(null, '', s ? '#' + s : location.pathname + location.search);
  }
  function applyHash() {
    var h = parseHash();
    if (h.q != null) $('q').value = h.q;
    if (h.cat != null) $('cat').value = h.cat;
    if (h.chain != null) $('chain').value = h.chain;
    if (h.watch != null) $('watchOnly').checked = h.watch === '1';
    if (h.sort != null) $('sort').value = h.sort;
    if (h.tab) showTab(h.tab);
    if (h.shot === 'filtered') document.body.classList.add('shot-filtered');
    renderBoard();
    if (h.detail) openDetail(h.detail);
  }
  ['q', 'cat', 'chain', 'watchOnly', 'sort'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      renderBoard();
      setHash({ q: $('q').value, cat: $('cat').value, chain: $('chain').value, watch: $('watchOnly').checked ? '1' : null, sort: $('sort').value === 'value' ? null : $('sort').value });
    });
    $(id).addEventListener('change', function () { renderBoard(); });
  });
  $('csv').addEventListener('click', function () {
    var list = filtered();
    var csv = 'rank,slug,name,category,chains,tvl_usd,change_7d,age_days,implied_value_usd\n' +
      list.map(function (r) { return [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', r.category || '', '"' + r.chains.join(';') + '"', r.tvl_usd, r.change_7d == null ? '' : r.change_7d, r.age_days == null ? '' : r.age_days, r.implied_value_usd].join(','); }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'token-radar-board.csv';
    a.click();
  });
  window.addEventListener('hashchange', applyHash);
  applyHash();
})();
