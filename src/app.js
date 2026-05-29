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
// customTags: { tagName: { color: '#hex', games: Set<id> } }
let customTags    = {};
let activeTagFilter = null;   // null | tagName
let gogGames      = [];           // GOG library
let localGames    = [];           // Local library (no store)
let emulatorGames = [];           // Emulator ROMs
let emulators     = [];           // Configured emulators
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
let genresCollapsed = false;
let tagsCollapsed   = false;
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
// ── Auto-updater ───────────────────────────────────────────────────────────────
let _updateInfo = null;

if (window.api.onUpdateAvailable) {
  window.api.onUpdateAvailable((info) => {
    _updateInfo = info;
    showUpdateBanner(info);
  });
  window.api.onUpdateProgress((info) => {
    updateBannerProgress(info);
  });
  window.api.onUpdateDownloaded((info) => {
    showUpdateReadyBanner(info);
  });
}

function fmt_bytes(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getOrCreateBanner() {
  let b = document.getElementById('update-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'update-banner';
    document.body.appendChild(b);
  }
  return b;
}

function showUpdateBanner(info) {
  const b = getOrCreateBanner();
  b.className = 'update-banner update-banner-available';
  b.innerHTML = `
    <div class="ubanner-icon">🔄</div>
    <div class="ubanner-body">
      <div class="ubanner-title">Atualização disponível — <strong>v${esc(info.version)}</strong></div>
      <div class="ubanner-sub" id="ubanner-sub">Clique em Baixar para atualizar</div>
      <div class="ubanner-progress-wrap" id="ubanner-progress-wrap" style="display:none">
        <div class="ubanner-progress-bar"><div class="ubanner-progress-fill" id="ubanner-progress-fill"></div></div>
        <span class="ubanner-pct" id="ubanner-pct">0%</span>
      </div>
    </div>
    <button class="ubanner-btn" id="ubanner-dl-btn">⬇ Baixar</button>
    <button class="ubanner-close" id="ubanner-close">✕</button>`;
  document.getElementById('ubanner-close').onclick = () => b.remove();
  document.getElementById('ubanner-dl-btn').onclick = () => {
    document.getElementById('ubanner-dl-btn').style.display = 'none';
    document.getElementById('ubanner-progress-wrap').style.display = '';
    document.getElementById('ubanner-sub').textContent = 'Baixando…';
    window.api.downloadUpdate();
  };
}

function updateBannerProgress(info) {
  const fill = document.getElementById('ubanner-progress-fill');
  const pct  = document.getElementById('ubanner-pct');
  const sub  = document.getElementById('ubanner-sub');
  if (fill) fill.style.width = info.percent + '%';
  if (pct)  pct.textContent  = info.percent + '%';
  if (sub)  sub.textContent  = `Baixando… ${fmt_bytes(info.transferred)} / ${fmt_bytes(info.total)}`;
}

function showUpdateReadyBanner(info) {
  const b = getOrCreateBanner();
  b.className = 'update-banner update-banner-ready';
  b.innerHTML = `
    <div class="ubanner-icon">✅</div>
    <div class="ubanner-body">
      <div class="ubanner-title">Atualização <strong>v${esc(info.version)}</strong> pronta!</div>
      <div class="ubanner-sub">O app será reiniciado para instalar.</div>
    </div>
    <button class="ubanner-btn ubanner-btn-install" id="ubanner-install-btn">🚀 Instalar agora</button>
    <button class="ubanner-close" id="ubanner-close">✕</button>`;
  document.getElementById('ubanner-close').onclick = () => b.remove();
  document.getElementById('ubanner-install-btn').onclick = () => window.api.installUpdate();
}

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
  const savedTags = await window.api.getTags();
  for (const [name, data] of Object.entries(savedTags || {})) {
    customTags[name] = { color: data.color || '#6366f1', games: new Set(data.games || []) };
  }
  renderTagChips();

  // Load local library
  const savedLocal = await window.api.localLibraryGet();
  localGames = (savedLocal || []).map(normalizeLocalGame);
  for (const g of localGames) {
    genreData[g.id] = genreData[g.id] || {};
    if (g.coverPath) genreData[g.id].localImage = 'file://' + g.coverPath.replace(/\\/g, '/');
  }

  // Load emulators + emulator games
  emulators = await window.api.emulatorsGet() || [];
  const savedEmuGames = await window.api.emulatorGamesGet() || [];
  emulatorGames = savedEmuGames.map(normalizeEmulatorGame);
  for (const g of emulatorGames) {
    genreData[g.id] = genreData[g.id] || {};
    if (g.coverPath) genreData[g.id].localImage = 'file://' + g.coverPath.replace(/\\/g, '/');
    if (g.coverUrl)  genreData[g.id].header     = g.coverUrl;
  }
  currentConfig = cfg || {};
  if (cfg.key && cfg.steamid) {
    $('cfg-key').value     = cfg.key;
    $('cfg-steamid').value = cfg.steamid;
    if (cfg.steamPath)  $('cfg-path').value  = cfg.steamPath;
    if (cfg.steamPath2) $('cfg-path2').value = cfg.steamPath2;
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
  $('btn-bigpicture').addEventListener('click', openBigPicture);
  $('bp-exit-btn').addEventListener('click', closeBigPicture);

  // F11 toggles Big Picture
  document.addEventListener('keydown', e => {
    if (e.key === 'F11' && !bpActive) { e.preventDefault(); openBigPicture(); }
  });
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
  $('btn-detect2').addEventListener('click', autoDetectSteam2);
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
  $('btn-collapse-genres').addEventListener('click', toggleCollapseGenres);
  $('btn-collapse-tags').addEventListener('click', toggleCollapseTags);
  $('btn-clear-all-filters').addEventListener('click', clearAllFilters);
  $('btn-add-local-game').addEventListener('click', addLocalGame);
  $('btn-scan-local-dir').addEventListener('click', scanLocalDir);
  $('btn-open-emu-manager').addEventListener('click', openEmulatorManager);

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
  if (action === 'local-img') {
    const g = getGameById(id);
    if (g?.source === 'local' || g?.source === 'emulator') pickLocalGameCover(id);
    else pickLocalImage(id);
  }
  if (action === 'edit-name')    { editGameName(id); }
  if (action === 'close-featured')  { $('featured-wrap').style.display = 'none'; featuredAppid = null; }
  if (action === 'fav-toggle')       { toggleFavorite(id); }
  if (action === 'hide-toggle')      { toggleHidden(id); }
  if (action === 'manage-tags')      { openTagsPopup(id); }
  if (action === 'filter-tag')       { setTagFilter(data.tagname); }
  if (action === 'clear-tag-filter') { setTagFilter(null); }
  if (action === 'remove-local')     { removeLocalGame(id); }
  if (action === 'add-local-game')   { addLocalGame(); }
  if (action === 'open-emu-manager')  { openEmulatorManager(); }
  if (action === 'remove-emu-game')   { removeEmulatorGame(id); }
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
  const steamPath  = $('cfg-path').value.trim();
  const steamPath2 = $('cfg-path2').value.trim();
  currentConfig.steamPath  = steamPath;
  currentConfig.steamPath2 = steamPath2;
  await window.api.saveConfig(currentConfig);
  $('path-hint').textContent = '✓ Salvo';
  $('path-hint').style.color = 'var(--green)';
  // Merge installed from both paths
  const arr1 = steamPath  ? await window.api.getInstalled(steamPath)  : [];
  const arr2 = steamPath2 ? await window.api.getInstalled(steamPath2) : [];
  installedSteam = new Set([...arr1, ...arr2].map(id => 'steam_' + id));
  $('cfg-steam-info').textContent = `${steamGames.length} jogos · ${installedSteam.size} instalados`;
  renderGames();
}


async function autoDetectSteam2() {
  const res = await window.api.detectSteam();
  if (res.error) {
    $('path-hint').textContent = '✗ ' + res.error;
    $('path-hint').style.color = 'var(--red)';
    return;
  }
  $('cfg-path2').value = res.path;
  $('path-hint').textContent = '✓ Detectado';
  $('path-hint').style.color = 'var(--green)';
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
    currentConfig = Object.assign(currentConfig, { key, steamid, steamPath: $('cfg-path').value.trim(), steamPath2: $('cfg-path2').value.trim() });
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
  const steamPath2 = currentConfig.steamPath2 || '';
  const [gamesRes, playerRes, installedArr, installedArr2] = await Promise.all([
    window.api.getGames({ key, steamid }),
    window.api.getPlayer({ key, steamid }).catch(() => null),
    steamPath  ? window.api.getInstalled(steamPath)  : Promise.resolve([]),
    steamPath2 ? window.api.getInstalled(steamPath2) : Promise.resolve([])
  ]);

  steamGames     = gamesRes.games.map(g => Object.assign(g, { source: 'steam', id: 'steam_' + g.appid }));
  installedSteam = new Set([...installedArr, ...installedArr2].map(id => 'steam_' + id));

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
  if (currentConfig.steamPath2) $('cfg-path2').value = currentConfig.steamPath2;
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
  const tagSection = $('tag-filter-section');
  if (tagSection) tagSection.style.display = hasGames ? '' : 'none';

  const hasBoth = steamGames.length > 0 && epicGames.length > 0;
  const hasAny  = steamGames.length > 0 || epicGames.length > 0 || gogGames.length > 0;
  $('tabs-bar').style.display = hasAny ? '' : 'none';
  document.querySelector('.tab[data-tab="steam"]').style.display = steamGames.length > 0 ? '' : 'none';
  document.querySelector('.tab[data-tab="epic"]').style.display  = epicGames.length  > 0 ? '' : 'none';
  document.querySelector('.tab[data-tab="gog"]').style.display   = gogGames.length   > 0 ? '' : 'none';
  const localTab = document.querySelector('.tab[data-tab="local"]');
  if (localTab) localTab.style.display = '';
  const emuTab = document.querySelector('.tab[data-tab="emulator"]');
  if (emuTab) emuTab.style.display = '';
  const hiddenTab = document.querySelector('.tab[data-tab="hidden"]');
  if (hiddenTab) {
    hiddenTab.style.display = hiddenGames.size > 0 ? '' : 'none';
    hiddenTab.querySelector('.hidden-count').textContent = hiddenGames.size;
  }

  updateCacheInfo();
}

// ── Merge libraries ────────────────────────────────────────────────────────────
function mergeAndRender() {
  allGames = [...steamGames, ...epicGames, ...gogGames, ...localGames, ...emulatorGames];
  showLibraryUI();
  applyFilters();
  if (bpActive) { bpRenderTabs(); bpRenderGrid(); bpFocus(bpFocusIdx); }
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
  if (currentTab === 'local')     return localGames;
  if (currentTab === 'emulator')  return emulatorGames;
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
    if (activeTagFilter && !customTags[activeTagFilter]?.games.has(g.id)) return false;
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
  if (g.source === 'local')    return true;
  if (g.source === 'emulator') return true;
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
    srcBadge.textContent = g.source === 'steam' ? 'S' : g.source === 'epic' ? 'E' : g.source === 'gog' ? 'G' : g.source === 'emulator' ? '🕹' : '📁';
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
    // Tag dots on card
    const gameTags = getGameTags(g.id);
    if (gameTags.length) {
      const tagDots = document.createElement('div');
      tagDots.className = 'card-tag-dots';
      gameTags.slice(0, 3).forEach(t => {
        const dot = document.createElement('span');
        dot.className = 'card-tag-dot';
        dot.style.background = customTags[t]?.color || '#6366f1';
        dot.title = t;
        tagDots.appendChild(dot);
      });
      card.appendChild(tagDots);
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
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:950;display:flex;align-items:center;justify-content:center';

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

    if (game.source === 'local') {
      await window.api.localLibraryUpdate({ id, name: trimmed });
    } else {
      await window.api.saveGameName({ id, name: trimmed });
    }

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
  } else if (game.source === 'local') {
    window.api.localLibraryLaunch(game.exePath);
  } else if (game.source === 'emulator') {
    window.api.emulatorLaunch({ emulatorId: game.emulatorId, romPath: game.romPath });
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
    : game.source === 'epic'
    ? '<span class="source-badge epic-badge">EPIC</span>'
    : game.source === 'gog'
    ? '<span class="source-badge gog-badge">GOG</span>'
    : game.source === 'emulator'
    ? '<span class="source-badge emu-badge">EMU</span>'
    : '<span class="source-badge local-badge">LOCAL</span>';
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
    + (game.source==='emulator' ? `<span>🕹 ${esc(getEmulatorName(game.emulatorId))}</span><span>.${game.ext||'rom'}</span>` : `<span>${installed?'✅ Instalado':'☁️ Não instalado'}</span>`) + '</div>'
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
  actions.appendChild(mkBtn('btn-ghost small','🏷️ Tags','manage-tags',game.id));
  const hideBtn = mkBtn('btn-ghost small', hiddenGames.has(game.id) ? '👁 Mostrar' : '🚫 Esconder', 'hide-toggle', game.id);
  if (!hiddenGames.has(game.id)) hideBtn.style.color = 'var(--danger, #e05c5c)';
  actions.appendChild(hideBtn);
  if (game.source === 'local') {
    const removeBtn = mkBtn('btn-ghost small', '🗑 Remover', 'remove-local', game.id);
    removeBtn.style.color = '#e05c5c';
    actions.appendChild(removeBtn);
  }
  if (game.source === 'emulator') {
    const removeEmuBtn = mkBtn('btn-ghost small', '🗑 Remover', 'remove-emu-game', game.id);
    removeEmuBtn.style.color = '#e05c5c';
    actions.appendChild(removeEmuBtn);
  }
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
  updateClearAllBtn();
}

function clearGenres() {
  activeGenres.clear();
  document.querySelectorAll('[data-genre]').forEach(el => el.classList.remove('active'));
  updateRandomSub(); applyFilters(); updateClearAllBtn();
}

function toggleCollapseGenres() {
  genresCollapsed = !genresCollapsed;
  const el = $('genre-collapsible');
  const arrow = $('collapse-arrow-genres');
  if (el) el.style.display = genresCollapsed ? 'none' : '';
  if (arrow) arrow.textContent = genresCollapsed ? '▸' : '▾';
}

function toggleCollapseTags() {
  tagsCollapsed = !tagsCollapsed;
  const el = $('tag-collapsible');
  const arrow = $('collapse-arrow-tags');
  if (el) el.style.display = tagsCollapsed ? 'none' : '';
  if (arrow) arrow.textContent = tagsCollapsed ? '▸' : '▾';
}

function clearAllFilters() {
  activeGenres.clear();
  document.querySelectorAll('[data-genre]').forEach(el => el.classList.remove('active'));
  activeTagFilter = null;
  renderTagChips();
  updateRandomSub();
  applyFilters();
  updateClearAllBtn();
}

function updateClearAllBtn() {
  const btn = $('btn-clear-all-filters');
  if (!btn) return;
  btn.style.display = (activeGenres.size > 0 || activeTagFilter) ? '' : 'none';
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
  const sourceGames = source === 'steam' ? steamGames : source === 'gog' ? gogGames : source === 'local' ? localGames : source === 'emulator' ? emulatorGames : epicGames;
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

// ── Local Library ─────────────────────────────────────────────────────────────


function normalizeEmulatorGame(entry) {
  return {
    id:          entry.id,
    name:        entry.name,
    source:      'emulator',
    emulatorId:  entry.emulatorId,
    romPath:     entry.romPath,
    coverPath:   entry.coverPath || null,
    coverUrl:    entry.coverUrl  || null,
    ext:         entry.ext       || '',
    addedAt:     entry.addedAt   || 0,
    playtime:    0,
    installed:   true
  };
}

function getEmulatorName(id) {
  const emu = emulators.find(e => e.id === id);
  return emu ? emu.name : 'Emulador';
}

async function removeEmulatorGame(id) {
  if (!confirm('Remover esta ROM da biblioteca?')) return;
  emulatorGames = emulatorGames.filter(g => g.id !== id);
  await window.api.emulatorGamesSave(emulatorGames.map(g => ({
    id: g.id, name: g.name, emulatorId: g.emulatorId, romPath: g.romPath,
    coverPath: g.coverPath, coverUrl: g.coverUrl, ext: g.ext, addedAt: g.addedAt
  })));
  closeModal();
  mergeAndRender();
  showLibraryUI();
}

// ── Emulator Manager ──────────────────────────────────────────────────────────
function openEmulatorManager() {
  const overlay = document.createElement('div');
  overlay.id = 'emu-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:950;display:flex;align-items:center;justify-content:center;padding:20px';

  const panel = document.createElement('div');
  panel.style.cssText = 'background:var(--surface,#13161d);border:1px solid rgba(255,255,255,.12);border-radius:16px;width:680px;max-width:95vw;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.6);overflow:hidden';

  const cleanup = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });

  function render() {
    panel.innerHTML = '';

    // Header
    const hdr = document.createElement('div');
    hdr.style.cssText = 'padding:22px 24px 16px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between;flex-shrink:0';
    hdr.innerHTML = `<div><div style="font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:2px;color:var(--text,#e8eaf0)">🕹 EMULADORES</div><div style="font-size:12px;color:var(--muted,#6b7280);margin-top:2px">Configure emuladores e escaneie pastas de ROMs</div></div><button id="emu-close" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:4px 8px">✕</button>`;
    panel.appendChild(hdr);
    document.getElementById('emu-close')?.addEventListener('click', cleanup);

    const body = document.createElement('div');
    body.style.cssText = 'overflow-y:auto;flex:1;padding:20px 24px;display:flex;flex-direction:column;gap:16px';

    // ── Existing emulators
    if (emulators.length) {
      emulators.forEach(emu => {
        const card = document.createElement('div');
        card.style.cssText = 'background:var(--surface2,#1a1e28);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px';

        const topRow = document.createElement('div');
        topRow.style.cssText = 'display:flex;align-items:center;gap:10px';
        topRow.innerHTML = `<span style="font-size:20px">🕹</span><div style="flex:1;min-width:0"><div style="font-weight:600;font-size:14px;color:var(--text,#e8eaf0)">${esc(emu.name)}</div><div style="font-size:11px;color:var(--muted,#6b7280);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(emu.exePath)}">${esc(emu.exePath)}</div></div>`;

        const extBadge = document.createElement('span');
        extBadge.style.cssText = 'font-size:11px;color:var(--muted);background:rgba(255,255,255,.07);padding:3px 8px;border-radius:6px;white-space:nowrap;flex-shrink:0';
        extBadge.textContent = (emu.extensions||[]).join(', ') || 'todas';
        topRow.appendChild(extBadge);
        card.appendChild(topRow);

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';

        const scanBtn = document.createElement('button');
        scanBtn.style.cssText = 'padding:6px 14px;border-radius:8px;border:none;background:linear-gradient(135deg,#6366f1,#4f46e5);color:white;cursor:pointer;font-size:12px;font-weight:600';
        scanBtn.textContent = '📂 Escanear ROMs';
        scanBtn.onclick = () => { cleanup(); scanRoms(emu); };

        const delBtn = document.createElement('button');
        delBtn.style.cssText = 'padding:6px 14px;border-radius:8px;border:1px solid rgba(224,92,92,.4);background:rgba(224,92,92,.1);color:#e05c5c;cursor:pointer;font-size:12px';
        delBtn.textContent = '🗑 Remover';
        delBtn.onclick = async () => {
          if (!confirm(`Remover o emulador "${emu.name}"? Os jogos associados serão removidos.`)) return;
          emulators = emulators.filter(e => e.id !== emu.id);
          emulatorGames = emulatorGames.filter(g => g.emulatorId !== emu.id);
          await window.api.emulatorsSave(emulators);
          await window.api.emulatorGamesSave(emulatorGames.map(serializeEmuGame));
          mergeAndRender(); showLibraryUI(); render();
        };

        btnRow.appendChild(scanBtn);
        btnRow.appendChild(delBtn);
        card.appendChild(btnRow);
        body.appendChild(card);
      });
    } else {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;padding:24px;color:var(--muted,#6b7280);font-size:13px';
      empty.textContent = 'Nenhum emulador configurado. Adicione um abaixo.';
      body.appendChild(empty);
    }

    // ── Add new emulator form
    const divider = document.createElement('div');
    divider.style.cssText = 'border-top:1px solid rgba(255,255,255,.08);padding-top:16px';

    const formTitle = document.createElement('div');
    formTitle.style.cssText = 'font-family:"Bebas Neue",sans-serif;font-size:16px;letter-spacing:1.5px;color:var(--text,#e8eaf0);margin-bottom:12px';
    formTitle.textContent = '+ ADICIONAR EMULADOR';
    divider.appendChild(formTitle);

    // Name field
    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;gap:8px;margin-bottom:10px';
    const nameInput = document.createElement('input');
    nameInput.type = 'text'; nameInput.placeholder = 'Nome do emulador (ex: PCSX2, RPCS3, RetroArch…)';
    nameInput.style.cssText = 'flex:1;background:var(--surface2,#1a1e28);border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:9px 12px;color:var(--text,#e8eaf0);font-size:13px;outline:none';
    nameRow.appendChild(nameInput);
    divider.appendChild(nameRow);

    // Exe picker
    const exeRow = document.createElement('div');
    exeRow.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;align-items:center';
    const exeInput = document.createElement('input');
    exeInput.type = 'text'; exeInput.placeholder = 'Caminho do executável…'; exeInput.readOnly = true;
    exeInput.style.cssText = 'flex:1;background:var(--surface2,#1a1e28);border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:9px 12px;color:var(--text,#e8eaf0);font-size:12px;outline:none';
    const exeBtn = document.createElement('button');
    exeBtn.textContent = '📂 Escolher .exe';
    exeBtn.style.cssText = 'padding:9px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:none;color:var(--text,#e8eaf0);cursor:pointer;font-size:12px;white-space:nowrap';
    exeBtn.onclick = async () => {
      const p = await window.api.emulatorsPickExe();
      if (p) { exeInput.value = p; if (!nameInput.value) nameInput.value = require ? '' : p.split(/[\/]/).pop().replace(/\.exe$/i,''); }
    };
    exeRow.appendChild(exeInput); exeRow.appendChild(exeBtn);
    divider.appendChild(exeRow);

    // Extensions field
    const extRow = document.createElement('div');
    extRow.style.cssText = 'display:flex;gap:8px;margin-bottom:14px;align-items:center';
    const extInput = document.createElement('input');
    extInput.type = 'text'; extInput.placeholder = 'Extensões de ROM (ex: iso, bin, nes) — separadas por vírgula ou espaço';
    extInput.style.cssText = 'flex:1;background:var(--surface2,#1a1e28);border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:9px 12px;color:var(--text,#e8eaf0);font-size:13px;outline:none';
    extRow.appendChild(extInput);
    divider.appendChild(extRow);

    const addEmuBtn = document.createElement('button');
    addEmuBtn.style.cssText = 'padding:10px 22px;border-radius:8px;border:none;background:linear-gradient(135deg,#f97316,#ea580c);color:white;font-size:13px;font-weight:600;cursor:pointer';
    addEmuBtn.textContent = '+ Adicionar Emulador';
    addEmuBtn.onclick = async () => {
      const name    = nameInput.value.trim();
      const exePath = exeInput.value.trim();
      if (!name || !exePath) { nameInput.style.borderColor = !name ? '#e05c5c' : ''; exeInput.style.borderColor = !exePath ? '#e05c5c' : ''; return; }
      const extensions = extInput.value.split(/[,\s]+/).map(e => e.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
      const emu = { id: 'emu_' + Date.now(), name, exePath, extensions };
      emulators.push(emu);
      await window.api.emulatorsSave(emulators);
      render();
    };
    divider.appendChild(addEmuBtn);
    body.appendChild(divider);
    panel.appendChild(body);
  }

  render();
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

function serializeEmuGame(g) {
  return { id: g.id, name: g.name, emulatorId: g.emulatorId, romPath: g.romPath, coverPath: g.coverPath, coverUrl: g.coverUrl, ext: g.ext, addedAt: g.addedAt };
}

async function scanRoms(emu) {
  const result = await window.api.emulatorScanRoms({ extensions: emu.extensions || [] });
  if (!result) return;
  const { roms } = result;
  if (!roms.length) { alert('Nenhuma ROM encontrada com as extensões configuradas.'); return; }

  const existingPaths = new Set(emulatorGames.map(g => g.romPath));
  const newRoms = roms.filter(r => !existingPaths.has(r.romPath));
  if (!newRoms.length) { alert('Todas as ROMs já estão na biblioteca.'); return; }

  openRomScanPreviewDialog(emu, newRoms);
}

function openRomScanPreviewDialog(emu, roms) {
  const items = roms.map((r, i) => ({
    _tmpId:   'rom_' + i,
    name:     r.name,
    romPath:  r.romPath,
    ext:      r.ext,
    coverUrl: null,
    selected: true,
    fetching: false
  }));

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:950;display:flex;align-items:center;justify-content:center;padding:20px';

  const panel = document.createElement('div');
  panel.style.cssText = 'background:var(--surface,#13161d);border:1px solid rgba(255,255,255,.12);border-radius:16px;width:720px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.6);overflow:hidden';

  const hdr = document.createElement('div');
  hdr.style.cssText = 'padding:20px 24px 14px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between;flex-shrink:0';
  hdr.innerHTML = `<div><div style="font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:2px;color:var(--text,#e8eaf0)">🕹 ROMs — ${esc(emu.name)}</div><div style="font-size:12px;color:var(--muted,#6b7280);margin-top:2px">${items.length} ROM${items.length!==1?'s':''} encontrada${items.length!==1?'s':''}</div></div><button id="rom-close" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:4px 8px">✕</button>`;
  panel.appendChild(hdr);

  const progressWrap = document.createElement('div');
  progressWrap.style.cssText = 'padding:10px 24px;background:rgba(249,115,22,.07);border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0;display:none';
  progressWrap.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><span style="font-size:12px;color:var(--muted)" id="rom-prog-lbl">Buscando capas…</span><span style="font-size:12px;font-weight:600;color:#f97316" id="rom-prog-pct">0%</span></div><div style="height:4px;background:rgba(255,255,255,.08);border-radius:2px"><div id="rom-prog-fill" style="height:100%;background:#f97316;border-radius:2px;width:0%;transition:width .3s"></div></div>`;
  panel.appendChild(progressWrap);

  const selRow = document.createElement('div');
  selRow.style.cssText = 'padding:10px 24px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;border-bottom:1px solid rgba(255,255,255,.06)';
  selRow.innerHTML = `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--text)"><input type="checkbox" id="rom-sel-all" checked style="width:15px;height:15px;accent-color:#f97316"> Selecionar todos</label><span id="rom-sel-count" style="font-size:12px;color:var(--muted)">${items.length} selecionados</span>`;
  panel.appendChild(selRow);

  const list = document.createElement('div');
  list.style.cssText = 'overflow-y:auto;flex:1;padding:12px 16px;display:flex;flex-direction:column;gap:5px';
  panel.appendChild(list);

  const footer = document.createElement('div');
  footer.style.cssText = 'padding:14px 24px;border-top:1px solid rgba(255,255,255,.08);display:flex;gap:10px;justify-content:flex-end;flex-shrink:0';
  footer.innerHTML = `<button id="rom-cancel" style="padding:9px 18px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:none;color:var(--muted);cursor:pointer;font-size:13px">Cancelar</button><button id="rom-add" style="padding:9px 20px;border-radius:8px;border:none;background:linear-gradient(135deg,#f97316,#ea580c);color:white;cursor:pointer;font-size:13px;font-weight:600">Adicionar Selecionadas</button>`;
  panel.appendChild(footer);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  function updateCount() {
    const n = items.filter(i => i.selected).length;
    const el = document.getElementById('rom-sel-count');
    if (el) el.textContent = `${n} selecionada${n!==1?'s':''}`;
    const btn = document.getElementById('rom-add');
    if (btn) btn.disabled = n === 0;
  }

  function renderList() {
    list.innerHTML = '';
    items.forEach(item => {
      const row = document.createElement('div');
      row.id = 'rom-row-' + item._tmpId;
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:9px;background:var(--surface2,#1a1e28);border:1px solid rgba(255,255,255,.05)';
      const cb = document.createElement('input');
      cb.type='checkbox'; cb.checked=item.selected; cb.style.cssText='width:14px;height:14px;accent-color:#f97316;flex-shrink:0;cursor:pointer';
      cb.addEventListener('change', () => { item.selected=cb.checked; updateCount(); const sa=document.getElementById('rom-sel-all'); if(sa) sa.checked=items.every(i=>i.selected); });
      const cw = document.createElement('div');
      cw.style.cssText='width:36px;height:50px;border-radius:5px;overflow:hidden;flex-shrink:0;background:rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center;font-size:16px';
      if (item.coverUrl) { const img=document.createElement('img'); img.src=item.coverUrl; img.style.cssText='width:100%;height:100%;object-fit:cover'; img.addEventListener('error',()=>{cw.innerHTML='🕹';}); cw.appendChild(img); }
      else if (item.fetching) { cw.innerHTML='<div style="width:18px;height:18px;border:2px solid rgba(255,255,255,.2);border-top-color:#f97316;border-radius:50%;animation:spin .7s linear infinite"></div>'; }
      else { cw.textContent='🕹'; }
      const info = document.createElement('div'); info.style.cssText='flex:1;min-width:0';
      const nameEl = document.createElement('input'); nameEl.type='text'; nameEl.value=item.name;
      nameEl.style.cssText='background:transparent;border:none;border-bottom:1px solid transparent;color:var(--text,#e8eaf0);font-size:12px;font-weight:600;width:100%;outline:none;padding:1px 0;transition:border-color .15s';
      nameEl.addEventListener('focus',()=>nameEl.style.borderBottomColor='#f97316');
      nameEl.addEventListener('blur',()=>{nameEl.style.borderBottomColor='transparent';item.name=nameEl.value.trim()||item.name;nameEl.value=item.name;});
      nameEl.addEventListener('keydown',e=>{if(e.key==='Enter')nameEl.blur();});
      const extEl = document.createElement('span'); extEl.style.cssText='font-size:10px;color:var(--muted);'; extEl.textContent='.'+item.ext+' · '+item.romPath.split(/[\/]/).pop();
      info.appendChild(nameEl); info.appendChild(extEl);
      row.appendChild(cb); row.appendChild(cw); row.appendChild(info);
      list.appendChild(row);
    });
  }
  renderList(); updateCount();

  document.getElementById('rom-sel-all').addEventListener('change', e => { items.forEach(i=>i.selected=e.target.checked); renderList(); updateCount(); });
  const cleanup2 = () => overlay.remove();
  document.getElementById('rom-close').addEventListener('click', cleanup2);
  document.getElementById('rom-cancel').addEventListener('click', cleanup2);
  overlay.addEventListener('click', e => { if(e.target===overlay) cleanup2(); });

  document.getElementById('rom-add').addEventListener('click', async () => {
    const selected = items.filter(i => i.selected);
    if (!selected.length) return;
    const btn = document.getElementById('rom-add');
    btn.disabled=true; btn.textContent='Adicionando…';
    for (const item of selected) {
      const id = 'emugame_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
      const entry = { id, name: item.name, emulatorId: emu.id, romPath: item.romPath, coverPath: null, coverUrl: item.coverUrl||null, ext: item.ext, addedAt: Date.now() };
      const game = normalizeEmulatorGame(entry);
      emulatorGames.push(game);
      genreData[game.id] = {};
      if (item.coverUrl) genreData[game.id].header = item.coverUrl;
    }
    await window.api.emulatorGamesSave(emulatorGames.map(serializeEmuGame));
    cleanup2();
    mergeAndRender(); showLibraryUI(); switchTab('emulator');
    fetchIgdbGenresBackground('emulator');
  });

  // Fetch covers in background
  setTimeout(async () => {
    progressWrap.style.display='';
    let done=0; const total=items.length;
    const updateProg = () => {
      const pct=Math.round((done/total)*100);
      const fill=document.getElementById('rom-prog-fill');
      const pctEl=document.getElementById('rom-prog-pct');
      const lbl=document.getElementById('rom-prog-lbl');
      if(fill) fill.style.width=pct+'%';
      if(pctEl) pctEl.textContent=pct+'%';
      if(lbl) lbl.textContent=done>=total?'✓ Capas carregadas':`Buscando capas… ${done}/${total}`;
    };
    items.forEach(i=>{i.fetching=true;}); renderList();
    const CONCUR=3;
    async function fetchCover(item) {
      try {
        const res = await window.api.localLibraryFetchCovers([{id:item._tmpId,name:item.name}]);
        if(res&&res[item._tmpId]) item.coverUrl=res[item._tmpId];
      } catch {}
      item.fetching=false; done++; updateProg();
      const row=document.getElementById('rom-row-'+item._tmpId);
      if(row) {
        const cw=row.children[1];
        if(item.coverUrl){cw.innerHTML='';const img=document.createElement('img');img.src=item.coverUrl;img.style.cssText='width:100%;height:100%;object-fit:cover';img.addEventListener('error',()=>{cw.innerHTML='🕹';});cw.appendChild(img);}
        else{cw.innerHTML='🕹';}
      }
    }
    for(let i=0;i<total;i+=CONCUR){await Promise.all(items.slice(i,i+CONCUR).map(fetchCover));}
    if(done>=total) setTimeout(()=>{if(progressWrap.parentNode)progressWrap.style.display='none';},2000);
  },100);
}

function normalizeLocalGame(entry) {
  return {
    id:       entry.id,
    name:     entry.name,
    source:   'local',
    exePath:  entry.exePath,
    coverPath: entry.coverPath || null,
    addedAt:  entry.addedAt || 0,
    playtime: 0,
    installed: true
  };
}

async function addLocalGame() {
  const btn = $('btn-add-local-game');
  if (btn) { btn.disabled = true; btn.textContent = 'Aguarde…'; }
  try {
    const entry = await window.api.localLibraryAdd();
    if (!entry) return;
    const game = normalizeLocalGame(entry);
    localGames.push(game);
    genreData[game.id] = {};
    if (entry.coverPath) {
      genreData[game.id].localImage = 'file://' + entry.coverPath.replace(/\\/g, '/');
    }
    mergeAndRender();
    showLibraryUI();
    // Fetch genres from IGDB in background
    fetchIgdbGenresBackground('local');
    switchTab('local');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '+ Adicionar Jogo Local'; }
  }
}

async function scanLocalDir() {
  const btn = $('btn-scan-local-dir');
  if (btn) { btn.disabled = true; btn.textContent = '🔍 Escaneando…'; }
  let scanResult;
  try {
    scanResult = await window.api.localLibraryScanDir();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📁 Escanear Pasta'; }
  }
  if (!scanResult) return;
  const { candidates } = scanResult;
  if (!candidates.length) { alert('Nenhum jogo encontrado na pasta selecionada.'); return; }
  const existingExes = new Set(localGames.map(g => g.exePath));
  const newCandidates = candidates.filter(c => !existingExes.has(c.exePath));
  if (!newCandidates.length) { alert('Todos os jogos encontrados já estão na biblioteca.'); return; }
  openScanPreviewDialog(newCandidates);
}

function openScanPreviewDialog(candidates) {
  const items = candidates.map((c, i) => ({
    _tmpId: 'scan_' + i, name: c.name, exePath: c.exePath,
    coverUrl: null, selected: true, fetching: false
  }));

  const overlay = document.createElement('div');
  overlay.id = 'scan-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:950;display:flex;align-items:center;justify-content:center;padding:20px';

  const panel = document.createElement('div');
  panel.style.cssText = 'background:var(--surface,#13161d);border:1px solid rgba(255,255,255,.12);border-radius:16px;width:720px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.6);overflow:hidden';

  const hdr = document.createElement('div');
  hdr.style.cssText = 'padding:22px 24px 16px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between;flex-shrink:0';
  hdr.innerHTML = `<div><div style="font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:2px;color:var(--text,#e8eaf0)">📁 JOGOS ENCONTRADOS</div><div style="font-size:12px;color:var(--muted,#6b7280);margin-top:3px">${items.length} jogo${items.length!==1?'s':''} detectado${items.length!==1?'s':''} — selecione os que deseja adicionar</div></div><button id="scan-close-btn" style="background:none;border:none;color:var(--muted,#6b7280);cursor:pointer;font-size:18px;padding:4px 8px">✕</button>`;
  panel.appendChild(hdr);

  const progressWrap = document.createElement('div');
  progressWrap.id = 'scan-progress-wrap';
  progressWrap.style.cssText = 'padding:10px 24px;background:rgba(99,102,241,.07);border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0;display:none';
  progressWrap.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><span style="font-size:12px;color:var(--muted,#6b7280)" id="scan-progress-lbl">Buscando capas…</span><span style="font-size:12px;font-weight:600;color:var(--accent2,#1a9fff)" id="scan-progress-pct">0%</span></div><div style="height:4px;background:rgba(255,255,255,.08);border-radius:2px"><div id="scan-progress-fill" style="height:100%;background:var(--accent2,#1a9fff);border-radius:2px;width:0%;transition:width .3s"></div></div>`;
  panel.appendChild(progressWrap);

  const selAllRow = document.createElement('div');
  selAllRow.style.cssText = 'padding:10px 24px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;border-bottom:1px solid rgba(255,255,255,.06)';
  selAllRow.innerHTML = `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--text,#e8eaf0)"><input type="checkbox" id="scan-select-all" checked style="width:15px;height:15px;accent-color:#6366f1"> Selecionar todos</label><span id="scan-sel-count" style="font-size:12px;color:var(--muted,#6b7280)">${items.length} selecionados</span>`;
  panel.appendChild(selAllRow);

  const list = document.createElement('div');
  list.id = 'scan-game-list';
  list.style.cssText = 'overflow-y:auto;flex:1;padding:12px 16px;display:flex;flex-direction:column;gap:6px';
  panel.appendChild(list);

  const footer = document.createElement('div');
  footer.style.cssText = 'padding:16px 24px;border-top:1px solid rgba(255,255,255,.08);display:flex;gap:10px;justify-content:flex-end;flex-shrink:0';
  footer.innerHTML = `<button id="scan-cancel-btn" style="padding:9px 20px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:none;color:var(--muted,#6b7280);cursor:pointer;font-size:13px">Cancelar</button><button id="scan-add-btn" style="padding:9px 22px;border-radius:8px;border:none;background:linear-gradient(135deg,#6366f1,#4f46e5);color:white;cursor:pointer;font-size:13px;font-weight:600">Adicionar Selecionados</button>`;
  panel.appendChild(footer);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  function updateSelCount() {
    const n = items.filter(i => i.selected).length;
    const el = document.getElementById('scan-sel-count');
    if (el) el.textContent = `${n} selecionado${n!==1?'s':''}`;
    const addBtn = document.getElementById('scan-add-btn');
    if (addBtn) addBtn.disabled = n === 0;
  }

  function renderList() {
    list.innerHTML = '';
    items.forEach(item => {
      const row = document.createElement('div');
      row.id = 'scan-row-' + item._tmpId;
      row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:10px;background:var(--surface2,#1a1e28);border:1px solid rgba(255,255,255,.06)';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = item.selected;
      cb.style.cssText = 'width:15px;height:15px;accent-color:#6366f1;flex-shrink:0;cursor:pointer';
      cb.addEventListener('change', () => { item.selected = cb.checked; updateSelCount(); const sa = document.getElementById('scan-select-all'); if (sa) sa.checked = items.every(i => i.selected); });
      const coverWrap = document.createElement('div');
      coverWrap.style.cssText = 'width:42px;height:56px;border-radius:6px;overflow:hidden;flex-shrink:0;background:rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center;font-size:20px';
      if (item.coverUrl) { const img = document.createElement('img'); img.src = item.coverUrl; img.style.cssText = 'width:100%;height:100%;object-fit:cover'; img.addEventListener('error', () => { coverWrap.innerHTML = '🎮'; }); coverWrap.appendChild(img); }
      else if (item.fetching) { coverWrap.innerHTML = '<div style="width:22px;height:22px;border:2px solid rgba(255,255,255,.2);border-top-color:#6366f1;border-radius:50%;animation:spin .7s linear infinite"></div>'; }
      else { coverWrap.textContent = '🎮'; }
      const info = document.createElement('div'); info.style.cssText = 'flex:1;min-width:0';
      const nameEl = document.createElement('input'); nameEl.type = 'text'; nameEl.value = item.name;
      nameEl.style.cssText = 'background:transparent;border:none;border-bottom:1px solid transparent;color:var(--text,#e8eaf0);font-size:13px;font-weight:600;width:100%;outline:none;padding:2px 0;transition:border-color .15s';
      nameEl.addEventListener('focus', () => nameEl.style.borderBottomColor = '#6366f1');
      nameEl.addEventListener('blur', () => { nameEl.style.borderBottomColor = 'transparent'; item.name = nameEl.value.trim() || item.name; nameEl.value = item.name; });
      nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') nameEl.blur(); });
      const pathEl = document.createElement('div'); pathEl.style.cssText = 'font-size:10px;color:var(--muted,#6b7280);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px'; pathEl.title = item.exePath; pathEl.textContent = item.exePath;
      info.appendChild(nameEl); info.appendChild(pathEl);
      row.appendChild(cb); row.appendChild(coverWrap); row.appendChild(info);
      list.appendChild(row);
    });
  }

  renderList();
  updateSelCount();

  document.getElementById('scan-select-all').addEventListener('change', e => { items.forEach(i => i.selected = e.target.checked); renderList(); updateSelCount(); });
  const cleanup = () => overlay.remove();
  document.getElementById('scan-close-btn').addEventListener('click', cleanup);
  document.getElementById('scan-cancel-btn').addEventListener('click', cleanup);
  overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });

  document.getElementById('scan-add-btn').addEventListener('click', async () => {
    const selected = items.filter(i => i.selected);
    if (!selected.length) return;
    const addBtn = document.getElementById('scan-add-btn');
    addBtn.disabled = true; addBtn.textContent = 'Adicionando…';
    for (const item of selected) {
      const id = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
      const entry = { id, name: item.name, exePath: item.exePath, coverPath: null, addedAt: Date.now() };
      await window.api.localLibraryUpdate({ id: entry.id, _addEntry: entry });
      const game = normalizeLocalGame(entry);
      localGames.push(game);
      genreData[game.id] = {};
      if (item.coverUrl) genreData[game.id].header = item.coverUrl;
    }
    cleanup();
    mergeAndRender();
    showLibraryUI();
    switchTab('local');
    fetchIgdbGenresBackground('local');
  });

  setTimeout(async () => {
    progressWrap.style.display = '';
    let done = 0; const total = items.length;
    const updateProgress = () => {
      const pct = Math.round((done / total) * 100);
      const fill = document.getElementById('scan-progress-fill');
      const pctEl = document.getElementById('scan-progress-pct');
      const lbl   = document.getElementById('scan-progress-lbl');
      if (fill) fill.style.width = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
      if (lbl) lbl.textContent = done >= total ? '✓ Capas carregadas' : `Buscando capas… ${done}/${total}`;
    };
    items.forEach(i => { i.fetching = true; }); renderList();
    const CONCUR = 3;
    async function fetchCover(item) {
      try {
        const res = await window.api.localLibraryFetchCovers([{ id: item._tmpId, name: item.name }]);
        if (res && res[item._tmpId]) item.coverUrl = res[item._tmpId];
      } catch {}
      item.fetching = false; done++; updateProgress();
      const row = document.getElementById('scan-row-' + item._tmpId);
      if (row) {
        const coverWrap = row.children[1];
        if (item.coverUrl) { coverWrap.innerHTML = ''; const img = document.createElement('img'); img.src = item.coverUrl; img.style.cssText = 'width:100%;height:100%;object-fit:cover'; img.addEventListener('error', () => { coverWrap.innerHTML = '🎮'; }); coverWrap.appendChild(img); }
        else { coverWrap.innerHTML = '🎮'; }
      }
    }
    for (let i = 0; i < total; i += CONCUR) { await Promise.all(items.slice(i, i + CONCUR).map(fetchCover)); }
    if (done >= total) setTimeout(() => { if (progressWrap.parentNode) progressWrap.style.display = 'none'; }, 2000);
  }, 100);
}

async function removeLocalGame(id) {
  if (!confirm('Remover este jogo da biblioteca local?')) return;
  await window.api.localLibraryRemove(id);
  localGames = localGames.filter(g => g.id !== id);
  closeModal();
  mergeAndRender();
  showLibraryUI();
}

async function pickLocalGameCover(id) {
  const filePath = await window.api.localLibraryPickCover();
  if (!filePath) return;
  const emuGame = emulatorGames.find(g => g.id === id);
  if (emuGame) {
    emuGame.coverPath = filePath;
    await window.api.emulatorGamesSave(emulatorGames.map(serializeEmuGame));
  } else {
    await window.api.localLibraryUpdate({ id, coverPath: filePath });
  }
  const game = localGames.find(g => g.id === id);
  if (game) game.coverPath = filePath;
  if (!genreData[id]) genreData[id] = {};
  genreData[id].localImage = 'file://' + filePath.replace(/\\/g, '/');
  noImageSet.delete(id);
  const card = $('card-' + id);
  if (card) {
    const old = card.querySelector('img, .gc-thumb-err, .gc-thumb-skeleton');
    if (old) {
      const img = document.createElement('img');
      img.className = 'gc-thumb'; img.src = genreData[id].localImage; img.alt = '';
      img.addEventListener('error', () => img.replaceWith(mkErr('gc-thumb-err')), { once: true });
      old.replaceWith(img);
    }
  }
  if (featuredAppid === id) showFeatured(getGameById(id));
  // Update modal if open
  const overlay = $('modal-overlay');
  if (overlay.classList.contains('open')) renderModal($('modal-box'), getGameById(id), genreData[id]);
}

// ── Custom Tags ───────────────────────────────────────────────────────────────

const TAG_PALETTE = [
  '#6366f1','#8b5cf6','#ec4899','#f43f5e','#f97316',
  '#eab308','#22c55e','#10b981','#06b6d4','#3b82f6'
];

function serializeTags() {
  const out = {};
  for (const [name, data] of Object.entries(customTags)) {
    out[name] = { color: data.color, games: [...data.games] };
  }
  return out;
}

async function persistTags() {
  await window.api.saveTags(serializeTags());
}

function getGameTags(id) {
  return Object.entries(customTags)
    .filter(([, data]) => data.games.has(id))
    .map(([name]) => name);
}

function setTagFilter(tagName) {
  activeTagFilter = tagName;
  renderTagChips();
  applyFilters();
  updateClearAllBtn();
}

function renderTagChips() {
  const container = $('tag-filter-chips');
  if (!container) return;
  container.innerHTML = '';

  const names = Object.keys(customTags);
  if (!names.length) {
    container.style.display = 'none';
    return;
  }
  container.style.display = '';

  // "Todos" pill
  const allBtn = document.createElement('button');
  allBtn.className = 'chip tag-chip' + (!activeTagFilter ? ' active' : '');
  allBtn.dataset.action = 'clear-tag-filter';
  allBtn.innerHTML = `<span class="chip-name">Todos</span>`;
  container.appendChild(allBtn);

  names.forEach(name => {
    const t   = customTags[name];
    const cnt = t.games.size;
    const btn = document.createElement('button');
    btn.className = 'chip tag-chip' + (activeTagFilter === name ? ' active' : '');
    btn.style.setProperty('--tag-color', t.color);
    btn.dataset.action  = 'filter-tag';
    btn.dataset.tagname = name;
    btn.innerHTML = `<span class="tag-chip-dot" style="background:${t.color}"></span>`
      + `<span class="chip-name">${esc(name)}</span>`
      + `<span class="chip-cnt">${cnt}</span>`;
    container.appendChild(btn);
  });
}

function openTagsPopup(gameId) {
  const game = getGameById(gameId);
  if (!game) return;

  const overlay = document.createElement('div');
  overlay.id = 'tags-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:950;display:flex;align-items:center;justify-content:center';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--surface,#13161d);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:28px 28px 22px;width:420px;max-width:92vw;display:flex;flex-direction:column;gap:16px;box-shadow:0 20px 60px rgba(0,0,0,.5)';

  function render() {
    box.innerHTML = '';

    // Header
    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between';
    hdr.innerHTML = `<div style="font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:2px;color:var(--text,#e8eaf0)">🏷️ TAGS — ${esc(game.name)}</div>`;
    const closeX = document.createElement('button');
    closeX.textContent = '✕';
    closeX.style.cssText = 'background:none;border:none;color:var(--muted,#6b7280);cursor:pointer;font-size:16px;padding:2px 6px';
    closeX.onclick = cleanup;
    hdr.appendChild(closeX);
    box.appendChild(hdr);

    // Existing tags with toggle + delete
    const gameTags = getGameTags(gameId);
    const allNames = Object.keys(customTags);
    if (allNames.length) {
      const list = document.createElement('div');
      list.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
      allNames.forEach(name => {
        const t      = customTags[name];
        const active = gameTags.includes(name);

        const wrap = document.createElement('div');
        wrap.style.cssText = `display:inline-flex;align-items:center;border-radius:999px;border:2px solid ${t.color};background:${active ? t.color+'33' : 'transparent'};overflow:hidden;transition:all .15s`;

        // Toggle pill button
        const pill = document.createElement('button');
        pill.style.cssText = `display:inline-flex;align-items:center;gap:6px;padding:5px 10px 5px 12px;background:none;border:none;color:var(--text,#e8eaf0);cursor:pointer;font-size:13px;font-weight:500`;
        pill.innerHTML = `<span style="width:9px;height:9px;border-radius:50%;background:${t.color};display:inline-block;flex-shrink:0"></span>${esc(name)}${active ? ' ✓' : ''}`;
        pill.title = active ? 'Remover tag' : 'Adicionar tag';
        pill.onclick = async () => {
          if (active) customTags[name].games.delete(gameId);
          else        customTags[name].games.add(gameId);
          await persistTags();
          renderTagChips();
          renderGames();
          render();
        };

        // Delete button
        const delBtn = document.createElement('button');
        delBtn.style.cssText = `background:none;border:none;border-left:1px solid ${t.color}44;color:var(--muted,#6b7280);cursor:pointer;padding:5px 8px;font-size:11px;line-height:1;transition:color .15s,background .15s`;
        delBtn.textContent = '✕';
        delBtn.title = `Excluir tag "${name}"`;
        delBtn.onmouseenter = () => { delBtn.style.color = '#e05c5c'; delBtn.style.background = 'rgba(224,92,92,.15)'; };
        delBtn.onmouseleave = () => { delBtn.style.color = 'var(--muted,#6b7280)'; delBtn.style.background = 'none'; };
        delBtn.onclick = (e) => { e.stopPropagation(); confirmDeleteTag(name); };

        wrap.appendChild(pill);
        wrap.appendChild(delBtn);
        list.appendChild(wrap);
      });
      box.appendChild(list);
    }

    // Divider
    const div = document.createElement('div');
    div.style.cssText = 'border-top:1px solid rgba(255,255,255,.08);margin:0 -4px';
    box.appendChild(div);

    // New tag form
    const formLabel = document.createElement('div');
    formLabel.style.cssText = 'font-size:11px;font-weight:600;letter-spacing:1px;color:var(--muted,#6b7280);text-transform:uppercase';
    formLabel.textContent = 'Nova tag';
    box.appendChild(formLabel);

    const formRow = document.createElement('div');
    formRow.style.cssText = 'display:flex;gap:8px;align-items:center';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Nome da tag…';
    nameInput.maxLength = 24;
    nameInput.style.cssText = 'flex:1;background:var(--surface2,#1a1e28);border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:8px 12px;color:var(--text,#e8eaf0);font-size:13px;outline:none';

    // Color picker row
    const colorRow = document.createElement('div');
    colorRow.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap';
    let pickedColor = TAG_PALETTE[0];
    const colorSwatches = TAG_PALETTE.map(hex => {
      const sw = document.createElement('button');
      sw.style.cssText = `width:20px;height:20px;border-radius:50%;background:${hex};border:2px solid ${hex === pickedColor ? 'white' : 'transparent'};cursor:pointer;flex-shrink:0;transition:border .12s`;
      sw.title = hex;
      sw.onclick = () => {
        pickedColor = hex;
        colorRow.querySelectorAll('button').forEach((s,i) => {
          s.style.borderColor = TAG_PALETTE[i] === pickedColor ? 'white' : 'transparent';
        });
      };
      return sw;
    });
    colorSwatches.forEach(sw => colorRow.appendChild(sw));

    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Criar';
    addBtn.style.cssText = 'padding:8px 16px;border-radius:8px;border:none;background:var(--accent2,#6366f1);color:white;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap';
    addBtn.onclick = async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      if (customTags[name]) { nameInput.style.borderColor = 'var(--red,#e05c5c)'; return; }
      customTags[name] = { color: pickedColor, games: new Set([gameId]) };
      await persistTags();
      renderTagChips();
      renderGames();
      render();
    };
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });

    formRow.appendChild(nameInput);
    formRow.appendChild(addBtn);
    box.appendChild(formRow);
    box.appendChild(colorRow);
  }

  async function confirmDeleteTag(name) {
    if (!confirm(`Excluir a tag "${name}"? Será removida de todos os jogos.`)) return;
    delete customTags[name];
    if (activeTagFilter === name) activeTagFilter = null;
    await persistTags();
    renderTagChips();
    renderGames();
    render();
  }

  function cleanup() { overlay.remove(); }
  overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });

  render();
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  setTimeout(() => overlay.querySelector('input')?.focus(), 50);
}




