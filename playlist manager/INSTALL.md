# Emby Playlist Manager — Install

## Prerequisites
- Node.js 14+ installed
- Emby server running and accessible

## 1. Get the Files

**Option A: Download ZIP**
- Download `emby-playlist-manager-backup.zip` from the repo
- Decompress into your desired folder
- Name the folder `emby-playlist-manager`

**Option B: Clone with Git**
```bash
git clone <your-repo-url>
cd emby-playlist-manager
```

## 2. Open Terminal/Command Prompt

**Windows:**
- Open the `emby-playlist-manager` folder
- Right-click in empty space → "Open PowerShell window here" (or "Open in Terminal")

**macOS/Linux:**
- Open the `emby-playlist-manager` folder
- Right-click → "New Terminal at Folder" (or use Finder → Services)
- Or: `cd /path/to/emby-playlist-manager`

## 3. Install Dependencies

In the terminal, run:
```bash
npm install
```

## 4. Configure .env File

Open `example.env` in a text editor:

**macOS users:** 
- Right-click `example.env` → Open With → TextEdit
- Format menu → "Make Plain Text"
- Save As... → change filename to `.env` (remove `example`)

**Windows/Linux:**
- Right-click `example.env` → Open With → Notepad (or VS Code)
- Save As... → change filename to `.env`

Edit the file and enter your credentials:

### Required:
```
EMBY_URL=http://192.168.1.xxx:8096
EMBY_TOKEN=your-emby-api-key
EMBY_USER_ID=your-emby-user-id
TMDB_API_KEY=your-tmdb-api-key
```

## 5. Get Your API Keys

### Emby API Key
1. Go to your Emby server: `http://192.168.1.xxx:8096`
2. Settings → API Keys
3. Click **Create** → copy the key
4. Paste into `EMBY_TOKEN` in .env

### TMDB API Key
1. Go to https://www.themoviedb.org/settings/api
2. Create an API key (free tier OK)
3. Copy and paste into `TMDB_API_KEY` in .env

### Trakt App (Optional, for Trakt sync)
1. Go to https://trakt.tv/oauth/applications
2. Click **Create Application**
3. Name: "Emby Playlist Manager"
4. Redirect URI: `http://localhost:5001`
5. Save → you'll connect via Settings UI in the app (no key needed in .env)

### MDBlists API Key (Optional, for MDBlists sync)
1. Go to https://mdblist.com/
2. Login or create account
3. Settings → API Key
4. You'll enter this in Settings UI in the app (no key needed in .env)

## 6. Start the Server

In the terminal, run:

**macOS/Linux:**
```bash
chmod +x start-playlist-manager.sh
./start-playlist-manager.sh
```
Browser opens automatically at `http://localhost:5001`

**Windows or Manual:**
```bash
node server.js
```
Then open browser: `http://localhost:5001`

## 7. First Run

1. Go to **Settings** tab
2. Click **"Change Emby Server"**
3. Verify URL, token, userId are correct
4. Click **"Test Connection"** → should say "Connected"
5. Save

## Done ✓

You can now:
- Browse collections in **Collections** tab
- Create smart rules in **Smart Sync** tab
- Import from Trakt/MDBlists in **Import** tab (connect via Settings first)
- Set up Franchise ordering in **Franchise** tab

## Troubleshooting

**"Cannot find HTML file"** → Make sure `emby-playlist-manager.html` is in the root directory

**"Emby connection fails"** → Verify Emby is running and token is correct in .env

**"Port 5001 already in use"** → Kill existing process: `pkill -f "node server.js"`

**"npm install fails"** → Ensure Node 14+ installed: `node --version`

**".env file not found"** → Make sure you renamed `example.env` to `.env` (not `example.env`)

---

See `QUICK_REFERENCE.md` for full API docs and features.
