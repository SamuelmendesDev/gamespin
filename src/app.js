/* GameSpin — app.js */
'use strict';

// ── Helpers for Epic codename detection ───────────────────────────────────────
function isEpicCodename(name) {
  if (!name) return true;
  const words = name.trim().split(' ');
  if (words.length === 1) return true;
  if (/(production|project|prototype|client|beta|test)/i.test(name)) return true;
  if (words.length === 2 && words.every(w => /^[A-Z][a-z]+$/.test(w)) && name.length < 20) return true;
  return false;
}

function extractNameFromDesc(desc, fallback) {
  if (!desc) return null;
  const idx = desc.search(/ is | was | are | lets /i);
  if (idx > 5 && idx < 70) {
    const candidate = desc.substring(0, idx).trim();
    if (candidate && candidate !== fallback && candidate.split(' ').length >= 2) {
      return candidate;
    }
  }
  return null;
}

// ── State ──────────────────────────────────────────────────────────────────────
let steamGames    = [];  // raw Steam games
let epicGames     = [];  // raw Epic games
let allGames      = [];  // merged (source='steam'|'epic')
let filteredGames = [];
let installedSteam = new Set();
let favorites     = new Set(); // persisted game ids
let hiddenGames   = new Set(); // games hidden by user
let gogGames      = [];           // GOG library
let installedGog  = new Set();

// ── Global progress tracking ────────────────────────────────────────
const globalProgress = {
  covers: { done: 0, total: 0 },
  genres: { done: 0, total: 0 },
  update() {
    const totalDone  = this.covers.done  + this.genres.done;
    const totalItems = this.covers.total + this.genres.total;
    if (totalItems === 0) { hideGlobalProgress(); return; }
    const pct = Math.round((totalDone / totalItems) * 100);
    const fp = $('global-progress-fill');
    const tp = $('global-progress-text');
    const pp = $('global-progress-pct');
    const gp = $('global-progress');
    if (fp) fp.style.width = pct + '%';
    if (pp) pp.textContent = pct + '%';
    if (tp) {
      const parts = [];
      if (this.covers.done < this.covers.total) parts.push(`capas ${this.covers.done}/${this.covers.total}`);
      if (this.genres.done  < this.genres.total)  parts.push(`gêneros ${this.genres.done}/${this.genres.total}`);
      tp.textContent = parts.length ? 'Carregando: ' + parts.join(' · ') : 'Concluído';
    }
    if (gp) gp.style.display = pct < 100 ? '' : 'none';
    if (pct >= 100) setTimeout(hideGlobalProgress, 1500);
  }
};

function hideGlobalProgress() {
  const gp = $('global-progress');
  if (gp) gp.style.display = 'none';
}
let installedEpic  = new Set();
let visibleCount  = 60;
let activeGenres  = new Set();
let genreData     = {};
let currentTab    = 'all'; // 'all' | 'steam' | 'epic'
let currentConfig = {};
let featuredAppid = null;
const noImageSet  = new Set();

const GENRE_ICONS = {
  'Action':'⚔️','Adventure':'🗺️','RPG':'🧙','Strategy':'♟️','Simulation':'🏗️',
  'Sports':'⚽','Racing':'🏎️','Horror':'👻','Puzzle':'🧩','Shooter':'🎯',
  'Platformer':'🏃','Fighting':'🥊','Stealth':'🕵️','Survival':'🏕️',
  'Indie':'🎨','Casual':'😊','Free to Play':'🆓','Early Access':'🔧',
  'MMO':'👥','Massively Multiplayer':'👾','Anime':'🌸','Sandbox':'🏖️',
  'Tower Defense':'🗼','Card Game':'🃏','Visual Novel':'📖'
};

const $ = id => document.getElementById(id);


// ── Splash screen ──────────────────────────────────────────────────────────────
function splashMsg(msg, pct) {
  const el = $('splash-subtitle');
  const bar = $('splash-bar');
  if (el) el.textContent = msg;
  if (bar && pct !== undefined) bar.style.width = pct + '%';
}

function hideSplash() {
  const splash = $('splash');
  const app    = $('app');
  if (!splash) return;
  splash.classList.add('hiding');
  if (app) app.style.display = '';
  setTimeout(() => { splash.style.display = 'none'; }, 450);
}

// ── Theme ──────────────────────────────────────────────────────────────────────
function applyTheme(light) {
  document.body.classList.toggle('light', light);
  const icon = $('theme-icon');
  if (icon) icon.textContent = light ? '🌙' : '☀️';
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light');
  const icon = $('theme-icon');
  if (icon) icon.textContent = isLight ? '🌙' : '☀️';
  currentConfig.lightTheme = isLight;
  window.api.saveConfig(currentConfig);
}

// ── Boot ───────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  bindEvents();

  // Safety net — always show app after 20s even if something hangs
  const splashTimeout = setTimeout(() => {
    console.warn('[Boot] Splash timeout — forcing show');
    hideSplash();
  }, 20000);

  const cfg = await window.api.getConfig();
  const savedFavs = await window.api.getFavorites();
  savedFavs.forEach(id => favorites.add(id));
  const savedHidden = await window.api.getHiddenGames();
  savedHidden.forEach(id => hiddenGames.add(id));
  currentConfig = cfg || {};
  if (cfg.key && cfg.steamid) {
    $('cfg-key').value     = cfg.key;
    $('cfg-steamid').value = cfg.steamid;
    if (cfg.steamPath) $('cfg-path').value = cfg.steamPath;
  }

  splashMsg('Verificando contas…', 25);
  const [epicAccount, gogAccount] = await Promise.all([
    window.api.epicGetAccount(),
    window.api.gogGetAccount()
  ]);
  const hasSteam = !!(cfg.key && cfg.steamid);
  const hasEpic  = !!epicAccount;
  const hasGog   = !!gogAccount;

  // Show GOG connected state if account found
  if (gogAccount) updateGogUI(gogAccount.username, 0);

  try {
    if (hasSteam || hasEpic || hasGog) {
      splashMsg('Conectando bibliotecas…', 40);
      await loadAllLibraries(hasSteam, hasEpic, hasGog);
      splashMsg('Pronto!', 100);
      setTimeout(hideSplash, 300);
    } else {
      splashMsg('Bem-vindo!', 100);
      setTimeout(hideSplash, 600);
    }
  } catch(e) {
    console.error('[Boot] Error:', e);
    hideSplash();
  } finally {
    clearTimeout(splashTimeout);
  }
});

