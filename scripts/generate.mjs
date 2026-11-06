#!/usr/bin/env node
// Builds the profile charts in assets/ from the GitHub GraphQL API.
// With a token for the profile owner (local `gh auth token`, or a STATS_TOKEN secret) every
// number is live. With the Actions GITHUB_TOKEN only the contribution calendar is readable,
// so merged PRs and languages come from the last full run saved in data/snapshot.json.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const LOGIN = process.env.PROFILE_LOGIN || 'hereisabrams';
const ROOT = new URL('..', import.meta.url).pathname;
const SNAPSHOT_PATH = `${ROOT}data/snapshot.json`;

const token = process.env.STATS_TOKEN || process.env.GITHUB_TOKEN || readGhToken();

if (!token) {
  console.error('No GitHub token: set STATS_TOKEN or GITHUB_TOKEN, or sign in with gh.');
  process.exit(1);
}

function readGhToken() {
  try {
    return execSync('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

async function graphql(query, variables = {}, attempt = 1) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  if (response.status >= 500 && attempt < 4) {
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));

    return graphql(query, variables, attempt + 1);
  }

  const body = await response.json();

  if (!response.ok || body.errors) {
    throw new Error(`GraphQL ${response.status}: ${JSON.stringify(body.errors || body)}`);
  }

  return body.data;
}

const USER_QUERY = `query($login: String!) {
  viewer { login }
  user(login: $login) {
    name createdAt
    followers { totalCount }
    repositories(ownerAffiliations: OWNER) { totalCount }
    repositoriesContributedTo(contributionTypes: [COMMIT, PULL_REQUEST, PULL_REQUEST_REVIEW]) { totalCount }
    pullRequests { totalCount }
    merged: pullRequests(states: MERGED) { totalCount }
  }
}`;

const YEAR_QUERY = `query($login: String!, $from: DateTime!, $to: DateTime!, $withRepos: Boolean!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
      commitContributionsByRepository(maxRepositories: 100) @include(if: $withRepos) {
        contributions { totalCount }
        repository {
          languages(first: 8, orderBy: { field: SIZE, direction: DESC }) {
            totalSize
            edges { size node { name } }
          }
        }
      }
    }
  }
}`;

async function collect() {
  const { viewer, user } = await graphql(USER_QUERY, { login: LOGIN });
  const isOwnerToken = viewer.login.toLowerCase() === LOGIN.toLowerCase();
  const firstYear = new Date(user.createdAt).getUTCFullYear();
  const now = new Date();
  const years = [];

  for (let year = firstYear; year <= now.getUTCFullYear(); year++) {
    const from = new Date(Date.UTC(year, 0, 1)).toISOString();
    const to = year === now.getUTCFullYear() ? now.toISOString() : new Date(Date.UTC(year, 11, 31, 23, 59, 59)).toISOString();
    const data = await graphql(YEAR_QUERY, { login: LOGIN, from, to, withRepos: isOwnerToken });
    years.push({ year, ...data.user.contributionsCollection });
  }

  return { user, years, isOwnerToken };
}

function weightLanguages(years) {
  const totals = new Map();

  for (const { commitContributionsByRepository = [] } of years) {
    for (const { contributions, repository } of commitContributionsByRepository) {
      const { totalSize, edges } = repository.languages;

      if (!totalSize) continue;

      for (const { size, node } of edges) {
        totals.set(node.name, (totals.get(node.name) || 0) + (contributions.totalCount * size) / totalSize);
      }
    }
  }

  const sum = [...totals.values()].reduce((a, b) => a + b, 0);

  return [...totals.entries()]
    .map(([name, weight]) => ({ name, share: weight / sum }))
    .sort((a, b) => b.share - a.share);
}

function computeStreaks(days) {
  let longest = { length: 0, start: null, end: null };
  let run = { length: 0, start: null };

  for (const day of days) {
    if (day.contributionCount === 0) {
      run = { length: 0, start: null };
      continue;
    }

    run = { length: run.length + 1, start: run.start || day.date };

    if (run.length > longest.length) longest = { ...run, end: day.date };
  }

  const today = days.at(-1);
  // Today with zero contributions does not break the current streak yet.
  const lastCounted = today?.contributionCount === 0 ? days.length - 2 : days.length - 1;
  let current = 0;

  for (let i = lastCounted; i >= 0 && days[i].contributionCount > 0; i--) current++;

  return { longest, current };
}

