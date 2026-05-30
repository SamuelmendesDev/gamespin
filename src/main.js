const { app, BrowserWindow, BrowserView, ipcMain, shell, dialog, Menu } = require('electron');

const path  = require('path');
const fs    = require('fs');
const fetch = require('node-fetch');

// Initialize logging immediately so log file is always created
let _log;
try {
  _log = require('electron-log');
  _log.transports.file.level    = 'debug';
  _log.transports.console.level = 'debug';
  _log.info('[App] Starting GameSpin', process.versions.electron);
} catch(e) {
  // Fallback to console if electron-log not available
  _log = { info: console.log, error: console.error, warn: console.warn,
    transports: { file: { level: 'debug', getFile: () => null } } };
  console.warn('[App] electron-log not available, using console:', e.message);
}

//  Cache dir 
const CACHE_DIR  = path.join(app.getPath('userData'), 'cache');
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const CACHE_TTL  = 7 * 24 * 60 * 60 * 1000; // 7 days

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

//  Bulk app-details cache (single file, much faster than one-file-per-app) 
const BULK_CACHE_FILE = path.join(app.getPath('userData'), 'appdetails_cache.json');

function loadBulkCache() {
  try {
    if (!fs.existsSync(BULK_CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(BULK_CACHE_FILE, 'utf8'));
  } catch { return {}; }
}

let _bulkCache = null;
function getBulkCache() {
  if (!_bulkCache) _bulkCache = loadBulkCache();
  return _bulkCache;
}

function saveBulkCache() {
  try { fs.writeFileSync(BULK_CACHE_FILE, JSON.stringify(_bulkCache)); } catch {}
}

function getBulkEntry(appid) {
  return getBulkCache()[appid] || null;
}

function setBulkEntry(appid, data) {
  getBulkCache()[appid] = data;
  // Debounce disk write — save at most every 2 seconds
  if (!setBulkEntry._timer) {
    setBulkEntry._timer = setTimeout(() => {
      saveBulkCache();
      setBulkEntry._timer = null;
    }, 1000);
  }
}



//  Window 
let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'GameSpin',
    backgroundColor: '#0b0d11',
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'assets', 'icon.png')
      : path.join(__dirname, '../assets/icon.png')
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

// IPC: toggle fullscreen / Big Picture mode
ipcMain.handle('toggle-fullscreen', () => {
  if (!win) return false;
  const going = !win.isFullScreen();
  win.setFullScreen(going);
  return going;
});
ipcMain.handle('get-fullscreen', () => win?.isFullScreen() ?? false);

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  // Run migration after window is shown (non-blocking)
  setImmediate(() => {
    try { migrateGenreCache(); } catch(e) { console.error('[Migration]', e.message); }
  });

  // Check for updates AFTER window is ready so webContents.send works
  win.webContents.once('did-finish-load', () => {
    if (!app.isPackaged) return; // dev mode — skip
    try {
      const { autoUpdater } = require('electron-updater');

      _log.transports.file.level = 'debug';
      autoUpdater.logger = _log;
      autoUpdater.autoDownload         = false;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.allowPrerelease      = false;
      autoUpdater.forceDevUpdateConfig = false;

      autoUpdater.setFeedURL({
        provider: 'github',
        owner:    'SamuelmendesDev',
        repo:     'gamespin',
      });

      _log.info(`[Updater] App version: ${app.getVersion()}`);
      _log.info(`[Updater] Feed: github/SamuelmendesDev/gamespin`);
      _log.info(`[Updater] Log file: ${_log.transports.file.getFile?.()?.path || 'unknown'}`);

      const sendToRenderer = (channel, data) => {
        if (win && !win.isDestroyed()) win.webContents.send(channel, data);
      };

      autoUpdater.on('checking-for-update', () => {
        _log.info('[Updater] Checking for updates...');
        sendToRenderer('update-checking', {});
      });
      autoUpdater.on('update-not-available', (info) => {
        _log.info('[Updater] Up to date:', info.version);
        sendToRenderer('update-not-available', { version: info.version });
      });
      autoUpdater.on('error', (err) => {
        _log.error('[Updater] Error:', err.message, err.stack);
        sendToRenderer('update-error', { message: err.message });
      });
      autoUpdater.on('update-available', (info) => {
        _log.info(`[Updater] Update available: v${info.version}`);
        sendToRenderer('update-available', {
          version:      info.version,
          releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
          releaseDate:  info.releaseDate || ''
        });
      });
      autoUpdater.on('download-progress', (progress) => {
        _log.info(`[Updater] Download progress: ${Math.round(progress.percent)}%`);
        sendToRenderer('update-progress', {
          percent:        Math.round(progress.percent),
          transferred:    progress.transferred,
          total:          progress.total,
          bytesPerSecond: progress.bytesPerSecond
        });
      });
      autoUpdater.on('update-downloaded', (info) => {
        _log.info(`[Updater] Downloaded: v${info.version}`);
        sendToRenderer('update-downloaded', { version: info.version });
      });

      // Check on launch
      setTimeout(() => {
        _log.info('[Updater] Starting initial check...');
        autoUpdater.checkForUpdates()
          .then(result => _log.info('[Updater] Check result:', JSON.stringify(result?.updateInfo || {})))
          .catch(e => {
            _log.error('[Updater] Check failed:', e.message);
            sendToRenderer('update-error', { message: e.message });
          });
      }, 3000);

      // Re-check every 2 hours
      setInterval(() => autoUpdater.checkForUpdates().catch(e => _log.error('[Updater] Periodic check failed:', e.message)), 2 * 60 * 60 * 1000);

    } catch(e) {
      _log.error('[Updater] Init failed:', e.message, e.stack);
    }
  });
});

ipcMain.handle('update-check-now', () => {
  if (!app.isPackaged) return { error: 'dev-mode' };
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.checkForUpdates().catch(e => console.log('[Updater] Manual check failed:', e.message));
    return { ok: true };
  } catch(e) { return { error: e.message }; }
});

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('get-log-path', () => {
  try {
    return _log.transports.file.getFile?.()?.path
      || require('path').join(app.getPath('userData'), 'logs', 'main.log');
  } catch(e) { return require('path').join(app.getPath('userData'), 'logs', 'main.log'); }
});

ipcMain.handle('update-download', () => {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.downloadUpdate();
  } catch {}
});

ipcMain.handle('install-update', () => {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.quitAndInstall();
  } catch {}
});



app.on('window-all-closed', () => {
  // Only quit when the main window closes, not auth popups
  if (BrowserWindow.getAllWindows().length === 0) {
    if (_bulkCache) saveBulkCache();
    if (process.platform !== 'darwin') app.quit();
  }
});
app.on('before-quit', () => { if (_bulkCache) saveBulkCache(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

//  Cache helpers 
function cacheFile(key) {
  return path.join(CACHE_DIR, key.replace(/[^a-z0-9_-]/gi, '_') + '.json');
}
function readCache(key) {
  try {
    const f = cacheFile(key);
    if (!fs.existsSync(f)) return null;
    const { ts, data } = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Date.now() - ts > CACHE_TTL) return null;
    return data;
  } catch { return null; }
}
function writeCache(key, data) {
  try { fs.writeFileSync(cacheFile(key), JSON.stringify({ ts: Date.now(), data })); } catch {}
}

//  Config (API key, steamid, steam path) 
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {}
}

//  Steam library detection 
function findInstalledGames(steamPath) {
  const installed = new Set();
  try {
    // Read libraryfolders.vdf to find all Steam library paths
    const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
    const vdf = fs.readFileSync(vdfPath, 'utf8');

    // Extract all library paths from VDF
    const libraryPaths = [path.join(steamPath, 'steamapps')];
    const pathMatches = [...vdf.matchAll(/"path"\s+"([^"]+)"/gi)];
    for (const m of pathMatches) {
      libraryPaths.push(path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps'));
    }

    // Scan each library for appmanifest_*.acf files
    for (const libPath of libraryPaths) {
      if (!fs.existsSync(libPath)) continue;
      const files = fs.readdirSync(libPath);
      for (const f of files) {
        const match = f.match(/^appmanifest_(\d+)\.acf$/);
        if (match) installed.add(parseInt(match[1]));
      }
    }
  } catch {}
  return installed;
}

function detectSteamPath() {
  const candidates = [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    process.env.HOME ? path.join(process.env.HOME, '.steam', 'steam') : '',
    '/usr/share/steam'
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'steamapps'))) return p;
  }
  return null;
}

