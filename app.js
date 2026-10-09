'use strict';

const API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const LOGO = abbr => `https://a.espncdn.com/i/teamlogos/nfl/500-dark/${abbr}.png`;

const TEAMS = {
  chi: { id: '3', abbr: 'chi', city: 'Chicago', name: 'Bears', theme: '#0B162A' },
  sf: { id: '25', abbr: 'sf', city: 'San Francisco', name: '49ers', theme: '#8E0000' },
};

const LIVE_REFRESH_MS = 30 * 1000;
const STALE_MS = 5 * 60 * 1000;
const UPCOMING_PREVIEW = 4;
// Networks you need an app for rather than a TV channel.
const STREAMERS = /prime video|netflix|peacock|youtube|espn\+|paramount\+|nfl\+|disney\+|hbo max/i;

const store = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / full */ }
  },
};

const hashTeam = location.hash.slice(1);
const state = {
  tab: TEAMS[hashTeam] ? hashTeam : (TEAMS[store.get('hd:tab')] ? store.get('hd:tab') : 'chi'),
  models: { chi: store.get('hd:model:chi'), sf: store.get('hd:model:sf') },
  errors: {},
  expanded: {},
  loading: {},
};

const app = document.getElementById('app');
const themeMeta = document.querySelector('meta[name="theme-color"]');

/* ---------- helpers ---------- */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const safeUrl = u => (typeof u === 'string' && /^https?:\/\//.test(u) ? u.replace(/^http:/, 'https:') : '');
// ESPN photos come in at full size; its image combiner can hand back a phone-sized one.
const thumb = (u, w) => (u.startsWith('https://a.espncdn.com/photo/')
  ? `https://a.espncdn.com/combiner/i?img=${u.slice('https://a.espncdn.com'.length)}&w=${w}`
  : u);

const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function when(g) {
  if (!g.timeValid) return { day: 'Date TBD', time: '' };
  const d = new Date(g.date);
  return { day: fmtDay.format(d), time: fmtTime.format(d) };
}

function ago(iso) {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso)) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function pickLogo(team) {
  const logos = team.logos || [];
  const dark = logos.find(l => l.rel?.includes('dark') && !l.rel.includes('scoreboard'));
  return safeUrl(dark?.href || logos[0]?.href) || LOGO(String(team.abbreviation || '').toLowerCase());
}

/* ---------- data ---------- */

function slimGame(e, teamId) {
  const c = e.competitions[0];
  const us = c.competitors.find(x => String(x.team.id) === teamId);
  const them = c.competitors.find(x => x !== us);
  const st = c.status.type;
  const networks = (c.broadcasts || []).map(b => b.media?.shortName).filter(Boolean);
  const link = rel => safeUrl((e.links || []).find(l => l.rel.includes(rel) && l.rel.includes('desktop'))?.href);
  return {
    id: e.id,
    week: e.week?.number,
    date: e.date,
    timeValid: e.timeValid !== false,
    state: st.state,
    detail: st.shortDetail,
    home: us.homeAway === 'home',
    opp: {
      id: String(them.team.id),
      abbr: them.team.abbreviation,
      name: them.team.shortDisplayName || them.team.displayName,
      logo: pickLogo(them.team),
    },
    us: us.score?.displayValue,
    them: them.score?.displayValue,
    won: us.winner === true,
    lost: them.winner === true,
    venue: c.venue?.fullName,
    city: [c.venue?.address?.city, c.venue?.address?.state].filter(Boolean).join(', '),
    tv: networks.join(' / '),
    stream: networks.length > 0 && networks.every(n => STREAMERS.test(n)),
    gamecast: link('gamecast') || link('summary'),
    recap: link('recap'),
  };
}

function pickStats(statsJ, recStats) {
  const cats = statsJ?.results?.stats?.categories || [];
  const get = (cat, name) => cats.find(c => c.name === cat)?.stats.find(s => s.name === name)?.displayValue;
  const pct = v => (v == null ? null : `${Number(v).toFixed(1)}%`);
  const signed = v => (v == null ? null : (Number(v) > 0 ? `+${v}` : String(v)));
  const allowed = recStats.avgPointsAgainst;
  return [
    ['Points / game', get('scoring', 'totalPointsPerGame')],
    ['Allowed / game', allowed == null ? null : allowed.toFixed(1)],
    ['Total yds / game', get('passing', 'yardsPerGame')],
    ['Pass yds / game', get('passing', 'netPassingYardsPerGame')],
    ['Rush yds / game', get('rushing', 'rushingYardsPerGame')],
    ['3rd down', pct(get('miscellaneous', 'thirdDownConvPct'))],
    ['Turnover margin', signed(get('miscellaneous', 'turnOverDifferential'))],
    ['Sacks', get('defensive', 'sacks')],
  ].filter(([, v]) => v != null).map(([label, value]) => ({ label, value }));
}

