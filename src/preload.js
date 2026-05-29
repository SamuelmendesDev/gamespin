const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig:          ()          => ipcRenderer.invoke('get-config'),
  saveConfig:         (cfg)       => ipcRenderer.invoke('save-config', cfg),

  // Steam
  detectSteam:        ()          => ipcRenderer.invoke('detect-steam'),
  steamStartAuth:     ()          => ipcRenderer.invoke('steam-start-auth'),
  getGames:           (opts)      => ipcRenderer.invoke('get-games', opts),
  getPlayer:          (opts)      => ipcRenderer.invoke('get-player', opts),
  getCachedDetails:   (appids)    => ipcRenderer.invoke('get-cached-details', appids),
  getAppDetails:      (appid)     => ipcRenderer.invoke('get-appdetails', appid),
  getAppDetailsBatch: (appids)    => ipcRenderer.invoke('get-appdetails-batch', appids),
  getInstalled:       (steamPath) => ipcRenderer.invoke('get-installed', steamPath),
  clearCache:         (steamid)   => ipcRenderer.invoke('clear-cache', steamid),
  clearGenreCache:    ()          => ipcRenderer.invoke('clear-genre-cache'),

  // Epic Games
  epicStartAuth:      ()          => ipcRenderer.invoke('epic-start-auth'),
  epicExchangeCode:   (code)      => ipcRenderer.invoke('epic-exchange-code', code),
  epicGetLibrary:     ()          => ipcRenderer.invoke('epic-get-library'),
  epicGetAccount:     ()          => ipcRenderer.invoke('epic-get-account'),
  epicDisconnect:     ()          => ipcRenderer.invoke('epic-disconnect'),
  epicGetInstalled:   ()          => ipcRenderer.invoke('epic-get-installed'),
  epicLaunch:         (appName)   => ipcRenderer.invoke('epic-launch', appName),
  epicFetchCovers:    (games)     => ipcRenderer.invoke('epic-fetch-covers', games),
  epicGetDescription: (opts)      => ipcRenderer.invoke('epic-get-description', opts),
  igdbFetchGenres:    (games)     => ipcRenderer.invoke('igdb-fetch-genres', games),
  igdbGetGame:        (opts)      => ipcRenderer.invoke('igdb-get-game', opts),
  saveGameName:       (opts)      => ipcRenderer.invoke('save-game-name', opts),
  hltbGet:            (opts)      => ipcRenderer.invoke('hltb-get', opts),
  installUpdate:      ()          => ipcRenderer.invoke('install-update'),
  downloadUpdate:     ()          => ipcRenderer.invoke('update-download'),
  onUpdateAvailable:  (cb)        => ipcRenderer.on('update-available',  (_, info) => cb(info)),
  onUpdateProgress:   (cb)        => ipcRenderer.on('update-progress',   (_, info) => cb(info)),
  onUpdateDownloaded: (cb)        => ipcRenderer.on('update-downloaded', (_, info) => cb(info)),
  getFavorites:       ()          => ipcRenderer.invoke('get-favorites'),
  getHiddenGames:     ()          => ipcRenderer.invoke('get-hidden-games'),
  saveHiddenGames:    (arr)       => ipcRenderer.invoke('save-hidden-games', arr),
  saveFavorites:      (arr)       => ipcRenderer.invoke('save-favorites', arr),
  getTags:            ()          => ipcRenderer.invoke('get-tags'),
  saveTags:           (obj)       => ipcRenderer.invoke('save-tags', obj),
  // GOG
  gogStartAuth:       ()          => ipcRenderer.invoke('gog-start-auth'),
  gogExchangeCode:    (code)      => ipcRenderer.invoke('gog-exchange-code', code),
  gogGetAccount:      ()          => ipcRenderer.invoke('gog-get-account'),
  gogGetLibrary:      ()          => ipcRenderer.invoke('gog-get-library'),
  gogDisconnect:      ()          => ipcRenderer.invoke('gog-disconnect'),
  gogLaunch:          (opts)      => ipcRenderer.invoke('gog-launch', opts),
  sgdbFetchCovers:    (games)     => ipcRenderer.invoke('sgdb-fetch-covers', games),
  epicGetGameDetails: (opts)      => ipcRenderer.invoke('epic-get-game-details', opts),

  // Launch (Steam + Epic unified)
  launchGame:         (opts)      => ipcRenderer.invoke('launch-game', opts),

  // Local images
  pickLocalImage:         ()          => ipcRenderer.invoke('pick-local-image'),
  getLocalImages:         ()          => ipcRenderer.invoke('get-local-images'),
  saveLocalImage:         (opts)      => ipcRenderer.invoke('save-local-image', opts),
  deleteLocalImage:       (appid)     => ipcRenderer.invoke('delete-local-image', appid),
  // Local Library
  localLibraryGet:        ()          => ipcRenderer.invoke('local-library-get'),
  localLibraryAdd:        ()          => ipcRenderer.invoke('local-library-add'),
  localLibraryRemove:     (id)        => ipcRenderer.invoke('local-library-remove', id),
  localLibraryUpdate:     (opts)      => ipcRenderer.invoke('local-library-update', opts),
  localLibraryPickCover:  ()          => ipcRenderer.invoke('local-library-pick-cover'),
  localLibraryLaunch:     (exePath)   => ipcRenderer.invoke('local-library-launch', exePath),
  localLibraryScanDir:    ()          => ipcRenderer.invoke('local-library-scan-dir'),
  localLibraryFetchCovers:(games)     => ipcRenderer.invoke('local-library-fetch-covers', games),
  emulatorsGet:           ()          => ipcRenderer.invoke('emulators-get'),
  emulatorsSave:          (arr)       => ipcRenderer.invoke('emulators-save', arr),
  emulatorsPickExe:       ()          => ipcRenderer.invoke('emulators-pick-exe'),
  emulatorGamesGet:       ()          => ipcRenderer.invoke('emulator-games-get'),
  emulatorGamesSave:      (arr)       => ipcRenderer.invoke('emulator-games-save', arr),
  emulatorScanRoms:       (opts)      => ipcRenderer.invoke('emulator-scan-roms', opts),
  emulatorLaunch:         (opts)      => ipcRenderer.invoke('emulator-launch', opts),
  // Fullscreen / Big Picture
  toggleFullscreen:       ()          => ipcRenderer.invoke('toggle-fullscreen'),
  getFullscreen:          ()          => ipcRenderer.invoke('get-fullscreen'),
});
