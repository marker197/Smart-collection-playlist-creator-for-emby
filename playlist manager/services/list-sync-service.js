// ═════════════════════════════════════════════
// List Sync Service
// Auto-downloads changes from Trakt/MDBlists, updates stored
// chrono collections, and optionally queues missing items to Radarr.
// ═════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SAFETY_LIMITS = {
  MAX_PERCENT_REMOVED: 50,   // warn if more than half a list disappears
  MAX_BACKUPS: 5             // keep this many .bak snapshots
};

class ListSyncService {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.logger = options.logger;
    this.embyUrl = options.embyUrl;
    this.embyToken = options.embyToken;
    this.embyUserId = options.embyUserId;

    this.chronoPath = path.join(this.dataDir, 'chrono-collections.json');
    this.credentialsPath = path.join(this.dataDir, 'sync-credentials.json');
    this.configPath = path.join(this.dataDir, 'sync-config.json');
    this.auditPath = path.join(this.dataDir, 'sync-audit.json');
    this.watchedStatePath = path.join(this.dataDir, 'watched-sync-state.json');
    this.publishStatePath = path.join(this.dataDir, 'smart-publish-state.json');
    this.backupDir = path.join(this.dataDir, 'backups');

    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }

    this.timer = null;
    this.isSyncing = false;
  }

  // ═════════════════════════════════════════════
  // FILE HELPERS
  // ═════════════════════════════════════════════

  readJSON(file, fallback) {
    try {
      if (!fs.existsSync(file)) return fallback;
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw || !raw.trim()) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      this.logger.warn(`List sync: could not read ${path.basename(file)}: ${e.message}`);
      return fallback;
    }
  }

  writeJSONAtomic(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file); // atomic on POSIX
  }

  loadCollections() { return this.readJSON(this.chronoPath, []); }

  loadCredentials() {
    return this.readJSON(this.credentialsPath, { trakt: null, radarrServers: [], mdblistApiKey: null, tmdbApiKey: null });
  }

  loadConfig() {
    return this.readJSON(this.configPath, {
      enabled: false,
      intervalHours: 24,
      lastSync: null,
      nextSync: null,
      autoRadarr: false,
      radarrServerId: null,
      watchedSyncEnabled: false
    });
  }

  loadAudit() { return this.readJSON(this.auditPath, { syncs: [] }); }

  loadWatchedState() {
    return this.readJSON(this.watchedStatePath, { pushed: {} });
    // pushed: { "imdb:tt0372784": { trakt: "2026-06-22T...", mdblist: "2026-06-22T..." } }
  }

  saveWatchedState(state) {
    this.writeJSONAtomic(this.watchedStatePath, state);
  }

  loadPublishState() {
    return this.readJSON(this.publishStatePath, {});
    // shape: { [scheduleId]: { trakt: { listId, pushedIds: [...] }, mdblist: { listId, pushedIds: [...] } } }
  }

  savePublishState(state) {
    this.writeJSONAtomic(this.publishStatePath, state);
  }

  // ═════════════════════════════════════════════
  // CREDENTIALS (synced from frontend — Trakt token, Radarr servers)
  // ═════════════════════════════════════════════

  saveCredentials(partial) {
    const current = this.loadCredentials();
    const updated = { ...current, ...partial };
    this.writeJSONAtomic(this.credentialsPath, updated);
    this.logger.info('🔑 Sync credentials updated (Trakt/Radarr)');
    return updated;
  }

  // ═════════════════════════════════════════════
  // SETTINGS
  // ═════════════════════════════════════════════

  saveConfig(updates) {
    const current = this.loadConfig();
    const updated = { ...current, ...updates };
    this.writeJSONAtomic(this.configPath, updated);
    this.restart();
    return updated;
  }

  appendAudit(entry) {
    const audit = this.loadAudit();
    audit.syncs.unshift(entry); // newest first
    audit.syncs = audit.syncs.slice(0, 500); // keep last 500 runs — enough for a meaningful timeline
    this.writeJSONAtomic(this.auditPath, audit);
  }

  // ═════════════════════════════════════════════
  // BACKUP (always snapshot before writing changes)
  // ═════════════════════════════════════════════

  backupCollections() {
    try {
      if (!fs.existsSync(this.chronoPath)) return;
      const backupFile = path.join(this.backupDir, `chrono-collections.${Date.now()}.bak`);
      fs.copyFileSync(this.chronoPath, backupFile);

      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('chrono-collections.') && f.endsWith('.bak'))
        .sort();
      while (files.length > SAFETY_LIMITS.MAX_BACKUPS) {
        fs.unlinkSync(path.join(this.backupDir, files.shift()));
      }
    } catch (e) {
      this.logger.warn('List sync: backup failed - ' + e.message);
    }
  }

  // ═════════════════════════════════════════════
  // FETCH FROM SOURCE
  // ═════════════════════════════════════════════

  // All of the user's currently-liked lists, as a Set of both numeric ids and slugs —
  // used to detect "unliked" as distinct from "deleted" or "emptied", since unliking
  // someone else's list doesn't touch the list's own content or existence at all.
  async fetchTraktLikedListIds(creds) {
    const headers = {
      'Authorization': 'Bearer ' + creds.trakt.accessToken,
      'trakt-api-version': '2',
      'trakt-api-key': creds.trakt.clientId || ''
    };
    const response = await axios.get('https://api.trakt.tv/users/likes/lists', { headers, timeout: 15000 });
    const likedLists = (response.data || []).map(item => item.list || item);

    const ids = new Set();
    likedLists.forEach(l => {
      if (l.ids) {
        if (l.ids.trakt) ids.add(String(l.ids.trakt));
        if (l.ids.slug) ids.add(String(l.ids.slug));
      }
    });
    return ids;
  }

  // Pulls {title, year, imdb, tmdb} out of a Trakt movie object — same shape used
  // throughout this file (sync/history, custom lists, etc.), so this is just
  // reading fields that were always there but previously discarded.
  extractTraktMovie(movie) {
    if (!movie || !movie.title) return null;
    return {
      title: movie.title,
      year: movie.year || null,
      imdb: (movie.ids && movie.ids.imdb) || null,
      tmdb: (movie.ids && movie.ids.tmdb) || null
    };
  }

  async fetchTraktList(coll, creds) {
    if (!creds || !creds.trakt || !creds.trakt.accessToken) {
      throw new Error('Trakt not connected (connect it in the app first)');
    }

    const headers = {
      'Authorization': 'Bearer ' + creds.trakt.accessToken,
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': creds.trakt.clientId || '',
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json'
    };

    const isWatchlist = coll.sourceListId === 'watchlist';
    const isOtherUser = coll.sourceUsername
      && coll.sourceUsername !== 'unknown'
      && coll.sourceUsername !== creds.trakt.username;

    const buildUrl = (listId) => {
      if (isWatchlist) return 'https://api.trakt.tv/users/me/watchlist/movies';
      if (coll.sourceListIsLiked) return `https://api.trakt.tv/lists/${listId}/items/movies`;
      if (isOtherUser) return `https://api.trakt.tv/users/${encodeURIComponent(coll.sourceUsername)}/lists/${encodeURIComponent(listId)}/items/movies`;
      return `https://api.trakt.tv/users/me/lists/${listId}/items/movies`;
    };

    const url = buildUrl(coll.sourceListId);

    try {
      const response = await axios.get(url, { headers, timeout: 15000 });
      const items = response.data || [];
      return items.map(i => this.extractTraktMovie(i.movie || i)).filter(Boolean);
    } catch (e) {
      const status = e.response ? e.response.status : '???';

      // Self-heal: "liked" lists are sometimes saved with their slug, but Trakt's
      // generic /lists/{id} endpoint requires the numeric ID for non-personal lists.
      // Look the list up by name in the user's liked lists and retry once.
      if (coll.sourceListIsLiked && status === 400) {
        this.logger.warn(`Trakt 400 on liked list "${coll.name}" — attempting to resolve the numeric list ID...`);
        try {
          const likedRes = await axios.get('https://api.trakt.tv/users/likes/lists', { headers, timeout: 15000 });
          const likedLists = (likedRes.data || []).map(item => item.list || item);
          const match = likedLists.find(l =>
            l.name === (coll.sourceListName || coll.name) ||
            (l.ids && (l.ids.slug === coll.sourceListId || String(l.ids.trakt) === String(coll.sourceListId)))
          );

          if (match && match.ids && match.ids.trakt) {
            const retryRes = await axios.get(buildUrl(match.ids.trakt), { headers, timeout: 15000 });
            const items = retryRes.data || [];

            // Persist the working numeric ID so future syncs — and the app's own
            // manual refresh button — stop hitting this bug
            coll.sourceListId = match.ids.trakt;
            coll._idHealed = true;
            this.logger.info(`   ✓ Resolved "${coll.name}" to numeric list ID ${match.ids.trakt} — saved for future syncs`);

            return items.map(i => this.extractTraktMovie(i.movie || i)).filter(Boolean);
          } else {
            this.logger.warn(`   Could not find "${coll.name}" in your liked lists — it may have been unliked on Trakt`);
          }
        } catch (recoveryError) {
          this.logger.warn(`   Recovery attempt failed: ${recoveryError.message}`);
        }
      }

      const body = e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
      this.logger.warn(`Trakt fetch failed [${status}] for "${coll.name}" → ${url}`);
      this.logger.warn(`  Response: ${body}`);
      const err = new Error(`Trakt HTTP ${status}`);
      err.status = status;
      throw err;
    }
  }

  async fetchMDBlistsList(coll, creds) {
    // Falls back to the account-wide key (same resilient pattern already used
    // for Smart Collection publishing) rather than requiring every single
    // collection to have its own key stored — a collection created without
    // one explicitly set would otherwise fail forever, even after the global
    // key is updated in Settings, since nothing here ever looked at it.
    const apiKey = coll.sourceListApiKey || (creds && creds.mdblistApiKey);
    if (!apiKey) {
      throw new Error('No MDBlists API key available — set one in Settings or for this specific collection');
    }

    const isWatchlist = coll.sourceListId === '_watchlist' || coll.isWatchlist === true;

    // MDBlists' field is release_year, not year — confirmed against a real response.
    // ids.imdb/ids.tmdb sit in the same nested shape used by sync/watched and
    // sync/collection elsewhere in this file.
    const extractMDBItem = (item) => {
      if (!item || !item.title) return null;
      return {
        title: item.title,
        year: item.release_year || null,
        imdb: (item.ids && item.ids.imdb) || item.imdb_id || null,
        tmdb: (item.ids && item.ids.tmdb) || null
      };
    };

    try {
      if (isWatchlist) {
        const [movies, shows] = await Promise.all([
          axios.get(`https://api.mdblist.com/watchlist/items/?mediatype=movie&apikey=${apiKey}`, { timeout: 15000 }),
          axios.get(`https://api.mdblist.com/watchlist/items/?mediatype=show&apikey=${apiKey}`, { timeout: 15000 }).catch(() => ({ data: {} }))
        ]);

        const titles = [];
        (movies.data.movies || []).forEach(m => { const r = extractMDBItem(m); if (r) titles.push(r); });
        (movies.data.shows || []).forEach(s => { const r = extractMDBItem(s); if (r) titles.push(r); });
        (shows.data.movies || []).forEach(m => { const r = extractMDBItem(m); if (r) titles.push(r); });
        (shows.data.shows || []).forEach(s => { const r = extractMDBItem(s); if (r) titles.push(r); });
        return titles;
      }

      const url = `https://api.mdblist.com/lists/${coll.sourceListId}/items?apikey=${apiKey}`;
      const response = await axios.get(url, { timeout: 15000 });
      const data = response.data || {};

      const titles = [];
      (data.movies || []).forEach(m => { const r = extractMDBItem(m); if (r) titles.push(r); });
      (data.shows || []).forEach(s => { const r = extractMDBItem(s); if (r) titles.push(r); });
      (data.episodes || []).forEach(e => { const r = extractMDBItem(e); if (r) titles.push(r); });
      return titles;

    } catch (e) {
      const status = e.response ? e.response.status : '???';
      this.logger.warn(`MDBlists fetch failed [${status}] for "${coll.name}" (listId: ${coll.sourceListId})`);
      const err = new Error(`MDBlists HTTP ${status}`);
      err.status = status;
      throw err;
    }
  }

  async fetchLatestTitles(coll, creds) {
    if (coll.source === 'Trakt') return this.fetchTraktList(coll, creds);
    if (coll.source === 'MDBlists') return this.fetchMDBlistsList(coll, creds);
    return null; // e.g. 'import' — no remote source to sync against
  }

  // ═════════════════════════════════════════════
  // EMBY LIBRARY SNAPSHOT (one call, reused for every collection)
  // ═════════════════════════════════════════════

  async fetchLibraryItems() {
    const url = `${this.embyUrl}/Items?IncludeItemTypes=Movie,Series&Recursive=true&Fields=Id,Name,ProductionYear,ProviderIds&Limit=10000&UserId=${this.embyUserId}&api_key=${this.embyToken}`;
    const response = await axios.get(url, { timeout: 20000 });
    return (response.data && response.data.Items) || [];
  }

  async fetchCollectionItems(embyId) {
    const url = `${this.embyUrl}/Items?ParentId=${embyId}&IncludeItemTypes=Movie&Recursive=true&Fields=Id,Name,ProviderIds,UserData&Limit=2000&UserId=${this.embyUserId}&api_key=${this.embyToken}`;
    const response = await axios.get(url, { timeout: 15000 });
    return (response.data && response.data.Items) || [];
  }

  // ID-first matching: an exact IMDB/TMDB match is unambiguous by definition, so it's
  // tried before any string comparison at all. Title+year matching (below) only ever
  // runs as a fallback for the rare case where neither side has an ID — which is also
  // exactly the scenario most prone to the kind of mismatch that started this work
  // (e.g. Scary Movie 2000 vs. 2026 sharing an identical bare name).
  matchItemToLibrary(item, libraryItems) {
    if (item.imdb) {
      const idMatch = libraryItems.find(m => m.ProviderIds && (m.ProviderIds.Imdb || m.ProviderIds.IMDB) === item.imdb);
      if (idMatch) return idMatch;
    }
    if (item.tmdb) {
      const idMatch = libraryItems.find(m => m.ProviderIds && String(m.ProviderIds.Tmdb || m.ProviderIds.TMDB) === String(item.tmdb));
      if (idMatch) return idMatch;
    }
    return this.matchTitleToLibrary(item.title, libraryItems, item.year);
  }

  // Same exact-then-year-stripped matching used by /api/refresh-all-collections,
  // now disambiguated by release year when multiple library items share a bare
  // name (e.g. a same-titled remake/reboot) — previously just took whichever
  // candidate Array.find() happened to hit first, regardless of which was correct.
  // sourceYear is an optional hint from Trakt/MDBlists, passed in separately rather
  // than parsed from the title string, since titles here are always bare.
  matchTitleToLibrary(title, libraryItems, sourceYear) {
    const exact = libraryItems.find(m => m.Name === title);

    if (exact) {
      // Even an exact name match can be the wrong movie if another library item
      // shares the same bare name with a different year — check for that collision
      // before trusting it.
      if (sourceYear) {
        const sameName = libraryItems.filter(m => m.Name === title);
        if (sameName.length > 1) {
          const yearMatched = sameName.find(m => m.ProductionYear === sourceYear);
          if (yearMatched) return yearMatched;
        }
      }
      return exact;
    }

    const tClean = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
    const candidates = libraryItems.filter(m => {
      const movClean = (m.Name || '').replace(/\s*\(\d{4}\)\s*$/, '').trim();
      return movClean === tClean;
    });

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // Multiple same-named candidates — use the source's year to pick the right one
    if (sourceYear) {
      const yearMatched = candidates.find(m => m.ProductionYear === sourceYear);
      if (yearMatched) return yearMatched;
    }

    // No year info to disambiguate (older data, or source didn't provide one) —
    // falls back to the previous behavior, but this is now a known-ambiguous case
    return candidates[0];
  }

  async addItemsToEmbyCollection(embyId, movieIds) {
    const url = `${this.embyUrl}/Collections/${embyId}/Items?Ids=${movieIds.join(',')}&api_key=${this.embyToken}`;
    await axios.post(url);  // No body - Emby rejects POST with empty body
  }

  async removeItemsFromEmbyCollection(embyId, movieIds) {
    const url = `${this.embyUrl}/Collections/${embyId}/Items?Ids=${movieIds.join(',')}&api_key=${this.embyToken}`;
    await axios.delete(url);
  }

  // Full teardown — used when a source list is confirmed gone (deleted or emptied)
  // and the user has explicitly confirmed they want the orphaned Emby collection removed.
  async deleteEmbyCollection(embyId) {
    const url = `${this.embyUrl}/Items/${embyId}?api_key=${this.embyToken}`;
    await axios.delete(url);
  }

  removeCollectionFromChrono(embyId) {
    const collections = this.loadCollections();
    const filtered = collections.filter(c => c.embyId !== embyId);
    if (filtered.length !== collections.length) {
      this.writeJSONAtomic(this.chronoPath, filtered);
      return true;
    }
    return false;
  }

  // ═════════════════════════════════════════════
  // SAFETY VALIDATION
  // ═════════════════════════════════════════════

  validateChanges(oldCount, newCount) {
    const warnings = [];

    if (oldCount > 0 && newCount === 0) {
      warnings.push('New list came back empty — skipping update to avoid wiping the collection');
      return { safe: false, warnings };
    }

    if (oldCount > 0) {
      const removedPct = ((oldCount - newCount) / oldCount) * 100;
      if (removedPct > SAFETY_LIMITS.MAX_PERCENT_REMOVED) {
        warnings.push(`${removedPct.toFixed(0)}% of items would be removed — check the source list`);
      }
    }

    return { safe: true, warnings };
  }

  // ═════════════════════════════════════════════
  // RADARR (mirrors the frontend's sendToRadarrSilent)
  // ═════════════════════════════════════════════

  async sendToRadarr(title, radarrServer) {
    try {
      const base = radarrServer.url.replace(/\/$/, '');
      const headers = { 'X-Api-Key': radarrServer.apiKey };

      const lookupRes = await axios.get(`${base}/api/v3/movie/lookup`, {
        headers, params: { term: title }, timeout: 10000
      });
      const results = lookupRes.data || [];
      if (!results.length) return { status: 'not_found', title };

      const [rfRes, qpRes] = await Promise.all([
        axios.get(`${base}/api/v3/rootfolder`, { headers, timeout: 10000 }).catch(() => ({ data: [] })),
        axios.get(`${base}/api/v3/qualityprofile`, { headers, timeout: 10000 }).catch(() => ({ data: [] }))
      ]);

      const rootPath = (rfRes.data[0] && rfRes.data[0].path) || '/movies';
      const qualityId = (qpRes.data[0] && qpRes.data[0].id) || 1;
      const movie = results[0];

      const payload = {
        title: movie.title,
        qualityProfileId: qualityId,
        titleSlug: movie.titleSlug,
        images: movie.images || [],
        tmdbId: movie.tmdbId,
        year: movie.year,
        rootFolderPath: rootPath,
        monitored: true,
        addOptions: { searchForMovie: true }
      };

      const addRes = await axios.post(`${base}/api/v3/movie`, payload, {
        headers: { ...headers, 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: () => true
      });

      if (addRes.status === 201 || addRes.status === 200) return { status: 'sent', title };
      if (addRes.status === 400) return { status: 'already_exists', title };
      return { status: 'failed', title, error: `HTTP ${addRes.status}` };

    } catch (e) {
      return { status: 'failed', title, error: e.message };
    }
  }

  // ═════════════════════════════════════════════
  // WATCHED SYNC (Emby → Trakt / MDBlists)
  // Pushes movies marked Played in Emby back to the source service.
  // ═════════════════════════════════════════════

  // Batched single call — Trakt accepts an array, no need for one request per movie
  async pushWatchedToTrakt(movies, creds) {
    if (!movies.length) return { succeeded: [], notFound: [], error: null };
    if (!creds || !creds.trakt || !creds.trakt.accessToken) {
      return { succeeded: [], notFound: [], error: 'Trakt not connected' };
    }

    const headers = {
      'Authorization': 'Bearer ' + creds.trakt.accessToken,
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': creds.trakt.clientId || ''
    };

    try {
      const response = await axios.post('https://api.trakt.tv/sync/history', {
        movies: movies.map(m => {
          // Build IDs object with both IMDB and TMDB if available
          // This matches the API's preference for dual-ID matching
          const ids = {};
          if (m.imdb) ids.imdb = String(m.imdb); // ensure string format
          if (m.tmdb) ids.tmdb = parseInt(m.tmdb, 10);
          
          return {
            ids,
            watched_at: m.watchedAt || new Date().toISOString()
          };
        })
      }, { headers, timeout: 15000 });

      const notFoundKeys = new Set((response.data.not_found?.movies || []).map(m =>
        (m.ids && (m.ids.imdb || m.ids.tmdb)) || ''
      ));

      const succeeded = movies.filter(m => !notFoundKeys.has(m.imdb || String(m.tmdb)));
      const notFound = movies.filter(m => notFoundKeys.has(m.imdb || String(m.tmdb)));

      return { succeeded, notFound, error: null, raw: response.data };
    } catch (e) {
      const status = e.response ? e.response.status : '???';
      this.logger.warn(`Trakt watched-sync failed [${status}]: ${e.message}`);
      return { succeeded: [], notFound: [], error: `Trakt HTTP ${status}` };
    }
  }

  // Batched per API key — each MDBlists-sourced collection may use a different key
  async pushWatchedToMDBList(movies, apiKey) {
    if (!movies.length) return { succeeded: [], notFound: [], error: null };
    if (!apiKey) return { succeeded: [], notFound: [], error: 'No MDBlists API key' };

    try {
      const response = await axios.post(
        `https://api.mdblist.com/sync/watched?apikey=${apiKey}`,
        {
          movies: movies.map(m => {
            // Build IDs object with both IMDB and TMDB if available
            const ids = {};
            if (m.imdb) ids.imdb = String(m.imdb);
            if (m.tmdb) ids.tmdb = parseInt(m.tmdb, 10);
            
            return {
              ids,
              watched_at: m.watchedAt || new Date().toISOString()
            };
          })
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
      );

      const notFoundKeys = new Set((response.data.not_found?.movies || []).map(m =>
        (m.ids && (m.ids.imdb || m.ids.tmdb)) || ''
      ));

      const succeeded = movies.filter(m => !notFoundKeys.has(m.imdb || String(m.tmdb)));
      const notFound = movies.filter(m => notFoundKeys.has(m.imdb || String(m.tmdb)));

      return { succeeded, notFound, error: null, raw: response.data };
    } catch (e) {
      const status = e.response ? e.response.status : '???';
      this.logger.warn(`MDBlists watched-sync failed [${status}]: ${e.message}`);
      return { succeeded: [], notFound: [], error: `MDBlists HTTP ${status}` };
    }
  }

  // Collect newly-Played movies from every tracked Trakt/MDBlists collection,
  // skip anything already pushed (per-service), then batch-push.
  async syncWatchedStatus(options = {}) {
    const dryRun = !!options.dryRun;
    const collections = this.loadCollections();
    const creds = this.loadCredentials();
    const watchedState = this.loadWatchedState();

    const result = {
      success: true,
      dryRun,
      traktPushed: [],
      traktNotFound: [],
      mdblistPushed: [],
      mdblistNotFound: [],
      skippedNoId: [],
      errors: []
    };

    // ---- Trakt: one combined batch across all Trakt-sourced collections ----
    const traktCollections = collections.filter(c => c.source === 'Trakt');
    const traktCandidates = [];

    for (const coll of traktCollections) {
      let items = [];
      try {
        items = await this.fetchCollectionItems(coll.embyId);
      } catch (e) {
        result.errors.push({ collection: coll.name, error: e.message });
        continue;
      }

      const watched = items.filter(i => i.UserData && i.UserData.Played);
      for (const item of watched) {
        const imdb = item.ProviderIds && (item.ProviderIds.Imdb || item.ProviderIds.IMDB);
        const tmdb = item.ProviderIds && (item.ProviderIds.Tmdb || item.ProviderIds.TMDB);
        if (!imdb && !tmdb) { result.skippedNoId.push(item.Name); continue; }

        const key = 'trakt:' + (imdb || tmdb);
        if (watchedState.pushed[key]) continue; // already pushed in a previous run

        traktCandidates.push({
          name: item.Name,
          imdb: imdb || null,
          tmdb: tmdb || null,
          watchedAt: item.UserData.LastPlayedDate || new Date().toISOString(),
          _key: key
        });
      }
    }

    if (traktCandidates.length) {
      if (dryRun) {
        result.traktPushed = traktCandidates.map(m => ({ name: m.name, imdb: m.imdb, tmdb: m.tmdb }));
      } else {
        const pushResult = await this.pushWatchedToTrakt(traktCandidates, creds);
        if (pushResult.error) {
          result.errors.push({ service: 'trakt', error: pushResult.error });
        } else {
          pushResult.succeeded.forEach(m => { watchedState.pushed[m._key] = { ...(watchedState.pushed[m._key]||{}), trakt: new Date().toISOString() }; });
          result.traktPushed = pushResult.succeeded.map(m => ({ name: m.name, imdb: m.imdb, tmdb: m.tmdb }));
          result.traktNotFound = pushResult.notFound.map(m => m.name);
        }
      }
    }

    // ---- MDBlists: grouped per API key, since different collections may use different keys ----
    const mdblistCollections = collections.filter(c => c.source === 'MDBlists' && c.sourceListApiKey);
    const byApiKey = new Map();
    for (const coll of mdblistCollections) {
      if (!byApiKey.has(coll.sourceListApiKey)) byApiKey.set(coll.sourceListApiKey, []);
      byApiKey.get(coll.sourceListApiKey).push(coll);
    }

    for (const [apiKey, colls] of byApiKey.entries()) {
      const mdbCandidates = [];

      for (const coll of colls) {
        let items = [];
        try {
          items = await this.fetchCollectionItems(coll.embyId);
        } catch (e) {
          result.errors.push({ collection: coll.name, error: e.message });
          continue;
        }

        const watched = items.filter(i => i.UserData && i.UserData.Played);
        for (const item of watched) {
          const imdb = item.ProviderIds && (item.ProviderIds.Imdb || item.ProviderIds.IMDB);
          const tmdb = item.ProviderIds && (item.ProviderIds.Tmdb || item.ProviderIds.TMDB);
          if (!imdb && !tmdb) continue; // already counted in skippedNoId via Trakt pass if shared; avoid double-count otherwise

          const key = 'mdblist:' + (imdb || tmdb) + ':' + apiKey.slice(-6);
          if (watchedState.pushed[key]) continue;

          mdbCandidates.push({
            name: item.Name,
            imdb: imdb || null,
            tmdb: tmdb || null,
            watchedAt: item.UserData.LastPlayedDate || new Date().toISOString(),
            _key: key
          });
        }
      }

      if (!mdbCandidates.length) continue;

      if (dryRun) {
        result.mdblistPushed.push(...mdbCandidates.map(m => ({ name: m.name, imdb: m.imdb, tmdb: m.tmdb })));
      } else {
        const pushResult = await this.pushWatchedToMDBList(mdbCandidates, apiKey);
        if (pushResult.error) {
          result.errors.push({ service: 'mdblist', error: pushResult.error });
        } else {
          pushResult.succeeded.forEach(m => { watchedState.pushed[m._key] = { ...(watchedState.pushed[m._key]||{}), mdblist: new Date().toISOString() }; });
          result.mdblistPushed.push(...pushResult.succeeded.map(m => ({ name: m.name, imdb: m.imdb, tmdb: m.tmdb })));
          result.mdblistNotFound.push(...pushResult.notFound.map(m => m.name));
        }
      }
    }

    if (!dryRun) this.saveWatchedState(watchedState);

    if (result.traktPushed.length || result.mdblistPushed.length) {
      this.logger.info(`✅ [WATCHED SYNC] Trakt: ${result.traktPushed.length} pushed, MDBlists: ${result.mdblistPushed.length} pushed${dryRun ? ' (dry run)' : ''}`);
    } else {
      this.logger.info(`✅ [WATCHED SYNC] Nothing new to push`);
    }

    return result;
  }

  // Webhook-driven single-item push — fires on Emby's item.markplayed event.
  // Logic:
  // - If in Trakt watchlist → push to Trakt only (bidirectional sync)
  // - If in MDBlists watchlist → push to MDBlists only (bidirectional sync)
  // - If in any other collection → push to both services (watched history sync)
  async pushWatchedSingleItem({ name, imdb, tmdb, watchedAt }) {
    const creds = this.loadCredentials();
    const watchedState = this.loadWatchedState();
    const idKey = imdb || tmdb;

    const result = { traktPushed: false, mdblistPushed: [] };

    // If no ID, we can't match anything
    if (!idKey) {
      this.logger.warn(`   Webhook watched-push: item "${name}" has no IMDB/TMDB ID, skipping`);
      return result;
    }

    const movie = { name, imdb, tmdb, watchedAt: watchedAt || new Date().toISOString() };

    // ═══════════════════════════════════════════════════════════════════
    // PUSH WATCHED STATUS: Independent of collections
    // Watch history pushes directly without requiring collection membership
    // ═══════════════════════════════════════════════════════════════════

    const traktKey = 'trakt:' + idKey;
    const mdblistKey = 'mdblist:' + idKey;

    // ═══════════════════════════════════════════════════════════════════
    // TRAKT: Push watched status unconditionally if credentials exist
    // ═══════════════════════════════════════════════════════════════════
    if (creds && creds.trakt && creds.trakt.accessToken) {
      if (!watchedState.pushed[traktKey]) {
        try {
          const r = await this.pushWatchedToTrakt([movie], creds);
          if (r.error) {
            this.logger.warn(`   Webhook watched-push to Trakt failed: ${r.error}`);
          } else if (r.succeeded.length) {
            watchedState.pushed[traktKey] = { ...(watchedState.pushed[traktKey] || {}), trakt: movie.watchedAt };
            result.traktPushed = true;
            this.logger.info(`   ✓ Watched pushed to Trakt: "${name}"`);
          } else if (r.notFound.length) {
            this.logger.warn(`   Trakt: item not found in Trakt database`);
          }
        } catch (e) {
          this.logger.warn(`   Webhook watched-push to Trakt threw: ${e.message}`);
        }
      } else {
        this.logger.info(`   Trakt: already pushed, skipping`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // MDBLIST: Push watched status unconditionally if credentials exist
    // ═══════════════════════════════════════════════════════════════════
    if (creds && creds.mdblistApiKey) {
      if (!watchedState.pushed[mdblistKey]) {
        try {
          const r = await this.pushWatchedToMDBList([movie], creds.mdblistApiKey);
          if (r.error) {
            this.logger.warn(`   Webhook watched-push to MDBlists failed: ${r.error}`);
          } else if (r.succeeded.length) {
            watchedState.pushed[mdblistKey] = { ...(watchedState.pushed[mdblistKey] || {}), mdblist: movie.watchedAt };
            result.mdblistPushed.push('watched-history');
            this.logger.info(`   ✓ Watched pushed to MDBlists: "${name}"`);
          } else if (r.notFound.length) {
            this.logger.warn(`   MDBlists: item not found in database`);
          }
        } catch (e) {
          this.logger.warn(`   Webhook watched-push to MDBlists threw: ${e.message}`);
        }
      } else {
        this.logger.info(`   MDBlists: already pushed, skipping`);
      }
    }

    this.saveWatchedState(watchedState);
    return result;
  }

  // ═════════════════════════════════════════════
  // SMART LIST PUBLISHING (Emby Smart Collection → Trakt / MDBlists)
  // Publishes a locally-built Smart Collection out as a real list on each
  // service, then keeps it in sync as the rule's matched items change.
  // ═════════════════════════════════════════════

  // Cheap existence checks — used to detect a list that was deleted externally,
  // since trusting a stored listId/pushedKeys forever would otherwise mean a
  // deleted list is never recreated (an empty diff never even attempts an API call).
  async traktListExists(listId, creds) {
    try {
      const headers = {
        'Authorization': 'Bearer ' + creds.trakt.accessToken,
        'trakt-api-version': '2',
        'trakt-api-key': creds.trakt.clientId || ''
      };
      await axios.get(`https://api.trakt.tv/users/me/lists/${listId}`, { headers, timeout: 10000 });
      return true;
    } catch (e) {
      if (e.response && e.response.status === 404) return false;
      throw e; // network/auth errors shouldn't be treated as "list doesn't exist"
    }
  }

  async mdblistExists(listId, apiKey) {
    try {
      await axios.get(`https://api.mdblist.com/lists/${listId}/items?apikey=${apiKey}`, { timeout: 10000 });
      return true;
    } catch (e) {
      if (e.response && e.response.status === 404) return false;
      throw e;
    }
  }

  async createTraktList(name, description, creds) {
    const headers = {
      'Authorization': 'Bearer ' + creds.trakt.accessToken,
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': creds.trakt.clientId || ''
    };
    const response = await axios.post('https://api.trakt.tv/users/me/lists', {
      name, description: description || '', privacy: 'private'
    }, { headers, timeout: 15000 });

    return response.data; // includes ids.trakt, ids.slug
  }

  async addItemsToTraktList(listId, movies, creds) {
    const headers = {
      'Authorization': 'Bearer ' + creds.trakt.accessToken,
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': creds.trakt.clientId || ''
    };
    const response = await axios.post(`https://api.trakt.tv/users/me/lists/${listId}/items`, {
      movies: movies.map(m => ({ ids: m.imdb ? { imdb: m.imdb } : { tmdb: parseInt(m.tmdb, 10) } }))
    }, { headers, timeout: 15000 });

    return response.data; // {added:{movies}, existing:{movies}, not_found:{movies:[]}}
  }

  async removeItemsFromTraktList(listId, movies, creds) {
    const headers = {
      'Authorization': 'Bearer ' + creds.trakt.accessToken,
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': creds.trakt.clientId || ''
    };
    const response = await axios.post(`https://api.trakt.tv/users/me/lists/${listId}/items/remove`, {
      movies: movies.map(m => {
        const ids = {};
        if (m.imdb) ids.imdb = String(m.imdb);
        if (m.tmdb) ids.tmdb = parseInt(m.tmdb, 10);
        return { ids };
      })
    }, { headers, timeout: 15000 });

    return response.data;
  }

  async createMDBList(name, apiKey) {
    const response = await axios.post(
      `https://api.mdblist.com/lists/user/add?apikey=${apiKey}`,
      { name, private: true },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return response.data; // {id, slug, url}
  }

  async addItemsToMDBList(listId, movies, apiKey) {
    // Flat shape confirmed working: {tmdb, imdb} directly on each item, no ids{} wrapper
    const response = await axios.post(
      `https://api.mdblist.com/lists/${listId}/items/add?apikey=${apiKey}`,
      { movies: movies.map(m => ({ tmdb: m.tmdb ? parseInt(m.tmdb, 10) : undefined, imdb: m.imdb || undefined })) },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return response.data; // {added:{movies}, existing:{movies}, not_found:{movies}}
  }

  async removeItemsFromMDBList(listId, movies, apiKey) {
    // Send both IMDB and TMDB if available — clean up undefined fields
    const response = await axios.post(
      `https://api.mdblist.com/lists/${listId}/items/remove?apikey=${apiKey}`,
      { movies: movies.map(m => {
        const obj = {};
        if (m.imdb) obj.imdb = String(m.imdb);
        if (m.tmdb) obj.tmdb = parseInt(m.tmdb, 10);
        return obj;
      }) },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return response.data;
  }

  // Orchestrator — called every time a Smart Collection's schedule runs (manual or cron).
  // items: the CURRENT full set of rule-matched movies, as {name, imdb, tmdb}.
  async publishSmartList(schedule, items, options = {}) {
    const dryRun = !!options.dryRun;
    const creds = this.loadCredentials();
    const publishState = this.loadPublishState();
    const scheduleId = schedule.id;

    if (!publishState[scheduleId]) {
      publishState[scheduleId] = { trakt: { listId: schedule.traktListId || null, listUrl: schedule.traktListUrl || null, pushedKeys: [] }, mdblist: { listId: schedule.mdblistListId || null, listUrl: schedule.mdblistListUrl || null, pushedKeys: [] } };
    }
    const state = publishState[scheduleId];
    if (schedule.traktListId && !state.trakt.listId) state.trakt.listId = schedule.traktListId;
    if (schedule.mdblistListId && !state.mdblist.listId) state.mdblist.listId = schedule.mdblistListId;

    const currentKeys = new Set(items.map(i => i.imdb || String(i.tmdb)));
    const itemsByKey = new Map(items.map(i => [i.imdb || String(i.tmdb), i]));

    const result = { traktListId: null, traktListUrl: null, traktAdded: 0, traktRemoved: 0, mdblistListId: null, mdblistListUrl: null, mdblistAdded: 0, mdblistRemoved: 0, errors: [] };

    // ---- Trakt ----
    if (schedule.publishToTrakt) {
      try {
        // Verify a previously-created list still actually exists. Without this,
        // a deleted list sits forever with an empty diff (everything already in
        // pushedKeys), so we'd never even attempt an API call that could reveal
        // it's gone — silently doing nothing instead of recreating it.
        let traktListId = state.trakt.listId;
        let traktListUrl = state.trakt.listUrl;
        let traktPushedKeys = state.trakt.pushedKeys;

        if (traktListId) {
          const exists = await this.traktListExists(traktListId, creds);
          if (!exists) {
            this.logger.warn(`   Trakt list ${traktListId} no longer exists (deleted externally?) — will recreate`);
            traktListId = null;
            traktListUrl = null;
            traktPushedKeys = [];
          }
        }

        if (!traktListId) {
          if (dryRun) {
            result.traktListId = 'would-create';
          } else {
            const created = await this.createTraktList(schedule.playlistName, schedule.description, creds);
            traktListId = created.ids.trakt;
            traktListUrl = `https://trakt.tv/users/${creds.trakt.username}/lists/${created.ids.slug}`;
            traktPushedKeys = [];
            result.traktListId = traktListId;
            result.traktListUrl = traktListUrl;
            this.logger.info(`   ✓ Created Trakt list "${schedule.playlistName}" (id ${traktListId}) — ${traktListUrl}`);
          }
        } else if (!traktListUrl && !dryRun) {
          // Self-heal: a list created before this fix has an id but no correct URL stored.
          try {
            const headers = {
              'Authorization': 'Bearer ' + creds.trakt.accessToken,
              'trakt-api-version': '2',
              'trakt-api-key': creds.trakt.clientId || ''
            };
            const listInfo = await axios.get(`https://api.trakt.tv/users/me/lists/${traktListId}`, { headers, timeout: 10000 });
            traktListUrl = `https://trakt.tv/users/${creds.trakt.username}/lists/${listInfo.data.ids.slug}`;
            result.traktListUrl = traktListUrl;
            this.logger.info(`   ✓ Recovered Trakt list URL — ${traktListUrl}`);
          } catch (e) {
            this.logger.warn(`   Could not recover Trakt list URL: ${e.message}`);
          }
        } else {
          result.traktListUrl = traktListUrl;
        }

        // Compute the diff even in dry-run-before-creation, when there's no real
        // listId yet — prevKeys is simply empty for a brand new (or recreated) list,
        // so this still gives an accurate "everything would be added" count.
        if (traktListId || dryRun) {
          const prevKeys = new Set(traktPushedKeys);
          const toAdd = items.filter(i => !prevKeys.has(i.imdb || String(i.tmdb)));
          const toRemoveKeys = traktPushedKeys.filter(k => !currentKeys.has(k));

          if (toAdd.length && !dryRun) {
            const addResp = await this.addItemsToTraktList(traktListId, toAdd, creds);
            const notFoundKeys = new Set((addResp.not_found && addResp.not_found.movies || []).map(m =>
              (m.ids && (m.ids.imdb || m.ids.tmdb)) || ''
            ));
            const actuallyAdded = toAdd.filter(i => !notFoundKeys.has(i.imdb || String(i.tmdb)));
            actuallyAdded.forEach(i => traktPushedKeys.push(i.imdb || String(i.tmdb)));
            if (actuallyAdded.length < toAdd.length) {
              this.logger.warn(`   Trakt rejected ${toAdd.length - actuallyAdded.length} item(s) as not_found — will retry next run, not marked as pushed`);
            }
            result.traktAdded = actuallyAdded.length;
          } else {
            result.traktAdded = toAdd.length;
          }

          if (toRemoveKeys.length && !dryRun) {
            const toRemoveItems = toRemoveKeys.map(k => ({ imdb: k.startsWith('tt') ? k : null, tmdb: k.startsWith('tt') ? null : k }));
            await this.removeItemsFromTraktList(traktListId, toRemoveItems, creds);
            // Unlike add, a not_found response here actually confirms the desired end state
            // (the item isn't on the list) just as much as a "removed" response would — so as
            // long as the call itself didn't throw, clearing pushedKeys is correct either way.
            traktPushedKeys = traktPushedKeys.filter(k => !toRemoveKeys.includes(k));
          }
          result.traktRemoved = toRemoveKeys.length;
        }

        // Commit the local working values back onto persisted state — only for real runs
        if (!dryRun) {
          state.trakt.listId = traktListId;
          state.trakt.listUrl = traktListUrl;
          state.trakt.pushedKeys = traktPushedKeys;
        }
      } catch (e) {
        const status = e.response ? e.response.status : '???';
        this.logger.warn(`   Trakt publish failed for "${schedule.playlistName}" [${status}]: ${e.message}`);
        result.errors.push({ service: 'trakt', error: e.message });
      }
    }

    // ---- MDBlists ----
    const mdblistApiKey = schedule.mdblistApiKey || creds.mdblistApiKey;

    if (schedule.publishToMDBlists && mdblistApiKey) {
      try {
        let mdblistListId = state.mdblist.listId;
        let mdblistListUrl = state.mdblist.listUrl;
        let mdblistPushedKeys = state.mdblist.pushedKeys;

        if (mdblistListId) {
          const exists = await this.mdblistExists(mdblistListId, mdblistApiKey);
          if (!exists) {
            this.logger.warn(`   MDBlists list ${mdblistListId} no longer exists (deleted externally?) — will recreate`);
            mdblistListId = null;
            mdblistListUrl = null;
            mdblistPushedKeys = [];
          }
        }

        if (!mdblistListId) {
          if (dryRun) {
            result.mdblistListId = 'would-create';
          } else {
            const created = await this.createMDBList(schedule.playlistName, mdblistApiKey);
            mdblistListId = created.id;
            mdblistListUrl = created.url;
            mdblistPushedKeys = [];
            result.mdblistListId = created.id;
            result.mdblistListUrl = created.url;
            this.logger.info(`   ✓ Created MDBlists list "${schedule.playlistName}" (id ${created.id}, ${created.url})`);
          }
        } else {
          result.mdblistListUrl = mdblistListUrl;
        }

        if (mdblistListId || dryRun) {
          const prevKeys = new Set(mdblistPushedKeys);
          const toAdd = items.filter(i => !prevKeys.has(i.imdb || String(i.tmdb)));
          const toRemoveKeys = mdblistPushedKeys.filter(k => !currentKeys.has(k));

          if (toAdd.length && !dryRun) {
            const addResp = await this.addItemsToMDBList(mdblistListId, toAdd, mdblistApiKey);
            const failedCount = (addResp.not_found && addResp.not_found.movies) || 0;
            if (failedCount > 0) {
              // MDBlists only reports a count, not which items — can't isolate the failure,
              // so mark none as pushed and retry the whole batch next run (safe: re-adding
              // already-successful items is a no-op per MDBlists' own "existing" field)
              this.logger.warn(`   MDBlists reported ${failedCount} not_found of ${toAdd.length} — none marked as pushed, will retry full batch next run`);
              result.mdblistAdded = 0;
            } else {
              toAdd.forEach(i => mdblistPushedKeys.push(i.imdb || String(i.tmdb)));
              result.mdblistAdded = toAdd.length;
            }
          } else {
            result.mdblistAdded = toAdd.length;
          }

          if (toRemoveKeys.length && !dryRun) {
            const toRemoveItems = toRemoveKeys.map(k => ({ imdb: k.startsWith('tt') ? k : null, tmdb: k.startsWith('tt') ? null : k }));
            const removeResp = await this.removeItemsFromMDBList(mdblistListId, toRemoveItems, mdblistApiKey);
            if (removeResp.not_found && removeResp.not_found.movies > 0) {
              this.logger.warn(`   MDBlists remove reported ${removeResp.not_found.movies} not_found — list state may be out of sync, treat with caution`);
            }
            mdblistPushedKeys = mdblistPushedKeys.filter(k => !toRemoveKeys.includes(k));
          }
          result.mdblistRemoved = toRemoveKeys.length;
        }

        // Commit the local working values back onto persisted state — only for real runs
        if (!dryRun) {
          state.mdblist.listId = mdblistListId;
          state.mdblist.listUrl = mdblistListUrl;
          state.mdblist.pushedKeys = mdblistPushedKeys;
        }
      } catch (e) {
        const status = e.response ? e.response.status : '???';
        this.logger.warn(`   MDBlists publish failed for "${schedule.playlistName}" [${status}]: ${e.message}`);
        result.errors.push({ service: 'mdblist', error: e.message });
      }
    }

    if (!dryRun) this.savePublishState(publishState);
    return result;
  }

  // ═════════════════════════════════════════════
  // PER-COLLECTION SYNC
  // ═════════════════════════════════════════════

  async syncCollection(coll, creds, libraryItems, options) {
    const result = {
      id: coll.embyId,
      name: coll.name,
      source: coll.source,
      changed: false,
      idHealed: false,
      skipped: false,
      error: null,
      warnings: [],
      added: [],
      removed: [],
      missingFromLibrary: [],
      addedToEmby: [],
      removedFromEmby: [],
      radarrQueued: [],
      radarrWouldSend: false,
      listGone: false,
      listGoneReason: null
    };

    try {
      // Unliking someone else's list doesn't delete it or empty it — the list keeps
      // existing exactly as before, just off your personal "liked" bookmark collection.
      // So this needs its own check entirely separate from the fetch-then-validate
      // logic below, which can only ever see "the list still has the same content."
      if (coll.source === 'Trakt' && coll.sourceListIsLiked && options.likedListIds) {
        const stillLiked = options.likedListIds.has(String(coll.sourceListId));
        if (!stillLiked) {
          result.listGone = true;
          result.listGoneReason = 'unliked';
          result.error = `No longer in your Trakt liked lists`;
          return result;
        }
      }

      let newTitles;
      try {
        newTitles = await this.fetchLatestTitles(coll, creds);
      } catch (fetchErr) {
        if (fetchErr.status === 404) {
          // The list itself is gone, not just temporarily empty — distinct from a
          // generic fetch failure, since this is something the user may want to
          // act on (delete the now-orphaned Emby collection) rather than just retry.
          result.listGone = true;
          result.listGoneReason = 'deleted';
          result.error = `${coll.source} list no longer exists (404) — it may have been deleted`;
          return result;
        }
        throw fetchErr; // anything else (auth, network, rate limit) stays a generic failure
      }

      if (coll._idHealed) {
        result.idHealed = true;
        delete coll._idHealed;
      }

      if (newTitles === null) {
        result.skipped = true;
        return result;
      }

      // newTitles is [{title, year, imdb, tmdb}, ...] from the fetch functions.
      // Everything below that diffs/stores titles keeps using bare strings exactly
      // as before — the richer data is only kept in a side lookup, used purely for
      // matching further down, and is never written into coll.originalTitles/
      // importedTitles. Changing the stored format itself would make every
      // already-tracked title look simultaneously "removed" and "re-added" on the
      // first sync after this change, which would trigger real deletions against
      // Emby — not worth the risk.
      const itemByTitle = new Map();
      newTitles.forEach(r => {
        if (r && r.title && !itemByTitle.has(r.title)) itemByTitle.set(r.title, r);
      });
      const flatTitles = newTitles.map(r => (r && r.title) || null);

      const uniqueNew = Array.from(new Set(flatTitles.filter(Boolean)));
      const oldTitles = coll.importedTitles || coll.originalTitles || [];

      const validation = this.validateChanges(oldTitles.length, uniqueNew.length);
      result.warnings = validation.warnings;
      if (!validation.safe) {
        result.error = validation.warnings.join('; ');
        if (oldTitles.length > 0 && uniqueNew.length === 0) {
          result.listGone = true;
          result.listGoneReason = 'empty';
        }
        return result;
      }

      const oldSet = new Set(oldTitles);
      const newSet = new Set(uniqueNew);

      // For smart collections, Emby is the source of truth, not the external list
      // So reverse the direction: remove items from external that aren't in Emby
      if (coll._isSmartPublished) {
        result.removed = uniqueNew.filter(t => !oldSet.has(t));  // in external but not Emby - remove
        result.added = oldTitles.filter(t => !newSet.has(t));    // in Emby but not external - add
      } else {
        // For imported collections, external list is source of truth
        result.added = uniqueNew.filter(t => !oldSet.has(t));    // in external but not Emby - add
        result.removed = oldTitles.filter(t => !newSet.has(t));  // in Emby but not external - remove
      }
      result.changed = result.added.length > 0 || result.removed.length > 0;

      // Track changes but don't update Emby collections
      // Just sync matched items to Trakt/MDBlists
      if (!options.dryRun) {
        // For imported collections, track what's currently in the external list
        if (!coll._isSmartPublished) {
          coll.importedTitles = uniqueNew;
          coll.originalTitles = uniqueNew;
        }
        // For smart collections, never modify importedTitles or originalTitles - Emby is truth
        
        coll.itemIds = Object.fromEntries(
          Array.from(itemByTitle.entries()).map(([t, r]) => [t, { imdb: r.imdb || null, tmdb: r.tmdb || null }])
        );
        coll.lastSourceFetch = new Date().toISOString();
      } else {
        // Dry run — check for missing items
        result.missingFromLibrary = uniqueNew.filter(t => {
          const item = itemByTitle.get(t) || { title: t, year: null, imdb: null, tmdb: null };
          return !this.matchItemToLibrary(item, libraryItems);
        });
      }

      // Send everything still missing to Radarr if this collection has it enabled,
      // OR if the global "auto-send all list updates" setting is on
      // (mirrors the existing manual-refresh behaviour — Radarr no-ops on dupes)
      const radarrEnabled = !!coll.radarrAutoSend || !!options.globalRadarr;
      const radarrServerId = (coll.radarrAutoSend && coll.radarrServerId !== undefined && coll.radarrServerId !== null)
        ? coll.radarrServerId
        : options.globalRadarrServerId;
      const radarrServer = creds.radarrServers && creds.radarrServers[radarrServerId];
      result.radarrWouldSend = !!(radarrEnabled && result.missingFromLibrary.length > 0 && radarrServer && radarrServer.url && radarrServer.apiKey);

      if (!options.dryRun && radarrEnabled && result.missingFromLibrary.length > 0 && radarrServer && radarrServer.url && radarrServer.apiKey) {
        for (const title of result.missingFromLibrary) {
          const sent = await this.sendToRadarr(title, radarrServer);
          if (sent.status === 'sent') result.radarrQueued.push(title);
        }
      }

    } catch (e) {
      result.error = e.message;
      this.logger.warn(`List sync: "${coll.name}" failed - ${e.message}`);
    }

    return result;
  }

  // ═════════════════════════════════════════════
  // FULL SYNC (all Trakt/MDBlists collections)
  // ═════════════════════════════════════════════

  async syncAll(options = {}) {
    if (this.isSyncing) {
      return { success: false, error: 'A sync is already running' };
    }
    this.isSyncing = true;

    const startTime = Date.now();
    const dryRun = !!options.dryRun;

    const summary = {
      timestamp: new Date().toISOString(),
      dryRun,
      success: false,
      collectionsChecked: 0,
      collectionsChanged: 0,
      collectionsSkipped: 0,
      collectionsFailed: 0,
      totalAdded: 0,
      totalRemoved: 0,
      totalAddedToEmby: 0,
      totalRemovedFromEmby: 0,
      totalRadarrQueued: 0,
      collections: [],
      errors: [],
      listGone: []
    };

    try {
      const collections = this.loadCollections();
      const creds = this.loadCredentials();
      const config = this.loadConfig();
      
      // Get imported collections (Trakt/MDBlists)
      const importedCollections = collections.filter(c => c.source === 'Trakt' || c.source === 'MDBlists');
      
      // Load schedules for smart collection publishing
      let publishedSchedules = [];
      try {
        const schedulesPath = path.join(this.dataDir, 'schedules.json');
        const smartRegistryPath = path.join(this.dataDir, 'smart-collections.json');
        
        if (fs.existsSync(schedulesPath)) {
          const schedules = JSON.parse(fs.readFileSync(schedulesPath, 'utf8') || '[]');
          const smartRegistry = fs.existsSync(smartRegistryPath) 
            ? JSON.parse(fs.readFileSync(smartRegistryPath, 'utf8') || '[]')
            : [];
          
          publishedSchedules = schedules
            .filter(s => (s.publishToTrakt || s.publishToMDBlists) && s.playlistName)
            .map(s => {
              const smartColl = smartRegistry.find(c => c.name === s.playlistName);
              const currentItems = (smartColl && smartColl.originalTitles) 
                ? smartColl.originalTitles.map(title => ({
                    title,
                    imdb: (smartColl.itemIds && smartColl.itemIds[title] && smartColl.itemIds[title].imdb) || null,
                    tmdb: (smartColl.itemIds && smartColl.itemIds[title] && smartColl.itemIds[title].tmdb) || null
                  }))
                : [];
              return { schedule: s, currentItems };
            });
        }
      } catch (e) {
        this.logger.warn('Could not load schedules for publishing: ' + e.message);
      }

      // Only sync imported collections — published smart collections are handled separately
      const syncable = importedCollections;

      if (syncable.length === 0 && publishedSchedules.length === 0) {
        summary.success = true;
        summary.message = 'No collections to sync or publish';
        return summary;
      }

      this.logger.info(`🔄 [LIST SYNC] Checking ${syncable.length} imported list(s) for updates${dryRun ? ' (dry run)' : ''}...`);

      let libraryItems = [];
      try {
        libraryItems = await this.fetchLibraryItems();
      } catch (e) {
        this.logger.warn('List sync: could not fetch Emby library - ' + e.message);
      }

      // Liked-list membership is checked once per sync, not once per collection —
      // only bother fetching it at all if something actually needs it
      let likedListIds = null;
      const hasLikedListCollection = syncable.some(c => c.source === 'Trakt' && c.sourceListIsLiked);
      if (hasLikedListCollection) {
        try {
          likedListIds = await this.fetchTraktLikedListIds(creds);
        } catch (e) {
          this.logger.warn('List sync: could not verify liked-list membership - ' + e.message);
        }
      }

      if (!dryRun) this.backupCollections();

      let anyIdHealed = false;
      let anyProcessed = false;

      for (const coll of syncable) {
        summary.collectionsChecked++;
        const result = await this.syncCollection(coll, creds, libraryItems, {
          dryRun,
          globalRadarr: !!config.autoRadarr,
          globalRadarrServerId: config.radarrServerId,
          likedListIds
        });

        if (result.idHealed) anyIdHealed = true;

        if (result.skipped) {
          summary.collectionsSkipped++;
          this.logger.info(`   • ${coll.name} (${coll.source}): skipped — not a syncable source`);
          continue;
        }

        if (result.error) {
          summary.collectionsFailed++;
          summary.errors.push({ name: coll.name, error: result.error });
          this.logger.warn(`   • ${coll.name} (${coll.source}): FAILED — ${result.error}`);
          if (result.listGone) {
            summary.listGone.push({ id: coll.embyId, name: coll.name, source: coll.source, reason: result.listGoneReason });
          }
          continue;
        }

        anyProcessed = true;
        this.logger.info(`   • ${coll.name} (${coll.source}): +${result.added.length} / -${result.removed.length}${result.addedToEmby.length ? `, ${result.addedToEmby.length} added to Emby collection` : ''}${result.removedFromEmby.length ? `, ${result.removedFromEmby.length} removed from Emby collection` : ''}${result.missingFromLibrary.length ? `, ${result.missingFromLibrary.length} missing from library` : ''}`);

        if (result.changed) {
          summary.collectionsChanged++;
          summary.totalAdded += result.added.length;
          summary.totalRemoved += result.removed.length;
        }
        summary.totalAddedToEmby += result.addedToEmby.length;
        summary.totalRemovedFromEmby += result.removedFromEmby.length;
        summary.totalRadarrQueued += result.radarrQueued.length;

        if (dryRun || result.changed || result.radarrQueued.length > 0 || result.idHealed) {
          summary.collections.push({
            id: result.id,
            name: result.name,
            source: result.source,
            added: result.added,
            removed: result.removed,
            addedToEmby: result.addedToEmby,
            removedFromEmby: result.removedFromEmby,
            missingFromLibrary: result.missingFromLibrary,
            radarrQueued: result.radarrQueued,
            radarrWouldSend: result.radarrWouldSend,
            idHealed: result.idHealed
          });
        }
      }

      // Always persist after a real (non-dry-run) pass — missingTitles/originalTitles
      // get refreshed on every collection regardless of whether the title-diff
      // itself changed, so the file needs to stay in step every run.
      if (!dryRun && anyProcessed) {
        this.writeJSONAtomic(this.chronoPath, collections);
      }

      // Publish smart collections to Trakt/MDBlists
      if (publishedSchedules.length > 0) {
        this.logger.info(`📤 [SMART PUBLISH] Publishing ${publishedSchedules.length} smart collection(s)...`);
        for (const { schedule, currentItems } of publishedSchedules) {
          try {
            const publishResult = await this.publishSmartList(schedule, currentItems, { dryRun });
            this.logger.info(`   • ${schedule.playlistName}: Trakt=${publishResult.traktAdded}add/${publishResult.traktRemoved}rem, MDBlists=${publishResult.mdblistAdded}add/${publishResult.mdblistRemoved}rem`);
          } catch (e) {
            this.logger.warn(`   • ${schedule.playlistName}: FAILED — ${e.message}`);
            summary.errors.push({ name: schedule.playlistName, error: e.message });
          }
        }
      }

      // Watched-status push (Emby → Trakt/MDBlists) — opt-in, runs as part of the same cycle
      if (config.watchedSyncEnabled) {
        try {
          const watchedResult = await this.syncWatchedStatus({ dryRun });
          summary.watchedSync = {
            traktPushed: watchedResult.traktPushed,
            mdblistPushed: watchedResult.mdblistPushed,
            skippedNoId: watchedResult.skippedNoId,
            errors: watchedResult.errors
          };
        } catch (e) {
          this.logger.warn('Watched sync step failed: ' + e.message);
          summary.watchedSync = { error: e.message };
        }
      }

      if (summary.collectionsChanged > 0 || summary.totalAddedToEmby > 0 || summary.totalRemovedFromEmby > 0) {
        this.logger.info(`✅ [LIST SYNC] ${summary.collectionsChanged} list(s) updated — +${summary.totalAdded} / -${summary.totalRemoved}${summary.totalAddedToEmby ? `, ${summary.totalAddedToEmby} added to Emby` : ''}${summary.totalRemovedFromEmby ? `, ${summary.totalRemovedFromEmby} removed from Emby` : ''}${summary.totalRadarrQueued ? `, ${summary.totalRadarrQueued} sent to Radarr` : ''}`);
      } else {
        this.logger.info(`✅ [LIST SYNC] Complete — no changes detected`);
      }

      summary.durationMs = Date.now() - startTime;
      summary.success = true;

      if (!dryRun) {
        this.appendAudit(summary);
        const config = this.loadConfig();
        config.lastSync = summary.timestamp;
        config.nextSync = config.enabled
          ? new Date(Date.now() + config.intervalHours * 60 * 60 * 1000).toISOString()
          : null;
        this.writeJSONAtomic(this.configPath, config);
      }

      return summary;

    } catch (error) {
      this.logger.error('List sync failed', error);
      summary.error = error.message;
      return summary;
    } finally {
      this.isSyncing = false;
    }
  }

  // ═════════════════════════════════════════════
  // SCHEDULING (simple interval timer, no cron needed)
  // ═════════════════════════════════════════════

  start() {
    const config = this.loadConfig();
    if (config.enabled) {
      this.scheduleNext(config.intervalHours);
      this.logger.info(`List sync scheduler started (every ${config.intervalHours}h)`);
    }
  }

  scheduleNext(intervalHours) {
    if (this.timer) clearTimeout(this.timer);
    const ms = Math.max(1, intervalHours) * 60 * 60 * 1000;
    this.timer = setTimeout(async () => {
      await this.syncAll({ dryRun: false });
      const config = this.loadConfig();
      if (config.enabled) this.scheduleNext(config.intervalHours);
    }, ms);
  }

  restart() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.start();
  }

  // ═════════════════════════════════════════════
  // STATUS
  // ═════════════════════════════════════════════

  getStatus() {
    const config = this.loadConfig();
    const audit = this.loadAudit();
    return {
      ...config,
      isSyncing: this.isSyncing,
      lastResult: audit.syncs[0] || null,
      history: audit.syncs.slice(0, 10)
    };
  }
}

module.exports = ListSyncService;