function pickNews(newsJ) {
  const arts = (newsJ?.articles || []).filter(a => !a.premium && safeUrl(a.links?.web?.href));
  const byDate = (a, b) => new Date(b.published) - new Date(a.published);
  const slim = a => ({
    title: a.headline,
    img: thumb(safeUrl(a.images?.[0]?.url), 480),
    url: safeUrl(a.links.web.href),
    date: a.published,
  });
  const teamCount = a => (a.categories || []).filter(c => c.type === 'team').length;
  const stories = arts.filter(a => a.type !== 'Media').sort(byDate);
  // League-wide roundups tag many teams; prefer stories that are really about this one.
  const focused = stories.filter(a => teamCount(a) <= 2);
  return {
    videos: arts.filter(a => a.type === 'Media').sort(byDate).slice(0, 8).map(slim),
    news: (focused.length >= 4 ? focused : stories).slice(0, 6).map(slim),
  };
}

function pickStars(sumJ, teamId) {
  const ours = (sumJ?.leaders || []).find(t => String(t.team?.id) === teamId);
  if (!ours) return [];
  return ['passingYards', 'rushingYards', 'receivingYards'].map(name => {
    const cat = ours.leaders.find(c => c.name === name);
    const top = cat?.leaders?.[0];
    return top && {
      cat: cat.displayName.replace(' Yards', ''),
      name: top.athlete?.displayName,
      line: top.displayValue,
      img: safeUrl(top.athlete?.headshot?.href),
    };
  }).filter(Boolean);
}

function streakOf(games) {
  const done = games.filter(g => g.state === 'post' && (g.won || g.lost)).reverse();
  if (!done.length) return null;
  let n = 0;
  while (n < done.length && done[n].won === done[0].won) n++;
  return `${done[0].won ? 'W' : 'L'}${n}`;
}

async function loadTeam(key) {
  const t = TEAMS[key];
  const prev = state.models[key];
  const [teamJ, schedJ, statsJ, newsJ] = await Promise.all([
    getJSON(`${API}/teams/${t.abbr}`),
    getJSON(`${API}/teams/${t.abbr}/schedule`),
    getJSON(`${API}/teams/${t.id}/statistics`).catch(() => null),
    getJSON(`${API}/news?team=${t.id}&limit=50`).catch(() => null),
  ]);

  const games = (schedJ.events || []).map(e => slimGame(e, t.id));
  const last = [...games].reverse().find(g => g.state === 'post');

  // The game summary is a big payload; only fetch it when the last game changes.
  let stars = prev?.starsFor === last?.id ? prev.stars : [];
  if (last && prev?.starsFor !== last.id) {
    stars = pickStars(await getJSON(`${API}/summary?event=${last.id}`).catch(() => null), t.id);
  }

  const rec = teamJ.team.record?.items || [];
  const recStats = Object.fromEntries((rec.find(r => r.type === 'total')?.stats || []).map(s => [s.name, s.value]));
  const diff = recStats.pointDifferential;

  return {
    record: rec.find(r => r.type === 'total')?.summary || '0-0',
    homeRec: rec.find(r => r.type === 'home')?.summary,
    awayRec: rec.find(r => r.type === 'road')?.summary,
    standing: teamJ.team.standingSummary,
    diff: diff == null ? null : (diff > 0 ? `+${diff}` : String(diff)),
    streak: streakOf(games),
    season: schedJ.season?.year,
    games,
    stats: pickStats(statsJ, recStats),
    stars,
    starsFor: last?.id,
    ...pickNews(newsJ),
  };
}