//  Steam Store API fetch with retry + JSON validation 
async function fetchAppDetails(appid) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=portuguese`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res  = await fetch(url, { timeout: 10000 });
      const text = await res.text();
      if (!text.trim().startsWith('{')) {
        await new Promise(r => setTimeout(r, 1500 * attempt));
        continue;
      }
      const data = JSON.parse(text);
      const info = data[appid];
      if (!info?.success || !info.data) {
        return { appid, name: '', description: '', genres: [], categories: [], screenshots: [], header: null, capsule: null };
      }
      const d = info.data;
      const result = {
        appid,
        name:        d.name || '',
        description: d.short_description || stripHtml(d.about_the_game || '') || '',
        genres:      (d.genres     || []).map(g => g.description),
        categories:  (d.categories || []).map(c => c.description),
        header:      d.header_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
        capsule:     `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`,
        screenshots: (d.screenshots || []).slice(0, 3).map(s => s.path_full || s.path_thumbnail)
      };
      setBulkEntry(appid, result);
      return result;
    } catch {
      if (attempt === 4) break;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  return { appid, genres: [], description: '', header: null, capsule: null };
}


//  Genre normalization — translate English IGDB genres to Portuguese 
const GENRE_TRANSLATE = {
  'Action':'Ação', 'Adventure':'Aventura', 'Indie':'Indie', 'RPG':'RPG',
  'Strategy':'Estratégia', 'Simulation':'Simulação', 'Sports':'Esportes',
  'Racing':'Corridas', 'Puzzle':'Puzzle', 'Shooter':'Ação', 'Fighting':'Ação',
  'Horror':'Aventura', 'Survival':'Aventura', 'Casual':'Casual',
  'Platformer':'Plataforma', 'Card Game':'Card Game', 'Visual Novel':'Visual Novel',
  'Platform':'Plataforma', 'RTS':'Estratégia', 'Turn-based Strategy':'Estratégia',
  'Hack and Slash':'Ação', 'Tactical':'Estratégia', 'Arcade':'Ação',
  'MOBA':'Ação', 'Point-and-click':'Aventura', 'Music':'Casual'
};

function normalizeGenres(genres) {
  if (!genres?.length) return genres;
  return [...new Set(genres.map(g => GENRE_TRANSLATE[g] || g))];
}

function migrateGenreCache() {
  const cache = getBulkCache();
  let changed = false;
  for (const [key, entry] of Object.entries(cache)) {
    if (!entry?.genres?.length) continue;
    const normalized = normalizeGenres(entry.genres);
    const different = normalized.some((g, i) => g !== entry.genres[i]) || normalized.length !== entry.genres.length;
    if (different) {
      cache[key].genres = normalized;
      changed = true;
    }
  }
  if (changed) {
    saveBulkCache();
    console.log('[Cache] Genre migration complete');
  }
}


//  Steam OpenID Login 
const STEAM_OPENID_URL = 'https://steamcommunity.com/openid/login?' + [
  'openid.ns=http://specs.openid.net/auth/2.0',
  'openid.mode=checkid_setup',
  'openid.return_to=http://localhost:1337/steam/callback',
  'openid.realm=http://localhost:1337',
  'openid.identity=http://specs.openid.net/auth/2.0/identifier_select',
  'openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select'
].join('&');

ipcMain.handle('steam-start-auth', async () => {
  return new Promise((resolve) => {
    const authWin = new BrowserWindow({
      width: 560, height: 700,
      title: 'Login Steam',
      parent: win,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      if (!authWin.isDestroyed()) authWin.destroy();
      resolve(result);
    };

    const checkUrl = (url) => {
      try {
        if (url.includes('localhost:1337/steam/callback')) {
          const u = new URL(url);
          const identity = u.searchParams.get('openid.identity') || u.searchParams.get('openid.claimed_id') || '';
          const match = identity.match(/\/(\d{17})$/);
          if (match) { done({ ok: true, steamid: match[1] }); return; }
        }
        // Also check for claimed_id in the URL directly
        const claimedMatch = url.match(/openid\.claimed_id=.*?\/(\d{17})/);
        if (claimedMatch) { done({ ok: true, steamid: claimedMatch[1] }); }
      } catch {}
    };

    authWin.loadURL(STEAM_OPENID_URL);
    authWin.webContents.on('did-navigate', (_, url) => checkUrl(url));
    authWin.webContents.on('did-redirect-navigation', (_, url) => checkUrl(url));
    authWin.webContents.on('will-navigate', (_, url) => checkUrl(url));
    authWin.on('closed', () => done({ ok: false, cancelled: true }));
  });
});

//  IPC handlers 

// Get/save config
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (_, cfg) => {
  const old = loadConfig();
  // Invalidate IGDB token if credentials changed
  if (cfg.igdbClientId !== old.igdbClientId || cfg.igdbClientSecret !== old.igdbClientSecret) {
    _igdbToken = null; _igdbTokenExpiry = 0;
    console.log('[IGDB] Credentials changed — token invalidated');
  }
  saveConfig(cfg);
  return true;
});

// Browse for Steam folder
ipcMain.handle('browse-steam-path', async (event) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const defaultPath = fs.existsSync('C:\\Program Files (x86)\\Steam')
    ? 'C:\\Program Files (x86)\\Steam'
    : 'C:\\';
  const result = await dialog.showOpenDialog(senderWin, {
    title: 'Selecione a pasta de instalação do Steam',
    properties: ['openDirectory'],
    defaultPath
  });
  if (result.canceled || !result.filePaths.length) return null;
  const selected = result.filePaths[0];
  if (!fs.existsSync(path.join(selected, 'steamapps'))) {
    return { error: 'Pasta inválida — não encontrei a subpasta "steamapps" aqui.' };
  }
  return { path: selected };
});

// Auto-detect Steam
ipcMain.handle('detect-steam', () => {
  const p = detectSteamPath();
  return p ? { path: p } : { error: 'Steam não encontrado automaticamente.' };
});

// Fetch games library
ipcMain.handle('get-games', async (_, { key, steamid }) => {
  const cacheKey = `games_${steamid}`;
  const cached = readCache(cacheKey);
  if (cached) return { source: 'cache', games: cached };

  // Try two endpoints — v1 is newer, v0001 is more reliable
  const urls = [
    `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${key}&steamid=${steamid}&include_appinfo=1&include_played_free_games=1&format=json`,
    `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${steamid}&include_appinfo=true&include_played_free_games=true`
  ];

  let lastErr;
  for (const url of urls) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res  = await fetch(url, { timeout: 45000 });
        const text = await res.text();
        if (!text.trim().startsWith('{')) throw new Error('Resposta inválida da Steam API');
        const data = JSON.parse(text);
        if (!data.response?.games) throw new Error('Biblioteca não encontrada. Verifique se o perfil está público e as credenciais estão corretas.');
        const games = data.response.games.map(g => ({
          appid: g.appid,
          name:  g.name || `App ${g.appid}`,
          playtime: g.playtime_forever || 0,
          playtime_recent: g.playtime_2weeks || 0
        }));
        games.sort((a, b) => b.playtime - a.playtime);
        writeCache(cacheKey, games);
        return { source: 'api', games };
      } catch (err) {
        lastErr = err;
        if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
  }
  throw lastErr;
});

// Fetch player info
ipcMain.handle('get-player', async (_, { key, steamid }) => {
  const url  = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${steamid}`;
  const res  = await fetch(url, { timeout: 8000 });
  const data = await res.json();
  const p    = data.response?.players?.[0];
  if (!p) throw new Error('Jogador não encontrado');
  return { name: p.personaname, avatar: p.avatarfull || p.avatarmedium };
});


// Load all cached app details at once — reads single bulk file, very fast
ipcMain.handle('get-cached-details', (_, appids) => {
  const bulk = getBulkCache();
  const results = {};
  for (const appid of appids) {
    // Works for both Steam appids (numbers) and Epic ids (epic_AppName strings)
    if (bulk[appid]) {
      results[appid] = bulk[appid];
    } else if (!String(appid).startsWith('epic_')) {
      // Only check per-file cache for Steam games
      const old = readCache(`app_${appid}`);
      if (old) {
        results[appid] = old;
        setBulkEntry(appid, old);
      }
    }
  }
  return results;
});

// Fetch app details (description + genres + screenshots)
ipcMain.handle('get-appdetails', async (_, appid) => {
  // Check bulk cache first (fast)
  const bulk = getBulkEntry(appid);
  if (bulk) return bulk;

  const result = await fetchAppDetails(appid);
  if (result.genres?.length || result.description) {
    setBulkEntry(appid, result);
  }
  return result;
});

// Batch app details — parallel with concurrency limit (fast but safe)
ipcMain.handle('get-appdetails-batch', async (_, appids) => {
  const results = {};
  const toFetch = [];

  const bulk = getBulkCache();
  for (const appid of appids) {
    if (bulk[appid]) results[appid] = bulk[appid];
    else toFetch.push(appid);
  }

  // Run up to 5 requests in parallel, with 200ms between batches
  const CONCURRENCY = 5;
  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const chunk = toFetch.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async appid => {
      const result = await fetchAppDetails(appid);
      results[appid] = result;
      if (result.genres?.length || result.description) {
        setBulkEntry(appid, result);
      }
    }));
    if (i + CONCURRENCY < toFetch.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return results;
});

// Get installed games list
ipcMain.handle('get-installed', (_, steamPath) => {
  const set = findInstalledGames(steamPath);
  return [...set];
});

// Launch or install game
ipcMain.handle('launch-game', (_, { appid, installed, url }) => {
  if (url) {
    shell.openExternal(url);
  } else if (installed) {
    shell.openExternal(`steam://rungameid/${appid}`);
  } else {
    shell.openExternal(`steam://install/${appid}`);
  }
  return true;
});


// Clear genre/appdetails cache
ipcMain.handle('clear-genre-cache', () => {
  try {
    _bulkCache = {};
    if (fs.existsSync(BULK_CACHE_FILE)) fs.unlinkSync(BULK_CACHE_FILE);
    return true;
  } catch { return false; }
});