// ── Events ─────────────────────────────────────────────────────────────────────
function bindEvents() {
  // Settings
  $('btn-open-settings').addEventListener('click', openSettings);
  $('btn-theme-toggle').addEventListener('click', toggleTheme);
  $('btn-open-settings-connect').addEventListener('click', openSettings);
  $('btn-empty-connect').addEventListener('click', openSettings);
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('settings-overlay').addEventListener('click', e => { if (e.target.classList.contains('settings-overlay')) closeSettings(); });

  // GOG
  $('btn-gog-auth').addEventListener('click', startGogAuth);
  $('btn-gog-exchange').addEventListener('click', gogExchangeCode);
  $('btn-gog-disconnect').addEventListener('click', disconnectGog);
  $('cfg-gog-code').addEventListener('keydown', e => { if (e.key === 'Enter') gogExchangeCode(); });

  // Steam
  $('btn-steam-login').addEventListener('click', steamLoginAuth);
  $('btn-steam-connect').addEventListener('click', connectSteam);
  $('btn-steam-disconnect').addEventListener('click', disconnectSteam);
  $('btn-detect').addEventListener('click', autoDetectSteam);
  $('btn-save-path').addEventListener('click', savePath);
  $('link-apikey').addEventListener('click', () => openLink('https://steamcommunity.com/dev/apikey'));
  $('link-steamid').addEventListener('click', () => openLink('https://steamid.io'));
  $('cfg-key').addEventListener('keydown',    e => { if (e.key === 'Enter') $('cfg-steamid').focus(); });
  $('cfg-steamid').addEventListener('keydown',e => { if (e.key === 'Enter') connectSteam(); });

  // Epic
  $('btn-epic-auth').addEventListener('click', startEpicAuth);
  $('btn-epic-exchange').addEventListener('click', epicExchangeCode);
  $('btn-epic-disconnect').addEventListener('click', disconnectEpic);
  $('cfg-epic-code').addEventListener('keydown', e => { if (e.key === 'Enter') epicExchangeCode(); });

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Library
  $('search-input').addEventListener('input', applyFilters);
  $('sort-select').addEventListener('change', applyFilters);
  $('btn-refresh').addEventListener('click', refreshAll);
  $('btn-load-more').addEventListener('click', loadMore);
  $('random-btn').addEventListener('click', pickRandom);
  $('btn-clear-genres').addEventListener('click', clearGenres);

  // SteamGridDB

  // Cache
  $('btn-clear-library-cache').addEventListener('click', clearLibraryCache);
  $('btn-clear-genre-cache').addEventListener('click', clearGenreCache);

  // Modal
  $('modal-overlay').addEventListener('click', e => { if (e.target === $('modal-overlay')) closeModal(); });

  // Delegation
  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-genre]');
    if (chip) { toggleGenre(chip.dataset.genre); return; }
    const card = e.target.closest('[data-gameid]');
    if (card && !e.target.closest('button')) { openModal(card.dataset.gameid); return; }
    const btn = e.target.closest('button[data-action]');
    if (btn) handleAction(btn.dataset.action, btn.dataset);
  });

  // Keyboard
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeModal(); closeSettings(); }
    if (e.key === ' ' && !['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)) {
      e.preventDefault(); pickRandom();
    }
  });
}

function handleAction(action, data) {
  const id = data.gameid || null;
  if (action === 'launch')       { launchGame(id); }
  if (action === 'launch-close') { launchGame(id); closeModal(); }
  if (action === 'random')       { pickRandom(); }
  if (action === 'details')      { openModal(id); }
  if (action === 'close')        { closeModal(); }
  if (action === 'highlight')    { closeModal(); showFeatured(getGameById(id)); }
  if (action === 'local-img')    { pickLocalImage(id); }
  if (action === 'edit-name')    { editGameName(id); }
  if (action === 'close-featured')  { $('featured-wrap').style.display = 'none'; featuredAppid = null; }
  if (action === 'fav-toggle')       { toggleFavorite(id); }
  if (action === 'hide-toggle')      { toggleHidden(id); }
}


// ── Steam OpenID login ────────────────────────────────────────────────────────
async function steamLoginAuth() {
  const btn = $('btn-steam-login');
  btn.innerHTML = '<span class="spin"></span> ABRINDO…';
  btn.disabled = true;
  try {
    const res = await window.api.steamStartAuth();
    if (res.cancelled) {
      btn.innerHTML = '🔵 DETECTAR STEAM ID'; btn.disabled = false; return;
    }
    if (res.steamid) {
      $('cfg-steamid').value = res.steamid;
      btn.innerHTML = '✓ Steam ID detectado!';
      btn.style.background = 'linear-gradient(135deg,#22c55e,#16a34a)';
      if (!$('cfg-key').value) $('cfg-key').focus();
    }
  } catch(e) {
    btn.innerHTML = '🔵 DETECTAR STEAM ID'; btn.disabled = false;
    showError('cfg-steam-error', e.message || 'Erro ao fazer login Steam.');
  }
}

// ── Steam path helpers ─────────────────────────────────────────────────────────
async function autoDetectSteam() {
  const res = await window.api.detectSteam();
  if (res.error) {
    $('path-hint').textContent = '✗ ' + res.error;
    $('path-hint').style.color = 'var(--red)';
    return;
  }
  $('cfg-path').value = res.path;
  $('path-hint').textContent = '✓ Steam detectado automaticamente';
  $('path-hint').style.color = 'var(--green)';
}

async function savePath() {
  const steamPath = $('cfg-path').value.trim();
  if (!steamPath) return;
  currentConfig.steamPath = steamPath;
  await window.api.saveConfig(currentConfig);
  $('path-hint').textContent = '✓ Salvo';
  $('path-hint').style.color = 'var(--green)';
  const arr = await window.api.getInstalled(steamPath);
  installedSteam = new Set(arr.map(id => 'steam_' + id));
  $('cfg-steam-info').textContent = `${steamGames.length} jogos · ${installedSteam.size} instalados`;
  renderGames();
}

// ── Settings ───────────────────────────────────────────────────────────────────
function openSettings() { $('settings-overlay').classList.add('open'); updateCacheInfo(); }
function closeSettings() { $('settings-overlay').classList.remove('open'); }

// ── Steam ──────────────────────────────────────────────────────────────────────
async function connectSteam() {
  const key     = $('cfg-key').value.trim();
  const steamid = $('cfg-steamid').value.trim();
  if (!key || !steamid)          { showError('cfg-steam-error', 'Preencha a API Key e o Steam ID.'); return; }
  if (!/^\d{17}$/.test(steamid)) { showError('cfg-steam-error', 'Steam ID inválido — deve ter 17 dígitos.'); return; }

  const btn = $('btn-steam-connect');
  btn.innerHTML = '<span class="spin"></span>CONECTANDO…'; btn.disabled = true;
  $('cfg-steam-error').style.display = 'none';

  try {
    currentConfig = Object.assign(currentConfig, { key, steamid, steamPath: $('cfg-path').value.trim() });
    await window.api.saveConfig(currentConfig);
    closeSettings();
    await loadSteamLibrary();
  } catch(e) {
    showError('cfg-steam-error', e.message || 'Erro ao conectar Steam.');
    btn.innerHTML = 'CONECTAR STEAM'; btn.disabled = false;
  }
}

async function disconnectSteam() {
  steamGames = [];
  installedSteam.clear();
  currentConfig = Object.assign(currentConfig, { key: '', steamid: '', steamPath: '' });
  await window.api.saveConfig(currentConfig);
  $('cfg-steam-connected').style.display    = 'none';
  $('cfg-steam-disconnected').style.display = '';
  $('cfg-path-section').style.display       = 'none';
  $('steam-account-row').style.display      = 'none';
  mergeAndRender();
}

