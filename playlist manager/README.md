# Emby Playlist Manager

Powerful web app for managing Emby collections with smart rules, Trakt/MDBlists sync, and chronological ordering.

![Node.js](https://img.shields.io/badge/Node.js-14%2B-green)
![License](https://img.shields.io/badge/License-MIT-blue)
![Status](https://img.shields.io/badge/Status-Production%20Ready-brightgreen)

---

## Features

✨ **Smart Collections** — Create rule-based playlists with AND/OR logic (genre, year, rating, actors, etc.)

🔄 **Bi-Directional Sync** — Keep Emby collections in sync with Trakt and MDBlists automatically

📺 **Chronological Ordering** — Build franchise timelines from TMDB or upload custom order

📊 **Analytics Dashboard** — View collection stats, genre breakdown, watched status, duplicate detection

🎬 **Watched Status Sync** — Push watched items from Emby to Trakt/MDBlists in real-time

⏰ **Scheduled Automation** — Cron-based rules to keep collections fresh, auto-add missing to Radarr

🖼️ **Artwork Management** — Cache posters from fanart.tv, TMDB, and Emby

---

## Quick Start

### Prerequisites
- **Node.js 14+** — [Download](https://nodejs.org/)
- **Emby Server** — Running and accessible

### Install (5 minutes)

See **[INSTALL.md](./INSTALL.md)** for detailed setup:

```bash
# 1. Download ZIP or clone repo
git clone <this-repo>
cd emby-playlist-manager

# 2. Install dependencies
npm install

# 3. Configure
cp example.env .env
# Edit .env with your Emby server details

# 4. Start
./start-playlist-manager.sh
# Opens http://localhost:5001
```

---

## Usage

### Collections Tab
Browse all Emby collections, search, sort, and quick-open in Emby. Color-coded by source (Trakt, MDBlists, Smart, etc.)

### Smart Sync Tab
1. Create rule with conditions (genre, year, rating, etc.)
2. Test rule to see matches
3. Create collection or schedule daily/weekly refresh
4. Optional: Auto-publish to Trakt/MDBlists

### Import Tab
1. Connect Trakt/MDBlists (via Settings)
2. Browse your lists
3. Preview matches in Emby library
4. Create collection (imports as BoxSet)
5. Auto-sync on interval to catch new items

### Franchise Tab
1. Select Emby playlist
2. Choose franchise name (built-in TMDB or upload CSV)
3. Refresh to reorder chronologically
4. Fine-tune with drag-and-drop
5. Save back to Emby

### Analytics Tab
- Collection statistics (total, sizes, empty, duplicates)
- Genre breakdown (pie chart)
- Release year trends (bar chart)
- Cleanup report with clickable items

### Settings Tab
- Connect/test Emby server
- Connect Trakt (OAuth)
- Connect MDBlists (API key)
- Add Radarr servers (auto-add missing)
- Enable/disable features
- Backup/restore

---

## API Endpoints

50+ REST API endpoints for:
- Collection management (CRUD)
- Rule evaluation & scheduling
- Trakt/MDBlists sync
- Watched status tracking
- Image caching
- Radarr integration



---

## Architecture

### Frontend
- **Single-file HTML/JS app** (3,969 lines)
- No framework dependencies (vanilla JS)
- All state in `localStorage`
- Communicates via `/api/*` endpoints

### Backend
- **Express.js server** on port 5001 (2,605 lines)
- Modular service architecture:
  - `emby-client.js` — Emby API wrapper
  - `list-sync-service.js` — Trakt/MDBlists sync engine
  - `image-service.js` — Artwork caching
  - `rules-engine.js` — Rule evaluation (AND/OR logic)
  - `scheduler.js` — Cron job management
  - `logger.js` — Logging
  - Plus: email, MDBlists, image services

### Data Storage
- `data/smart-collections.json` — Smart collection registry
- `data/schedules.json` — Cron schedules
- `data/chrono-collections.json` — Imported collections metadata
- `data/images/` — Cached artwork (safe to delete)

---

## Configuration

### Required (.env)
```
EMBY_URL=http://192.168.1.90:8096
EMBY_TOKEN=your-api-key
EMBY_USER_ID=your-user-id
TMDB_API_KEY=your-tmdb-key
```

### Optional
- `TRAKT_CLIENT_ID` / `TRAKT_CLIENT_SECRET` — Configured via Settings UI instead
- `MDBLIST_API_KEY` — Configured via Settings UI instead

### Getting API Keys
- **Emby:** Server → Settings → API Keys → Create
- **TMDB:** https://www.themoviedb.org/settings/api
- **Trakt:** https://trakt.tv/oauth/applications → Create App
- **MDBlists:** https://mdblist.com/ → Settings → API Key

---


---

## Troubleshooting

**Port 5001 already in use?**
```bash
pkill -f "node server.js"
```

**Emby connection fails?**
- Verify Emby is running
- Check URL in Settings
- Generate new API key in Emby

**Npm install errors?**
```bash
node --version  # Should be 14+
npm cache clean --force
rm -rf node_modules package-lock.json
npm install
```

**Collections not showing?**
- Refresh browser (Ctrl+Shift+R)
- Check browser console for errors
- Verify Emby has collections/playlists

See **[INSTALL.md](./INSTALL.md)** for more troubleshooting.

---

## Development

### Project Structure
- **11,919 lines of code** across 10 files
- **No external UI framework** (vanilla JS)
- **Modular services** for easy maintenance
- **Production-ready** codebase

### Stack
- **Frontend:** Vanilla JavaScript, HTML, CSS
- **Backend:** Node.js + Express.js
- **Database:** JSON files (no database required)
- **APIs:** Emby, Trakt, MDBlists, TMDB, fanart.tv

### Adding Features
1. Backend: Add route in `server.js`, service in `services/`
2. Frontend: Add UI in `emby-playlist-manager.html`, call via `/api/*`
3. Test with `npm run dev` (requires nodemon)

---

## What's NOT Included

- ❌ `node_modules/` — Run `npm install` to get dependencies
- ❌ `.env` — Copy `example.env` to `.env` and fill in your secrets
- ❌ `data/` folder — Created automatically on first run
- ❌ `logs/` — Generated at runtime, safe to ignore
- ❌ Gmail notifications — Not currently implemented

---



## License

MIT — Use freely in personal and commercial projects.

---

## Support

- **Installation stuck?** → See [INSTALL.md](./INSTALL.md)
- **API questions?** → See [QUICK_REFERENCE.md](./QUICK_REFERENCE.md)
- **Architecture deep-dive?** → See [PROJECT_BACKUP_MANIFEST.md](./PROJECT_BACKUP_MANIFEST.md)
- **Issues/bugs?** → Open a GitHub issue

---

## Credits

Built for Emby media server enthusiasts who want powerful collection automation and sync without leaving the browser.

---