// ── Big Picture Mode ─────────────────────────────────────────────────────────
let bpActive    = false;
let bpFocusIdx  = 0;
let bpGames     = [];
let bpQuery     = '';
let bpTab       = 'all';
let bpClockTick = null;

function getBpGames() {
  const q = bpQuery.toLowerCase();
  return allGames
    .filter(g => !hiddenGames.has(g.id))
    .filter(g => {
      if (bpTab === 'all')       return true;
      if (bpTab === 'favorites') return favorites.has(g.id);
      return g.source === bpTab;
    })
    .filter(g => !q || g.name.toLowerCase().includes(q));
}

async function openBigPicture() {
  bpActive = true;
  bpQuery  = '';
  bpTab    = 'all';
  document.getElementById('bp-overlay').style.display = 'flex';
  document.getElementById('bp-search').value = '';
  document.body.classList.add('bp-mode');
  await window.api.toggleFullscreen();
  bpRenderTabs();
  bpRenderGrid();
  bpFocus(0);
  bpStartClock();
  document.getElementById('bp-search').addEventListener('input', bpOnSearch);
  document.addEventListener('keydown', bpKeyHandler);
}

async function closeBigPicture() {
  bpActive = false;
  document.getElementById('bp-overlay').style.display = 'none';
  document.body.classList.remove('bp-mode');
  clearInterval(bpClockTick);
  document.removeEventListener('keydown', bpKeyHandler);
  const isFs = await window.api.getFullscreen();
  if (isFs) await window.api.toggleFullscreen();
}