async function refresh(key) {
  if (state.loading[key]) return;
  state.loading[key] = true;
  try {
    const model = await loadTeam(key);
    const sig = JSON.stringify(model);
    const changed = state.models[key]?.sig !== sig;
    state.models[key] = { ...model, sig, updated: Date.now() };
    state.errors[key] = false;
    store.set(`hd:model:${key}`, state.models[key]);
    render(changed && key === state.tab);
  } catch (err) {
    console.error(err);
    state.errors[key] = true;
    render(!state.models[key] && key === state.tab);
  } finally {
    state.loading[key] = false;
  }
}

/* ---------- views ---------- */

const head = (label, extra = '') => `<div class="card-head"><h2>${esc(label)}</h2>${extra}</div>`;
const img = (src, cls = '', alt = '') => (src ? `<img class="${cls}" src="${esc(src)}" alt="${esc(alt)}" loading="lazy">` : '');

function hero(t, m) {
  const chips = m ? [
    ['Streak', m.streak], ['Home', m.homeRec], ['Away', m.awayRec], ['Pt diff', m.diff],
  ].filter(([, v]) => v) : [];
  return `
  <header class="hero">
    <img class="hero-ghost" src="${LOGO(t.abbr)}" alt="">
    <div class="hero-top">
      <span class="wordmark">Game Day</span>
      <button class="icon-btn" type="button" data-action="refresh" aria-label="Refresh">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/></svg>
      </button>
    </div>
    <div class="hero-main">
      <img class="hero-logo" src="${LOGO(t.abbr)}" alt="${esc(t.name)} logo">
      <div>
        <p class="hero-city">${esc(t.city)}</p>
        <h1>${esc(t.name)}</h1>
        <p class="hero-record"><b>${esc(m ? m.record.replace(/-/g, '–') : '–')}</b>${m?.standing ? `<span>${esc(m.standing)}</span>` : ''}</p>
      </div>
    </div>
    ${chips.length ? `<div class="chips">${chips.map(([k, v]) => `<span class="chip"><i>${k}</i>${esc(v)}</span>`).join('')}</div>` : ''}
  </header>`;
}

function side(name, logo, score, sub) {
  return `<div class="side">${img(logo, 'side-logo', name)}<b>${esc(name)}</b>${
    score != null ? `<span class="side-score">${esc(score)}</span>` : (sub ? `<span class="side-sub">${esc(sub)}</span>` : '')
  }</div>`;
}

function nextCard(t, m) {
  const g = m.games.find(x => x.state === 'in') || m.games.find(x => x.state === 'pre');
  if (!g) {
    return `<section class="card">${head('Next up')}<p class="empty">No games on the schedule right now. See you next season.</p></section>`;
  }
  const live = g.state === 'in';
  const w = when(g);
  const us = side(t.name, LOGO(t.abbr), live ? g.us : null, m.record);
  const them = side(g.opp.name, g.opp.logo, live ? g.them : null);
  const rival = Object.values(TEAMS).some(x => x.id === g.opp.id);
  const tag = live ? '<span class="pill live"><i></i>Live</span>' : '';
  const watch = g.tv ? `
    <div class="watch${g.stream ? ' stream' : ''}">
      <span class="watch-label">Watch on</span><b>${esc(g.tv)}</b>
      ${g.stream ? '<span class="watch-note">Streaming only — you’ll need the app</span>' : ''}
    </div>` : '';
  return `
  <section class="card next${live ? ' is-live' : ''}">
    ${head(`${live ? 'Now playing' : 'Next up'} · Week ${g.week}`, tag)}
    ${rival ? '<p class="rival">Bears vs 49ers — choose your side of the couch.</p>' : ''}
    <div class="matchup">
      ${g.home ? them : us}
      <div class="mid">${live ? `<b>${esc(g.detail)}</b>` : '<b>at</b>'}</div>
      ${g.home ? us : them}
    </div>
    <p class="when">${esc(w.day)}${w.time ? `<span>·</span>${esc(w.time)}` : ''}</p>
    <p class="where">${esc([g.venue, g.city].filter(Boolean).join(' · '))}</p>
    ${watch}
    ${live
      ? (g.gamecast ? `<div class="btns"><a class="btn primary" href="${esc(g.gamecast)}" target="_blank" rel="noopener">Follow live on ESPN</a></div>` : '')
      : (g.timeValid ? `<div class="countdown" data-kick="${esc(g.date)}"></div>` : '')}
  </section>`;
}