async function loadSteamLibrary() {
  const { key, steamid, steamPath } = currentConfig;
  splashMsg('Carregando biblioteca Steam…', 55);
  const [gamesRes, playerRes, installedArr] = await Promise.all([
    window.api.getGames({ key, steamid }),
    window.api.getPlayer({ key, steamid }).catch(() => null),
    steamPath ? window.api.getInstalled(steamPath) : []
  ]);

  steamGames     = gamesRes.games.map(g => Object.assign(g, { source: 'steam', id: 'steam_' + g.appid }));
  installedSteam = new Set(installedArr.map(id => 'steam_' + id));

  if (playerRes) {
    updateSteamUI(playerRes, gamesRes.games.length);
  }

  // Load cached details
  const appids = gamesRes.games.map(g => g.appid);
  const cached = await window.api.getCachedDetails(appids);
  for (const [appid, d] of Object.entries(cached)) {
    genreData['steam_' + appid] = d;
  }

  // Load local images for all sources (steam_ and epic_ prefixed keys)
  const localImgs = await window.api.getLocalImages();
  for (const [key, filePath] of Object.entries(localImgs || {})) {
    if (!genreData[key]) genreData[key] = {};
    genreData[key].localImage = 'file://' + filePath.replace(/\\/g, '/');
  }

  mergeAndRender();
  startGenreFetch('steam');
  // IGDB as fallback for Steam games that failed the Steam API fetch
  setTimeout(() => fetchIgdbGenresBackground('steam'), 5000);
}

function updateSteamUI(playerRes, count) {
  $('cfg-steam-avatar').src = playerRes.avatar;
  $('cfg-steam-name').textContent = playerRes.name;
  $('cfg-steam-info').textContent = `${count} jogos`;
  $('cfg-steam-connected').style.display    = '';
  $('cfg-steam-disconnected').style.display = 'none';
  $('cfg-path-section').style.display       = '';
  $('sidebar-steam-avatar').src = playerRes.avatar;
  $('sidebar-steam-name').textContent = playerRes.name;
  $('steam-account-row').style.display = 'flex';
  $('no-accounts').style.display = 'none';
}

// ── Epic ───────────────────────────────────────────────────────────────────────
async function startEpicAuth() {
  const btn = $('btn-epic-auth');
  btn.innerHTML = '<span class="spin"></span>ABRINDO LOGIN…';
  btn.disabled = true;
  $('cfg-epic-error').style.display = 'none';

  try {
    const res = await window.api.epicStartAuth();
    if (res.cancelled) {
      btn.innerHTML = '<span>🎮</span> ENTRAR COM EPIC GAMES';
      btn.disabled = false; return;
    }
    if (res.code) {
      btn.innerHTML = '<span class="spin"></span>AUTENTICANDO…';
      const authRes = await window.api.epicExchangeCode(res.code);
      if (!authRes.ok) throw new Error('Falha na autenticação');
      await loadEpicLibrary();
      closeSettings();
    }
  } catch(e) {
    showError('cfg-epic-error', e.message || 'Erro ao conectar Epic.');
    btn.innerHTML = '<span>🎮</span> ENTRAR COM EPIC GAMES';
    btn.disabled = false;
  }
}

async function epicExchangeCode() {
  // Manual fallback
  let raw = $('cfg-epic-code').value.trim();
  if (!raw) { showError('cfg-epic-error', 'Cole o código de autorização.'); return; }
  let code = raw;
  try {
    const parsed = JSON.parse(raw);
    code = parsed.authorizationCode || parsed.exchangeCode || parsed.code || raw;
  } catch {}
  code = code.trim();
  const btn = $('btn-epic-exchange');
  btn.innerHTML = '<span class="spin"></span>VERIFICANDO…'; btn.disabled = true;
  $('cfg-epic-error').style.display = 'none';
  try {
    const res = await window.api.epicExchangeCode(code);
    if (!res.ok) throw new Error('Código inválido');
    await loadEpicLibrary();
    closeSettings();
  } catch(e) {
    showError('cfg-epic-error', e.message || 'Código inválido.');
    btn.innerHTML = 'CONFIRMAR'; btn.disabled = false;
  }
}

async function disconnectEpic() {
  await window.api.epicDisconnect();
  epicGames = []; installedEpic.clear();
  $('cfg-epic-connected').style.display    = 'none';
  $('cfg-epic-disconnected').style.display = '';
  $('epic-code-section').style.display     = 'none';
  $('btn-epic-auth').style.display         = '';
  $('epic-account-row').style.display      = 'none';
  mergeAndRender();
}

async function loadEpicLibrary() {
  splashMsg('Carregando biblioteca Epic…', 70);
  const res = await window.api.epicGetLibrary();
  if (res.error === 'not_authenticated') return;
  if (!res.games) return;

  // games from API already have id set as 'epic_' + appName from main.js
  epicGames     = res.games;
  installedEpic = new Set(epicGames.filter(g => g.installed).map(g => g.id));

  // Load cached details for Epic games (genres, descriptions from previous sessions)
  const epicAppids = epicGames.map(g => g.id);
  const epicCached = await window.api.getCachedDetails(epicAppids);
  const epicWithGenres = Object.values(epicCached).filter(d => d?.genres?.length).length;
  console.log(`[Epic] Cache loaded: ${Object.keys(epicCached).length} entries, ${epicWithGenres} with genres`);
  Object.assign(genreData, epicCached);

  // Populate genreData with Epic game info — preserve cached genres/description/name
  for (const g of epicGames) {
    const existing = genreData[g.id] || {};

    // Fix codename: use cached corrected name, or extract from description
    let realName = g.name;
    if (existing.name && !isEpicCodename(existing.name)) {
      realName = existing.name;
    } else if (existing.description) {
      // Description often starts with the real game name
      const extracted = extractNameFromDesc(existing.description, g.name);
      if (extracted) realName = extracted;
    }
    if (realName !== g.name) g.name = realName;

    genreData[g.id] = {
      genres:      existing.genres?.length ? existing.genres : (g.genres || []),
      description: existing.description || g.description || '',
      header:      g.header || existing.header || null,
      name:        realName,
      localImage:  existing.localImage || null
    };
  }

  updateEpicUI(res.displayName, epicGames.length);
  // Load any local images for Epic games
  const epicLocalImgs = await window.api.getLocalImages();
  for (const [key, filePath] of Object.entries(epicLocalImgs || {})) {
    if (!key.startsWith('epic_')) continue;
    if (!genreData[key]) genreData[key] = {};
    genreData[key].localImage = 'file://' + filePath.replace(/\\/g, '/');
  }

  mergeAndRender();

  // Fetch covers in background (non-blocking)
  fetchEpicCoversBackground();

  // Fetch genres via IGDB for Epic games missing genres
  fetchIgdbGenresBackground('epic');
}

function updateEpicUI(name, count) {
  $('cfg-epic-name').textContent = name || 'Conta Epic';
  $('cfg-epic-info').textContent = `${count} jogos`;
  $('cfg-epic-connected').style.display    = '';
  $('cfg-epic-disconnected').style.display = 'none';
  $('sidebar-epic-name').textContent = name || 'Epic';
  $('epic-account-row').style.display = 'flex';
  $('no-accounts').style.display = 'none';
}

// ── GOG ────────────────────────────────────────────────────────────────────────
async function startGogAuth() {
  const btn = $('btn-gog-auth');
  btn.innerHTML = '<span class="spin"></span>ABRINDO LOGIN…';
  btn.disabled = true;
  $('cfg-gog-error').style.display = 'none';

  try {
    // Opens embedded browser — code is captured automatically
    const res = await window.api.gogStartAuth();
    if (res.cancelled) {
      btn.innerHTML = '🎮 ENTRAR COM GOG'; btn.disabled = false; return;
    }
    if (res.code) {
      btn.innerHTML = '<span class="spin"></span>AUTENTICANDO…';
      const authRes = await window.api.gogExchangeCode(res.code);
      if (!authRes.ok) throw new Error('Falha na autenticação');
      await loadGogLibrary();
      closeSettings();
    }
  } catch(e) {
    showError('cfg-gog-error', e.message || 'Erro ao conectar GOG.');
    btn.innerHTML = '🎮 ENTRAR COM GOG'; btn.disabled = false;
  }
}