function summarize({ user, years, isOwnerToken }, snapshot) {
  const days = years
    .flatMap((y) => y.contributionCalendar.weeks.flatMap((w) => w.contributionDays))
    .filter((d, i, all) => i === 0 || d.date !== all[i - 1].date)
    .sort((a, b) => a.date.localeCompare(b.date));
  const lastYear = days.slice(-365);
  const busiest = days.reduce((best, d) => (d.contributionCount > best.contributionCount ? d : best), days[0]);
  const activeDays = lastYear.filter((d) => d.contributionCount > 0).length;
  const lastYearTotal = lastYear.reduce((a, d) => a + d.contributionCount, 0);

  const monthly = new Map();

  for (const d of lastYear) {
    const key = d.date.slice(0, 7);
    monthly.set(key, (monthly.get(key) || 0) + d.contributionCount);
  }

  const weekday = Array(7).fill(0);

  for (const d of lastYear) weekday[(new Date(`${d.date}T00:00:00Z`).getUTCDay() + 6) % 7] += d.contributionCount;

  const live = {
    mergedPullRequests: user.merged.totalCount,
    pullRequests: user.pullRequests.totalCount,
    languages: weightLanguages(years),
  };

  return {
    login: LOGIN,
    generatedAt: new Date().toISOString(),
    fullRun: isOwnerToken,
    memberSince: user.createdAt.slice(0, 10),
    followers: user.followers.totalCount,
    ownedRepos: user.repositories.totalCount,
    reposContributedTo: user.repositoriesContributedTo.totalCount,
    ...(isOwnerToken ? live : pickSnapshot(snapshot, live)),
    allTime: days.reduce((a, d) => a + d.contributionCount, 0),
    yearly: years.map((y) => ({ year: y.year, total: y.contributionCalendar.totalContributions })),
    lastYearTotal,
    activeDays,
    averagePerActiveDay: activeDays ? Math.round(lastYearTotal / activeDays) : 0,
    busiestDay: { date: busiest.date, count: busiest.contributionCount },
    streaks: computeStreaks(days),
    monthly: [...monthly.entries()].map(([month, total]) => ({ month, total })).slice(-12),
    weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, i) => ({ day, total: weekday[i] })),
  };
}

function pickSnapshot(snapshot, live) {
  if (!snapshot) return live;

  return {
    mergedPullRequests: Math.max(snapshot.mergedPullRequests, live.mergedPullRequests),
    pullRequests: Math.max(snapshot.pullRequests, live.pullRequests),
    languages: snapshot.languages,
  };
}

// ---------- rendering ----------

const THEMES = {
  light: {
    surface: '#ffffff', border: '#d0d7de', text: '#1f2328', secondary: '#59636e', muted: '#818b98',
    grid: '#eaeef2', accent: '#2a78d6', accentSoft: '#cde2fb',
    categorical: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'], other: '#afb8c1',
  },
  dark: {
    surface: '#0d1117', border: '#30363d', text: '#e6edf3', secondary: '#9198a1', muted: '#6e7681',
    grid: '#21262d', accent: '#3987e5', accentSoft: '#184f95',
    categorical: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'], other: '#484f58',
  },
};

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const fmt = (n) => n.toLocaleString('en-US');
const compact = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : fmt(n));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const prettyDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);

  return `${MONTHS[m - 1]} ${d}, ${y}`;
};