function bpStartClock() {
  const el = document.getElementById('bp-clock');
  const tick = () => {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };
  tick();
  bpClockTick = setInterval(tick, 10000);
}

function bpOnSearch(e) {
  bpQuery = e.target.value.trim();
  bpRenderTabs();
  bpRenderGrid();
  bpFocus(0);
}

function bpRenderTabs() {
  const container = document.getElementById('bp-tabs');
  if (!container) return;
  container.innerHTML = '';

  const sources = [
    { id: 'all',       label: 'Todos',       dot: '' },
    { id: 'steam',     label: 'Steam',       dot: '🔵' },
    { id: 'epic',      label: 'Epic',        dot: '🟣' },
    { id: 'gog',       label: 'GOG',         dot: '🟠' },
    { id: 'local',     label: 'Local',       dot: '📁' },
    { id: 'emulator',  label: 'Emuladores',  dot: '🕹' },
    { id: 'favorites', label: 'Favoritos',   dot: '⭐' },
  ];

  // Count ignores search query so tabs don't disappear while typing
  sources.forEach(({ id, label, dot }) => {
    const count = id === 'all'
      ? allGames.filter(g => !hiddenGames.has(g.id)).length
      : id === 'favorites'
        ? allGames.filter(g => favorites.has(g.id) && !hiddenGames.has(g.id)).length
        : allGames.filter(g => g.source === id && !hiddenGames.has(g.id)).length;
    if (count === 0) return;

    const btn = document.createElement('button');
    btn.className = 'bp-tab' + (bpTab === id ? ' active' : '');
    btn.innerHTML = (dot ? dot + ' ' : '') + label + ` <span style="opacity:.5;font-size:11px">${count}</span>`;
    btn.onclick = () => {
      bpTab = id;
      container.querySelectorAll('.bp-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      bpRenderGrid();
      bpFocus(0);
    };
    container.appendChild(btn);
  });
}

function bpRenderGrid() {
  bpGames = getBpGames();
  const grid = document.getElementById('bp-grid');
  grid.innerHTML = '';
  bpGames.forEach((g, i) => {
    const card = document.createElement('div');
    card.className = 'bp-card';
    card.dataset.idx = i;
    card.id = 'bp-card-' + i;

    const cover = genreData[g.id]?.localImage || genreData[g.id]?.header || gameHeader(g);
    const imgWrap = document.createElement('div');
    imgWrap.className = 'bp-card-img-wrap';

    const img = document.createElement('img');
    img.src = cover; img.alt = '';
    img.className = 'bp-card-img';

    const fallback = document.createElement('div');
    fallback.className = 'bp-card-fallback';
    fallback.textContent = '🎮';
    fallback.style.display = 'none';

    img.addEventListener('error', () => { img.style.display='none'; fallback.style.display='flex'; });
    imgWrap.appendChild(img);
    imgWrap.appendChild(fallback);

    const name = document.createElement('div');
    name.className = 'bp-card-name';
    name.textContent = g.name;

    card.appendChild(imgWrap);
    card.appendChild(name);
    card.addEventListener('click', () => { bpFocus(i); });
    card.addEventListener('dblclick', () => { launchGame(g.id); });
    grid.appendChild(card);
  });
}

function bpFocus(idx) {
  if (!bpGames.length) { bpClearFocused(); return; }
  bpFocusIdx = Math.max(0, Math.min(idx, bpGames.length - 1));

  // Update card highlight
  document.querySelectorAll('.bp-card').forEach((c, i) => {
    c.classList.toggle('bp-focused', i === bpFocusIdx);
  });

  // Scroll focused card into view
  const focusedCard = document.getElementById('bp-card-' + bpFocusIdx);
  if (focusedCard) focusedCard.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });

  // Update bottom bar
  const g = bpGames[bpFocusIdx];
  if (!g) return;

  const cover = genreData[g.id]?.localImage || genreData[g.id]?.header || gameHeader(g);
  const coverEl = document.getElementById('bp-focused-cover');
  coverEl.style.backgroundImage = `url('${cover}')`;

  document.getElementById('bp-focused-name').textContent = g.name;

  const installed = isInstalled(g);
  document.getElementById('bp-focused-meta').textContent =
    (g.playtime ? fmtTime(g.playtime) + ' jogados · ' : '') +
    (installed ? '✅ Instalado' : '☁️ Não instalado') +
    ' · ' + g.source.toUpperCase();

  const actionsEl = document.getElementById('bp-focused-actions');
  actionsEl.innerHTML = '';

  const playBtn = document.createElement('button');
  playBtn.className = 'bp-action-btn bp-action-play';
  playBtn.textContent = installed ? '▶  JOGAR' : '⬇  INSTALAR';
  playBtn.onclick = () => launchGame(g.id);
  actionsEl.appendChild(playBtn);

  const detailBtn = document.createElement('button');
  detailBtn.className = 'bp-action-btn';
  detailBtn.textContent = '📋  DETALHES';
  detailBtn.onclick = () => { openModal(g.id); };
  actionsEl.appendChild(detailBtn);
}

function bpClearFocused() {
  document.getElementById('bp-focused-cover').style.backgroundImage = '';
  document.getElementById('bp-focused-name').textContent = '';
  document.getElementById('bp-focused-meta').textContent = '';
  document.getElementById('bp-focused-actions').innerHTML = '';
}

function bpKeyHandler(e) {
  if (!bpActive) return;
  const COLS = Math.floor(document.getElementById('bp-grid').offsetWidth / 200) || 6;
  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      closeBigPicture();
      break;
    case 'ArrowRight':
      e.preventDefault();
      bpFocus(bpFocusIdx + 1);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      bpFocus(bpFocusIdx - 1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      bpFocus(bpFocusIdx + COLS);
      break;
    case 'ArrowUp':
      e.preventDefault();
      bpFocus(bpFocusIdx - COLS);
      break;
    case 'Enter':
      e.preventDefault();
      if (bpGames[bpFocusIdx]) launchGame(bpGames[bpFocusIdx].id);
      break;
    case 'F11':
      e.preventDefault();
      closeBigPicture();
      break;
    default:
      // Start typing → focus search
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        const search = document.getElementById('bp-search');
        search.focus();
      }
  }
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