function gameRow(g) {
  const w = when(g);
  const done = g.state === 'post';
  const result = g.won ? 'W' : g.lost ? 'L' : 'T';
  const net = g.tv ? `<em class="net${g.stream ? ' stream' : ''}">${esc(g.tv.split(' / ')[0])}</em>` : '';
  const inner = `
    <span class="row-wk">Wk ${g.week}</span>
    ${img(g.opp.logo, 'row-logo')}
    <span class="row-opp"><i>${g.home ? 'vs' : '@'}</i> ${esc(g.opp.name)}</span>
    ${done
      ? `<span class="row-end"><b class="res ${result}">${result}</b>${esc(g.us)}–${esc(g.them)}</span>`
      : `<span class="row-end"><b>${esc(w.day)}</b>${[esc(w.time), net].filter(Boolean).join(' · ')}</span>`}`;
  return done && g.gamecast
    ? `<a class="row" href="${esc(g.gamecast)}" target="_blank" rel="noopener">${inner}</a>`
    : `<div class="row">${inner}</div>`;
}

function upcoming(m) {
  const pre = m.games.filter(g => g.state === 'pre');
  const rest = pre.slice(m.games.some(g => g.state === 'in') ? 0 : 1);
  if (!rest.length) return '';
  const open = state.expanded.upcoming;
  const shown = open ? rest : rest.slice(0, UPCOMING_PREVIEW);
  const rows = [];
  let prevWeek = (pre[0] || rest[0]).week;
  for (const g of shown) {
    if (g.week - prevWeek === 2) rows.push(`<div class="row bye"><span class="row-wk">Wk ${g.week - 1}</span><span class="row-opp">Bye week</span></div>`);
    rows.push(gameRow(g));
    prevWeek = g.week;
  }
  const more = rest.length > UPCOMING_PREVIEW
    ? `<button class="more" type="button" data-action="toggle" data-key="upcoming">${open ? 'Show less' : `Full schedule (${rest.length} games)`}</button>`
    : '';
  return `<section class="card">${head('Upcoming games')}<div class="rows">${rows.join('')}</div>${more}</section>`;
}

function stats(m) {
  if (!m.stats.length) return '';
  return `
  <section class="card">
    ${head('Team stats', `<span class="muted">${esc(m.season || '')} season</span>`)}
    <div class="stat-grid">${m.stats.map(s => `<div class="stat"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join('')}</div>
  </section>`;
}

function lastCard(t, m) {
  const g = [...m.games].reverse().find(x => x.state === 'post');
  if (!g) return '';
  const result = g.won ? 'W' : g.lost ? 'L' : 'T';
  const names = g.home ? `${g.opp.name} vs ${t.name}` : `${t.name} vs ${g.opp.name}`;
  const yt = `https://www.youtube.com/results?search_query=${encodeURIComponent(`NFL ${names} highlights Week ${g.week} ${m.season || ''}`.trim())}`;
  const starHtml = m.stars.length ? `
    <div class="stars">${m.stars.map(s => `
      <div class="star">
        <span class="star-img">${img(s.img)}</span>
        <span class="star-cat">${esc(s.cat)}</span>
        <b>${esc(s.name)}</b>
        <span class="star-line">${esc(s.line)}</span>
      </div>`).join('')}
    </div>` : '';
  return `
  <section class="card last">
    ${head(`Last game · Week ${g.week}`, `<span class="res big ${result}">${result === 'W' ? 'Win' : result === 'L' ? 'Loss' : 'Tie'}</span>`)}
    <div class="final">
      <div class="final-team">${img(LOGO(t.abbr))}<b>${esc(g.us)}</b></div>
      <span class="final-mid">Final</span>
      <div class="final-team"><b>${esc(g.them)}</b>${img(g.opp.logo)}</div>
    </div>
    <p class="where">${g.home ? 'vs' : 'at'} ${esc(g.opp.name)} · ${esc(when(g).day)}</p>
    ${starHtml}
    <div class="btns">
      <a class="btn primary" href="${esc(yt)}" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>Game highlights
      </a>
      ${g.recap ? `<a class="btn" href="${esc(g.recap)}" target="_blank" rel="noopener">Recap</a>` : ''}
    </div>
  </section>`;
}

