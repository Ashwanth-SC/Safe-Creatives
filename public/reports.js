// ============================================================================
// Safe Creatives — shared reporting helpers (window.SCReports)
// ============================================================================
//
// Thin wrapper over Chart.js (loaded from a CDN as the global `Chart`) used by
// the Reports tab on both dashboards (dashboard.js, turnkey-dashboard.js).
// Keeps all the charting decisions in one place so the two reports read as one
// system: the same palette, fonts, axes, tooltips, date-bucketing and
// category-grouping.
//
// Colour follows the data's job, per the data-viz method:
//   * Single-series bars and time-series lines use ONE brand hue (teal) — the
//     category identity is on the axis, so one hue is correct and needs no
//     cross-series colour-blindness check.
//   * Pies / doughnuts (several categories in one chart) use the validated
//     8-hue categorical palette, assigned by a FIXED domain order (never by
//     rank) so changing the date range never repaints a slice a new colour.
//
// Requires Chart.js v4 (UMD). If it did not load, SCReports.ready() is false
// and the panels show a friendly note instead of breaking.
// ============================================================================

(function () {
  "use strict";

  // --- Palette ---------------------------------------------------------------
  // Validated categorical order (data-viz skill reference palette): passes the
  // adjacent-pair CVD and contrast gates on a light surface.
  const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
  const OTHER = "#9a9a93"; // the folded "Other" bucket — deliberately neutral
  const TEAL = "#0c4444"; // brand hue for single-series marks
  const TEAL_FILL = "rgba(12,68,68,0.10)";
  const INK = "#171717";
  const INK2 = "#52514e";
  const MUTED = "#898781";
  const GRID = "#e8e7e0";
  const BASE = "#c3c2b7";
  const FONT = "'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";

  const DAY = 86400000;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Live chart instances, so a re-render (range change) can tear them down
  // before drawing again — Chart.js will not reuse a canvas otherwise.
  const charts = [];
  function reset() {
    while (charts.length) {
      try { charts.pop().destroy(); } catch (e) { /* already gone */ }
    }
  }

  function ready() {
    return typeof window.Chart !== "undefined";
  }

  let defaultsApplied = false;
  function applyDefaults() {
    if (defaultsApplied || !ready()) return;
    Chart.defaults.font.family = FONT;
    Chart.defaults.color = INK2;
    Chart.defaults.plugins.tooltip.displayColors = false;
    defaultsApplied = true;
  }

  // --- Date ranges + bucketing ----------------------------------------------

  // [key, label, days] — days null means "all time".
  const RANGES = [
    ["7d", "Last 7 days", 7],
    ["30d", "Last 30 days", 30],
    ["90d", "Last 90 days", 90],
    ["12m", "Last 12 months", 365],
    ["all", "All time", null],
  ];

  function rangeStart(key, now) {
    const r = RANGES.find((x) => x[0] === key);
    if (!r || r[2] == null) return null;
    return new Date(now.getTime() - r[2] * DAY);
  }

  // Pick a bucket width that keeps a time series readable for the given span.
  function grainFor(startDate, now) {
    if (!startDate) return "month";
    const days = (now - startDate) / DAY;
    if (days <= 31) return "day";
    if (days <= 120) return "week";
    return "month";
  }

  function grainWord(grain) {
    return grain === "day" ? "day" : grain === "week" ? "week" : "month";
  }

  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function startOfWeek(d) { const x = startOfDay(d); const wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); return x; } // Monday
  function startOfMonth(d) { const x = startOfDay(d); x.setDate(1); return x; }

  function bucketStart(d, grain) {
    if (grain === "day") return startOfDay(d);
    if (grain === "week") return startOfWeek(d);
    return startOfMonth(d);
  }
  function nextBucket(d, grain) {
    const x = new Date(d);
    if (grain === "day") x.setDate(x.getDate() + 1);
    else if (grain === "week") x.setDate(x.getDate() + 7);
    else x.setMonth(x.getMonth() + 1);
    return x;
  }
  function bucketLabel(d, grain) {
    if (grain === "month") return `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
    return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }

  // Build a continuous, zero-filled series between startDate (or the earliest
  // datum, for "all time") and now. `dateFn` returns a Date/parseable value per
  // row; `valueFn` returns the number to sum (omit for a count of 1 per row).
  function series(rows, dateFn, valueFn, startDate, now, grain) {
    const items = rows
      .map((r) => ({ t: new Date(dateFn(r)), v: valueFn ? Number(valueFn(r)) || 0 : 1 }))
      .filter((x) => !isNaN(x.t.getTime()));

    let from = startDate ? bucketStart(startDate, grain) : null;
    if (!from) {
      from = items.length
        ? bucketStart(new Date(Math.min(...items.map((i) => i.t.getTime()))), grain)
        : bucketStart(now, grain);
    }

    const buckets = [];
    const index = new Map();
    const end = bucketStart(now, grain);
    let cur = new Date(from);
    let guard = 0;
    while (cur <= end && guard++ < 2000) {
      index.set(cur.getTime(), buckets.length);
      buckets.push({ label: bucketLabel(cur, grain), value: 0 });
      cur = nextBucket(cur, grain);
    }

    items.forEach((it) => {
      if (startDate && it.t < startDate) return;
      const i = index.get(bucketStart(it.t, grain).getTime());
      if (i != null) buckets[i].value += it.v;
    });

    return { labels: buckets.map((b) => b.label), values: buckets.map((b) => b.value), grain };
  }

  // Group rows into {labels, values}. `keyFn` -> category, `valueFn` -> number
  // (omit for counts). With `domain`, categories keep that fixed order (stable
  // colours); without it they sort by value desc and everything past `top`
  // folds into "Other". Empty categories are dropped.
  function group(rows, keyFn, valueFn, opts) {
    opts = opts || {};
    const top = opts.top || 8;
    const m = new Map();
    rows.forEach((r) => {
      let k = keyFn(r);
      k = (k == null || k === "") ? "—" : String(k);
      m.set(k, (m.get(k) || 0) + (valueFn ? Number(valueFn(r)) || 0 : 1));
    });

    let entries;
    if (opts.domain) {
      entries = opts.domain.filter((k) => m.has(k)).map((k) => [k, m.get(k)]);
      [...m.keys()].filter((k) => !opts.domain.includes(k)).forEach((k) => entries.push([k, m.get(k)]));
    } else {
      entries = [...m.entries()].sort((a, b) => b[1] - a[1]);
      if (entries.length > top) {
        const head = entries.slice(0, top - 1);
        const rest = entries.slice(top - 1).reduce((s, e) => s + e[1], 0);
        head.push(["Other", rest]);
        entries = head;
      }
    }
    return { labels: entries.map((e) => e[0]), values: entries.map((e) => e[1]) };
  }

  function sliceColor(label, i) {
    return label === "Other" ? OTHER : PALETTE[i % PALETTE.length];
  }

  // --- Chart.js option fragments ---------------------------------------------

  function axes(horizontal, valueFmt) {
    const value = {
      beginAtZero: true,
      grid: { color: GRID, drawTicks: false },
      border: { display: false },
      ticks: {
        color: MUTED,
        font: { family: FONT, size: 11 },
        padding: 6,
        callback: (v) => (valueFmt ? valueFmt(v) : v),
      },
    };
    const cat = {
      grid: { display: false },
      border: { color: BASE },
      ticks: { color: INK2, font: { family: FONT, size: 11 }, autoSkip: true, maxRotation: 0 },
    };
    return horizontal ? { x: value, y: cat } : { x: cat, y: value };
  }

  function tooltip(valueFmt) {
    return {
      backgroundColor: INK,
      padding: 10,
      cornerRadius: 6,
      titleFont: { family: FONT, weight: "600" },
      bodyFont: { family: FONT },
      callbacks: {
        label: (ctx) => {
          const type = ctx.chart.config.type;
          if (type === "pie" || type === "doughnut") {
            const total = ctx.dataset.data.reduce((s, n) => s + Number(n || 0), 0);
            const pct = total ? Math.round((Number(ctx.raw) / total) * 100) : 0;
            return ` ${ctx.label}: ${valueFmt ? valueFmt(ctx.raw) : ctx.raw} (${pct}%)`;
          }
          const v = ctx.parsed.y != null ? ctx.parsed.y : ctx.parsed.x;
          return ` ${valueFmt ? valueFmt(v) : v}`;
        },
      },
    };
  }

  // --- Chart builders --------------------------------------------------------

  function pie(canvas, labels, values, opts) {
    opts = opts || {};
    applyDefaults();
    const colors = labels.map(sliceColor);
    const c = new Chart(canvas, {
      type: opts.doughnut ? "doughnut" : "pie",
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: "#fff", borderWidth: 2 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: opts.doughnut ? "58%" : 0,
        plugins: { legend: { display: false }, tooltip: tooltip(opts.valueFmt) },
      },
    });
    charts.push(c);
    return c;
  }

  function bar(canvas, labels, values, opts) {
    opts = opts || {};
    applyDefaults();
    const c = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: TEAL,
          hoverBackgroundColor: "#0a3838",
          borderRadius: 4,
          borderSkipped: false,
          maxBarThickness: 36,
        }],
      },
      options: {
        indexAxis: opts.horizontal ? "y" : "x",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: tooltip(opts.valueFmt) },
        scales: axes(opts.horizontal, opts.valueFmt),
      },
    });
    charts.push(c);
    return c;
  }

  function line(canvas, labels, values, opts) {
    opts = opts || {};
    applyDefaults();
    const c = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: TEAL,
          backgroundColor: TEAL_FILL,
          borderWidth: 2,
          fill: opts.fill !== false,
          tension: 0.3,
          pointRadius: labels.length > 24 ? 0 : 3,
          pointBackgroundColor: TEAL,
          pointHoverRadius: 5,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: tooltip(opts.valueFmt) },
        scales: axes(false, opts.valueFmt),
      },
    });
    charts.push(c);
    return c;
  }

  // An HTML legend for a pie/doughnut: swatch + name + value + share. Doubles as
  // the accessible "identity is never colour-alone" channel and a tiny table.
  function legend(labels, values, valueFmt) {
    const total = values.reduce((s, n) => s + Number(n || 0), 0);
    const ul = document.createElement("ul");
    ul.className = "report-legend";
    labels.forEach((lab, i) => {
      const pct = total ? Math.round((Number(values[i]) / total) * 100) : 0;
      const li = document.createElement("li");
      const sw = document.createElement("span");
      sw.className = "report-sw";
      sw.style.background = sliceColor(lab, i);
      const name = document.createElement("span");
      name.className = "report-lg-name";
      name.textContent = lab;
      const val = document.createElement("span");
      val.className = "report-lg-val";
      val.textContent = `${valueFmt ? valueFmt(values[i]) : values[i]} · ${pct}%`;
      li.append(sw, name, val);
      ul.appendChild(li);
    });
    return ul;
  }

  window.SCReports = {
    ready, reset, RANGES, rangeStart, grainFor, grainWord,
    series, group, pie, bar, line, legend,
    PALETTE, TEAL, INK, INK2, MUTED,
  };
})();