async function gogExchangeCode() {
  // Manual fallback — used if auto-capture fails
  const code = $('cfg-gog-code').value.trim();
  if (!code) { showError('cfg-gog-error', 'Cole o código de autorização.'); return; }
  const btn = $('btn-gog-exchange');
  btn.innerHTML = '<span class="spin"></span>VERIFICANDO…'; btn.disabled = true;
  $('cfg-gog-error').style.display = 'none';
  try {
    const res = await window.api.gogExchangeCode(code);
    if (!res.ok) throw new Error('Código inválido');
    await loadGogLibrary();
    closeSettings();
  } catch(e) {
    showError('cfg-gog-error', e.message || 'Código inválido.');
    btn.innerHTML = 'CONFIRMAR'; btn.disabled = false;
  }
}

async function disconnectGog() {
  await window.api.gogDisconnect();
  gogGames = []; installedGog.clear();
  $('cfg-gog-connected').style.display    = 'none';
  $('cfg-gog-disconnected').style.display = '';
  $('gog-code-section').style.display     = 'none';
  $('btn-gog-auth').style.display         = '';
  mergeAndRender();
}

async function loadGogLibrary() {
  splashMsg('Carregando biblioteca GOG…', 75);
  const res = await window.api.gogGetLibrary();
  if (res.error) return;
  gogGames     = res.games || [];
  installedGog = new Set(gogGames.filter(g => g.installed).map(g => g.id));

  // Load cached details
  const cached = await window.api.getCachedDetails(gogGames.map(g => g.id));
  Object.assign(genreData, cached);

  for (const g of gogGames) {
    const ex = genreData[g.id] || {};
    genreData[g.id] = {
      header:      g.header || ex.header || null,
      name:        ex.name || g.name,
      genres:      ex.genres || [],
      description: ex.description || '',
      localImage:  ex.localImage || null
    };
  }

  updateGogUI(res.username, gogGames.length);
  mergeAndRender();
  fetchIgdbGenresBackground('gog');
}

function updateGogUI(name, count) {
  $('cfg-gog-name').textContent = name || 'GOG User';
  $('cfg-gog-info').textContent = `${count} jogos`;
  $('cfg-gog-connected').style.display    = '';
  $('cfg-gog-disconnected').style.display = 'none';
}