// Clear cache for a steamid
ipcMain.handle('clear-cache', (_, steamid) => {
  try {
    const f = cacheFile(`games_${steamid}`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return true;
  } catch { return false; }
});

//  Util 
function stripHtml(h) {
  return h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Pick local image for a game
ipcMain.handle('pick-local-image', async (event) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(senderWin, {
    title: 'Selecione uma imagem para o jogo',
    properties: ['openFile'],
    filters: [{ name: 'Imagens', extensions: ['jpg','jpeg','png','webp','gif'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  // Return as file:// URL so Electron renderer can load it
  return 'file://' + result.filePaths[0].replace(/\\/g, '/');
});


//  Local Library (jogos locais sem loja) 
// Format: [ { id, name, exePath, coverPath, addedAt }, ... ]
const LOCAL_LIBRARY_FILE = path.join(app.getPath('userData'), 'local_library.json');

function loadLocalLibrary() {
  try { return JSON.parse(fs.readFileSync(LOCAL_LIBRARY_FILE, 'utf8')); } catch { return []; }
}
function saveLocalLibrary(arr) {
  try { fs.writeFileSync(LOCAL_LIBRARY_FILE, JSON.stringify(arr, null, 2)); } catch {} 
}

// IPC: get full local library
ipcMain.handle('local-library-get', () => loadLocalLibrary());

// IPC: add a game — opens dialogs to pick exe then optional cover image
ipcMain.handle('local-library-add', async (event) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);

  // Step 1 — pick the .exe
  const exeResult = await dialog.showOpenDialog(senderWin, {
    title: 'Selecione o executável do jogo (.exe)',
    properties: ['openFile'],
    filters: [{ name: 'Executável', extensions: ['exe', 'bat', 'cmd', 'sh', 'app'] }]
  });
  if (exeResult.canceled || !exeResult.filePaths.length) return null;
  const exePath = exeResult.filePaths[0];

  // Derive a default name from the exe folder (parent dir is usually the game name)
  const exeDir  = path.dirname(exePath);
  const dirName = path.basename(exeDir);
  const exeName = path.basename(exePath, path.extname(exePath));
  // Prefer folder name unless it's something generic like 'bin', 'Binaries', etc.
  const genericDirs = /^(bin|binaries|game|win64|win32|x64|x86|release|debug)$/i;
  const defaultName = genericDirs.test(dirName) ? exeName : dirName;

  // Step 2 — optionally pick a cover image
  const imgResult = await dialog.showOpenDialog(senderWin, {
    title: 'Selecione uma capa para o jogo (opcional — cancele para pular)',
    properties: ['openFile'],
    filters: [{ name: 'Imagens', extensions: ['jpg','jpeg','png','webp','gif'] }]
  });
  const coverPath = (!imgResult.canceled && imgResult.filePaths.length)
    ? imgResult.filePaths[0] : null;

  const id = 'local_' + Date.now();
  const entry = { id, name: defaultName, exePath, coverPath, addedAt: Date.now() };

  const lib = loadLocalLibrary();
  lib.push(entry);
  saveLocalLibrary(lib);
  return entry;
});

// IPC: remove a game from local library
ipcMain.handle('local-library-remove', (_, id) => {
  const lib = loadLocalLibrary().filter(g => g.id !== id);
  saveLocalLibrary(lib);
  return true;
});

// IPC: update name or cover for a local game
ipcMain.handle('local-library-update', (_, { id, name, coverPath, coverUrl, _addEntry }) => {
  const lib = loadLocalLibrary();
  if (_addEntry) {
    if (!lib.find(g => g.id === _addEntry.id)) lib.push(_addEntry);
    saveLocalLibrary(lib);
    return true;
  }
  const entry = lib.find(g => g.id === id);
  if (!entry) return false;
  if (name      !== undefined) entry.name      = name;
  if (coverPath !== undefined) entry.coverPath = coverPath;
  if (coverUrl  !== undefined) entry.coverUrl  = coverUrl;
  saveLocalLibrary(lib);
  return true;
});

// IPC: pick a new cover image for a local game
ipcMain.handle('local-library-pick-cover', async (event) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(senderWin, {
    title: 'Selecione uma capa para o jogo',
    properties: ['openFile'],
    filters: [{ name: 'Imagens', extensions: ['jpg','jpeg','png','webp','gif'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// IPC: launch a local game exe directly
ipcMain.handle('local-library-launch', (_, exePath) => {
  try {
    shell.openPath(exePath);
    return true;
  } catch { return false; }
});

// IPC: scan a directory recursively for game executables
// Returns candidate list: [{ name, exePath, folderName }]
ipcMain.handle('local-library-scan-dir', async (event) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);

  const dirResult = await dialog.showOpenDialog(senderWin, {
    title: 'Selecione a pasta para escanear',
    properties: ['openDirectory']
  });
  if (dirResult.canceled || !dirResult.filePaths.length) return null;
  const rootDir = dirResult.filePaths[0];

  // Blacklist of exe names that are launchers, engines, tools — not the game itself
  const EXE_BLACKLIST = new Set([
    'unins000','uninstall','uninst','setup','install','installer','update','updater',
    'crashreporter','crashhandler','crash_reporter','bugsplat','sentry',
    'ue4prereqsetup_x64','ue4prereqsetup_x86','uereqdsetup',
    'dxsetup','directx','vcredist_x64','vcredist_x86','dotnetfx',
    'redist','prerequisite','prereq',
    'launcher','gamelaunchhelper','start','bootstrapper',
    'engine','editor','devenv','worldeditor',
    'steam','steamservice','steamwebhelper','epicgameslauncher',
    'galaxyclient','gogservices','playnite',
    'vc_redist.x64','vc_redist.x86',
    'python','python3','pythonw','node','npm',
  ]);

  // Folder names to skip entirely
  const DIR_BLACKLIST = /^(node_modules|__pycache__|\.git|\.svn|redist|redistributable|directx|vcredist|prerequisites|prereq|common\s*redist|support|tools|utilities|editor|sdk|docs|documentation|__macosx)$/i;

  // Max depth to avoid scanning too deep into system dirs
  const MAX_DEPTH = 6;

  const candidates = [];
  const seen = new Set();

  function scanDir(dir, depth) {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    const exesHere = [];
    const subdirs  = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!DIR_BLACKLIST.test(entry.name)) subdirs.push(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) {
        const base = path.basename(entry.name, '.exe').toLowerCase().replace(/[_\-\s]+/g, '');
        if (!EXE_BLACKLIST.has(base)) {
          exesHere.push(path.join(dir, entry.name));
        }
      }
    }

    // Heuristic: if a folder has exactly 1 non-blacklisted exe, it's likely the game
    // If multiple exes, pick the one whose name most closely matches the folder name
    if (exesHere.length === 1) {
      const exePath = exesHere[0];
      if (!seen.has(exePath)) {
        seen.add(exePath);
        const folderName = path.basename(dir);
        const exeName    = path.basename(exePath, '.exe');
        const genericDirs = /^(bin|binaries|game|win64|win32|x64|x86|release|debug|shipping)$/i;
        const name = genericDirs.test(folderName) ? exeName : folderName;
        candidates.push({ name, exePath, folderName });
      }
    } else if (exesHere.length > 1) {
      const folderName  = path.basename(dir).toLowerCase().replace(/[_\-\s]+/g, '');
      const bestExe     = exesHere.find(e => path.basename(e,'.exe').toLowerCase().replace(/[_\-\s]+/g,'') === folderName)
                       || exesHere.find(e => path.basename(e,'.exe').toLowerCase().includes(folderName.slice(0,4)))
                       || exesHere[0];
      if (!seen.has(bestExe)) {
        seen.add(bestExe);
        const exeName = path.basename(bestExe, '.exe');
        const genericDirs = /^(bin|binaries|game|win64|win32|x64|x86|release|debug|shipping)$/i;
        const name = genericDirs.test(path.basename(dir)) ? exeName : path.basename(dir);
        candidates.push({ name, exePath: bestExe, folderName: path.basename(dir) });
      }
    }

    // Recurse into subdirs only if this folder didn't yield a game
    // (avoids adding both "GameFolder" and "GameFolder/bin/game.exe")
    if (exesHere.length === 0) {
      for (const sub of subdirs) scanDir(sub, depth + 1);
    } else {
      // Still recurse into subdirs to catch multi-game root folders
      // but only one level deeper to avoid duplicates
      if (depth < 2) {
        for (const sub of subdirs) scanDir(sub, depth + 1);
      }
    }
  }

  scanDir(rootDir, 0);
  console.log(`[LocalScan] Found ${candidates.length} candidates in ${rootDir}`);
  return { rootDir, candidates };
});

// ── Cover Cascade ─────────────────────────────────────────────────────────────
// Tries sources in order until a cover is found:
// 1. SGDB (by Steam appid or name search)
// 2. IGDB cover field
// 3. RAWG
// 4. MobyGames
// 5. Steam Store by name (for non-Steam games)

async function igdbGetCover(name) {
  try {
    const token = await getIgdbToken();
    if (!token) return null;
    const clean = name.replace(/[™®©]/g, '').replace(/:.*/,'').trim();
    const res = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: {
        'Client-ID': loadConfig().igdbClientId || IGDB_CLIENT_ID,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'text/plain'
      },
      body: `search "${clean}"; fields name,cover.url; limit 3;`,
      timeout: 10000
    });
    if (!res.ok) return null;
    const games = await res.json();
    if (!games?.length) return null;
    const cleanLow = clean.toLowerCase();
    const best = games.find(g => g.name?.toLowerCase() === cleanLow) || games[0];
    if (!best?.cover?.url) return null;
    // IGDB returns //images.igdb.com/... — upgrade to t_cover_big
    return best.cover.url.replace('t_thumb', 't_cover_big').replace(/^\/\//, 'https://');
  } catch { return null; }
}

async function rawgGetCover(name) {
  try {
    const cfg = loadConfig();
    const key = cfg.rawgKey || '';
    if (!key) return null;
    const clean = name.replace(/[™®©]/g, '').trim();
    const res = await fetch(
      `https://api.rawg.io/api/games?key=${key}&search=${encodeURIComponent(clean)}&page_size=3`,
      { timeout: 10000 }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const results = data?.results || [];
    if (!results.length) return null;
    const cleanLow = clean.toLowerCase();
    const best = results.find(g => g.name?.toLowerCase() === cleanLow) || results[0];
    return best?.background_image || null;
  } catch { return null; }
}

async function mobyGamesGetCover(name) {
  try {
    const cfg = loadConfig();
    const key = cfg.mobygamesKey || '';
    if (!key) return null;
    const clean = name.replace(/[™®©]/g, '').replace(/:.*/,'').trim();
    const res = await fetch(
      `https://api.mobygames.com/v1/games?api_key=${key}&title=${encodeURIComponent(clean)}&format=brief&limit=3`,
      { timeout: 10000 }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const games = data?.games || [];
    if (!games.length) return null;
    const cleanLow = clean.toLowerCase();
    const best = games.find(g => g.title?.toLowerCase() === cleanLow) || games[0];
    if (!best?.game_id) return null;
    // Fetch covers for the game
    const coverRes = await fetch(
      `https://api.mobygames.com/v1/games/${best.game_id}/covers?api_key=${key}`,
      { timeout: 10000 }
    );
    if (!coverRes.ok) return null;
    const coverData = await coverRes.json();
    const covers = coverData?.cover_groups?.[0]?.covers || [];
    const front = covers.find(c => c.scan_of === 'Front Cover') || covers[0];
    return front?.image || null;
  } catch { return null; }
}

async function steamStoreByNameGetCover(name) {
  try {
    const clean = name.replace(/[™®©]/g, '').trim();
    const res = await fetch(
      `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(clean)}&l=english&cc=US`,
      { timeout: 10000 }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const items = data?.items || [];
    if (!items.length) return null;
    const cleanLow = clean.toLowerCase();
    const best = items.find(i => i.name?.toLowerCase() === cleanLow) || items[0];
    if (!best?.id) return null;
    return `https://cdn.cloudflare.steamstatic.com/steam/apps/${best.id}/header.jpg`;
  } catch { return null; }
}

// Main cascade function — tries all sources in priority order
async function fetchCoverCascade(opts) {
  const { name, appName, appid, sgdbKey, skipSgdb } = opts;

  // Clean the name — strip codename patterns common in Epic games
  const cleanName = name
    .replace(/[™®©]/g, '')
    .replace(/\s*(Production|Project|Codename|Build|Beta|Alpha|Demo|Test)\s*$/i, '')
    .replace(/^(Project|Codename)\s+/i, '')
    .replace(/\s+v\d+(\.\d+)*\s*$/i, '')  // version suffixes
    .trim();

  // If cleaned name is very short or looks like a slug (all lowercase, no spaces), skip
  const isUnusable = cleanName.length < 3 || /^[a-z0-9_-]+$/.test(cleanName);
  if (isUnusable) {
    console.log(`[Cover] Skipping unresolvable codename: ${name}`);
    return null;
  }

  const displayName = cleanName;

  // 1. SGDB by appid (Steam only, most accurate)
  if (!skipSgdb && sgdbKey && appid) {
    try {
      const res = await fetch(
        `https://www.steamgriddb.com/api/v2/grids/steam/${appid}?dimensions=600x900,342x482&limit=1`,
        { headers: { 'Authorization': `Bearer ${sgdbKey}` }, timeout: 8000 }
      );
      if (res.ok) {
        const data = await res.json();
        const url = data?.data?.[0]?.url;
        if (url) { console.log(`[Cover] SGDB(appid) ✓ ${displayName}`); return url; }
      }
    } catch {}
  }

  // 2. SGDB by name search
  if (!skipSgdb && sgdbKey) {
    try {
      const game = await sgdbSearch(displayName, sgdbKey, appName);
      if (game) {
        const url = await sgdbGetGrid(game.id, sgdbKey);
        if (url) { console.log(`[Cover] SGDB(name) ✓ ${displayName}`); return url; }
      }
    } catch {}
  }

  // 3. IGDB cover
  try {
    const url = await igdbGetCover(displayName);
    if (url) { console.log(`[Cover] IGDB ✓ ${displayName}`); return url; }
  } catch {}

  // 4. RAWG
  try {
    const url = await rawgGetCover(displayName);
    if (url) { console.log(`[Cover] RAWG ✓ ${displayName}`); return url; }
  } catch {}

  // 5. MobyGames
  try {
    const url = await mobyGamesGetCover(displayName);
    if (url) { console.log(`[Cover] MobyGames ✓ ${displayName}`); return url; }
  } catch {}

  // 6. Steam Store by name (for non-Steam games that exist on Steam)
  if (!appid) {
    try {
      const url = await steamStoreByNameGetCover(displayName);
      if (url) { console.log(`[Cover] Steam(name) ✓ ${displayName}`); return url; }
    } catch {}
  }

  console.log(`[Cover] ✗ No cover found: ${displayName}`);
  return null;
}

// IPC: fetch covers via full cascade for any game list
ipcMain.handle('fetch-covers-cascade', async (_, gamesList) => {
  const toFetch = gamesList.filter(g => !getBulkEntry(g.id)?.header);
  if (!toFetch.length) return {};
  console.log(`[Cover] Cascade fetch for ${toFetch.length} games...`);

  const cfg     = loadConfig();
  const sgdbKey = cfg.sgdbKey || SGDB_DEFAULT_KEY;
  const updates = {};
  const CONCUR  = 3;

  async function fetchOne(g) {
    const url = await fetchCoverCascade({
      name:    getBulkEntry(g.id)?.name || g.name,
      appName: g.appName,
      appid:   g.appid,
      sgdbKey
    });
    if (!url) return;
    const ex = getBulkEntry(g.id) || {};
    setBulkEntry(g.id, Object.assign(ex, { header: url }));
    updates[g.id] = { header: url };
  }

  for (let i = 0; i < toFetch.length; i += CONCUR) {
    await Promise.all(toFetch.slice(i, i + CONCUR).map(fetchOne));
    if (i + CONCUR < toFetch.length) await new Promise(r => setTimeout(r, 300));
  }

  if (_bulkCache) saveBulkCache();
  console.log(`[Cover] Cascade done: ${Object.keys(updates).length}/${toFetch.length}`);
  return updates;
});

// IPC: fetch covers via full cascade for local/emulator games (by name only)
ipcMain.handle('local-library-fetch-covers', async (_, gamesList) => {
  const cfg     = loadConfig();
  const sgdbKey = cfg.sgdbKey || SGDB_DEFAULT_KEY;
  const results = {};
  const CONCUR  = 2;

  async function fetchOne(g) {
    const url = await fetchCoverCascade({ name: g.name, sgdbKey, skipSgdb: !sgdbKey });
    if (url) results[g.id] = url;
    await new Promise(r => setTimeout(r, 300));
  }

  for (let i = 0; i < gamesList.length; i += CONCUR) {
    await Promise.all(gamesList.slice(i, i + CONCUR).map(fetchOne));
  }

  console.log(`[Cover] Local cascade: ${Object.keys(results).length}/${gamesList.length}`);
  return results;
});

// IPC: fetch covers via full cascade for local/emulator games (by name only)
// kept for back compat — delegates to fetch-covers-cascade
// 


//  Emulators 
// emulators.json: [ { id, name, exePath, extensions: ['nes','sfc',...], platform } ]
// emulator_games.json: [ { id, name, emulatorId, romPath, coverPath, addedAt } ]
const EMULATORS_FILE      = path.join(app.getPath('userData'), 'emulators.json');
const EMULATOR_GAMES_FILE = path.join(app.getPath('userData'), 'emulator_games.json');

function loadEmulators()      { try { return JSON.parse(fs.readFileSync(EMULATORS_FILE,      'utf8')); } catch { return []; } }
function saveEmulators(arr)   { try { fs.writeFileSync(EMULATORS_FILE,      JSON.stringify(arr, null, 2)); } catch {} }
function loadEmulatorGames()  { try { return JSON.parse(fs.readFileSync(EMULATOR_GAMES_FILE, 'utf8')); } catch { return []; } }
function saveEmulatorGames(a) { try { fs.writeFileSync(EMULATOR_GAMES_FILE, JSON.stringify(a,   null, 2)); } catch {} }

ipcMain.handle('emulators-get',       ()        => loadEmulators());
ipcMain.handle('emulators-save',      (_, arr)  => { saveEmulators(arr); return true; });
ipcMain.handle('emulator-games-get',  ()        => loadEmulatorGames());
ipcMain.handle('emulator-games-save', (_, arr)  => { saveEmulatorGames(arr); return true; });

ipcMain.handle('emulators-pick-exe', async (event) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(senderWin, {
    title: 'Selecione o executável do emulador',
    properties: ['openFile'],
    filters: [{ name: 'Executável', extensions: ['exe','bat','cmd','sh','app'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('emulator-scan-roms', async (event, { extensions }) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const dirResult = await dialog.showOpenDialog(senderWin, {
    title: 'Selecione a pasta de ROMs',
    properties: ['openDirectory']
  });
  if (dirResult.canceled || !dirResult.filePaths.length) return null;
  const rootDir = dirResult.filePaths[0];

  const extSet = new Set((extensions || []).map(e => e.toLowerCase().replace(/^\./, '')));
  const found  = [];

  function scan(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        scan(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (!extSet.size || extSet.has(ext)) {
          const romPath = path.join(dir, entry.name);
          const name = path.basename(entry.name, path.extname(entry.name))
            .replace(/\s*\(.*?\)/g, '').replace(/\s*\[.*?\]/g, '').trim();
          found.push({ name, romPath, ext });
        }
      }
    }
  }
  scan(rootDir, 0);
  console.log(`[EmuScan] Found ${found.length} ROMs in ${rootDir}`);
  return { rootDir, roms: found };
});

ipcMain.handle('emulator-launch', (_, { emulatorId, romPath }) => {
  const emulators = loadEmulators();
  const emu = emulators.find(e => e.id === emulatorId);
  if (!emu) return false;
  const { execFile } = require('child_process');
  try {
    execFile(emu.exePath, [romPath], { detached: true });
    return true;
  } catch(e) {
    console.error('[EmuLaunch]', e.message);
    return false;
  }
});



//  Epic Games 
const EPIC_TOKEN_FILE = path.join(app.getPath('userData'), 'epic_token.json');
// Launcher client — used for auth + library listing
const EPIC_CLIENT_ID     = '34a02cf8f4414e29b15921876da36f9a';
const EPIC_CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf';
// Catalog client — has access to keyImages/metadata (same as Epic Games website)
const EPIC_CATALOG_ID     = '9fc856b42c954c47829b2b65ee7b5c2b';
const EPIC_CATALOG_SECRET = 'WUjFfLJBnZD2OsVGWfBNHaHVSJySSBNe';
const EPIC_REDIRECT   = 'https://www.epicgames.com/id/api/redirect?clientId=34a02cf8f4414e29b15921876da36f9a&responseType=code';

function loadEpicToken() {
  try { return JSON.parse(fs.readFileSync(EPIC_TOKEN_FILE, 'utf8')); } catch { return null; }
}
function saveEpicToken(token) {
  try { fs.writeFileSync(EPIC_TOKEN_FILE, JSON.stringify(token)); } catch {}
}
function clearEpicToken() {
  try { if (fs.existsSync(EPIC_TOKEN_FILE)) fs.unlinkSync(EPIC_TOKEN_FILE); } catch {}
}

// Get a token using catalog client credentials (for keyImages access)
let _catalogToken = null;
let _catalogTokenExpiry = 0;
async function getCatalogToken() {
  if (_catalogToken && Date.now() < _catalogTokenExpiry - 60000) return _catalogToken;
  try {
    const res = await fetch('https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${EPIC_CATALOG_ID}:${EPIC_CATALOG_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials',
      timeout: 10000
    });
    const data = await res.json();
    if (data.access_token) {
      _catalogToken = data.access_token;
      _catalogTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
      return _catalogToken;
    }
  } catch(e) { console.error('[Epic] Catalog token error:', e.message); }
  return null;
}

async function refreshEpicToken(refreshToken) {
  const res = await fetch('https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${EPIC_CLIENT_ID}:${EPIC_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
    timeout: 15000
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Falha ao renovar token Epic');
  return data;
}

async function getValidEpicToken() {
  const stored = loadEpicToken();
  if (!stored) return null;
  // Check if access token is still valid (with 60s buffer)
  if (stored.expires_at && Date.now() < stored.expires_at - 60000) {
    return stored.access_token;
  }
  // Try refresh
  if (stored.refresh_token) {
    try {
      const fresh = await refreshEpicToken(stored.refresh_token);
      const newToken = {
        access_token:  fresh.access_token,
        refresh_token: fresh.refresh_token || stored.refresh_token,
        account_id:    fresh.account_id || stored.account_id,
        display_name:  fresh.displayName || stored.display_name,
        expires_at:    Date.now() + (fresh.expires_in || 7200) * 1000
      };
      saveEpicToken(newToken);
      return newToken.access_token;
    } catch { clearEpicToken(); return null; }
  }
  return null;
}

// Read locally installed Epic games from manifest files
function getEpicInstalledGames() {
  const games = [];
  const manifestDirs = [
    'C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests',
    path.join(process.env.PROGRAMDATA || 'C:\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
  ];
  const seen = new Set();
  for (const dir of manifestDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.item'));
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
          if (data.AppName && !seen.has(data.AppName)) {
            seen.add(data.AppName);
            games.push({
              catalogItemId: data.CatalogItemId || data.AppName,
              appName:       data.AppName,
              name:          data.DisplayName || data.AppName,
              installPath:   data.InstallLocation,
              installed:     true
            });
          }
        } catch {}
      }
    } catch {}
  }
  return games;
}

// IPC: start Epic OAuth flow — embedded browser captures code automatically
const EPIC_LOGIN_URL = `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent(EPIC_REDIRECT)}`;

ipcMain.handle('epic-start-auth', async () => {
  return new Promise((resolve) => {
    const authWin = new BrowserWindow({
      width: 560, height: 700,
      title: 'Login Epic Games',
      parent: win,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      if (!authWin.isDestroyed()) authWin.destroy();
      resolve(result);
    };

    const checkUrl = (url) => {
      try {
        // Epic redirects to epicgames.com/id/api/redirect with authorizationCode in JSON
        if (url.includes('/id/api/redirect') || url.includes('authorizationCode')) {
          // Fetch the page content to get the code
          authWin.webContents.executeJavaScript('document.body.innerText')
            .then(text => {
              try {
                const data = JSON.parse(text);
                const code = data.authorizationCode || data.exchangeCode;
                if (code) { done({ ok: true, code }); return; }
              } catch {}
            }).catch(() => {});
        }
      } catch {}
    };

    authWin.loadURL(EPIC_LOGIN_URL);
    authWin.webContents.on('did-navigate', (_, url) => checkUrl(url));
    authWin.webContents.on('did-redirect-navigation', (_, url) => checkUrl(url));
    authWin.on('closed', () => done({ ok: false, cancelled: true }));
  });
});

// IPC: exchange authorization code for token
ipcMain.handle('epic-exchange-code', async (_, code) => {
  const res = await fetch('https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${EPIC_CLIENT_ID}:${EPIC_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `grant_type=authorization_code&code=${code}`,
    timeout: 15000
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(data.errorMessage || 'Código inválido');

  const token = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    account_id:    data.account_id,
    display_name:  data.displayName,
    expires_at:    Date.now() + (data.expires_in || 7200) * 1000
  };
  saveEpicToken(token);
  return { ok: true, displayName: token.display_name };
});

// IPC: get Epic library
ipcMain.handle('epic-get-library', async () => {
  const accessToken = await getValidEpicToken();
  if (!accessToken) return { error: 'not_authenticated' };

  const stored     = loadEpicToken();
  const accountId  = stored.account_id;

  // Always read locally installed games first
  const installedLocal = getEpicInstalledGames();
  const installedMap   = {};
  installedLocal.forEach(g => { installedMap[g.appName] = g; });

  let games = [];

  //  library-service REST API (paginated) 
  if (games.length === 0) {
    try {
      console.log('[Epic] Trying library-service (paginated)...');
      const seen = new Set();
      let cursor = '';
      let page   = 0;

      while (true) {
        const url = `https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true${cursor ? '&cursor=' + cursor : ''}`;
        const res = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'User-Agent': 'EpicGamesLauncher/15.0.0'
          },
          timeout: 20000
        });
        if (!res.ok) { console.log('[Epic] library-service status:', res.status); break; }

        const data    = await res.json();
        const records = data.records || [];
        console.log(`[Epic] library-service page ${page}: ${records.length} records`);
        for (const r of records) {
          const appName = r.appName || r.catalogItemId;
          if (!appName || seen.has(appName)) continue;
          // Skip non-game records (DLC, addons, etc)
          if (r.recordType && r.recordType !== 'APPLICATION') continue;
          // Skip entries that look like DLC/addons by appName pattern
          // Main games usually have short appNames; skip entries where the same
          // sandboxName (game title) already exists from a different namespace
          const name = r.sandboxName || installedMap[appName]?.name || appName;
          seen.add(appName);

          // Dedup by sandboxName — keep only one entry per game title
          // Prefer the one that matches an installed game, or the first seen
          const existingIdx = games.findIndex(g => g.name === name);
          if (existingIdx !== -1) {
            // If this one is installed and existing is not, replace it
            if (installedMap[appName] && !games[existingIdx].installed) {
              games[existingIdx] = {
                id: 'epic_' + appName, appName, name, source: 'epic',
                installed: true, playtime: 0,
                namespace: r.namespace, catalogItemId: r.catalogItemId, header: null
              };
            }
            continue;
          }

          games.push({
            id:            'epic_' + appName,
            appName,
            name,
            source:        'epic',
            installed:     !!installedMap[appName],
            playtime:      0,
            namespace:     r.namespace,
            catalogItemId: r.catalogItemId,
            header:        null
          });
        }

        // Check for next page
        cursor = data.responseMetadata?.nextCursor || '';
        if (!cursor || records.length === 0) break;
        page++;
        if (page > 20) break; // safety limit
        await new Promise(r => setTimeout(r, 300));
      }
    } catch(e) { console.error('[Epic] library-service error:', e.message); }
  }

  //  Method 3: catalog ownership API 
  if (games.length === 0) {
    try {
      const url = `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/bulk/items?id=${accountId}&includeDLCDetails=true&includeMainGameDetails=true&country=BR&locale=pt`;
      console.log('[Epic] Trying catalog API...');
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        timeout: 20000
      });
      console.log('[Epic] Catalog status:', res.status);
      if (res.ok) {
        const data = await res.json();
        console.log('[Epic] Catalog keys:', Object.keys(data).length);
      }
    } catch(e) { console.error('[Epic] Catalog error:', e.message); }
  }

  //  Fallback: installed only 
  if (games.length === 0 && installedLocal.length > 0) {
    console.log('[Epic] Using fallback: installed games only');
    games = installedLocal.map(g => ({
      id:        'epic_' + g.appName,
      appName:   g.appName,
      name:      g.name,
      source:    'epic',
      installed: true,
      playtime:  0
    }));
  }

  // Apply any already-cached catalog data (headers/titles from previous sessions)
  for (const g of games) {
    const cached = getBulkEntry(g.id);
    if (cached?.header) g.header = cached.header;
    if (cached?.name && cached.name !== g.name) g.name = cached.name;
  }

  // Bulk-fix codenames using catalog API with user token
  const codenamed = games.filter(g => isInternalCodename(g.name) && g.namespace && g.catalogItemId);
  if (codenamed.length > 0) {
    console.log(`[Epic] Fixing ${codenamed.length} codenames via catalog API...`);
    const byNs = {};
    for (const g of codenamed) {
      if (!byNs[g.namespace]) byNs[g.namespace] = [];
      byNs[g.namespace].push(g);
    }
    await Promise.all(Object.entries(byNs).map(async ([ns, nsGames]) => {
      const ids = nsGames.map(g => g.catalogItemId).join(',');
      try {
        const res = await fetch(
          `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${ns}/bulk/items?id=${ids}&includeMainGameDetails=true&country=BR&locale=pt-BR`,
          { headers: { 'Authorization': `Bearer ${accessToken}` }, timeout: 12000 }
        );
        if (!res.ok) return;
        const text = await res.text();
        if (!text || text === '{}') return;
        const data = JSON.parse(text);
        for (const g of nsGames) {
          const item = data[g.catalogItemId];
          if (!item?.title) continue;
          const title = item.title;
          g.name = title;
          const ex = getBulkEntry(g.id) || {};
          setBulkEntry(g.id, Object.assign(ex, { name: title }));
        }
      } catch {}
    }));
  }

  // Sort alphabetically
  games.sort((a, b) => a.name.localeCompare(b.name));

  console.log(`[Epic] Final: ${games.length} games (${installedLocal.length} installed locally)`);
  return { games, displayName: stored.display_name };
});

// Detect internal Epic codenames (single word, fruit/animal names, "Production" suffix)
function isInternalCodename(name) {
  if (!name) return true;
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return true;
  if (/(production|project|prototype|client|beta|test)/i.test(name)) return true;
  // Two word names where both words are simple capitalized words (e.g. "Blunder buss")
  if (words.length === 2 && words.every(w => /^[A-Z][a-z]+$/.test(w)) && name.length < 20) return true;
  return false;
}


// Get Epic game description for a single game (called on modal open)
ipcMain.handle('epic-get-description', async (_, { namespace, catalogItemId, appName, name }) => {
  const cacheId = 'epic_' + (appName || catalogItemId);
  const cached  = getBulkEntry(cacheId);
  if (cached?.description) return { description: cached.description, genres: cached.genres };

  // Try user access token against catalog API
  const userToken = await getValidEpicToken();
  if (userToken && namespace && catalogItemId) {
    try {
      const res = await fetch(
        `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${namespace}/bulk/items?id=${catalogItemId}&includeMainGameDetails=true&country=BR&locale=pt-BR`,
        { headers: { 'Authorization': `Bearer ${userToken}` }, timeout: 10000 }
      );
      if (res.ok) {
        const text = await res.text();
        if (text && text !== '{}') {
          const data = JSON.parse(text);
          const item = data[catalogItemId];
          if (item?.description) {
            const MAP = { 'action':'Action','adventure':'Adventure','role-playing-games-rpg':'RPG',
              'strategy':'Strategy','simulation':'Simulation','sports':'Sports','racing':'Racing',
              'puzzle-game':'Puzzle','shooter':'Shooter','fighting':'Fighting','horror':'Horror',
              'survival':'Survival','indie':'Indie','casual':'Casual','platformer':'Platformer' };
            const genres = (item.categories||[]).map(c => MAP[(c.path||'').split('/').pop()]||null).filter(Boolean);
            const result = { description: item.description, genres };
            const ex = getBulkEntry(cacheId)||{};
            setBulkEntry(cacheId, Object.assign(ex, result));
            return result;
          }
        }
      }
    } catch {}
  }

  // Fallback: Epic Store public GraphQL
  if (name) {
    try {
      const query = `query($kw:String){Catalog{searchStore(keywords:$kw,count:1,category:"games/edition/base"){elements{title description}}}}`;
      const res = await fetch('https://store.epicgames.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ query, variables: { kw: name } }),
        timeout: 10000
      });
      if (res.ok) {
        const data = await res.json();
        const el   = data?.data?.Catalog?.searchStore?.elements?.[0];
        if (el?.description) {
          const result = { description: el.description };
          setBulkEntry(cacheId, Object.assign(getBulkEntry(cacheId)||{}, result));
          return result;
        }
      }
    } catch {}
  }

  return null;
});

//  SteamGridDB — fetch covers for any game by name
const SGDB_DEFAULT_KEY = '3d5bf6fb378d0c351a64df86e95188e0';
async function sgdbSearch(name, sgdbKey, appName) {
  const clean = name.replace(/[™®©]/g, '').trim();
  const appNameWords = appName
    ? appName.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim()
    : null;
  const attempts = [
    clean,
    clean.replace(/:.*/, '').trim(),
    clean.replace(/\s*\(.*?\)/g, '').trim(),
    appNameWords
  ].filter((v,i,a) => v && v.length > 1 && a.indexOf(v) === i);

  for (const q of attempts) {
    try {
      const res = await fetch(
        `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(q)}`,
        { headers: { 'Authorization': `Bearer ${sgdbKey}` }, timeout: 8000 }
      );
      if (!res.ok) {
        console.log(`[SGDB] Search "${q}" status: ${res.status}`);
        if (res.status === 401) { console.log('[SGDB] 401 — API key inválida ou expirada'); return null; }
        continue;
      }
      const data = await res.json();
      if (data?.data?.[0]) return data.data[0];
    } catch(e) { console.log(`[SGDB] Search error: ${e.message}`); }
  }
  return null;
}

async function sgdbGetGrid(gameId, sgdbKey) {
  // Try grids (portrait), then heroes (landscape) as fallback
  const endpoints = [
    `https://www.steamgriddb.com/api/v2/grids/game/${gameId}?dimensions=600x900,342x482&limit=3`,
    `https://www.steamgriddb.com/api/v2/grids/game/${gameId}?limit=3`,
    `https://www.steamgriddb.com/api/v2/heroes/game/${gameId}?limit=1`,
    `https://www.steamgriddb.com/api/v2/logos/game/${gameId}?limit=1`
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${sgdbKey}` }, timeout: 8000
      });
      if (!res.ok) continue;
      const data = await res.json();
      const items = (data?.data || []).filter(i => !i.nsfw && !i.humor);
      const result = items[0]?.url || data?.data?.[0]?.url || null;
      if (result) return result;
    } catch {}
  }
  return null;
}

// IPC: fetch Epic covers via SteamGridDB
ipcMain.handle('epic-fetch-covers', async (_, gamesList) => {
  const toFetch = gamesList.filter(g => !getBulkEntry(g.id)?.header);
  if (toFetch.length === 0) { console.log('[Epic] All covers cached'); return {}; }
  console.log(`[Epic] Fetching ${toFetch.length} covers...`);

  const updates = {};
  const cfg     = loadConfig();
  const sgdbKey = cfg.sgdbKey || SGDB_DEFAULT_KEY;
  const PREFER  = ['DieselGameBoxTall','DieselStoreFrontTall','OfferImageTall','Thumbnail','DieselGameBox'];
  const GENRE_MAP = {
    'action':'Action','adventure':'Adventure','role-playing-games-rpg':'RPG',
    'strategy':'Strategy','simulation':'Simulation','sports':'Sports','racing':'Racing',
    'puzzle-game':'Puzzle','shooter':'Shooter','fighting':'Fighting','horror':'Horror',
    'survival':'Survival','indie':'Indie','casual':'Casual','platformer':'Platformer'
  };

  //  Step 1: Epic Catalog API with client_credentials token 
  const catalogToken = await getCatalogToken();
  console.log('[Epic] Catalog token:', catalogToken ? 'ok' : 'failed');

  if (catalogToken) {
    const byNs = {};
    for (const g of toFetch) {
      if (!g.namespace || !g.catalogItemId) continue;
      if (!byNs[g.namespace]) byNs[g.namespace] = [];
      byNs[g.namespace].push(g);
    }
    const nsKeys = Object.keys(byNs);
  
    for (let i = 0; i < nsKeys.length; i += 6) {
      await Promise.all(nsKeys.slice(i, i + 6).map(async ns => {
        const games = byNs[ns];
        const ids   = games.map(g => g.catalogItemId).join(',');
        try {
          const res  = await fetch(
            `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${ns}/bulk/items?id=${ids}&includeMainGameDetails=true&country=BR&locale=pt-BR`,
            { headers: { 'Authorization': `Bearer ${catalogToken}` }, timeout: 12000 }
          );
          if (!res.ok) return;
          const text = await res.text();
          if (!text || text === '{}') return;
          const data = JSON.parse(text);
          for (const g of games) {
            const item = data[g.catalogItemId];
            if (!item?.keyImages?.length) continue;
            const thumb = item.keyImages.find(i => PREFER.includes(i.type))?.url || item.keyImages[0]?.url;
            if (!thumb) continue;
            const title  = item.title || g.name;
            const genres = (item.categories||[]).map(c => GENRE_MAP[(c.path||'').split('/').pop()]||null).filter(Boolean);
            const desc   = item.description || '';
            const ex = getBulkEntry(g.id)||{};
            setBulkEntry(g.id, Object.assign(ex, { header:thumb, name:title, genres, description:desc }));
            updates[g.id] = { header:thumb, name:title, genres, description:desc };
          }
        } catch {}
      }));
      if (i + 6 < nsKeys.length) await new Promise(r => setTimeout(r, 200));
    }
    }

  //  Step 2: Full cascade fallback for remaining 
  const missing = toFetch.filter(g => !updates[g.id]);
  if (missing.length) {
    console.log(`[Cover] Cascade fallback for ${missing.length} Epic games...`);
    for (let i = 0; i < missing.length; i += 3) {
      await Promise.all(missing.slice(i, i + 3).map(async g => {
        try {
          const cachedName = getBulkEntry(g.id)?.name || g.name;
          const url = await fetchCoverCascade({
            name: cachedName, appName: g.appName, sgdbKey, skipSgdb: false
          });
          if (!url) return;
          const ex = getBulkEntry(g.id) || {};
          setBulkEntry(g.id, Object.assign(ex, { header: url }));
          updates[g.id] = { header: url, name: cachedName };
        } catch(e) { console.log('[Cover] Error:', g.name, e.message); }
      }));
      if (i + 3 < missing.length) await new Promise(r => setTimeout(r, 300));
    }
    console.log(`[Cover] Cascade done: ${Object.keys(updates).length} total`);
  }

  console.log(`[Epic] Covers final: ${Object.keys(updates).length} / ${toFetch.length}`);
  return updates;
});

// IPC: fetch covers for Steam games missing images — full cascade
ipcMain.handle('sgdb-fetch-covers', async (_, gamesList) => {
  const cfg     = loadConfig();
  const sgdbKey = cfg.sgdbKey || SGDB_DEFAULT_KEY;

  const toFetch = gamesList.filter(g => !getBulkEntry(g.id)?.header);
  if (!toFetch.length) return {};
  console.log(`[Cover] Steam cascade covers: ${toFetch.length}`);

  const updates = {};
  const CONCUR  = 3;

  async function fetchOne(g) {
    try {
      const cachedName = getBulkEntry(g.id)?.name || g.name;
      const url = await fetchCoverCascade({
        name: cachedName, appid: g.appid, sgdbKey
      });
      if (!url) return;
      const existing = getBulkEntry(g.id) || {};
      setBulkEntry(g.id, Object.assign(existing, { header: url }));
      updates[g.id] = { header: url };
    } catch {}
  }

  for (let i = 0; i < toFetch.length; i += CONCUR) {
    await Promise.all(toFetch.slice(i, i + CONCUR).map(fetchOne));
    if (i + CONCUR < toFetch.length) await new Promise(r => setTimeout(r, 300));
  }

  if (_bulkCache) saveBulkCache();
  console.log(`[Cover] Steam cascade done: ${Object.keys(updates).length}/${toFetch.length}`);
  return updates;
});

// IPC: get Epic account info
ipcMain.handle('epic-get-account', () => {
  const stored = loadEpicToken();
  if (!stored) return null;
  return { displayName: stored.display_name, accountId: stored.account_id };
});

// IPC: disconnect Epic
ipcMain.handle('epic-disconnect', () => {
  clearEpicToken();
  return true;
});

// IPC: get Epic installed games (no auth needed)
ipcMain.handle('epic-get-installed', () => {
  return getEpicInstalledGames();
});

// IPC: launch Epic game
ipcMain.handle('epic-launch', (_, appName) => {
  shell.openExternal(`com.epicgames.launcher://apps/${appName}?action=launch&silent=true`);
  return true;
});

// IPC: get Epic game details from IGDB/SteamGridDB fallback (use Epic Store API)
ipcMain.handle('epic-get-game-details', async (_, { catalogItemId, namespace }) => {
  const cacheKey = `epic_${catalogItemId}`;
  const cached = getBulkEntry(cacheKey);
  if (cached) return cached;

  try {
    const accessToken = await getValidEpicToken();
    if (!accessToken) return null;

    const query = `{ Catalog { catalogOffers( namespace: "${namespace || 'epic'}", params: { count: 1, keywords: "" } ) { elements { title description keyImages { type url } categories { path } } } } }`;

    // Use Epic Store catalog API
    const res = await fetch('https://www.epicgames.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      timeout: 10000
    });
    if (!res.ok) return null;
    const data = await res.json();
    const offer = data?.data?.Catalog?.catalogOffers?.elements?.[0];
    if (!offer) return null;

    const thumb = offer.keyImages?.find(i => i.type === 'Thumbnail' || i.type === 'DieselGameBoxTall')?.url
      || offer.keyImages?.[0]?.url || null;

    const result = {
      name:        offer.title,
      description: offer.description || '',
      header:      thumb,
      genres:      (offer.categories || []).map(c => c.path?.split('/')?.[1]).filter(Boolean),
      source:      'epic'
    };
    setBulkEntry(cacheKey, result);
    return result;
  } catch { return null; }
});


//  IGDB (Twitch) — genre lookup for any game 
const IGDB_CLIENT_ID     = 'qr3ysgpwy5ka5nak0kig386t8yoqhh';
const IGDB_CLIENT_SECRET = 'rt5m7gnhcx7kt3b34klpaup2hy0ooc';

let _igdbToken = null;
let _igdbTokenExpiry = 0;

async function getIgdbToken() {
  const cfg = loadConfig();
  const clientId     = cfg.igdbClientId     || IGDB_CLIENT_ID;
  const clientSecret = cfg.igdbClientSecret || IGDB_CLIENT_SECRET;

  if (_igdbToken && Date.now() < _igdbTokenExpiry - 60000) return _igdbToken;
  try {
    const res = await fetch(
      `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
      { method: 'POST', timeout: 12000 }
    );
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch {
      console.error('[IGDB] Token parse error, response:', text.substring(0,100));
      return null;
    }
    if (!data.access_token) {
      console.error('[IGDB] Token error:', data.message || JSON.stringify(data).substring(0,100));
      if (data.message?.includes('invalid') || data.status === 403) {
        console.error('[IGDB] ⚠ Credenciais inválidas. Configure em Configurações → IGDB.');
      }
      return null;
    }
    _igdbToken = data.access_token;
    _igdbTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
    console.log('[IGDB] Token OK');
    return _igdbToken;
  } catch(e) {
    console.error('[IGDB] Token fetch error:', e.message);
    return null;
  }
}

const IGDB_GENRE_MAP = {
  2:'Aventura', 4:'Ação', 5:'Ação', 7:'Casual', 8:'Plataforma',
  9:'Puzzle', 10:'Corridas', 11:'Estratégia', 12:'RPG', 13:'Simulação', 14:'Esportes',
  15:'Estratégia', 16:'Estratégia', 24:'Estratégia', 25:'Ação',
  26:'Casual', 30:'Casual', 31:'Aventura', 32:'Indie', 33:'Ação',
  34:'Visual Novel', 35:'Card Game', 36:'Ação'
};

async function igdbGetGenres(name, appName, retries = 3) {
  const token = await getIgdbToken();
  if (!token) return null;
  const clean = name.replace(/[™®©]/g, '').replace(/:.*/,'').trim();
  const appNameWords = appName
    ? appName.replace(/([A-Z])/g, ' $1').replace(/[_-]/g,' ').replace(/\s+/g,' ').trim()
    : null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const _cfg = loadConfig();
      const _cid = _cfg.igdbClientId || IGDB_CLIENT_ID;
      const _tok = await getIgdbToken();
      if (!_tok) return null;
      const res = await fetch('https://api.igdb.com/v4/games', {
        method: 'POST',
        headers: {
          'Client-ID': _cid,
          'Authorization': `Bearer ${_tok}`,
          'Content-Type': 'text/plain'
        },
        body: `search "${clean}"; fields name,genres,summary; limit 5;`,
        timeout: 12000
      });

      // Rate limited — wait and retry
      if (res.status === 429) {
        const wait = attempt * 1500;
        console.warn(`[IGDB] 429 for "${clean}", retrying in ${wait}ms (attempt ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      // Auth error — clear cached token and retry
      if (res.status === 401) {
        _igdbToken = null;
        _igdbTokenExpiry = 0;
        console.warn(`[IGDB] 401 for "${clean}", refreshing token`);
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error(`[IGDB] HTTP ${res.status} for "${clean}" (attempt ${attempt}): ${errBody.slice(0,120)}`);
        if (res.status === 429) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
        if (attempt < retries) { await new Promise(r => setTimeout(r, 800 * attempt)); continue; }
        return null;
      }

      const games = await res.json();
      if (!games?.length) {
        // Try appName if game name search returned nothing
        if (appNameWords && appNameWords !== clean && attempt === 1) {
          const res2 = await fetch('https://api.igdb.com/v4/games', {
            method: 'POST',
            headers: { 'Client-ID': IGDB_CLIENT_ID, 'Authorization': `Bearer ${_igdbToken}`, 'Content-Type': 'text/plain' },
            body: `search "${appNameWords}"; fields name,genres,summary; limit 5;`,
            timeout: 12000
          });
          if (res2.ok) {
            const games2 = await res2.json();
            if (games2?.length) {
              const best2 = games2[0];
              return {
                name:        best2.name || null,
                genres:      (best2.genres || []).map(id => IGDB_GENRE_MAP[id]).filter(Boolean),
                description: best2.summary || ''
              };
            }
          }
        }
        return null;
      }

      const cleanLow = clean.toLowerCase();
      const best = games.find(g => g.name?.toLowerCase() === cleanLow)
                 || games.find(g => g.name?.toLowerCase().includes(cleanLow))
                 || games[0];
      return {
        name:        best.name || null,
        genres:      (best.genres || []).map(id => IGDB_GENRE_MAP[id]).filter(Boolean),
        description: best.summary || ''
      };

    } catch(e) {
      console.error(`[IGDB] Error for "${clean}" attempt ${attempt}:`, e.message);
      if (attempt < retries) await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
  return null;
}

// IPC: fetch genres for a batch of games via IGDB
// IGDB rate limit: 4 req/s — process sequentially with adaptive delay
ipcMain.handle('igdb-fetch-genres', async (_, gamesList) => {
  const token = await getIgdbToken();
  if (!token) { console.log('[IGDB] No token — skipping'); return {}; }

  const toFetch = gamesList.filter(g => {
    const cached = getBulkEntry(g.id);
    if (cached?.genres?.length) return false; // already has genres
    // Don't apply _igdbChecked skip to local/emulator IDs
    const isLocalOrEmu = g.id.startsWith('local_') || g.id.startsWith('emugame_');
    if (!isLocalOrEmu && cached?._igdbChecked) return false; // already tried, no match
    return true;
  });
  if (!toFetch.length) { console.log('[IGDB] All genres cached'); return {}; }
  console.log(`[IGDB] Fetching ${toFetch.length} games (sequential, adaptive delay)...`);

  const updates  = {};
  let consecutive429 = 0;

  for (let i = 0; i < toFetch.length; i++) {
    const g = toFetch[i];
    try {
      const result = await igdbGetGenres(g.name, g.appName, 3);
      if (result?.genres?.length || result?.name) {
        consecutive429 = 0;
        const existing    = getBulkEntry(g.id) || {};
        const normalized  = normalizeGenres(result.genres || []);
        const isCodename  = !g.name.includes(' ') || /production|project|codename/i.test(g.name);
        const realName    = (isCodename && result.name) ? result.name : (existing.name || g.name);
        const merged      = Object.assign(existing, {
          name:        realName,
          genres:      normalized.length ? normalized : (existing.genres || []),
          description: result.description || existing.description || ''
        });
        setBulkEntry(g.id, merged);
        updates[g.id] = { name: realName, genres: merged.genres, description: merged.description };
      } else {
        // No match in IGDB — mark as checked so we don't retry every boot
        // Skip marking for local/emulator games (their IDs change between sessions)
        const isLocalOrEmu = g.id.startsWith('local_') || g.id.startsWith('emugame_');
        if (!isLocalOrEmu) {
          const existing = getBulkEntry(g.id) || {};
          setBulkEntry(g.id, Object.assign(existing, { _igdbChecked: true }));
        }
      }
    } catch {}

    // 250ms delay — safe under 4 req/s IGDB limit (4 req/s = 250ms between requests)
    await new Promise(r => setTimeout(r, 250));

    if ((i + 1) % 10 === 0 || i === toFetch.length - 1) {
      console.log(`[IGDB] Progress: ${i + 1}/${toFetch.length} (${Object.keys(updates).length} hits)`);
    }
  }

  if (_bulkCache) saveBulkCache();
  console.log(`[IGDB] Done: ${Object.keys(updates).length} / ${toFetch.length}`);
  return updates;
});

// IPC: get single game genres+description from IGDB
ipcMain.handle('igdb-get-game', async (_, { id, name }) => {
  const cached = getBulkEntry(id);
  if (cached?.genres?.length && cached?.description) return cached;
  try {
    const result = await igdbGetGenres(name);
    if (!result) return null;
    const existing = getBulkEntry(id) || {};
    const merged = Object.assign(existing, result);
    setBulkEntry(id, merged);
    return merged;
  } catch { return null; }
});


// Save custom game name (persists in bulk cache)
ipcMain.handle('save-game-name', (_, { id, name }) => {
  const existing = getBulkEntry(id) || {};
  setBulkEntry(id, Object.assign(existing, { name }));
  saveBulkCache();
  return true;
});



//  GOG Integration 
const GOG_CLIENT_ID     = '46899977096215655';
const GOG_CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const GOG_REDIRECT_URI  = 'https://embed.gog.com/on_login_success?origin=client';
const GOG_AUTH_URL      = `https://auth.gog.com/auth?client_id=${GOG_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOG_REDIRECT_URI)}&response_type=code&layout=client2`;
const GOG_TOKEN_FILE    = path.join(app.getPath('userData'), 'gog_token.json');

function loadGogToken() {
  try { return JSON.parse(fs.readFileSync(GOG_TOKEN_FILE, 'utf8')); } catch { return null; }
}
function saveGogToken(t) { try { fs.writeFileSync(GOG_TOKEN_FILE, JSON.stringify(t)); } catch {} }
function clearGogToken() { try { if (fs.existsSync(GOG_TOKEN_FILE)) fs.unlinkSync(GOG_TOKEN_FILE); } catch {} }

async function getValidGogToken() {
  const stored = loadGogToken();
  if (!stored) return null;
  if (stored.expires_at && Date.now() < stored.expires_at - 60000) return stored.access_token;
  if (stored.refresh_token) {
    try {
      const res = await fetch(
        `https://auth.gog.com/token?client_id=${GOG_CLIENT_ID}&client_secret=${GOG_CLIENT_SECRET}&grant_type=refresh_token&refresh_token=${stored.refresh_token}`,
        { timeout: 10000 }
      );
      const data = await res.json();
      if (data.access_token) {
        const fresh = {
          access_token:  data.access_token,
          refresh_token: data.refresh_token || stored.refresh_token,
          user_id:       data.user_id || stored.user_id,
          username:      stored.username,
          expires_at:    Date.now() + (data.expires_in || 3600) * 1000
        };
        saveGogToken(fresh);
        return fresh.access_token;
      }
    } catch {}
    clearGogToken(); return null;
  }
  return null;
}

// IPC: start GOG auth — opens embedded browser window, captures code automatically
ipcMain.handle('gog-start-auth', async () => {
  return new Promise((resolve) => {
    const authWin = new BrowserWindow({
      width: 520, height: 650,
      title: 'Login GOG',
      parent: win,  // child of main window — won't trigger app quit
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      // Destroy instead of close to avoid window-all-closed
      if (!authWin.isDestroyed()) authWin.destroy();
      resolve(result);
    };

    const checkUrl = (url) => {
      try {
        if (url.includes('on_login_success') && url.includes('code=')) {
          const code = new URL(url).searchParams.get('code');
          if (code) { done({ ok: true, code }); return true; }
        }
      } catch {}
      return false;
    };

    authWin.loadURL(GOG_AUTH_URL);
    authWin.webContents.on('will-navigate', (_, url) => checkUrl(url));
    authWin.webContents.on('did-navigate', (_, url) => checkUrl(url));
    authWin.webContents.on('did-redirect-navigation', (_, url) => checkUrl(url));
    authWin.on('closed', () => done({ ok: false, cancelled: true }));
  });
});

// IPC: exchange GOG code for token
ipcMain.handle('gog-exchange-code', async (_, code) => {
  const res = await fetch(
    `https://auth.gog.com/token?client_id=${GOG_CLIENT_ID}&client_secret=${GOG_CLIENT_SECRET}&grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(GOG_REDIRECT_URI)}`,
    { timeout: 15000 }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error(data.error_description || 'Código inválido');

  let username = 'GOG User';
  let userId   = data.user_id;
  try {
    const uRes = await fetch('https://embed.gog.com/userData.json', {
      headers: { 'Authorization': `Bearer ${data.access_token}` }, timeout: 8000
    });
    if (uRes.ok) {
      const ud = await uRes.json();
      username = ud.username || ud.galaxyUserId || 'GOG User';
      userId   = ud.userId || userId;
    }
  } catch {}

  const token = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    user_id:       userId,
    username,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000
  };
  saveGogToken(token);
  return { ok: true, username };
});

// IPC: get GOG account
ipcMain.handle('gog-get-account', () => {
  const t = loadGogToken();
  return t ? { username: t.username, userId: t.user_id } : null;
});

// IPC: get GOG library
ipcMain.handle('gog-get-library', async () => {
  const token = await getValidGogToken();
  if (!token) return { error: 'not_authenticated' };
  const stored = loadGogToken();

  try {
    // Fetch owned games (paginated)
    const games = [];
    let page = 1;
    while (true) {
      const res = await fetch(
        `https://embed.gog.com/account/getFilteredProducts?mediaType=1&page=${page}&totalPages=1`,
        { headers: { 'Authorization': `Bearer ${token}` }, timeout: 15000 }
      );
      if (!res.ok) break;
      const data = await res.json();
      const products = data.products || [];
      console.log(`[GOG] Page ${page}: ${products.length} games (total pages: ${data.totalPages})`);
      for (const p of products) {
        games.push({
          id:        'gog_' + p.id,
          gogId:     p.id,
          name:      p.title || `GOG ${p.id}`,
          source:    'gog',
          installed: false,
          playtime:  0,
          header:    p.image ? 'https:' + p.image + '_392.jpg' : null,
          url:       p.url || null
        });
      }
      if (page >= (data.totalPages || 1)) break;
      page++;
      await new Promise(r => setTimeout(r, 300));
    }

    // Check installed games from GOG Galaxy local data
    const installedGog = getGogInstalledGames();
    const installedMap = {};
    installedGog.forEach(g => { installedMap[g.gogId] = g; });
    games.forEach(g => { if (installedMap[g.gogId]) g.installed = true; });

    console.log(`[GOG] Total: ${games.length} games (${installedGog.length} installed)`);
    return { games, username: stored.username };
  } catch(e) {
    console.error('[GOG] Library error:', e.message);
    return { error: e.message };
  }
});

// IPC: disconnect GOG
ipcMain.handle('gog-disconnect', () => { clearGogToken(); return true; });

// IPC: launch GOG game
ipcMain.handle('gog-launch', (_, { gogId, installed }) => {
  if (installed) {
    shell.openExternal(`goggalaxy://openGame/${gogId}`);
  } else {
    shell.openExternal(`https://www.gog.com/game/${gogId}`);
  }
  return true;
});

// Get locally installed GOG games
function getGogInstalledGames() {
  const games = [];
  const dirs = [
    'C:\ProgramData\GOG.com\Galaxy\storage',
    path.join(process.env.PROGRAMDATA || 'C:\ProgramData', 'GOG.com', 'Galaxy', 'storage')
  ];
  const seen = new Set();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      // GOG stores game info in minigalaxy.db or individual folders
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const infoFile = path.join(dir, entry, 'galaxy_info.json');
        if (!fs.existsSync(infoFile)) continue;
        try {
          const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
          const gogId = info.gameId || info.productId;
          if (gogId && !seen.has(gogId)) {
            seen.add(gogId);
            games.push({ gogId: String(gogId), name: info.name || entry });
          }
        } catch {}
      }
    } catch {}
  }
  return games;
}


//  Hidden games persistence 
const HIDDEN_FILE = path.join(app.getPath('userData'), 'hidden_games.json');
function loadHiddenGames() { try { return JSON.parse(fs.readFileSync(HIDDEN_FILE, 'utf8')); } catch { return []; } }
function saveHiddenGamesData(arr) { try { fs.writeFileSync(HIDDEN_FILE, JSON.stringify(arr)); } catch {} }
ipcMain.handle('get-hidden-games', () => loadHiddenGames());
ipcMain.handle('save-hidden-games', (_, arr) => { saveHiddenGamesData(arr); return true; });

//  Favorites persistence 
const FAVORITES_FILE = path.join(app.getPath('userData'), 'favorites.json');

function loadFavorites() {
  try { return JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8')); } catch { return []; }
}
function saveFavoritesData(arr) {
  try { fs.writeFileSync(FAVORITES_FILE, JSON.stringify(arr)); } catch {}
}

ipcMain.handle('get-favorites', () => loadFavorites());
ipcMain.handle('save-favorites', (_, arr) => { saveFavoritesData(arr); return true; });

//  Custom tags persistence 
// Format: { tagName: { color: '#hex', games: ['id1', 'id2', ...] }, ... }
const TAGS_FILE = path.join(app.getPath('userData'), 'custom_tags.json');

function loadTags() {
  try { return JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8')); } catch { return {}; }
}
function saveTagsData(obj) {
  try { fs.writeFileSync(TAGS_FILE, JSON.stringify(obj, null, 2)); } catch {}
}

ipcMain.handle('get-tags',  ()       => loadTags());
ipcMain.handle('save-tags', (_, obj) => { saveTagsData(obj); return true; });

//  Local images persistence 
const LOCAL_IMAGES_FILE = path.join(app.getPath('userData'), 'local_images.json');

function loadLocalImages() {
  try { return JSON.parse(fs.readFileSync(LOCAL_IMAGES_FILE, 'utf8')); } catch { return {}; }
}
function saveLocalImages(map) {
  try { fs.writeFileSync(LOCAL_IMAGES_FILE, JSON.stringify(map, null, 2)); } catch {}
}

ipcMain.handle('get-local-images', () => loadLocalImages());

ipcMain.handle('save-local-image', (_, { appid, filePath }) => {
  const map = loadLocalImages();
  map[appid] = filePath;
  saveLocalImages(map);
  return true;
});

ipcMain.handle('delete-local-image', (_, appid) => {
  const map = loadLocalImages();
  delete map[appid];
  saveLocalImages(map);
  return true;
});

// ── HowLongToBeat ─────────────────────────────────────────────────────────────
// Uses hltbapi.codepotatoes.de — free public API, no auth needed
async function fetchHltb(name, appid) {
  const toHours = (h) => {
    if (!h || h <= 0) return null;
    return h < 1 ? `${Math.round(h * 60)}min` : `${Math.round(h * 10) / 10}h`;
  };

  // For Steam games: use appId directly (most accurate)
  if (appid) {
    try {
      const res = await fetch(`https://hltbapi.codepotatoes.de/steam/${appid}`, { timeout: 8000 });
      if (res.ok) {
        const d = await res.json();
        if (d.mainStory || d.mainStoryWithExtras || d.completionist) {
          return {
            main:          toHours(d.mainStory),
            mainExtra:     toHours(d.mainStoryWithExtras),
            completionist: toHours(d.completionist),
            name:          d.title
          };
        }
      }
    } catch {}
  }

  // For GOG: use codepotatoes gog endpoint
  if (appid && String(appid).startsWith('gog_')) {
    const gogId = String(appid).replace('gog_', '');
    try {
      const res = await fetch(`https://hltbapi.codepotatoes.de/gog/${gogId}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
      if (res.ok) {
        const d = await res.json();
        if (d && (d.mainStory || d.mainStoryWithExtras || d.completionist)) {
          return { main: toHours(d.mainStory), mainExtra: toHours(d.mainStoryWithExtras), completionist: toHours(d.completionist), name: d.title };
        }
      }
    } catch {}
  }

  // For Epic/GOG fallback: search by title via IGDB-based HLTB search
  // Use the IGDB name which is more accurate than codenames
  const clean = name.replace(/[™®©]/g, '').replace(/:.*/, '').trim();
  try {
    // Use HLTB search via their public search API with proper headers
    const searchRes = await fetch(`https://www.howlongtobeat.com/api/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': 'https://howlongtobeat.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://howlongtobeat.com',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      body: JSON.stringify({
        searchType: 'games', searchTerms: clean.split(' '), searchPage: 1, size: 5,
        searchOptions: { games: { userId: 0, platform: '', sortCategory: 'popular', rangeCategory: 'main', rangeTime: { min: 0, max: 0 }, gameplay: { perspective: '', flow: '', genre: '' }, modifier: '' }, users: { sortCategory: 'postcount' }, filter: '', sort: 0, randomizer: 0 }
      }),
      timeout: 12000
    });
    if (searchRes.ok) {
      const data = await searchRes.json();
      const games = data?.data || [];
      const cleanLow = clean.toLowerCase();
      const best = games.find(g => g.game_name?.toLowerCase() === cleanLow) || games.find(g => g.game_name?.toLowerCase().includes(cleanLow)) || games[0];
      if (best) {
        const toH = (s) => { if (!s||s<=0) return null; const h=s/3600; return h<1?`${Math.round(h*60)}min`:`${Math.round(h*10)/10}h`; };
        return { main: toH(best.comp_main), mainExtra: toH(best.comp_plus), completionist: toH(best.comp_100), name: best.game_name };
      }
    }
  } catch(e) { console.log('[HLTB] Epic/GOG search error:', e.message); }

  return null;
}

ipcMain.handle('hltb-get', async (_, { id, name, appid }) => {
  const cached = getBulkEntry(id);
  if (cached?.hltb) return cached.hltb;
  const result = await fetchHltb(name, appid);
  if (result) {
    const ex = getBulkEntry(id) || {};
    setBulkEntry(id, Object.assign(ex, { hltb: result }));
  }
  return result;
});