function frame(t, width, height, title, subtitle, body, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
<style>
  text { font-family: ${FONT}; }
  .title { font-size: 16px; font-weight: 600; fill: ${t.text}; }
  .sub { font-size: 12px; fill: ${t.secondary}; }
  .tick { font-size: 11px; fill: ${t.muted}; }
  .val { font-size: 12px; font-weight: 600; fill: ${t.text}; }
  .lbl { font-size: 12px; fill: ${t.secondary}; }
  .big { font-size: 28px; font-weight: 700; fill: ${t.text}; letter-spacing: -0.5px; }
  .grow { transform-box: fill-box; transform-origin: bottom; animation: grow .9s cubic-bezier(.2,.8,.2,1) both; }
  .growx { transform-box: fill-box; transform-origin: left; animation: growx .9s cubic-bezier(.2,.8,.2,1) both; }
  .fade { animation: fade .6s ease-out both; }
  @keyframes grow { from { transform: scaleY(0); } }
  @keyframes growx { from { transform: scaleX(0); } }
  @keyframes fade { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .grow, .growx, .fade { animation: none; } }
</style>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${t.surface}" stroke="${t.border}"/>
<text class="title" x="24" y="36">${esc(title)}</text>
<text class="sub" x="24" y="56">${esc(subtitle)}</text>
${body}
</svg>`;
}

// Bars rise from the baseline with a 4px rounded top and a square foot.
function barPath(x, y, w, h, r = 4) {
  const rr = Math.min(r, h, w / 2);

  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function niceMax(value) {
  const exp = 10 ** Math.floor(Math.log10(value || 1));
  const steps = [1, 2, 2.5, 5, 10];

  return steps.map((s) => s * exp).find((s) => s >= value) ?? 10 * exp;
}

function columnChart(t, { width, height, title, subtitle, items, highlight, labelAll }) {
  const left = 52, right = 24, top = 84, bottom = 36;
  const plotW = width - left - right, plotH = height - top - bottom;
  const max = niceMax(Math.max(...items.map((i) => i.value)));
  const slot = plotW / items.length;
  const barW = Math.min(44, slot - 2 - slot * 0.28);
  const grid = [0, 0.5, 1]
    .map((f) => {
      const y = top + plotH - f * plotH;

      return `<line x1="${left}" x2="${width - right}" y1="${y}" y2="${y}" stroke="${t.grid}"/><text class="tick" x="${left - 8}" y="${y + 4}" text-anchor="end">${compact(max * f)}</text>`;
    })
    .join('');
  const maxValue = Math.max(...items.map((i) => i.value));
  const bars = items
    .map((item, i) => {
      const h = item.value ? Math.max(2, (item.value / max) * plotH) : 0;
      const x = left + i * slot + (slot - barW) / 2;
      const y = top + plotH - h;
      const isHighlight = highlight ? highlight(item, i) : true;
      const showLabel = labelAll || item.value === maxValue || i === items.length - 1;
      const value = showLabel && item.value
        ? `<text class="val fade" x="${x + barW / 2}" y="${y - 8}" text-anchor="middle" style="animation-delay:${0.5 + i * 0.06}s">${compact(item.value)}</text>`
        : '';

      return `${h ? `<path class="grow" style="animation-delay:${i * 0.06}s" d="${barPath(x, y, barW, h)}" fill="${isHighlight ? t.accent : t.accentSoft}"><title>${esc(item.label)}: ${fmt(item.value)}</title></path>` : ''}
${value}<text class="tick" x="${x + barW / 2}" y="${height - 14}" text-anchor="middle">${esc(item.label)}</text>`;
    })
    .join('\n');

  return frame(t, width, height, title, subtitle, `${grid}\n${bars}`, `${title}. ${items.map((i) => `${i.label} ${i.value}`).join(', ')}`);
}

function statsCard(t, s) {
  const width = 900, height = 244;
  const tiles = [
    ['All-time contributions', fmt(s.allTime), `since ${prettyDate(s.memberSince)}`],
    [`Contributions in ${s.yearly.at(-1).year}`, fmt(s.yearly.at(-1).total), `${fmt(s.lastYearTotal)} in the last 365 days`],
    ['Pull requests merged', fmt(s.mergedPullRequests), `${fmt(s.pullRequests)} opened`],
    ['Longest streak', `${fmt(s.streaks.longest.length)} days`, s.streaks.longest.start ? `${prettyDate(s.streaks.longest.start)} → ${prettyDate(s.streaks.longest.end)}` : ''],
    ['Current streak', `${fmt(s.streaks.current)} days`, `${s.activeDays} active days in the last year`],
    ['Busiest day', fmt(s.busiestDay.count), prettyDate(s.busiestDay.date)],
  ];
  const colW = (width - 48) / 3;
  const body = tiles
    .map(([label, value, note], i) => {
      const x = 24 + (i % 3) * colW;
      const y = 96 + Math.floor(i / 3) * 76;

      return `<g class="fade" style="animation-delay:${i * 0.08}s"><text class="lbl" x="${x}" y="${y}">${esc(label)}</text><text class="big" x="${x}" y="${y + 30}">${esc(value)}</text><text class="tick" x="${x}" y="${y + 47}">${esc(note)}</text></g>`;
    })
    .join('\n');
  const divider = `<line x1="24" x2="${width - 24}" y1="70" y2="70" stroke="${t.grid}"/>`;

  return frame(t, width, height, `${s.login} in numbers`, 'Public and private contributions, refreshed daily', `${divider}\n${body}`, tiles.map((x) => `${x[0]}: ${x[1]}`).join('. '));
}

function weekdayChart(t, s) {
  const width = 440, height = 300;
  const left = 56, right = 64, top = 82, rowH = 28;
  const max = Math.max(...s.weekday.map((d) => d.total));
  const plotW = width - left - right;
  const rows = s.weekday
    .map((d, i) => {
      const y = top + i * rowH;
      const w = max ? Math.max(2, (d.total / max) * plotW) : 0;
      const isWeekend = i >= 5;

      return `<text class="lbl" x="${left - 10}" y="${y + 14}" text-anchor="end">${d.day}</text>
<path class="growx" style="animation-delay:${i * 0.06}s" d="M${left},${y + 3}H${left + w - 4}Q${left + w},${y + 3} ${left + w},${y + 7}V${y + 15}Q${left + w},${y + 19} ${left + w - 4},${y + 19}H${left}Z" fill="${isWeekend ? t.accentSoft : t.accent}"><title>${d.day}: ${fmt(d.total)}</title></path>
<text class="val fade" x="${left + w + 8}" y="${y + 15}" style="animation-delay:${0.5 + i * 0.06}s">${compact(d.total)}</text>`;
    })
    .join('\n');

  return frame(t, width, height, 'Contributions by weekday', `Last 365 days · weekends exist, technically`, rows, `Contributions by weekday. ${s.weekday.map((d) => `${d.day} ${d.total}`).join(', ')}`);
}

function languagesChart(t, s) {
  const width = 440, height = 300;
  const top5 = s.languages.slice(0, 5);
  const otherShare = 1 - top5.reduce((a, l) => a + l.share, 0);
  const parts = [...top5.map((l, i) => ({ ...l, color: t.categorical[i] })), ...(otherShare > 0.005 ? [{ name: 'Other', share: otherShare, color: t.other }] : [])];
  const barX = 24, barY = 84, barW = width - 48, barH = 16, gap = 2;
  const usable = barW - gap * (parts.length - 1);
  let cursor = barX;
  const segments = parts
    .map((p, i) => {
      const w = Math.max(1, p.share * usable);
      const isFirst = i === 0, isLast = i === parts.length - 1;
      const r = 4;
      const d = `M${cursor + (isFirst ? r : 0)},${barY}H${cursor + w - (isLast ? r : 0)}${isLast ? `Q${cursor + w},${barY} ${cursor + w},${barY + r}V${barY + barH - r}Q${cursor + w},${barY + barH} ${cursor + w - r},${barY + barH}` : `V${barY + barH}`}H${cursor + (isFirst ? r : 0)}${isFirst ? `Q${cursor},${barY + barH} ${cursor},${barY + barH - r}V${barY + r}Q${cursor},${barY} ${cursor + r},${barY}` : `V${barY}`}Z`;
      const out = `<path d="${d}" fill="${p.color}"><title>${esc(p.name)}: ${(p.share * 100).toFixed(1)}%</title></path>`;
      cursor += w + gap;

      return out;
    })
    .join('');
  const legend = parts
    .map((p, i) => {
      const x = 24 + (i % 2) * 200;
      const y = 136 + Math.floor(i / 2) * 44;

      return `<g class="fade" style="animation-delay:${0.3 + i * 0.07}s"><rect x="${x}" y="${y - 10}" width="10" height="10" rx="3" fill="${p.color}"/><text class="lbl" x="${x + 18}" y="${y}">${esc(p.name)}</text><text class="val" x="${x + 18}" y="${y + 19}">${(p.share * 100).toFixed(1)}%</text></g>`;
    })
    .join('\n');

  return frame(t, width, height, 'What I write', 'Languages weighted by my commits per repo', `<g class="growx">${segments}</g>\n${legend}`, `Languages. ${parts.map((p) => `${p.name} ${(p.share * 100).toFixed(1)}%`).join(', ')}`);
}

function render(s) {
  const files = {};

  for (const [mode, t] of Object.entries(THEMES)) {
    files[`stats-${mode}.svg`] = statsCard(t, s);
    files[`yearly-${mode}.svg`] = columnChart(t, {
      width: 440, height: 300, title: 'Contributions per year', subtitle: '2026: the year sleep became optional',
      items: s.yearly.map((y) => ({ label: String(y.year), value: y.total })), labelAll: true,
      highlight: (_, i) => i === s.yearly.length - 1,
    });
    files[`monthly-${mode}.svg`] = columnChart(t, {
      width: 440, height: 300, title: 'Last 12 months', subtitle: `${fmt(s.lastYearTotal)} contributions · ~${fmt(s.averagePerActiveDay)} per active day`,
      items: s.monthly.map((m) => ({ label: MONTHS[Number(m.month.slice(5)) - 1], value: m.total })),
    });
    files[`weekday-${mode}.svg`] = weekdayChart(t, s);
    files[`languages-${mode}.svg`] = languagesChart(t, s);
  }

  return files;
}

function statsTable(s) {
  const rows = [
    ['All-time contributions', fmt(s.allTime)],
    ...s.yearly.map((y) => [`Contributions in ${y.year}`, fmt(y.total)]),
    ['Pull requests merged', fmt(s.mergedPullRequests)],
    ['Longest streak', `${s.streaks.longest.length} days`],
    ['Current streak', `${s.streaks.current} days`],
    ['Busiest day', `${fmt(s.busiestDay.count)} on ${prettyDate(s.busiestDay.date)}`],
    ['Repositories contributed to', fmt(s.reposContributedTo)],
    ...s.languages.slice(0, 5).map((l) => [`Language: ${l.name}`, `${(l.share * 100).toFixed(1)}%`]),
  ];

  return `| Stat | Value |\n|---|---|\n${rows.map(([a, b]) => `| ${a} | ${b} |`).join('\n')}\n\n<sub>Last refreshed ${s.generatedAt.slice(0, 10)}.</sub>`;
}

async function updateReadme(s) {
  const path = `${ROOT}README.md`;
  const readme = await readFile(path, 'utf8');
  const updated = readme.replace(/(<!-- STATS-TABLE:START -->)[\s\S]*?(<!-- STATS-TABLE:END -->)/, `$1\n${statsTable(s)}\n$2`);

  await writeFile(path, updated);
}

async function main() {
  const snapshot = await readFile(SNAPSHOT_PATH, 'utf8').then(JSON.parse).catch(() => null);
  const summary = summarize(await collect(), snapshot);

  await mkdir(`${ROOT}assets`, { recursive: true });

  for (const [name, svg] of Object.entries(render(summary))) await writeFile(`${ROOT}assets/${name}`, svg);

  if (summary.fullRun || !snapshot) await writeFile(SNAPSHOT_PATH, `${JSON.stringify(summary, null, 2)}\n`);

  await updateReadme(summary);
  console.log(`Charts written (full run: ${summary.fullRun}). All-time ${summary.allTime}, merged PRs ${summary.mergedPullRequests}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