// ── Load all ───────────────────────────────────────────────────────────────────
function withTimeout(promise, ms, name) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timeout`)), ms))
  ]);
}

async function loadAllLibraries(hasSteam, hasEpic, hasGog) {
  const promises = [];
  if (hasSteam) promises.push(withTimeout(loadSteamLibrary(), 30000, 'Steam').catch(e => console.error('Steam:', e.message)));
  if (hasEpic)  promises.push(withTimeout(loadEpicLibrary(),  30000, 'Epic').catch(e => console.error('Epic:', e.message)));
  if (hasGog)   promises.push(withTimeout(loadGogLibrary(),   30000, 'GOG').catch(e => console.error('GOG:', e.message)));
  await Promise.all(promises);
  showLibraryUI();
}

function showLibraryUI() {
  const hasGames = allGames.length > 0;
  $('empty-state').style.display  = hasGames ? 'none' : 'flex';
  $('toolbar').style.display      = hasGames ? '' : 'none';
  $('random-panel').style.display = hasGames ? '' : 'none';
  $('genre-section').style.display = hasGames ? '' : 'none';

  const hasBoth = steamGames.length > 0 && epicGames.length > 0;
  const hasAny  = steamGames.length > 0 || epicGames.length > 0 || gogGames.length > 0;
  $('tabs-bar').style.display = hasAny ? '' : 'none';
  document.querySelector('.tab[data-tab="steam"]').style.display = steamGames.length > 0 ? '' : 'none';
  document.querySelector('.tab[data-tab="epic"]').style.display  = epicGames.length  > 0 ? '' : 'none';
  document.querySelector('.tab[data-tab="gog"]').style.display   = gogGames.length   > 0 ? '' : 'none';
  const hiddenTab = document.querySelector('.tab[data-tab="hidden"]');
  if (hiddenTab) {
    hiddenTab.style.display = hiddenGames.size > 0 ? '' : 'none';
    hiddenTab.querySelector('.hidden-count').textContent = hiddenGames.size;
  }

  updateCacheInfo();
}

// ── Merge libraries ────────────────────────────────────────────────────────────
function mergeAndRender() {
  allGames = [...steamGames, ...epicGames, ...gogGames];
  showLibraryUI();
  applyFilters();
}

// ── Tabs ───────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  visibleCount = 60;
  applyFilters();
}

function getTabGames() {
  if (currentTab === 'steam')     return steamGames;
  if (currentTab === 'epic')      return epicGames;
  if (currentTab === 'gog')       return gogGames;
  if (currentTab === 'favorites') return allGames.filter(g => favorites.has(g.id));
  if (currentTab === 'hidden')    return allGames.filter(g => hiddenGames.has(g.id));
  return allGames;
}

// ── Filters & render ───────────────────────────────────────────────────────────
function applyFilters() {
  const q    = $('search-input').value.toLowerCase();
  const sort = $('sort-select').value;
  let pool   = getTabGames().filter(g => {
    if (currentTab !== 'hidden' && hiddenGames.has(g.id)) return false;
    return g.name.toLowerCase().includes(q);
  });

  if (activeGenres.size > 0) {
    pool = pool.filter(g => {
      const genres = genreData[g.id]?.genres || [];
      return [...activeGenres].some(ag => genres.includes(ag));
    });
  }

  if      (sort === 'playtime')  pool.sort((a,b) => (b.playtime||0) - (a.playtime||0));
  else if (sort === 'name')      pool.sort((a,b) => a.name.localeCompare(b.name));
  else if (sort === 'recent')    pool.sort((a,b) => (b.playtime_recent||0) - (a.playtime_recent||0));
  else if (sort === 'unplayed')  { pool = pool.filter(g => !g.playtime); pool.sort((a,b) => a.name.localeCompare(b.name)); }
  else if (sort === 'installed') { pool = pool.filter(g => isInstalled(g)); pool.sort((a,b) => a.name.localeCompare(b.name)); }

  filteredGames = pool;
  visibleCount  = 60;
  renderGames();
}

function isInstalled(g) {
  if (g.source === 'steam') return installedSteam.has(g.id);
  if (g.source === 'epic')  return installedEpic.has(g.id) || g.installed;
  if (g.source === 'gog')   return installedGog.has(g.id) || g.installed;
  return false;
}

function getGameById(id) {
  return allGames.find(g => g.id === id);
}

// Lazy image observer
let imgObserver = null;
function getImgObserver() {
  if (!imgObserver) {
    imgObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const img = entry.target;
        if (img.dataset.src) {
          const realSrc = img.dataset.src;
          delete img.dataset.src;
          // Skip if already in noImageSet
          const id = img.dataset.gameid_img;
          if (id && noImageSet.has(id)) {
            img.replaceWith(mkErr('gc-thumb-err'));
          } else {
            img.src = realSrc;
          }
        }
        imgObserver.unobserve(img);
      });
    }, { rootMargin: '300px' });
  }
  return imgObserver;
}

function renderGames() {
  const grid  = $('games-grid');
  const slice = filteredGames.slice(0, visibleCount);
  $('results-label').textContent = `${Math.min(visibleCount, filteredGames.length)} de ${filteredGames.length}`;

  // Disconnect old observer
  if (imgObserver) { imgObserver.disconnect(); imgObserver = null; }
  grid.innerHTML = '';

  const observer = getImgObserver();
  const frag = document.createDocumentFragment();

  slice.forEach(g => {
    const d         = genreData[g.id] || {};
    const installed = isInstalled(g);
    const genres    = (d.genres || []).slice(0, 2);

    const card = document.createElement('div');
    card.className = 'game-card';
    card.id = 'card-' + g.id;
    card.dataset.gameid = g.id;

    // Source badge
    const srcBadge = document.createElement('div');
    srcBadge.className = `source-mini-badge ${g.source}-mini`;
    srcBadge.textContent = g.source === 'steam' ? 'S' : 'E';
    card.appendChild(srcBadge);

    // Image — skeleton if no data yet, lazy loaded otherwise
    const hasData = !!(d.header || d.localImage || gameHeader(g));
    if (noImageSet.has(g.id) && !d.localImage) {
      card.appendChild(mkErr('gc-thumb-err'));
    } else if (!d.header && !d.localImage && g.source === 'epic') {
      // Show skeleton while Epic cover loads
      const skel = document.createElement('div');
      skel.className = 'gc-thumb-skeleton';
      card.appendChild(skel);
    } else {
      const img = document.createElement('img');
      img.className = 'gc-thumb'; img.alt = g.name;
      img.loading = 'lazy';
      const imgSrc = d.localImage || d.header || gameHeader(g);
      img.dataset.src = imgSrc;
      img.dataset.gameid_img = g.id;
      img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
      img.addEventListener('error', function onErr() {
        if (img.src.startsWith('data:')) return;
        img.removeEventListener('error', onErr);
        const fb = gameHeader(g);
        if (img.src !== fb && fb) {
          img.src = fb;
          img.addEventListener('error', () => { noImageSet.add(g.id); img.replaceWith(mkErr('gc-thumb-err')); }, { once: true });
        } else { noImageSet.add(g.id); img.replaceWith(mkErr('gc-thumb-err')); }
      });
      observer.observe(img);
      card.appendChild(img);
    }

    if (installed) {
      const badge = document.createElement('div');
      badge.className = 'installed-badge'; badge.textContent = 'INSTALADO';
      card.appendChild(badge);
    }
    if (favorites.has(g.id)) {
      const favBadge = document.createElement('div');
      favBadge.className = 'fav-badge';
      favBadge.textContent = '★';
      card.appendChild(favBadge);
    }
    if (currentTab === 'hidden') {
      const hideBadge = document.createElement('div');
      hideBadge.className = 'hidden-badge';
      hideBadge.textContent = '🚫';
      card.appendChild(hideBadge);
    }

    const info = document.createElement('div');
    info.className = 'gc-info';
    const genreHtml = genres.length
      ? `<div class="gc-genres">${genres.map(gn=>`<span class="gc-genre">${esc(gn)}</span>`).join('')}</div>`
      : (!genreData[g.id]?.genres
          ? `<div class="gc-genres"><div class="gc-sub-skeleton" style="margin-top:4px"></div></div>`
          : '');
    info.innerHTML = `<div class="gc-name" title="${esc(g.name)}">${esc(g.name)}</div>`
      + `<div class="gc-playtime">${g.playtime ? fmtTime(g.playtime) : (installed ? '✅ Instalado' : '')}</div>`
      + genreHtml;
    card.appendChild(info);
    frag.appendChild(card);
  });

  grid.appendChild(frag);
  $('load-more-wrap').style.display = filteredGames.length > visibleCount ? 'block' : 'none';
}

function loadMore() { visibleCount += 80; renderGames(); }

// ── Random ─────────────────────────────────────────────────────────────────────
function pickRandom() {
  const pool = getPool(getTabGames());
  if (!pool.length) { alert('Nenhum jogo encontrado com esses filtros.'); return; }
  const game = pool[Math.floor(Math.random() * pool.length)];
  showFeatured(game);
  document.querySelectorAll('.game-card').forEach(c => c.classList.remove('hi'));
  const card = $('card-' + game.id);
  if (card) {
    card.classList.add('hi');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => card.classList.remove('hi'), 3500);
  }
}

function getPool(base) {
  if (activeGenres.size === 0) return base;
  return base.filter(g => {
    const genres = genreData[g.id]?.genres || [];
    return [...activeGenres].some(ag => genres.includes(ag));
  });
}

// ── Featured ───────────────────────────────────────────────────────────────────
function showFeatured(game) {
  if (!game) return;
  featuredAppid = game.id;
  const d         = genreData[game.id] || {};
  const installed = isInstalled(game);

  const fc = $('featured-card');
  fc.innerHTML = '';

  const img = document.createElement('img');
  img.className = 'fc-img'; img.alt = game.name;
  img.src = d.localImage || d.header || gameHeader(game);
  img.addEventListener('error', function onErr() {
    img.removeEventListener('error', onErr);
    img.addEventListener('error', () => img.replaceWith(mkErr('fc-img-err')), { once: true });
    img.src = gameHeader(game);
  });
  fc.appendChild(img);

  const info = document.createElement('div');
  info.className = 'fc-info';
  const genreTags = (d.genres||[]).map(g=>`<span class="genre-tag">${esc(g)}</span>`).join('');
  const srcLabel  = game.source === 'steam' ? '<span class="source-badge steam-badge" style="font-size:9px">STEAM</span>'
                                             : '<span class="source-badge epic-badge" style="font-size:9px">EPIC</span>';
  info.innerHTML = `<div class="fc-eyebrow">✦ sorteado agora &nbsp;${srcLabel}</div>`
    + `<div class="fc-name">${esc(game.name)}</div>`
    + (genreTags ? `<div class="fc-genres">${genreTags}</div>` : '')
    + `<div class="fc-desc">${d.description ? esc(d.description) : '<em style="opacity:.4">Carregando…</em>'}</div>`;

  const foot = document.createElement('div');
  foot.className = 'fc-foot';
  foot.innerHTML = `<span class="fc-playtime">${game.playtime ? fmtTime(game.playtime) : (installed ? '✅ Instalado' : '☁️ Não instalado')}</span>`;

  const mkBtn = (cls, txt, action, id) => {
    const b = document.createElement('button');
    b.className = cls; b.textContent = txt;
    b.dataset.action = action; if (id) b.dataset.gameid = id;
    return b;
  };
  const starBtn = document.createElement('button');
  starBtn.className = 'btn-ghost small';
  starBtn.textContent = favorites.has(game.id) ? '★' : '☆';
  starBtn.dataset.action = 'fav-toggle';
  starBtn.dataset.gameid = game.id;
  starBtn.dataset.favId = game.id;
  starBtn.style.color = favorites.has(game.id) ? '#f6c456' : '';
  starBtn.title = 'Favoritar';
  foot.appendChild(starBtn);
  foot.appendChild(mkBtn(`btn-launch ${installed?'installed':'not-installed'}`, installed?'▶ Jogar':'⬇ Instalar', 'launch', game.id));
  foot.appendChild(mkBtn('btn-ghost small','🎲 Outro','random'));
  foot.appendChild(mkBtn('btn-ghost small','Detalhes','details', game.id));
  foot.appendChild(mkBtn('btn-ghost small','🖼 Imagem','local-img', game.id));
  foot.appendChild(mkBtn('btn-ghost small','✏️ Nome','edit-name', game.id));
  if (hiddenGames.has(game.id)) foot.appendChild(mkBtn('btn-ghost small','👁 Mostrar','hide-toggle', game.id));

  // Close button — top right of featured card
  const closeBtn = document.createElement('button');
  closeBtn.dataset.action = 'close-featured';
  closeBtn.title = 'Fechar';
  closeBtn.style.cssText = 'position:absolute;top:10px;right:10px;background:rgba(0,0,0,.5);border:none;border-radius:50%;width:28px;height:28px;color:#e8eaf0;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:2;line-height:1';
  closeBtn.textContent = '✕';
  fc.style.position = 'relative';
  fc.appendChild(closeBtn);

  info.appendChild(foot);
  fc.appendChild(info);
  $('featured-wrap').style.display = 'block';

  if (!d.description && !d._fetching) {
    fetchGameDetails(game);
  }
}

async function fetchGameDetails(game) {
  genreData[game.id] = Object.assign(genreData[game.id] || {}, { _fetching: true });
  try {
    const local = genreData[game.id]?.localImage;
    if (game.source === 'steam') {
      const res = await window.api.getAppDetails(game.appid);
      if (res) genreData[game.id] = Object.assign({}, res, { localImage: local });
    } else if (game.source === 'epic') {
      // Fetch Epic details via a single-game cover fetch which includes description
      const updates = await window.api.epicFetchCovers([{
        id: game.id, name: game.name,
        appName: game.appName, namespace: game.namespace,
        catalogItemId: game.catalogItemId
      }]).catch(() => ({}));
      if (updates[game.id]) {
        genreData[game.id] = Object.assign(genreData[game.id] || {}, updates[game.id], { localImage: local });
      }
    }
    if (featuredAppid === game.id) showFeatured(game);
  } catch {}
}

// ── Favorites ─────────────────────────────────────────────────────────────────
async function toggleFavorite(id) {
  if (favorites.has(id)) {
    favorites.delete(id);
  } else {
    favorites.add(id);
  }
  await window.api.saveFavorites([...favorites]);
  // Update star buttons
  document.querySelectorAll(`[data-fav-id="${id}"]`).forEach(el => {
    el.textContent = favorites.has(id) ? '★' : '☆';
    el.style.color = favorites.has(id) ? '#f6c456' : '';
  });
  renderGames();
  updateRandomSub();
}

// ── Hidden games ──────────────────────────────────────────────────────────────
async function toggleHidden(id) {
  const wasHidden = hiddenGames.has(id);
  if (wasHidden) hiddenGames.delete(id);
  else           hiddenGames.add(id);
  await window.api.saveHiddenGames([...hiddenGames]);
  // Close modal if hiding from there
  if (!wasHidden) closeModal();
  renderGames();
  updateRandomSub();
  showLibraryUI();
}

// ── Edit game name ────────────────────────────────────────────────────────────
async function editGameName(id) {
  const game = getGameById(id);
  if (!game) return;

  // Build inline edit popup
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:500;display:flex;align-items:center;justify-content:center';

  const box = document.createElement('div');
  box.style.cssText = 'background:#13161d;border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:28px 32px;width:420px;display:flex;flex-direction:column;gap:14px';
  box.innerHTML = `
    <div style="font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:2px">EDITAR NOME</div>
    <input id="edit-name-input" type="text" value="${esc(game.name)}"
      style="background:#1a1e28;border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:10px 14px;color:#e8eaf0;font-size:14px;outline:none;width:100%">
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button id="edit-cancel" style="background:none;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:8px 18px;color:#6b7280;cursor:pointer;font-size:13px">Cancelar</button>
      <button id="edit-confirm" style="background:linear-gradient(135deg,#1a9fff,#0d8ce0);border:none;border-radius:8px;padding:8px 18px;color:white;cursor:pointer;font-size:13px;font-weight:600">Salvar</button>
    </div>`;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const input = document.getElementById('edit-name-input');
  input.focus();
  input.select();

  const cleanup = () => document.body.removeChild(overlay);

  document.getElementById('edit-cancel').addEventListener('click', cleanup);
  overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });

  const save = async () => {
    const trimmed = input.value.trim();
    cleanup();
    if (!trimmed || trimmed === game.name) return;

    game.name = trimmed;
    if (!genreData[id]) genreData[id] = {};
    genreData[id].name = trimmed;

    await window.api.saveGameName({ id, name: trimmed });

    window.api.igdbGetGame({ id, name: trimmed }).then(res => {
      if (res?.genres?.length) genreData[id].genres = res.genres;
      if (res?.description)    genreData[id].description = res.description;
      buildChips();
    }).catch(() => {});

    renderGames();
    const modalOverlay = $('modal-overlay');
    if (modalOverlay.classList.contains('open')) renderModal($('modal-box'), game, genreData[id] || {});
    if (featuredAppid === id) showFeatured(game);
  };

  document.getElementById('edit-confirm').addEventListener('click', save);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cleanup(); });
}

// ── Launch ─────────────────────────────────────────────────────────────────────
async function launchGame(id) {
  const game = getGameById(id);
  if (!game) return;
  if (game.source === 'steam') {
    window.api.launchGame({ appid: game.appid, installed: installedSteam.has(game.id) });
  } else if (game.source === 'epic') {
    window.api.epicLaunch(game.appName);
  } else if (game.source === 'gog') {
    window.api.gogLaunch({ gogId: game.gogId, installed: isInstalled(game) });
  }
}

// ── Local image ────────────────────────────────────────────────────────────────
async function pickLocalImage(id) {
  const res = await window.api.pickLocalImage();
  if (!res) return;
  const filePath = res.replace(/^file:\/\/\/?/, '').replace(/\//g, '\\');
  await window.api.saveLocalImage({ appid: id, filePath });
  if (!genreData[id]) genreData[id] = {};
  genreData[id].localImage = res;
  noImageSet.delete(id);
  const card = $('card-' + id);
  if (card) {
    const old = card.querySelector('img, .gc-thumb-err');
    if (old) {
      const img = document.createElement('img');
      img.className = 'gc-thumb'; img.src = res; img.alt = '';
      img.addEventListener('error', () => img.replaceWith(mkErr('gc-thumb-err')), { once: true });
      old.replaceWith(img);
    }
  }
  if (featuredAppid === id) showFeatured(getGameById(id));
}

// ── Modal ──────────────────────────────────────────────────────────────────────
async function openModal(id) {
  const game = getGameById(id);
  if (!game) return;
  const overlay = $('modal-overlay');
  const box     = $('modal-box');
  renderModal(box, game, genreData[id] || {});
  overlay.classList.add('open');

  // Fetch HLTB in background
  if (!genreData[id]?.hltb) {
    window.api.hltbGet({ id: game.id, name: game.name, appid: game.source === 'steam' ? game.appid : game.id }).then(hltb => {
      if (hltb && $('modal-overlay').classList.contains('open')) {
        if (!genreData[id]) genreData[id] = {};
        genreData[id].hltb = hltb;
        renderModal($('modal-box'), game, genreData[id]);
      }
    }).catch(() => {});
  }

  if (!genreData[id]?.description) {
    const local = genreData[id]?.localImage;
    try {
      if (game.source === 'steam') {
        const res = await window.api.getAppDetails(game.appid);
        if (res) {
          genreData[id] = Object.assign({}, res, { localImage: local });
          if (overlay.classList.contains('open')) renderModal(box, game, genreData[id]);
        }
      } else if (game.source === 'epic') {
        // Try Epic description first, then IGDB as fallback
        let epicDesc = await window.api.epicGetDescription({
          namespace:     game.namespace,
          catalogItemId: game.catalogItemId,
          appName:       game.appName,
          name:          game.name
        }).catch(() => null);

        if (!epicDesc?.description) {
          // IGDB fallback — has descriptions + genres for most games
          epicDesc = await window.api.igdbGetGame({ id: game.id, name: game.name }).catch(() => null);
        }

        if (epicDesc) {
          if (!genreData[id]) genreData[id] = {};
          if (epicDesc.description)        genreData[id].description = epicDesc.description;
          if (epicDesc.genres?.length && !genreData[id].genres?.length)
            genreData[id].genres = epicDesc.genres;
          if (overlay.classList.contains('open')) renderModal(box, game, genreData[id]);
          buildChips();
        }
      }
    } catch {}
  }
}

function renderModal(box, game, d) {
  const installed = isInstalled(game);
  const genres    = d.genres    || [];
  const cats      = (d.categories || []).slice(0, 5);
  const screens   = d.screenshots || [];
  box.innerHTML = '';

  const img = document.createElement('img');
  img.className = 'modal-hero'; img.alt = game.name;
  img.src = d.localImage || d.header || gameHeader(game);
  img.addEventListener('error', function onErr() {
    img.removeEventListener('error', onErr);
    img.addEventListener('error', () => img.replaceWith(mkErr('modal-hero-err')), { once: true });
    img.src = gameHeader(game);
  });
  box.appendChild(img);

  const body = document.createElement('div');
  body.className = 'modal-body';
  const srcBadge = game.source === 'steam'
    ? '<span class="source-badge steam-badge">STEAM</span>'
    : '<span class="source-badge epic-badge">EPIC</span>';
  const genreTags = genres.map(g=>`<span class="genre-tag">${esc(g)}</span>`).join('');
  const catTags   = cats.map(c=>`<span class="genre-tag cat">${esc(c)}</span>`).join('');
  const screensHtml = screens.length
    ? `<div class="modal-screens">${screens.map(s=>`<img src="${esc(s)}" loading="lazy">`).join('')}</div>` : '';

  const hltb     = d.hltb;
  const hltbHtml = hltb
    ? `<div class="modal-hltb">
        <span class="hltb-label">⏳ HowLongToBeat</span>
        ${hltb.main        ? `<span class="hltb-item"><span class="hltb-type">Principal</span><span class="hltb-val">${hltb.main}</span></span>` : ''}
        ${hltb.mainExtra   ? `<span class="hltb-item"><span class="hltb-type">+ Extras</span><span class="hltb-val">${hltb.mainExtra}</span></span>` : ''}
        ${hltb.completionist ? `<span class="hltb-item"><span class="hltb-type">100%</span><span class="hltb-val">${hltb.completionist}</span></span>` : ''}
      </div>` : '';

  body.innerHTML = `<div class="modal-name">${esc(game.name)} ${srcBadge}</div>`
    + (genreTags||catTags ? `<div class="modal-tags">${genreTags}${catTags}</div>` : '')
    + `<div class="modal-meta"><span>⏱ ${game.playtime ? fmtTime(game.playtime) : '—'}</span>`
    + `<span>${installed?'✅ Instalado':'☁️ Não instalado'}</span></div>`
    + hltbHtml
    + `<div class="modal-desc">${d.description ? esc(d.description) : '<em style="opacity:.4">Carregando…</em>'}</div>`
    + screensHtml;

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const mkBtn = (cls,txt,action,id) => {
    const b = document.createElement('button');
    b.className=cls; b.textContent=txt;
    b.dataset.action=action; if(id) b.dataset.gameid=id;
    return b;
  };
  actions.appendChild(mkBtn(`btn-launch ${installed?'installed':'not-installed'}`, installed?'▶ Jogar':'⬇ Instalar','launch-close',game.id));
  actions.appendChild(mkBtn('btn-ghost small','🎯 Destacar','highlight',game.id));
  const modalStar = document.createElement('button');
  modalStar.className = 'btn-ghost small';
  modalStar.textContent = favorites.has(game.id) ? '★' : '☆';
  modalStar.dataset.action = 'fav-toggle';
  modalStar.dataset.gameid = game.id;
  modalStar.dataset.favId = game.id;
  modalStar.style.color = favorites.has(game.id) ? '#f6c456' : '';
  modalStar.title = 'Favoritar';
  actions.appendChild(modalStar);
  actions.appendChild(mkBtn('btn-ghost small','🖼 Imagem','local-img',game.id));
  actions.appendChild(mkBtn('btn-ghost small','✏️ Nome','edit-name',game.id));
  const hideBtn = mkBtn('btn-ghost small', hiddenGames.has(game.id) ? '👁 Mostrar' : '🚫 Esconder', 'hide-toggle', game.id);
  if (!hiddenGames.has(game.id)) hideBtn.style.color = 'var(--danger, #e05c5c)';
  actions.appendChild(hideBtn);
  const cl = mkBtn('btn-ghost small','Fechar','close');
  cl.style.marginLeft='auto'; actions.appendChild(cl);
  body.appendChild(actions);
  box.appendChild(body);
}

function closeModal() { $('modal-overlay').classList.remove('open'); }

// ── Genre fetch ────────────────────────────────────────────────────────────────
async function startGenreFetch(source) {
  const sourceGames = source === 'steam' ? steamGames : source === 'gog' ? gogGames : epicGames;
  if (!sourceGames.length) return;

  const toFetch = sourceGames
    .filter(g => !genreData[g.id] || (!genreData[g.id].genres?.length && !genreData[g.id].description));

  const total  = sourceGames.length;
  const needed = toFetch.length;

  if (needed === 0) {
    $('genre-status').style.display = '';
    setGenreStatus('done', `${allGames.length} em cache`);
    buildChips();
    return;
  }

  $('genre-progress-wrap').style.display = 'flex';
  $('genre-status').style.display = 'none';

  if (source === 'steam') {
    const BATCH = 10;
    let done = 0;
    const appids = toFetch.map(g => g.appid);
    for (let i = 0; i < appids.length; i += BATCH) {
      const chunk  = appids.slice(i, i + BATCH);
      const result = await window.api.getAppDetailsBatch(chunk);
      for (const [appid, d] of Object.entries(result)) {
        genreData['steam_' + appid] = d;
      }
      done += chunk.length;
      const pct = Math.round(((total - needed + done) / total) * 100);
      $('progress-fill').style.width = pct + '%';
      $('progress-lbl').textContent  = `${total - needed + done} / ${total}`;
      buildChips();
      renderGames();
    }
  }
  // Epic genre fetch would go here when Epic Store API supports it

  $('genre-progress-wrap').style.display = 'none';
  $('genre-status').style.display = '';
  setGenreStatus('done', `${allGames.length} mapeados`);
  buildChips();
  renderGames();
  updateCacheInfo();
}

function setGenreStatus(type, text) {
  const el = $('genre-status');
  el.textContent = text;
  el.className   = `status-pill ${type}`;
}

// ── Genre chips ────────────────────────────────────────────────────────────────
function buildChips() {
  const counts = {};
  for (const [id, d] of Object.entries(genreData)) {
    if (!d?.genres?.length) continue;
    if (!allGames.find(g => g.id === id)) continue;
    for (const genre of d.genres) counts[genre] = (counts[genre] || 0) + 1;
  }
  const sorted = Object.entries(counts).filter(([,c])=>c>=2).sort((a,b)=>b[1]-a[1]);
  const container = $('genre-chips');
  const existing  = new Map();
  container.querySelectorAll('[data-genre]').forEach(el => existing.set(el.dataset.genre, el));
  sorted.forEach(([genre, cnt]) => {
    if (existing.has(genre)) {
      const cntEl = existing.get(genre).querySelector('.chip-cnt');
      if (cntEl) cntEl.textContent = cnt;
      existing.delete(genre);
    } else {
      const btn = document.createElement('button');
      btn.className = 'chip' + (activeGenres.has(genre) ? ' active' : '');
      btn.dataset.genre = genre;
      btn.innerHTML = `<span class="chip-icon">${GENRE_ICONS[genre]||'🎮'}</span>`
        + `<span class="chip-name">${esc(genre)}</span>`
        + `<span class="chip-cnt">${cnt}</span>`;
      container.appendChild(btn);
    }
  });
  existing.forEach(el => el.remove());
}

function toggleGenre(genre) {
  if (activeGenres.has(genre)) activeGenres.delete(genre);
  else activeGenres.add(genre);
  document.querySelectorAll('[data-genre]').forEach(el => {
    el.classList.toggle('active', activeGenres.has(el.dataset.genre));
  });
  updateRandomSub();
  applyFilters();
}

function clearGenres() {
  activeGenres.clear();
  document.querySelectorAll('[data-genre]').forEach(el => el.classList.remove('active'));
  updateRandomSub(); applyFilters();
}

function updateRandomSub() {
  const pool = getPool(getTabGames());
  const base = currentTab === 'favorites'
    ? `${favorites.size} favoritos`
    : 'da biblioteca toda';
  $('random-sub').textContent = activeGenres.size === 0
    ? base
    : `${pool.length} jogos · ${[...activeGenres].join(' + ')}`;
}

// ── Apply Epic/SGDB updates ────────────────────────────────────────────────────
function applyEpicUpdates(updates) {
  if (!updates || !Object.keys(updates).length) return;
  let genresChanged = false;
  for (const [id, data] of Object.entries(updates)) {
    const game = epicGames.find(g => g.id === id);
    if (game) {
      if (data.header) game.header = data.header;
      if (data.name)   game.name   = data.name;
    }
    if (!genreData[id]) genreData[id] = { genres: [], description: '' };
    if (data.header)           genreData[id].header      = data.header;
    if (data.name)             genreData[id].name        = data.name;
    if (data.description)      genreData[id].description = data.description;
    if (data.genres?.length) {
      genreData[id].genres = data.genres;
      genresChanged = true;
    }
  }
  if (genresChanged) buildChips();
  renderGames();
  console.log(`[SGDB/Epic] Applied ${Object.keys(updates).length} updates`);
}

// ── IGDB genre background fetch ────────────────────────────────────────────────
async function fetchIgdbGenresBackground(source) {
  const sourceGames = source === 'steam' ? steamGames : source === 'gog' ? gogGames : epicGames;
  if (!sourceGames.length) return;

  const toFetch = sourceGames
    .filter(g => !genreData[g.id]?.genres?.length)
    .map(g => ({ id: g.id, name: g.name, appName: g.appName }));

  if (!toFetch.length) return;
  console.log(`[IGDB] Fetching genres for ${toFetch.length} ${source} games...`);

  globalProgress.genres.total += toFetch.length;
  globalProgress.update();

  const updates = await window.api.igdbFetchGenres(toFetch).catch(() => ({}));
  globalProgress.genres.done += toFetch.length;
  globalProgress.update();
  if (!updates || !Object.keys(updates).length) return;

  let namesFixed = 0;
  for (const [id, data] of Object.entries(updates)) {
    if (!genreData[id]) genreData[id] = {};
    if (data.genres?.length)  genreData[id].genres      = data.genres;
    if (data.description && !genreData[id].description) genreData[id].description = data.description;
    // Fix codename titles with real IGDB name
    if (data.name) {
      genreData[id].name = data.name;
      const game = allGames.find(g => g.id === id);
      if (game && data.name !== game.name) {
        game.name = data.name;
        namesFixed++;
      }
    }
  }

  if (namesFixed > 0) console.log(`[IGDB] Fixed ${namesFixed} game names`);
  buildChips();
  renderGames();
  console.log(`[IGDB] Applied ${Object.keys(updates).length} genre updates`);
}

// ── Epic cover background fetch ────────────────────────────────────────────────
async function fetchEpicCoversBackground() {
  if (!epicGames.length) return;
  const toFetch = epicGames.map(g => ({
    id:            g.id,
    name:          g.name,
    appName:       g.appName,
    namespace:     g.namespace,
    catalogItemId: g.catalogItemId
  }));

  const missing = toFetch.filter(g => !genreData[g.id]?.header);
  globalProgress.covers.total += missing.length;
  globalProgress.update();

  const updates = await window.api.epicFetchCovers(toFetch).catch(() => ({}));
  globalProgress.covers.done += missing.length;
  globalProgress.update();
  if (!updates || !Object.keys(updates).length) return;

  applyEpicUpdates(updates);
}

// ── Refresh ────────────────────────────────────────────────────────────────────
async function refreshAll() {
  if (currentConfig.steamid) await window.api.clearCache(currentConfig.steamid);
  steamGames = []; epicGames = [];
  const hasSteam = !!(currentConfig.key && currentConfig.steamid);
  const epicAcc  = await window.api.epicGetAccount();
  await loadAllLibraries(hasSteam, !!epicAcc);
}

// ── Cache ──────────────────────────────────────────────────────────────────────
function updateCacheInfo() {
  const el = $('cfg-cache-info');
  if (!el) return;
  const cached = Object.keys(genreData).length;
  el.textContent = `${cached} de ${allGames.length} jogos em cache local.`;
  if (allGames.length > 0) $('cfg-cache-section').style.display = '';
}

async function clearLibraryCache() {
  if (currentConfig.steamid) await window.api.clearCache(currentConfig.steamid);
  $('cfg-cache-info').textContent = 'Cache de biblioteca limpo.';
}

async function clearGenreCache() {
  await window.api.clearGenreCache();
  genreData = {};
  $('genre-chips').innerHTML = '';
  startGenreFetch('steam');
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function gameHeader(g) {
  if (g.source === 'steam') return `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`;
  if (g.source === 'epic')  return g.header || '';
  if (g.source === 'gog')   return g.header || '';
  return '';
}

function openLink(url) { window.api.launchGame({ url }); }
function showError(id, msg) { const el=$(id); el.textContent=msg; el.style.display='block'; }

function fmtTime(m) {
  if (!m) return 'Nunca jogado';
  return m < 60 ? m + ' min' : Math.round(m / 60) + 'h jogadas';
}
function mkErr(cls) { const d=document.createElement('div'); d.className=cls; d.textContent='🎮'; return d; }
function esc(s) {
  return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