function videos(m) {
  if (!m.videos.length) return '';
  return `
  <section class="card flush">
    ${head('Highlights & clips')}
    <div class="reel">${m.videos.map(v => `
      <a class="clip" href="${esc(v.url)}" target="_blank" rel="noopener">
        <span class="clip-thumb">${img(v.img)}<i><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></i></span>
        <b>${esc(v.title)}</b>
        <span class="muted">${esc(ago(v.date))}</span>
      </a>`).join('')}
    </div>
  </section>`;
}

function headlines(m) {
  if (!m.news.length) return '';
  return `
  <section class="card">
    ${head('Headlines')}
    <div class="news">${m.news.map(n => `
      <a class="story" href="${esc(n.url)}" target="_blank" rel="noopener">
        <span><b>${esc(n.title)}</b><i class="muted">${esc(ago(n.date))}</i></span>
        ${img(n.img)}
      </a>`).join('')}
    </div>
  </section>`;
}

function results(m) {
  const done = m.games.filter(g => g.state === 'post').reverse();
  if (done.length < 2) return '';
  return `<section class="card">${head('Results')}<div class="rows">${done.map(gameRow).join('')}</div></section>`;
}

function footer(key, m) {
  const note = state.errors[key] ? 'Offline — showing the last update' : `Updated ${fmtTime.format(new Date(m.updated))}`;
  return `<footer class="foot"><p>${esc(note)} · Scores, stats and clips from ESPN</p><p>A fan project. Not affiliated with the NFL or its teams.</p></footer>`;
}

function skeleton(key) {
  if (state.errors[key]) {
    return `<section class="card"><p class="empty">Couldn’t reach the scores feed.</p><div class="btns"><button class="btn primary" type="button" data-action="refresh">Try again</button></div></section>`;
  }
  return '<section class="card skel"></section><section class="card skel short"></section><section class="card skel"></section>';
}

function render(full = true) {
  const key = state.tab;
  const t = TEAMS[key];
  const m = state.models[key];
  document.body.dataset.team = key;
  themeMeta.content = t.theme;
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.team === key;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-pressed', on);
  }
  for (const el of document.querySelectorAll('[data-record]')) {
    el.textContent = state.models[el.dataset.record]?.record || ' ';
  }
  if (!full && app.dataset.shown === key) {
    const foot = app.querySelector('.foot');
    if (foot && m) foot.outerHTML = footer(key, m);
    return;
  }
  app.dataset.shown = key;
  app.innerHTML = hero(t, m) + `<div class="stack">${m
    ? nextCard(t, m) + upcoming(m) + stats(m) + lastCard(t, m) + videos(m) + headlines(m) + results(m) + footer(key, m)
    : skeleton(key)}</div>`;
  tick();
}

function tick() {
  const el = app.querySelector('[data-kick]');
  if (!el) return;
  const mins = Math.floor((new Date(el.dataset.kick) - Date.now()) / 60000);
  if (mins <= 0) {
    el.innerHTML = '<p class="kick-soon">Kickoff!</p>';
    return;
  }
  const parts = [[Math.floor(mins / 1440), 'days'], [Math.floor((mins % 1440) / 60), 'hrs'], [mins % 60, 'min']];
  el.innerHTML = parts.map(([n, l]) => `<div><b>${n}</b><span>${l}</span></div>`).join('');
}

/* ---------- wiring ---------- */

function switchTo(key) {
  if (key === state.tab) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  state.tab = key;
  state.expanded = {};
  store.set('hd:tab', key);
  history.replaceState(null, '', `#${key}`);
  render();
  window.scrollTo(0, 0);
}

document.addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (tab) return switchTo(tab.dataset.team);
  const act = e.target.closest('[data-action]');
  if (!act) return;
  if (act.dataset.action === 'refresh') {
    act.classList.add('spin');
    Promise.all(Object.keys(TEAMS).map(refresh)).finally(() => act.classList.remove('spin'));
  } else if (act.dataset.action === 'toggle') {
    state.expanded[act.dataset.key] = !state.expanded[act.dataset.key];
    render();
  }
});

const refreshAll = () => Object.keys(TEAMS).forEach(refresh);
const isLive = () => Object.values(state.models).some(m => m?.games.some(g => g.state === 'in'));
const isStale = () => Object.values(state.models).some(m => !m || Date.now() - m.updated > STALE_MS);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (isLive() || isStale())) refreshAll();
});

setInterval(() => {
  tick();
  if (!document.hidden && (isLive() || isStale())) refreshAll();
}, LIVE_REFRESH_MS);

render();
refreshAll();
