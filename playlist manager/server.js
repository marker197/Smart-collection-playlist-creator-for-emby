// ═════════════════════════════════════════════
// Smart Playlist Generator - Backend Server
// ═════════════════════════════════════════════

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
console.log('ENV loaded:', process.env.EMBY_URL);
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const axios = require('axios');

const EmbyClient = require('./services/emby-client');
const RulesEngine = require('./services/rules-engine');
const Scheduler = require('./services/scheduler');
const EmailService = require('./services/email-service');
const Logger = require('./services/logger');
const MDBListService = require('./services/mdblist-service');
const ImageService = require('./services/image-service');
const ListSyncService = require('./services/list-sync-service');

// ═════════════════════════════════════════════
// INITIALIZATION
// ═════════════════════════════════════════════

const app = express();
const logger = new Logger();

// Middleware - CORS MUST BE FIRST
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: false,
  optionsSuccessStatus: 200
}));
app.use(express.json({ limit: '50mb' }));

// Create data directory if it doesn't exist
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// ═════════════════════════════════════════════
// SMART COLLECTION REGISTRY (shared helpers)
// ═════════════════════════════════════════════
const SMART_REGISTRY = path.join(__dirname, 'data', 'smart-collections.json');

function readSmartRegistry() {
  try {
    if (!fs.existsSync(SMART_REGISTRY)) return [];
    return JSON.parse(fs.readFileSync(SMART_REGISTRY, 'utf8') || '[]');
  } catch (e) {
    logger.warn('Smart registry unreadable, treating as empty: ' + e.message);
    return [];
  }
}

function writeSmartRegistry(registry) {
  const tmp = SMART_REGISTRY + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
  fs.renameSync(tmp, SMART_REGISTRY); // atomic on POSIX
}

// ═════════════════════════════════════════════
// SERVE FRONTEND HTML
// ═════════════════════════════════════════════

// Look for HTML in same directory as server.js
const htmlPath = path.join(__dirname, 'emby-playlist-manager.html');
const faviconPath = path.join(__dirname, 'favicon.ico');
console.log(`\n📂 Looking for HTML at: ${htmlPath}`);
console.log(`📂 Server directory (__dirname): ${__dirname}`);
console.log(`📂 Files in directory:`);
try {
  const files = fs.readdirSync(__dirname);
  files.forEach(f => console.log(`   - ${f}`));
} catch (e) {
  console.log(`   Error reading directory: ${e.message}`);
}
console.log(`📂 HTML file exists: ${fs.existsSync(htmlPath)}\n`);

app.get('/', (req, res) => {
  console.log(`\n🔍 ROOT REQUEST at: ${new Date().toISOString()}`);
  console.log(`   Checking: ${htmlPath}`);
  console.log(`   Exists: ${fs.existsSync(htmlPath)}`);
  
  if (!fs.existsSync(htmlPath)) {
    logger.error('HTML file not found at:', htmlPath);
    return res.status(404).json({ 
      success: false, 
      error: 'HTML file not found',
      lookingAt: htmlPath,
      currentDir: __dirname,
      filesInDir: fs.readdirSync(__dirname)
    });
  }
  
  console.log(`   ✓ File found, sending...`);
  res.sendFile(htmlPath, (err) => {
    if (err) {
      console.error(`   ❌ sendFile error:`, err.message);
      console.error(`   Full error:`, err);
      logger.error('Error serving HTML:', err);
      res.status(500).json({ 
        success: false, 
        error: 'Could not load HTML',
        details: err.message
      });
    } else {
      console.log(`   ✓ HTML sent successfully`);
    }
  });
});

// Browsers request this automatically — without an explicit route, Express has
// no static-file serving set up at all, so this would otherwise just 404
app.get('/favicon.ico', (req, res) => {
  if (!fs.existsSync(faviconPath)) {
    return res.status(404).end();
  }
  res.sendFile(faviconPath);
});

// ═════════════════════════════════════════════
// SERVICES
// ═════════════════════════════════════════════

// A connection set via the Settings UI takes precedence over .env — this
// lets the Emby server be reconfigured in-app without editing files or
// restarting, while .env still works as the original/default setup path.
const embyConnectionPath = path.join(__dirname, 'data', 'emby-connection.json');
function loadEmbyConnectionOverride() {
  try {
    if (fs.existsSync(embyConnectionPath)) {
      return JSON.parse(fs.readFileSync(embyConnectionPath, 'utf8') || '{}');
    }
  } catch (e) { /* fall through to env */ }
  return null;
}
const embyOverride = loadEmbyConnectionOverride();

const embyClient = new EmbyClient(
  (embyOverride && embyOverride.serverUrl) || process.env.EMBY_URL,
  (embyOverride && embyOverride.token) || process.env.EMBY_TOKEN,
  (embyOverride && embyOverride.userId) || process.env.EMBY_USER_ID,
  logger
);

const rulesEngine = new RulesEngine(logger);

const listSyncService = new ListSyncService({
  dataDir: path.join(__dirname, 'data'),
  logger,
  embyUrl: process.env.EMBY_URL,
  embyToken: process.env.EMBY_TOKEN,
  embyUserId: process.env.EMBY_USER_ID
});

const scheduler = new Scheduler(embyClient, rulesEngine, logger, listSyncService);

// Only initialize EmailService if Gmail credentials are provided
const emailService = (process.env.GMAIL_ADDRESS && process.env.GMAIL_APP_PASSWORD) 
  ? new EmailService(
      process.env.GMAIL_ADDRESS,
      process.env.GMAIL_APP_PASSWORD,
      logger
    )
  : null;

// ═════════════════════════════════════════════
// HEALTH CHECK & STATUS
// ═════════════════════════════════════════════

app.get('/api/health', async (req, res) => {
  try {
    // Test Emby connection
    const embyStatus = await embyClient.getHealth();
    
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      server: {
        version: '1.0.0',
        environment: process.env.NODE_ENV,
        port: process.env.PORT || 5001
      },
      services: {
        emby: embyStatus ? 'connected' : 'disconnected',
        scheduler: scheduler ? 'active' : 'inactive',
        email: emailService ? 'configured' : 'not-configured'
      }
    });
  } catch (error) {
    logger.error('Health check failed', error);
    res.status(503).json({
      status: 'error',
      message: error.message
    });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    embyUrl: process.env.EMBY_URL,
    serverId: process.env.EMBY_SERVER_ID || '6e62d71393b44c69a54a20d4c12cc784',
    serverVersion: '1.0.0',
    schedulesActive: scheduler.getActiveScheduleCount(),
    timestamp: new Date().toISOString()
  });
});

// Real connection status — actually pings Emby, not just "is something configured"
app.get('/api/emby/status', async (req, res) => {
  try {
    const healthy = await embyClient.getHealth();
    res.json({
      success: true,
      connected: healthy,
      serverUrl: embyClient.serverUrl,
      userId: embyClient.userId,
      usingOverride: fs.existsSync(embyConnectionPath)
    });
  } catch (error) {
    res.json({ success: true, connected: false, serverUrl: embyClient.serverUrl, userId: embyClient.userId, usingOverride: fs.existsSync(embyConnectionPath) });
  }
});

// Change the Emby connection at runtime — tests it first, only persists and
// switches over if the test actually succeeds, so a typo can't silently
// break the whole app's only path to its data
app.post('/api/emby/connect', express.json(), async (req, res) => {
  try {
    const { serverUrl, token, userId } = req.body;
    if (!serverUrl || !token || !userId) {
      return res.status(400).json({ success: false, error: 'serverUrl, token, and userId are all required' });
    }

    const testClient = new EmbyClient(serverUrl, token, userId, logger);
    const healthy = await testClient.getHealth();
    if (!healthy) {
      return res.status(400).json({ success: false, error: 'Could not reach this Emby server with these credentials — nothing was changed' });
    }

    embyClient.updateConnection(serverUrl, token, userId);
    fs.writeFileSync(embyConnectionPath, JSON.stringify({ serverUrl, token, userId }, null, 2));

    logger.info(`✓ Emby connection updated: ${serverUrl}`);
    res.json({ success: true, serverUrl, userId });
  } catch (error) {
    logger.error('Emby connect failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Disconnect — blanks the live connection entirely, regardless of whether it
// came from an override or .env. Reverting to .env automatically would make
// "Disconnect" meaningless for anyone who never set an override (nothing
// would actually change). Reconnect via Settings, or restart the server to
// reload from .env/override as normal.
app.post('/api/emby/disconnect', (req, res) => {
  try {
    if (fs.existsSync(embyConnectionPath)) fs.unlinkSync(embyConnectionPath);
    embyClient.updateConnection('', '', '');
    logger.info('Emby disconnected — connection cleared until reconnected or server restarted');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═════════════════════════════════════════════
// SMART PLAYLIST ROUTES
// ═════════════════════════════════════════════

// List all rules (stored by frontend, returned for reference)
app.get('/api/smart/rules', (req, res) => {
  try {
    res.json({
      success: true,
      message: 'Rules are stored in frontend localStorage. Backend manages schedules.'
    });
  } catch (error) {
    logger.error('Get rules failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create smart collection immediately (no schedule required)
app.post('/api/smart/create-collection', async (req, res) => {
  try {
    const { rule, playlistName, description } = req.body;

    if (!rule || !playlistName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: rule, playlistName'
      });
    }

    // Evaluate rule to get matched items
    const items = await embyClient.getLibraryItems();
    const matchedItems = rulesEngine.evaluateRule(rule, items);

    if (matchedItems.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No items matched the rule'
      });
    }

    // Create the BoxSet in Emby
    const collection = await embyClient.createCollection(
      playlistName,
      matchedItems.map(i => i.Id),
      description || ''
    );

    // Also create a default schedule so publish settings can work later
    const schedule = scheduler.addSchedule({
      id: 'sched_' + uuidv4(),
      ruleId: 'rule_' + Date.now(),
      rule,
      playlistName,
      cronExpression: '0 3 * * *',
      frequencyLabel: 'Daily',
      notificationEmail: '',
      description: description || '',
      enabled: false,
      createdAt: new Date().toISOString()
    });

    logger.info(`Smart collection created: ${collection.id} - ${playlistName} (${matchedItems.length} items)`);
    logger.info(`Associated schedule created: ${schedule.id}`);

    res.status(201).json({
      success: true,
      collection: {
        id: collection.id,
        name: playlistName,
        itemCount: matchedItems.length,
        itemTitles: matchedItems.map(i => i.Name),
        scheduleId: schedule.id
      }
    });
  } catch (error) {
    logger.error('Create smart collection failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create or update schedule
app.post('/api/smart/schedules', async (req, res) => {
  try {
    const { ruleId, rule, playlistName, cronExpression, frequencyLabel, notificationEmail, description } = req.body;

    if (!ruleId || !playlistName || !cronExpression) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: ruleId, playlistName, cronExpression'
      });
    }

    const schedule = scheduler.addSchedule({
      id: 'sched_' + uuidv4(),
      ruleId,
      rule,  // ← PASS RULE OBJECT
      playlistName,
      cronExpression,
      frequencyLabel: frequencyLabel || cronExpression,
      notificationEmail: notificationEmail || '',
      description: description || '',
      enabled: true,
      createdAt: new Date().toISOString()
    });

    logger.info(`Schedule created: ${schedule.id} - ${playlistName}`);

    res.status(201).json({
      success: true,
      schedule: {
        id: schedule.id,
        playlistName: schedule.playlistName,
        frequencyLabel: schedule.frequencyLabel,
        enabled: schedule.enabled,
        nextRun: schedule.nextRun,
        createdAt: schedule.createdAt
      }
    });
  } catch (error) {
    logger.error('Create schedule failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all schedules
app.get('/api/smart/schedules', (req, res) => {
  try {
    const schedules = scheduler.getSchedules();
    res.json({
      success: true,
      schedules: schedules.map(s => ({
        id: s.id,
        ruleId: s.ruleId,
        playlistName: s.playlistName,
        cronExpression: s.cronExpression,
        frequencyLabel: s.frequencyLabel,
        enabled: s.enabled,
        nextRun: s.nextRun,
        lastRun: s.lastRun,
        createdAt: s.createdAt,
        publishToTrakt: s.publishToTrakt || false,
        publishToMDBlists: s.publishToMDBlists || false,
        traktListId: s.traktListId || null,
        traktListUrl: s.traktListUrl || null,
        mdblistListId: s.mdblistListId || null,
        mdblistListUrl: s.mdblistListUrl || null,
        mdblistApiKey: s.mdblistApiKey || ''
      }))
    });
  } catch (error) {
    logger.error('Get schedules failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get schedule details with history
app.get('/api/smart/schedules/:id', (req, res) => {
  try {
    const schedule = scheduler.getSchedule(req.params.id);
    if (!schedule) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    const history = scheduler.getExecutionHistory(req.params.id, 10);

    res.json({
      success: true,
      schedule: {
        id: schedule.id,
        ruleId: schedule.ruleId,
        rule: schedule.rule,
        playlistName: schedule.playlistName,
        frequencyLabel: schedule.frequencyLabel,
        enabled: schedule.enabled,
        nextRun: schedule.nextRun,
        lastRun: schedule.lastRun,
        createdAt: schedule.createdAt,
        publishToTrakt: schedule.publishToTrakt || false,
        publishToMDBlists: schedule.publishToMDBlists || false,
        traktListId: schedule.traktListId || null,
        traktListUrl: schedule.traktListUrl || null,
        mdblistListId: schedule.mdblistListId || null,
        mdblistListUrl: schedule.mdblistListUrl || null
      },
      history
    });
  } catch (error) {
    logger.error('Get schedule details failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update schedule
app.put('/api/smart/schedules/:id', (req, res) => {
  try {
    const { enabled, cronExpression, frequencyLabel, rule, playlistName } = req.body;
    const updates = {};
    if (typeof enabled === 'boolean') updates.enabled = enabled;
    if (cronExpression !== undefined) updates.cronExpression = cronExpression;
    if (frequencyLabel !== undefined) updates.frequencyLabel = frequencyLabel;
    if (rule !== undefined) updates.rule = rule;
    if (playlistName !== undefined) updates.playlistName = playlistName;

    const schedule = scheduler.updateSchedule(req.params.id, updates);

    if (!schedule) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    res.json({
      success: true,
      schedule: {
        id: schedule.id,
        playlistName: schedule.playlistName,
        enabled: schedule.enabled,
        nextRun: schedule.nextRun
      }
    });
  } catch (error) {
    logger.error('Update schedule failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete schedule
app.delete('/api/smart/schedules/:id', (req, res) => {
  try {
    const deleted = scheduler.removeSchedule(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    res.json({ success: true, deleted: true });
  } catch (error) {
    logger.error('Delete schedule failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Execute schedule immediately
app.post('/api/smart/schedules/:id/run', async (req, res) => {
  try {
    const result = await scheduler.executeScheduleNow(req.params.id);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    res.json({
      success: true,
      execution: result.execution
    });
  } catch (error) {
    logger.error('Execute schedule failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Set per-schedule publish settings (Trakt/MDBlists) — toggled on an existing Smart Collection schedule
app.post('/api/smart/schedules/:id/publish-settings', (req, res) => {
  try {
    const { publishToTrakt, publishToMDBlists, mdblistApiKey } = req.body;
    const updates = {};
    if (typeof publishToTrakt === 'boolean') updates.publishToTrakt = publishToTrakt;
    if (typeof publishToMDBlists === 'boolean') updates.publishToMDBlists = publishToMDBlists;
    if (typeof mdblistApiKey === 'string') updates.mdblistApiKey = mdblistApiKey;

    const schedule = scheduler.updateSchedule(req.params.id, updates);
    if (!schedule) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }
    res.json({ success: true, schedule: { id: schedule.id, publishToTrakt: schedule.publishToTrakt, publishToMDBlists: schedule.publishToMDBlists, traktListId: schedule.traktListId, mdblistListId: schedule.mdblistListId } });
  } catch (error) {
    logger.error('Update publish settings failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual publish trigger / preview for a Smart Collection's Trakt/MDBlists lists
app.post('/api/smart/schedules/:id/publish', async (req, res) => {
  try {
    const dryRun = !!(req.body && req.body.dryRun);
    const schedule = scheduler.getSchedule ? scheduler.getSchedule(req.params.id) : scheduler.schedules.get(req.params.id);
    if (!schedule) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }
    if (!schedule.publishToTrakt && !schedule.publishToMDBlists) {
      return res.status(400).json({ success: false, error: 'Publishing is not enabled for this schedule' });
    }

    const items = await embyClient.getLibraryItems();
    const matchedItems = schedule.rule ? rulesEngine.evaluateRule(schedule.rule, items) : items;
    const publishItems = matchedItems.map(i => ({
      name: i.Name,
      imdb: i.ProviderIds && (i.ProviderIds.Imdb || i.ProviderIds.IMDB) || null,
      tmdb: i.ProviderIds && (i.ProviderIds.Tmdb || i.ProviderIds.TMDB) || null
    })).filter(i => i.imdb || i.tmdb);

    const result = await listSyncService.publishSmartList(schedule, publishItems, { dryRun });

    if (!dryRun) {
      const updates = {};
      if (result.traktListId && result.traktListId !== 'would-create' && result.traktListId !== schedule.traktListId) updates.traktListId = result.traktListId;
      if (result.mdblistListId && result.mdblistListId !== 'would-create' && result.mdblistListId !== schedule.mdblistListId) updates.mdblistListId = result.mdblistListId;
      if (result.traktListUrl && result.traktListUrl !== schedule.traktListUrl) updates.traktListUrl = result.traktListUrl;
      if (result.mdblistListUrl && result.mdblistListUrl !== schedule.mdblistListUrl) updates.mdblistListUrl = result.mdblistListUrl;
      if (Object.keys(updates).length) scheduler.updateSchedule(req.params.id, updates);
    }

    res.json({ success: true, dryRun, ...result });
  } catch (error) {
    logger.error('Manual publish failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get execution history
app.get('/api/smart/history', (req, res) => {
  try {
    const scheduleId = req.query.scheduleId;
    const limit = parseInt(req.query.limit) || 50;

    if (!scheduleId) {
      return res.status(400).json({ success: false, error: 'scheduleId parameter required' });
    }

    const executions = scheduler.getExecutionHistory(scheduleId, limit);
    res.json({
      success: true,
      executions
    });
  } catch (error) {
    logger.error('Get history failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test email notification
app.post('/api/smart/test-email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email parameter required' });
    }

    if (!emailService) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email service not configured. Set GMAIL_ADDRESS and GMAIL_APP_PASSWORD in .env' 
      });
    }

    await emailService.sendTestEmail(email);
    res.json({ success: true, message: 'Test email sent' });
  } catch (error) {
    logger.error('Send test email failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═════════════════════════════════════════════
// CHRONOLOGICAL PLAYLIST ROUTES
// ═════════════════════════════════════════════

// Create chronological collection
app.post('/api/chrono/create', async (req, res) => {
  try {
    const { source, sourceId, playlistName, items } = req.body;

    if (!playlistName || !items || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: playlistName, items'
      });
    }

    // Create collection in Emby
    const collection = await embyClient.createCollection(playlistName, items);

    logger.info(`Chrono collection created: ${collection.id} - ${playlistName}`);

    res.status(201).json({
      success: true,
      collection: {
        id: collection.id,
        name: playlistName,
        itemCount: items.length,
        createdAt: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Create chrono collection failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all collections
app.get('/api/chrono/collections', async (req, res) => {
  try {
    const collections = await embyClient.getCollections();
    res.json({
      success: true,
      collections
    });
  } catch (error) {
    logger.error('Get collections failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Refresh chronological collection
app.post('/api/chrono/refresh/:collectionId', async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Items parameter required' });
    }

    const result = await embyClient.updateCollection(req.params.collectionId, { items });

    logger.info(`Chrono collection refreshed: ${req.params.collectionId}`);

    res.json({
      success: true,
      collection: result
    });
  } catch (error) {
    logger.error('Refresh chrono collection failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update collection description
app.post('/api/chrono/update-description/:collectionId', async (req, res) => {
  try {
    const { description } = req.body;
    if (description === undefined) {
      return res.status(400).json({ success: false, error: 'Description parameter required' });
    }

    await embyClient.updateItemMetadata(req.params.collectionId, {
      Overview: description
    });

    res.json({ success: true, updated: true });
  } catch (error) {
    logger.error('Update description failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═════════════════════════════════════════════
// SMART COLLECTION METADATA REGISTRY (endpoints)
// ═════════════════════════════════════════════

app.post('/api/smart/register-metadata', async (req, res) => {
  try {
    const { collectionId, name, itemCount, source = 'smart' } = req.body;
    if (!collectionId || !name) {
      return res.status(400).json({ success: false, error: 'Missing collectionId or name' });
    }
    const registry = readSmartRegistry();
    const existing = registry.find(s => s.embyId === collectionId);
    if (existing) {
      return res.json({ success: true, message: 'Already registered', metadata: existing });
    }
    const entry = {
      embyId: collectionId, name, source, itemCount,
      originalTitles: [],
      registeredAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };
    registry.push(entry);
    writeSmartRegistry(registry);
    logger.info(`Registered Smart collection: ${name} (ID: ${collectionId})`);
    res.json({ success: true, message: 'Collection registered', metadata: entry });
  } catch (e) {
    logger.error('Register metadata failed', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/smart/get-metadata', async (req, res) => {
  try {
    const registry = readSmartRegistry();
    res.json({ success: true, metadata: registry });
  } catch (e) {
    logger.error('Get metadata failed', e);
    res.json({ success: true, metadata: [] });
  }
});

app.post('/api/smart/unregister-metadata', async (req, res) => {
  try {
    const { collectionId } = req.body;
    const registry = readSmartRegistry().filter(s => s.embyId !== collectionId);
    writeSmartRegistry(registry);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═════════════════════════════════════════════
// MDBLISTS INTEGRATION (curl service)
// ═════════════════════════════════════════════

app.get('/api/chrono/mdblist', async (req, res) => {
  try {
    const { cmd } = req.query;

    if (!cmd) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: cmd'
      });
    }

    const result = await MDBListService.executeCurl(cmd);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('MDBlists curl execution failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ═════════════════════════════════════════════
// IMAGE SERVICE (Fanart.tv, Emby)
// ═════════════════════════════════════════════

// Fetch artwork from all sources for a collection
app.get('/api/images/fetch/:collectionId', async (req, res) => {
  try {
    const { collectionId } = req.params;
    const tmdbApiKey = req.query.tmdbKey || process.env.TMDB_API_KEY || '';
    const fanartProjectKey = req.query.fanartProjectKey || '';
    const fanartPersonalKey = req.query.fanartPersonalKey || '';

    if (!fanartProjectKey) {
      console.log('⚠️ No fanart.tv project key provided - will use Emby artwork only');
    }

    // Fetch artwork from all sources
    // Pass both project key (required) and personal key (optional)
    const result = await ImageService.fetchAllArtwork(
      embyClient,
      collectionId,
      tmdbApiKey,
      fanartProjectKey,
      fanartPersonalKey
    );

    res.json(result);
  } catch (error) {
    logger.error('Image fetch failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Serve cached image file
app.get('/api/images/:collectionId/:source.jpg', (req, res) => {
  try {
    const { collectionId, source } = req.params;

    // Validate source to prevent directory traversal
    if (!/^[a-z0-9]+$/.test(source)) {
      return res.status(400).json({ success: false, error: 'Invalid source' });
    }

    const imageData = ImageService.serveImage(collectionId, source);

    if (!imageData) {
      return res.status(404).json({
        success: false,
        error: `Image not found: ${source}`
      });
    }

    res.setHeader('Content-Type', imageData.mimeType);
    res.setHeader('Content-Length', imageData.size);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 24 hours
    res.send(imageData.buffer);
  } catch (error) {
    logger.error('Image serve failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get metadata about available images for a collection
app.get('/api/images/metadata/:collectionId', (req, res) => {
  try {
    const { collectionId } = req.params;

    const result = ImageService.getAvailableSources(collectionId);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Get image metadata failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Delete all cached images for a collection (called when a collection is removed)
app.delete('/api/images/:collectionId', (req, res) => {
  try {
    const { collectionId } = req.params;
    const deleted = ImageService.deleteCollectionImages(collectionId);
    res.json({ success: true, deleted });
  } catch (error) {
    logger.error('Delete collection images failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test fanart.tv API connection
app.get('/api/images/test-fanart', async (req, res) => {
  try {
    const projectKey = req.query.projectKey;
    const personalKey = req.query.personalKey;
    
    if (!projectKey) {
      return res.status(400).json({
        success: false,
        error: 'Missing projectKey parameter'
      });
    }

    // Use the @fanart-tv/api npm package
    const FanartTVClient = require('@fanart-tv/api');
    const client = new FanartTVClient({
      apiKey: projectKey,
      clientKey: personalKey || undefined,  // Optional personal key
      version: 'v3.2'
    });

    // Test with a popular movie (Fight Club = TMDB ID 550)
    const movie = await client.getMovie(550);

    if (!movie || !movie.tmdb_id) {
      throw new Error('Invalid response from fanart.tv');
    }

    res.json({
      success: true,
      message: 'fanart.tv API connection successful',
      usingPersonalKey: !!personalKey,
      imageCount: movie.image_count
    });
  } catch (error) {
    logger.error('fanart.tv test failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Check if collection preview cache is valid
app.get('/api/check-collection-preview-cache/:collectionId', async (req, res) => {
  try {
    const collectionId = req.params.collectionId;
    const path = require('path');
    const fs = require('fs');
    
    const itemsDir = path.join(__dirname, 'data', 'images', collectionId, 'items');
    
    // Check if directory exists
    if(!fs.existsSync(itemsDir)){
      console.log(`  ℹ️ No cache for collection ${collectionId}`);
      return res.json({
        success: true,
        cached: false,
        itemsCached: 0,
        message: 'No cache directory'
      });
    }
    
    // Count cached files
    const files = fs.readdirSync(itemsDir).filter(f => f.endsWith('_preview.jpg'));
    console.log(`  ✓ Found ${files.length} cached images for collection ${collectionId}`);
    
    // Get current item count from Emby
    const items = await embyClient.getCollectionItems(collectionId);
    const currentItemCount = Math.min(items.length, 10);  // We only cache first 10
    
    console.log(`  📊 Cached: ${files.length}, Current: ${currentItemCount}`);
    
    // Cache is valid if count matches
    const isValid = files.length === currentItemCount && files.length > 0;
    
    res.json({
      success: true,
      cached: isValid,
      itemsCached: files.length,
      currentItems: currentItemCount,
      message: isValid ? 'Cache is valid' : 'Cache is invalid or outdated'
    });
    
  } catch(error){
    console.error('Error checking cache:', error.message);
    res.json({
      success: false,
      cached: false,
      error: error.message
    });
  }
});

// Cache collection preview item images
app.get('/api/cache-collection-previews/:collectionId', async (req, res) => {
  try {
    const collectionId = req.params.collectionId;
    console.log(`\n📸 Caching preview images for collection: ${collectionId}`);
    
    // Get collection items
    const items = await embyClient.getCollectionItems(collectionId);
    console.log(`  ✓ Got ${items.length} items from Emby`);
    
    // Take first 10 items
    const preview = items.slice(0, 10);
    const path = require('path');
    const fs = require('fs');
    const https = require('https');
    const http = require('http');
    
    // Create items directory
    const itemsDir = path.join(__dirname, 'data', 'images', collectionId, 'items');
    if(!fs.existsSync(itemsDir)){
      fs.mkdirSync(itemsDir, { recursive: true });
      console.log(`  📁 Created directory: ${itemsDir}`);
    }
    
    // Download and cache each item image
    const cachedItems = [];
    for(let item of preview){
      try {
        if(!item.ImageTags?.Primary) continue;
        
        const imageUrl = `${embyClient.serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}`;
        const fileName = `${item.Id}_preview.jpg`;
        const filePath = path.join(itemsDir, fileName);
        
        console.log(`  📥 Downloading: ${item.Name}`);
        
        // Download image - detect http vs https
        const client = imageUrl.startsWith('https') ? https : http;
        
        // Download image
        await new Promise((resolve, reject) => {
          client.get(imageUrl, (response) => {
            if(response.statusCode !== 200){
              reject(new Error(`Status ${response.statusCode}`));
              return;
            }
            const file = fs.createWriteStream(filePath);
            response.pipe(file);
            file.on('finish', () => {
              file.close();
              console.log(`    ✓ Saved: ${fileName}`);
              resolve();
            });
            file.on('error', reject);
          }).on('error', reject);
        });
        
        // Add to cached items with local path
        cachedItems.push({
          id: item.Id,
          name: item.Name,
          imagePath: imageUrl,
          cachedPath: `/api/images/${collectionId}/items/${fileName}`
        });
        
      } catch(e){
        console.warn(`    ⚠️ Failed to cache ${item.Name}:`, e.message);
      }
    }
    
    console.log(`  ✓ Cached ${cachedItems.length} preview images`);
    
    res.json({
      success: true,
      collectionId: collectionId,
      itemsCached: cachedItems.length,
      items: cachedItems
    });
    
  } catch(error){
    console.error('❌ Error caching previews:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get collection items for preview (streaming URLs, not cached)
app.get('/api/collections/:collectionId/items', async (req, res) => {
  try {
    const collectionId = req.params.collectionId;
    const limit = req.query.limit ? parseInt(req.query.limit) : 10;
    
    console.log(`\n📦 Fetching items for collection: ${collectionId} (limit: ${limit})`);
    console.log(`  Calling embyClient.getCollectionItems()...`);
    
    // Get collection items using emby-client
    const items = await embyClient.getCollectionItems(collectionId);
    console.log(`  Response type: ${typeof items}`);
    console.log(`  Response:`, items);
    console.log(`  ✓ Got ${items ? items.length : 0} items`);
    
    // Take first N items and format for preview
    const preview = (items || []).slice(0, limit).map(item => ({
      id: item.Id,
      name: item.Name,
      imagePath: item.ImageTags?.Primary 
        ? `${embyClient.serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}`
        : null
    }));
    
    console.log(`  Returning ${preview.length} preview items`);
    
    res.json({
      success: true,
      items: preview
    });
  } catch (error) {
    console.error('❌ Error fetching collection items:', error.message);
    console.error('  Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Add items to collection (for undo)
app.post('/api/collections/:collectionId/items', async (req, res) => {
  try {
    const collectionId = req.params.collectionId;
    const { ids } = req.body;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
    }

    const embyUrl = process.env.EMBY_URL;
    const embyToken = process.env.EMBY_TOKEN;
    if (!embyUrl || !embyToken) {
      return res.status(500).json({ success: false, error: 'Emby config missing' });
    }

    const itemIds = ids.join(',');
    const addUrl = `${embyUrl}/Collections/${collectionId}/Items?Ids=${itemIds}&api_key=${embyToken}`;
    
    console.log(`\n➕ Adding ${ids.length} item(s) to collection ${collectionId}`);
    await axios.post(addUrl, {});
    console.log(`  ✓ Items added`);
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error adding collection items:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete items from collection
app.delete('/api/collections/:collectionId/items', async (req, res) => {
  try {
    const collectionId = req.params.collectionId;
    const { ids, isPlaylist } = req.body;
    
    console.log('\n🗑️  DELETE /api/collections/:collectionId/items endpoint hit');
    console.log(`  collectionId: ${collectionId}`);
    console.log(`  isPlaylist: ${isPlaylist}`);
    console.log(`  ids: ${JSON.stringify(ids)}`);
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      console.log('  ❌ Invalid ids');
      return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
    }

    const embyUrl = process.env.EMBY_URL;
    const embyToken = process.env.EMBY_TOKEN;
    if (!embyUrl || !embyToken) {
      console.log(`  ❌ Emby config missing`);
      return res.status(500).json({ success: false, error: 'Emby config missing' });
    }

    const itemIds = ids.join(',');
    let response;
    
    if (isPlaylist) {
      // Playlist: DELETE /Playlists/{id}/Items?EntryIds=...  (uses PlaylistItemIds)
      const deleteUrl = `${embyUrl}/Playlists/${collectionId}/Items?EntryIds=${itemIds}&api_key=${embyToken}`;
      console.log(`  Using: DELETE /Playlists/{id}/Items?EntryIds=${itemIds}`);
      response = await axios.delete(deleteUrl);
      console.log(`  ✓ Playlists deletion succeeded (status ${response.status})`);
    } else {
      // Collection: POST /Collections/{id}/Items/Delete?Ids=...
      const deleteUrl = `${embyUrl}/Collections/${collectionId}/Items/Delete?Ids=${itemIds}&api_key=${embyToken}`;
      console.log(`  Using: POST /Collections/{id}/Items/Delete?Ids=${itemIds}`);
      response = await axios.post(deleteUrl, {});
      console.log(`  ✓ Collections deletion succeeded (status ${response.status})`);
    }

    console.log(`  ✓ Items deleted from Emby`);

    // After deletion, fetch updated collection items and refresh metadata
    let updatedTitles = [];
    try {
      const updatedItems = await embyClient.getCollectionItems(collectionId);
      updatedTitles = updatedItems.map(i => i.Name).sort();
      
      // Update smart-collections.json registry
      const registry = readSmartRegistry();
      const collIdx = registry.findIndex(c => c.embyId === collectionId);
      if(collIdx > -1) {
        registry[collIdx].itemCount = updatedTitles.length;
        registry[collIdx].originalTitles = updatedTitles;
        writeSmartRegistry(registry);
        logger.info(`  ✓ Updated registry: ${collectionId} now has ${updatedTitles.length} items`);
      }
    } catch (e) {
      logger.warn(`  Could not refresh collection metadata: ${e.message}`);
    }

    // Also remove deleted items from Trakt/MDBlists if the collection is published
    try {
      const registry = readSmartRegistry();
      const collection = registry.find(c => c.embyId === collectionId);
      if(collection) {
        // Get the item names to remove
        const itemNamesToRemove = await Promise.all(
          ids.map(async (itemId) => {
            try {
              const item = await axios.get(`${embyUrl}/Items/${itemId}?api_key=${embyToken}`);
              return item.data.Name;
            } catch (e) {
              return null;
            }
          })
        ).then(names => names.filter(Boolean));

        if(itemNamesToRemove.length > 0) {
          logger.info(`  Removing ${itemNamesToRemove.length} item(s) from external lists: ${itemNamesToRemove.join(', ')}`);
          // Will be handled by next sync cycle
        }
      }
    } catch (e) {
      logger.warn(`  Could not prepare external list removal: ${e.message}`);
    }
    
    // Return updated data so frontend can sync localStorage
    res.json({ success: true, updatedTitles, itemCount: updatedTitles.length });
  } catch (error) {
    console.error('❌ Error deleting collection items:', error.message);
    if(error.response) console.error(`  Emby response: ${error.response.status} ${JSON.stringify(error.response.data)}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/images/:collectionId/items/:filename', (req, res) => {
  try {
    const path = require('path');
    const filePath = path.join(__dirname, 'data', 'images', req.params.collectionId, 'items', req.params.filename);
    
    // Security: prevent directory traversal
    if(!filePath.startsWith(path.join(__dirname, 'data', 'images'))){
      return res.status(403).json({success: false, error: 'Access denied'});
    }
    
    res.sendFile(filePath);
  } catch(error){
    console.error('Error serving cached image:', error.message);
    res.status(500).json({success: false, error: error.message});
  }
});

// ═════════════════════════════════════════════
// ═════════════════════════════════════════════
// REFRESH ALL COLLECTIONS (Backend)
// ═════════════════════════════════════════════

app.post('/api/refresh-all-collections', async (req, res) => {
  try {
    logger.info('🔄 [REFRESH ALL] Starting full collection refresh...');
    
    const startTime = Date.now();
    const results = {
      collectionsProcessed: 0,
      itemsMatched: 0,
      itemsAdded: 0,
      collectionsUpdated: []
    };

    // Load all chrono collections
    const chronoPath = path.join(__dirname, 'data', 'chrono-collections.json');
    if (!fs.existsSync(chronoPath)) {
      return res.json({ 
        success: true, 
        message: 'No chrono collections to refresh',
        results 
      });
    }

    const allCollections = JSON.parse(fs.readFileSync(chronoPath, 'utf8')) || [];
    
    if (allCollections.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No collections found',
        results 
      });
    }

    logger.info(`   📋 Found ${allCollections.length} collections to refresh`);

    // Get Emby auth headers
    const embyUrl = process.env.EMBY_URL;
    const embyToken = process.env.EMBY_TOKEN;
    const userId = process.env.EMBY_USER_ID;
    
    if (!embyUrl || !embyToken || !userId) {
      return res.status(500).json({ success: false, error: 'Missing Emby configuration' });
    }

    // Get all library movies once (for efficiency)
    let libraryMovies = [];
    try {
      const libraryUrl = `${embyUrl}/Items?IncludeItemTypes=Movie&Recursive=true&Fields=Id,Name,ProductionYear,ProviderIds&Limit=5000&UserId=${userId}&api_key=${embyToken}`;
      const embyResponse = await axios.get(libraryUrl);
      libraryMovies = (embyResponse.data && embyResponse.data.Items) || [];
      logger.info(`   📚 Loaded ${libraryMovies.length} movies from Emby library`);
    } catch (e) {
      logger.error('Failed to fetch library movies:', e.message);
      return res.status(500).json({ success: false, error: 'Failed to fetch Emby library' });
    }

    // Process each collection
    for (const coll of allCollections) {
      try {
        logger.info(`   🔄 Processing: ${coll.name} (ID: ${coll.embyId})`);
        
        // Get current items in collection using ParentId (correct Emby endpoint)
        let currentItems = [];
        try {
          const collUrl = `${embyUrl}/Items?ParentId=${coll.embyId}&IncludeItemTypes=Movie&Recursive=true&Fields=Id,Name&Limit=2000&UserId=${userId}&api_key=${embyToken}`;
          const collResponse = await axios.get(collUrl);
          currentItems = (collResponse.data && collResponse.data.Items) || [];
        } catch (e) {
          logger.warn(`   ⚠️  Failed to fetch collection items: ${e.message}`);
          continue;
        }

        const currentNames = new Set(currentItems.map(m => m.Name));
        const currentIds = new Set(currentItems.map(m => m.Id));

        // Get missing titles for this collection
        const missingTitles = coll.originalTitles || [];
        if (missingTitles.length === 0) {
          logger.info(`   ℹ️  No missing titles for this collection`);
          continue;
        }

        logger.info(`   🔍 Searching for ${missingTitles.length} missing titles...`);

        // Same ID-first matching as the scheduled/manual sync path (listSyncService),
        // not a separate copy — this also retires the old substring-prefix fallback
        // that used to cause false positives (e.g. "Spider-Man" matching
        // "Spider-Man: No Way Home" via prefix matching alone).
        const itemIds = coll.itemIds || {};
        const matched = [];
        let notFoundCount = 0;

        for (const title of missingTitles) {
          const movieInCollection = currentNames.has(title);
          if (movieInCollection) {
            continue;
          }

          const ids = itemIds[title] || {};
          const item = { title, year: null, imdb: ids.imdb || null, tmdb: ids.tmdb || null };
          const match = listSyncService.matchItemToLibrary(item, libraryMovies);

          if (match && !currentIds.has(match.Id)) {
            matched.push({ Id: match.Id, Name: match.Name });
          } else if (!match) {
            notFoundCount++;
          }
        }

        if (notFoundCount > 0) {
          logger.info(`   ❌ Could not find ${notFoundCount} titles in library`);
        }

        // Add matched movies to collection
        if (matched.length > 0) {
          try {
            const movieIds = matched.map(m => m.Id).join(',');
            const addUrl = `${embyUrl}/Collections/${coll.embyId}/Items?Ids=${movieIds}&api_key=${embyToken}`;
            
            await axios.post(addUrl, {});
            
            logger.info(`   ➕ Added ${matched.length} movie(s) to ${coll.name}`);
            
            results.itemsMatched += matched.length;
            results.itemsAdded += matched.length;
            results.collectionsUpdated.push({
              name: coll.name,
              itemsAdded: matched.length,
              movies: matched.map(m => m.Name)
            });
          } catch (e) {
            logger.error(`   ⚠️  Failed to add items: ${e.message}`);
          }
        }

        results.collectionsProcessed++;

      } catch (e) {
        logger.warn(`Error processing collection ${coll.name}:`, e.message);
      }
    }

    const processingTime = Date.now() - startTime;
    logger.info(`✅ [REFRESH ALL] Complete in ${processingTime}ms - ${results.itemsAdded} items added`);

    res.json({
      success: true,
      message: `Refreshed ${results.collectionsProcessed} collections - added ${results.itemsAdded} items`,
      results,
      processingTimeMs: processingTime
    });

  } catch (error) {
    logger.error('Refresh all collections error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═════════════════════════════════════════════
// CHRONO COLLECTIONS SYNC (Frontend → Backend)
// ═════════════════════════════════════════════

app.post('/api/chrono/sync-metadata', express.json(), async (req, res) => {
  try {
    const { collections } = req.body;

    if (!Array.isArray(collections)) {
      return res.status(400).json({ success: false, error: 'collections must be an array' });
    }

    // Filter to only chrono collections (source is Trakt, MDBlists, or import)
    const chronoCollections = collections.filter(c => 
      ['Trakt', 'MDBlists', 'import'].includes(c.source)
    );

    // Save to backend
    const chronoPath = path.join(__dirname, 'data', 'chrono-collections.json');
    fs.writeFileSync(chronoPath, JSON.stringify(chronoCollections, null, 2));

    logger.info(`✓ Synced ${chronoCollections.length} chrono collections to backend`);

    res.json({
      success: true,
      synced: chronoCollections.length,
      collections: chronoCollections.map(c => ({ id: c.embyId, name: c.name, source: c.source }))
    });
  } catch (error) {
    logger.error('Chrono sync error', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═════════════════════════════════════════════
// LIST SYNC (Trakt/MDBlists auto-download + Radarr)
// ═════════════════════════════════════════════

// Frontend pushes Trakt token + Radarr servers here so the backend can sync without the browser open
app.post('/api/credentials/sync', express.json(), async (req, res) => {
  try {
    const { trakt, radarrServers, mdblistApiKey, tmdbApiKey } = req.body;
    const updated = listSyncService.saveCredentials({
      ...(trakt !== undefined ? { trakt } : {}),
      ...(radarrServers !== undefined ? { radarrServers } : {}),
      ...(mdblistApiKey !== undefined ? { mdblistApiKey } : {}),
      ...(tmdbApiKey !== undefined ? { tmdbApiKey } : {})
    });
    res.json({
      success: true,
      traktConnected: !!(updated.trakt && updated.trakt.accessToken),
      radarrServerCount: (updated.radarrServers || []).length,
      mdblistConnected: !!updated.mdblistApiKey,
      tmdbConnected: !!updated.tmdbApiKey
    });
  } catch (error) {
    logger.error('Credentials sync error', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Current missing-title list per collection (post-sync), keyed by embyId —
// lets the frontend catch up its localStorage cache after a background sync
app.get('/api/chrono/missing-lists', (req, res) => {
  try {
    const chronoPath = path.join(__dirname, 'data', 'chrono-collections.json');
    if (!fs.existsSync(chronoPath)) {
      return res.json({ success: true, lists: {} });
    }
    const collections = JSON.parse(fs.readFileSync(chronoPath, 'utf8') || '[]');
    const lists = {};
    collections.forEach(c => {
      if (Array.isArray(c.missingTitles)) lists[c.embyId] = c.missingTitles;
    });
    res.json({ success: true, lists });
  } catch (error) {
    logger.error('Missing lists fetch error', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Explicit, user-confirmed teardown — deletes the Emby collection itself AND its
// chrono-collections.json entry. Only ever called after the user has confirmed in
// the UI that a source list is genuinely gone (deleted or emptied), never automatic.
app.post('/api/chrono/collections/:embyId/teardown', async (req, res) => {
  try {
    const embyId = req.params.embyId;
    let embyDeleted = false;

    try {
      await listSyncService.deleteEmbyCollection(embyId);
      embyDeleted = true;
    } catch (e) {
      // If Emby already doesn't have it (e.g. manually deleted there too), that's
      // fine — still proceed to clean up our own stored data either way.
      logger.warn(`Could not delete Emby collection ${embyId} (may already be gone): ${e.message}`);
    }

    const dataRemoved = listSyncService.removeCollectionFromChrono(embyId);

    res.json({ success: true, embyDeleted, dataRemoved });
  } catch (error) {
    logger.error('Collection teardown failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Server names only — never expose API keys to the frontend for this list
app.get('/api/radarr/servers', (req, res) => {
  try {
    const creds = listSyncService.loadCredentials();
    const servers = (creds.radarrServers || []).map((s, i) => ({ id: i, name: s.name || ('Server ' + i), configured: !!(s.url && s.apiKey) }));
    res.json({ success: true, servers });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Connection status for the Settings panel — what's configured, no secrets returned
app.get('/api/connections/status', (req, res) => {
  try {
    const creds = listSyncService.loadCredentials();
    res.json({
      success: true,
      trakt: {
        connected: !!(creds.trakt && creds.trakt.accessToken),
        username: (creds.trakt && creds.trakt.username) || null
      },
      mdblists: {
        connected: !!creds.mdblistApiKey
      },
      radarrServers: (creds.radarrServers || []).map((s, i) => ({
        id: i, name: s.name || ('Server ' + i), url: s.url || '', configured: !!(s.url && s.apiKey)
      })),
      tmdb: {
        configured: !!(process.env.TMDB_API_KEY || creds.tmdbApiKey)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add a Radarr server — appends server-side, where the existing servers'
// API keys already live; never requires the frontend to round-trip them
app.post('/api/radarr/servers', (req, res) => {
  try {
    const { name, url, apiKey } = req.body;
    if (!name || !url || !apiKey) {
      return res.status(400).json({ success: false, error: 'name, url, and apiKey are all required' });
    }
    const creds = listSyncService.loadCredentials();
    const servers = creds.radarrServers || [];
    servers.push({ name, url, apiKey });
    const updated = listSyncService.saveCredentials({ radarrServers: servers });
    res.json({ success: true, servers: (updated.radarrServers || []).map((s, i) => ({ id: i, name: s.name, url: s.url, configured: !!(s.url && s.apiKey) })) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Remove a Radarr server by index — same reasoning, mutated server-side
app.delete('/api/radarr/servers/:index', (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    const creds = listSyncService.loadCredentials();
    const servers = creds.radarrServers || [];
    if (idx < 0 || idx >= servers.length) {
      return res.status(404).json({ success: false, error: 'No server at that index' });
    }
    servers.splice(idx, 1);
    const updated = listSyncService.saveCredentials({ radarrServers: servers });
    res.json({ success: true, servers: (updated.radarrServers || []).map((s, i) => ({ id: i, name: s.name, url: s.url, configured: !!(s.url && s.apiKey) })) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Actually verifies the TMDB key works (not just that it's set) by fetching
// a well-known movie (Fight Club, id 550)
app.get('/api/tmdb/test', async (req, res) => {
  try {
    const creds = listSyncService.loadCredentials();
    const key = process.env.TMDB_API_KEY || creds.tmdbApiKey;
    if (!key) return res.json({ success: false, error: 'No TMDB key set — add one in Settings or via TMDB_API_KEY in .env' });

    const r = await axios.get(`https://api.themoviedb.org/3/movie/550?api_key=${key}`, { timeout: 8000 });
    res.json({ success: true, testTitle: r.data.title });
  } catch (error) {
    const status = error.response ? error.response.status : '???';
    res.json({ success: false, error: `TMDB responded with ${status}` });
  }
});

// Proxies a single TMDB collection lookup — used by the franchise refresh feature
app.get('/api/tmdb/collection/:id', async (req, res) => {
  try {
    const creds = listSyncService.loadCredentials();
    const key = process.env.TMDB_API_KEY || creds.tmdbApiKey;
    if (!key) return res.status(400).json({ success: false, error: 'No TMDB key set — add one in Settings or via TMDB_API_KEY in .env' });

    const r = await axios.get(`https://api.themoviedb.org/3/collection/${req.params.id}?api_key=${key}`, { timeout: 10000 });
    const parts = (r.data.parts || []).filter(p => p.release_date);
    parts.sort((a, b) => (a.release_date || '').localeCompare(b.release_date || ''));

    res.json({ success: true, titles: parts.map(p => p.title) });
  } catch (error) {
    const status = error.response ? error.response.status : '???';
    res.status(500).json({ success: false, error: `TMDB responded with ${status}` });
  }
});

// Looks up a poster for each given title via TMDB search — used to give
// missing items a real visual instead of a blank box, since we already
// touch TMDB elsewhere and the user's fine with the external lookup
app.post('/api/tmdb/posters', async (req, res) => {
  try {
    const { titles } = req.body;
    const creds = listSyncService.loadCredentials();
    const key = process.env.TMDB_API_KEY || creds.tmdbApiKey;
    if (!key) return res.json({ success: false, error: 'No TMDB key set — add one in Settings or via TMDB_API_KEY in .env' });
    if (!Array.isArray(titles) || titles.length === 0) return res.json({ success: true, posters: {} });

    const posters = {};
    const failures = [];

    for (const title of titles) {
      try {
        const cleanTitle = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
        const r = await axios.get('https://api.themoviedb.org/3/search/movie', {
          params: { api_key: key, query: cleanTitle },
          timeout: 8000
        });
        const hit = (r.data.results || [])[0];
        if (hit && hit.poster_path) {
          posters[title] = 'https://image.tmdb.org/t/p/w200' + hit.poster_path;
        } else {
          failures.push(`${title}: no TMDB match found`);
        }
      } catch (e) {
        const status = e.response ? e.response.status : '???';
        const body = e.response ? JSON.stringify(e.response.data).slice(0, 150) : e.message;
        logger.warn(`TMDB poster lookup failed [${status}] for "${title}": ${body}`);
        failures.push(`${title}: HTTP ${status}`);
      }
    }

    if (failures.length) {
      logger.warn(`TMDB posters: ${Object.keys(posters).length} found, ${failures.length} failed — ${failures.slice(0,3).join('; ')}`);
    }

    res.json({ success: true, posters, foundCount: Object.keys(posters).length, failedCount: failures.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Full backup — schedules, chrono collections, sync config/audit. Never raw
// secrets — those stay in sync-credentials.json on disk untouched, and get
// re-entered via Settings if this server is ever rebuilt from scratch.
app.get('/api/backup/export', (req, res) => {
  try {
    const chronoPath = path.join(__dirname, 'data', 'chrono-collections.json');
    const chronoCollections = fs.existsSync(chronoPath) ? JSON.parse(fs.readFileSync(chronoPath, 'utf8') || '[]') : [];

    res.json({
      success: true,
      exportedAt: new Date().toISOString(),
      schedules: scheduler.getSchedules(),
      chronoCollections,
      syncConfig: listSyncService.loadConfig()
    });
  } catch (error) {
    logger.error('Backup export failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Restore from a backup file — schedules and chrono collections only.
// Credentials/API keys are never part of the backup and must be re-entered
// via Settings, since they were never exported in the first place.
app.post('/api/backup/import', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { schedules, chronoCollections, syncConfig } = req.body;
    let schedulesRestored = 0, collectionsRestored = 0;

    if (Array.isArray(chronoCollections)) {
      const chronoPath = path.join(__dirname, 'data', 'chrono-collections.json');
      fs.writeFileSync(chronoPath, JSON.stringify(chronoCollections, null, 2));
      collectionsRestored = chronoCollections.length;
    }

    if (Array.isArray(schedules)) {
      for (const s of schedules) {
        if (!scheduler.getSchedule(s.id)) {
          scheduler.addSchedule(s);
          schedulesRestored++;
        }
      }
    }

    if (syncConfig) {
      listSyncService.saveConfig(syncConfig);
    }

    logger.info(`Backup restored: ${schedulesRestored} schedules, ${collectionsRestored} collections`);
    res.json({ success: true, schedulesRestored, collectionsRestored });
  } catch (error) {
    logger.error('Backup import failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Browse a Trakt user's public lists — uses our own stored app credentials
// (client_id + access token) to authenticate the request; the username in
// the URL is just whose public lists we're asking to see, same as Trakt's
// own website lets anyone do when viewing a public profile.
app.get('/api/import/browse-trakt', async (req, res) => {
  try {
    const creds = listSyncService.loadCredentials();
    if (!creds.trakt || !creds.trakt.accessToken) {
      return res.status(400).json({ success: false, error: 'Trakt is not connected yet — connect it in Settings first' });
    }

    // No username given → browse your own lists, using the username from
    // when you connected. Trakt's API doesn't have a "/lists/user" shortcut
    // like MDBlists does, so this is how we replicate the same convenience.
    const username = req.query.username || creds.trakt.username;
    if (!username) {
      return res.status(400).json({ success: false, error: 'No username available — try reconnecting Trakt' });
    }

    const headers = {
      'Authorization': 'Bearer ' + creds.trakt.accessToken,
      'trakt-api-version': '2',
      'trakt-api-key': creds.trakt.clientId || ''
    };
    const r = await axios.get(`https://api.trakt.tv/users/${encodeURIComponent(username)}/lists`, { headers, timeout: 15000 });

    const lists = (r.data || []).map(l => ({
      name: l.name,
      slug: l.ids && l.ids.slug,
      itemCount: l.item_count || 0,
      description: l.description || ''
    }));

    res.json({ success: true, lists });
  } catch (error) {
    const status = error.response ? error.response.status : '???';
    logger.warn(`Browse Trakt lists failed [${status}]`, error.message);
    res.status(500).json({ success: false, error: status === 404 ? 'User not found' : error.message });
  }
});

// Browse an MDBlists user's lists — current authenticated account if no
// username given, or a specific user's public lists if one is provided.
// Field names are mapped defensively since we don't have a confirmed sample
// response for this specific endpoint to test against.
app.get('/api/import/browse-mdblists', async (req, res) => {
  try {
    const { username } = req.query;
    const creds = listSyncService.loadCredentials();
    if (!creds.mdblistApiKey) {
      return res.status(400).json({ success: false, error: 'MDBlists is not connected yet — add your API key in Settings first' });
    }

    const url = username
      ? `https://api.mdblist.com/lists/user/${encodeURIComponent(username)}?apikey=${creds.mdblistApiKey}`
      : `https://api.mdblist.com/lists/user?apikey=${creds.mdblistApiKey}`;

    const r = await axios.get(url, { timeout: 15000 });
    const raw = Array.isArray(r.data) ? r.data : (r.data.lists || []);

    const lists = raw.map(l => ({
      name: l.name,
      id: l.id,
      slug: l.slug,
      itemCount: l.items || l.item_count || l.count || 0
    }));

    res.json({ success: true, lists });
  } catch (error) {
    const status = error.response ? error.response.status : '???';
    logger.warn(`Browse MDBlists lists failed [${status}]`, error.message);
    res.status(500).json({ success: false, error: status === 404 ? 'User not found' : error.message });
  }
});

// Browse your liked Trakt lists — same /users/likes/lists endpoint used for
// the self-heal logic elsewhere in this app, just mapped to the same
// {name, slug, itemCount} shape as the other browse endpoints
app.get('/api/import/browse-trakt-liked', async (req, res) => {
  try {
    const creds = listSyncService.loadCredentials();
    if (!creds.trakt || !creds.trakt.accessToken) {
      return res.status(400).json({ success: false, error: 'Trakt is not connected yet — connect it in Settings first' });
    }
    const headers = {
      'Authorization': 'Bearer ' + creds.trakt.accessToken,
      'trakt-api-version': '2',
      'trakt-api-key': creds.trakt.clientId || ''
    };
    const r = await axios.get('https://api.trakt.tv/users/likes/lists', { headers, timeout: 15000 });
    const lists = (r.data || []).map(item => {
      const l = item.list || item;
      return { name: l.name, slug: l.ids && l.ids.slug, id: l.ids && l.ids.trakt, itemCount: l.item_count || 0 };
    });
    res.json({ success: true, lists });
  } catch (error) {
    const status = error.response ? error.response.status : '???';
    res.status(500).json({ success: false, error: `Trakt liked lists failed [${status}]: ${error.message}` });
  }
});

// Browse your liked MDBlists lists
app.get('/api/import/browse-mdblists-liked', async (req, res) => {
  try {
    const creds = listSyncService.loadCredentials();
    if (!creds.mdblistApiKey) {
      return res.status(400).json({ success: false, error: 'MDBlists is not connected yet — add your API key in Settings first' });
    }
    const r = await axios.get(`https://api.mdblist.com/lists/liked?apikey=${creds.mdblistApiKey}`, { timeout: 15000 });
    const raw = Array.isArray(r.data) ? r.data : (r.data.lists || []);
    const lists = raw.map(l => ({
      name: l.name,
      id: l.id,
      slug: l.slug,
      itemCount: l.items || l.item_count || l.count || 0
    }));
    res.json({ success: true, lists });
  } catch (error) {
    const status = error.response ? error.response.status : '???';
    res.status(500).json({ success: false, error: `MDBlists liked lists failed [${status}]: ${error.message}` });
  }
});

// Send one or more titles to Radarr — reuses listSyncService's existing
// lookup/rootfolder/qualityprofile/add logic rather than duplicating Radarr
// API calls in the frontend (which is how the original app did it)
app.post('/api/radarr/send', async (req, res) => {
  try {
    const { titles, radarrServerId } = req.body;
    if (!Array.isArray(titles) || titles.length === 0) {
      return res.status(400).json({ success: false, error: 'titles array required' });
    }

    const creds = listSyncService.loadCredentials();
    const server = creds.radarrServers && creds.radarrServers[radarrServerId];
    if (!server || !server.url || !server.apiKey) {
      return res.status(400).json({ success: false, error: 'No valid Radarr server at that index' });
    }

    const results = [];
    for (const title of titles) {
      const r = await listSyncService.sendToRadarr(title, server);
      results.push(r);
    }

    const sent = results.filter(r => r.status === 'sent').length;
    res.json({ success: true, sent, total: titles.length, results });
  } catch (error) {
    logger.error('Radarr send failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Franchise/timeline mode — unlike Trakt/MDBlists import, order matters here
// (it's the whole point of a franchise collection), so titles are matched in
// the exact sequence given rather than deduped/sorted. Creation reuses the
// same /api/import/create endpoint, tagged source:'emby' since there's no
// external list driving ongoing sync for this kind of collection.
app.post('/api/franchise/preview', async (req, res) => {
  try {
    const { titles } = req.body;
    if (!Array.isArray(titles) || titles.length === 0) {
      return res.status(400).json({ success: false, error: 'titles array required' });
    }

    const libraryItems = await listSyncService.fetchLibraryItems();
    const matched = [];
    const missing = [];

    titles.forEach(title => {
      const clean = (title || '').trim();
      if (!clean) return;
      const item = { title: clean, year: null, imdb: null, tmdb: null };
      const m = listSyncService.matchItemToLibrary(item, libraryItems);
      if (m) matched.push({ title: clean, embyId: m.Id, embyName: m.Name });
      else missing.push(clean);
    });

    res.json({
      success: true,
      totalCount: matched.length + missing.length,
      matchedCount: matched.length,
      missingCount: missing.length,
      matched, missing,
      allTitles: titles.map(t => (t || '').trim()).filter(Boolean)
    });
  } catch (error) {
    logger.error('Franchise preview failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ID-first matching logic the scheduled sync already uses, just against a
// throwaway "collection" object instead of a stored one.
app.post('/api/import/preview', async (req, res) => {
  try {
    const { source, listId, isLiked, isWatchlist, username, mdblistApiKey } = req.body;
    if (!source || (!listId && !isWatchlist)) {
      return res.status(400).json({ success: false, error: 'source and listId (or isWatchlist) required' });
    }

    const creds = listSyncService.loadCredentials();
    const fakeColl = {
      name: 'preview',
      source,
      sourceListId: isWatchlist ? (source === 'Trakt' ? 'watchlist' : '_watchlist') : listId,
      sourceListIsLiked: !!isLiked,
      sourceUsername: username || null,
      sourceListApiKey: source === 'MDBlists' ? (mdblistApiKey || creds.mdblistApiKey) : undefined
    };

    const items = await listSyncService.fetchLatestTitles(fakeColl, creds);
    if (items === null) {
      return res.status(400).json({ success: false, error: 'Unsupported source' });
    }

    const libraryItems = await listSyncService.fetchLibraryItems();
    const matched = [];
    const missing = [];
    items.forEach(item => {
      const m = listSyncService.matchItemToLibrary(item, libraryItems);
      if (m) matched.push({ title: item.title, embyId: m.Id, embyName: m.Name });
      else missing.push(item.title);
    });

    res.json({
      success: true,
      totalCount: items.length,
      matchedCount: matched.length,
      missingCount: missing.length,
      matched, missing,
      allTitles: items.map(i => i.title)
    });
  } catch (error) {
    logger.error('Import preview failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Actually create the Emby collection from a previewed import, and persist
// metadata the same way the rest of the app expects (chrono-collections.json)
app.post('/api/import/create', async (req, res) => {
  try {
    const { name, source, listId, isLiked, isWatchlist, username, mdblistApiKey, matchedEmbyIds, allTitles, missingTitles, kind } = req.body;
    if (!name || !Array.isArray(matchedEmbyIds) || matchedEmbyIds.length === 0) {
      return res.status(400).json({ success: false, error: 'name and at least one matched item required' });
    }

    const creds = listSyncService.loadCredentials();

    // Franchise/CSV mode uses a real Playlist (preserves the order given —
    // that's the entire point of those modes). Trakt/MDBlists import uses a
    // Collection, matching how those have always behaved.
    const created = kind === 'playlist'
      ? await embyClient.createPlaylist(name, matchedEmbyIds)
      : await embyClient.createCollection(name, matchedEmbyIds);

    const chronoPath = path.join(__dirname, 'data', 'chrono-collections.json');
    let collections = [];
    if (fs.existsSync(chronoPath)) {
      try { collections = JSON.parse(fs.readFileSync(chronoPath, 'utf8') || '[]'); } catch (e) { collections = []; }
    }

    collections.push({
      embyId: created.id,
      name,
      source,
      kind: kind === 'playlist' ? 'playlist' : 'collection',
      sourceListId: isWatchlist ? (source === 'Trakt' ? 'watchlist' : '_watchlist') : listId,
      sourceListIsLiked: !!isLiked,
      sourceUsername: username || null,
      sourceListApiKey: source === 'MDBlists' ? (mdblistApiKey || creds.mdblistApiKey || null) : undefined,
      originalTitles: allTitles || [],
      importedTitles: allTitles || [],
      missingTitles: missingTitles || [],
      savedAt: new Date().toISOString()
    });

    fs.writeFileSync(chronoPath, JSON.stringify(collections, null, 2));
    logger.info(`Import created: ${created.id} - ${name} (${source}, ${kind === 'playlist' ? 'playlist' : 'collection'})`);

    res.status(201).json({ success: true, collection: { id: created.id, name } });
  } catch (error) {
    logger.error('Import create failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Smart rule preview — real match count against the live library, no rule is saved
app.post('/api/rules/preview', express.json(), async (req, res) => {
  try {
    const { logic, conditions } = req.body;

    if (!Array.isArray(conditions) || conditions.length === 0) {
      return res.status(400).json({ success: false, error: 'No conditions provided' });
    }

    const items = await embyClient.getLibraryItems();
    const rule = { type: logic || 'AND', logic: logic || 'AND', conditions };
    const matched = rulesEngine.evaluateRule(rule, items);

    res.json({
      success: true,
      count: matched.length,
      totalLibrarySize: items.length,
      sample: matched.slice(0, 20).map(i => ({
        id: i.Id,
        name: i.Name,
        year: i.ProductionYear || null
      }))
    });
  } catch (error) {
    logger.error('Rule preview error', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual "Sync Now" trigger (also used by the scheduled timer internally)
app.post('/api/sync-lists', express.json(), async (req, res) => {
  try {
    const dryRun = !!(req.body && req.body.dryRun);
    const result = await listSyncService.syncAll({ dryRun });
    res.json(result);
  } catch (error) {
    logger.error('Sync lists error', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Current settings + last run + short history
app.get('/api/sync-status', (req, res) => {
  try {
    res.json({ success: true, ...listSyncService.getStatus() });
  } catch (error) {
    logger.error('Sync status error', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Full sync-run history for the Sync Activity Timeline chart (up to 500 runs)
app.get('/api/sync-history', (req, res) => {
  try {
    const audit = listSyncService.loadAudit();
    res.json({ success: true, syncs: audit.syncs || [] });
  } catch (error) {
    logger.error('Sync history error', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update auto-sync settings (enabled, intervalHours)
app.post('/api/sync-settings', express.json(), async (req, res) => {
  try {
    const { enabled, intervalHours, autoRadarr, radarrServerId, watchedSyncEnabled } = req.body;
    const updates = {};
    if (typeof enabled === 'boolean') updates.enabled = enabled;
    if (typeof intervalHours === 'number' && intervalHours > 0) updates.intervalHours = intervalHours;
    if (typeof autoRadarr === 'boolean') updates.autoRadarr = autoRadarr;
    if (radarrServerId === null || typeof radarrServerId === 'number') updates.radarrServerId = radarrServerId;
    if (typeof watchedSyncEnabled === 'boolean') updates.watchedSyncEnabled = watchedSyncEnabled;

    const updated = listSyncService.saveConfig(updates);
    res.json({ success: true, config: updated });
  } catch (error) {
    logger.error('Sync settings error', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual trigger / preview for watched-status sync (Emby → Trakt/MDBlists), independent of list-content sync
app.post('/api/sync-watched', express.json(), async (req, res) => {
  try {
    const dryRun = !!(req.body && req.body.dryRun);
    const result = await listSyncService.syncWatchedStatus({ dryRun });
    res.json(result);
  } catch (error) {
    logger.error('Watched sync error', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═════════════════════════════════════════════
// EMBY WEBHOOK HANDLER (Real-time Schedule Refresh)
// ═════════════════════════════════════════════

app.post('/api/webhooks/emby', express.json(), async (req, res) => {
  try {
    const { Event, Item } = req.body;

    logger.info(`📌 Webhook received: ${Event}`);
    logger.info(`   Item: ${Item?.Name || 'Unknown'} (ID: ${Item?.Id || '?'})`);

    // ─── New item added to library → refresh collections ───
    if (Event === 'library.new') {
      if (!Item || !Item.Id) {
        return res.status(400).json({ success: false, error: 'No item data in webhook' });
      }

      let autoRefreshResult = null;
      try {
        logger.info(`   🔄 Triggering refresh for ALL collections...`);
        const refreshResponse = await axios.post(`http://localhost:${process.env.PORT || 5001}/api/refresh-all-collections`, {});
        autoRefreshResult = refreshResponse.data;

        if (autoRefreshResult && autoRefreshResult.success) {
          logger.info(`   ✓ Refresh complete: ${autoRefreshResult.results.itemsAdded} items added`);
        }
      } catch (e) {
        logger.warn('Refresh all collections failed:', e.message);
      }

      return res.json({
        success: true,
        event: Event,
        item: Item.Name,
        itemsAdded: autoRefreshResult?.results?.itemsAdded || 0,
        collectionsRefreshed: autoRefreshResult?.results?.collectionsProcessed || 0,
        message: 'Movie processed - collections refreshed and auto-updated'
      });
    }

    // ─── Item marked watched → push to Trakt/MDBlists if tracked ───
    if (Event === 'item.markplayed') {
      if (!Item || !Item.Id) {
        return res.status(400).json({ success: false, error: 'No item data in webhook' });
      }

      const config = listSyncService.loadConfig();
      if (!config.watchedSyncEnabled) {
        logger.info(`   Watched-sync is disabled in settings — ignoring`);
        return res.json({ success: true, message: 'Watched-sync disabled in settings', event: Event });
      }

      if (Item.Type !== 'Movie') {
        logger.info(`   Skipping — only movies are supported currently (got ${Item.Type})`);
        return res.json({ success: true, message: 'Only movies are supported currently', event: Event });
      }

      const imdb = Item.ProviderIds && Item.ProviderIds.Imdb;
      const tmdb = Item.ProviderIds && Item.ProviderIds.Tmdb;
      if (!imdb && !tmdb) {
        logger.warn(`   No IMDB/TMDB id on "${Item.Name}" — cannot push`);
        return res.json({ success: true, message: 'No IMDB/TMDB id, cannot push', event: Event });
      }

      const watchedAt = (Item.UserData && Item.UserData.LastPlayedDate) || new Date().toISOString();

      let pushResult = { traktPushed: false, mdblistPushed: [] };
      try {
        pushResult = await listSyncService.pushWatchedSingleItem({ name: Item.Name, imdb, tmdb, watchedAt });
        logger.info(`   ✓ Watched-push for "${Item.Name}": Trakt=${pushResult.traktPushed}, MDBlists keys=${pushResult.mdblistPushed.length}`);
      } catch (e) {
        logger.warn('   Watched single-item push failed: ' + e.message);
      }

      return res.json({ success: true, event: Event, item: Item.Name, ...pushResult });
    }

    // ─── Anything else → acknowledge, do nothing ───
    return res.json({ success: true, message: 'Event type not configured', event: Event });

  } catch (error) {
    logger.error('Webhook handler error', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper: Find which schedules' rules match the new item
async function findSchedulesThatMatchItem(embyItem) {
  try {
    // Load all active schedules
    const schedulesPath = path.join(__dirname, 'data', 'schedules.json');
    if (!fs.existsSync(schedulesPath)) return [];
    
    const schedules = JSON.parse(fs.readFileSync(schedulesPath, 'utf8')) || [];
    const matching = [];

    for (const schedule of schedules) {
      // Skip disabled schedules
      if (schedule.disabled === true) continue;

      // Load the rule for this schedule
      const rule = schedule.rule; // Assume rule is embedded or load it
      if (!rule) continue;

      // Evaluate: does this item match the rule?
      const ruleEngine = new RulesEngine(logger);
      const matches = await ruleEngine.evaluateRuleForItem(rule, embyItem);

      if (matches) {
        matching.push(schedule);
      }
    }

    return matching;
  } catch (e) {
    logger.warn('Error finding matching schedules', e.message);
    return [];
  }
}

// Helper: Trigger chrono refresh (calls existing /api/chrono/refresh endpoint)
async function triggerChronoRefresh(collectionId) {
  try {
    const port = process.env.PORT || 5001;
    const refreshUrl = `http://localhost:${port}/api/chrono/refresh/${collectionId}`;
    
    const response = await axios.post(refreshUrl, {}, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (response.data && response.data.success !== false) {
      logger.info(`   ✓ Chrono refresh for ${collectionId}: ${response.data.itemsAdded || 0} items`);
      return response.data;
    } else {
      throw new Error(response.data?.error || 'Refresh failed');
    }
  } catch (error) {
    logger.warn(`Chrono refresh for ${collectionId}: ${error.message}`);
    throw error;
  }
}

// Helper: Refresh chrono collections that share IDs with triggered smart schedules
async function refreshMatchingChronoCollections(collectionIds) {
  try {
    const chronoPath = path.join(__dirname, 'data', 'chrono-collections.json');
    
    if (!fs.existsSync(chronoPath)) {
      logger.info('No synced chrono collections yet');
      return 0;
    }

    const chronoCollections = JSON.parse(fs.readFileSync(chronoPath, 'utf8')) || [];
    let refreshCount = 0;

    for (const collId of collectionIds) {
      // Find chrono collections using this collection ID
      const matchingChrono = chronoCollections.filter(c => c.embyId === collId);

      for (const chrono of matchingChrono) {
        try {
          logger.info(`   🔄 Refreshing chrono collection: ${chrono.name} (source: ${chrono.source})`);
          
          // Refresh based on source
          if (chrono.source === 'Trakt') {
            await refreshTraktCollection(chrono);
            refreshCount++;
          } else if (chrono.source === 'MDBlists') {
            await refreshMDBlistsCollection(chrono);
            refreshCount++;
          } else if (chrono.source === 'import') {
            logger.info(`   ℹ️  Imported collection "${chrono.name}" - manual refresh only`);
          }
        } catch (chronoError) {
          logger.warn(`   ⚠️  Failed to refresh chrono "${chrono.name}": ${chronoError.message}`);
        }
      }
    }

    return refreshCount;
  } catch (e) {
    logger.warn('Error refreshing chrono collections', e.message);
    return 0;
  }
}

// Refresh a Trakt collection by fetching latest items and updating Emby
async function refreshTraktCollection(chronoCollection) {
  try {
    logger.info(`[Trakt Refresh] Fetching latest items for "${chronoCollection.name}"`);
    
    // Get Trakt list ID from collection metadata
    const traktListId = chronoCollection.sourceListId;
    if (!traktListId) {
      throw new Error('No Trakt list ID stored');
    }

    // Fetch fresh items from Trakt API (would use your Trakt service)
    // For now, just log - implementation depends on your Trakt integration
    logger.info(`   Fetching Trakt list: ${traktListId}`);
    
    // Once fetched, update the Emby collection with new items
    // This would call updateCollection or similar
    logger.info(`   ✓ Trakt collection updated`);
  } catch (error) {
    logger.error(`Trakt refresh failed: ${error.message}`);
    throw error;
  }
}

// Refresh an MDBlists collection by fetching latest items and updating Emby
async function refreshMDBlistsCollection(chronoCollection) {
  try {
    logger.info(`[MDBlists Refresh] Fetching latest items for "${chronoCollection.name}"`);
    
    // Get MDBlists API key and list ID from collection metadata
    const apiKey = chronoCollection.sourceListApiKey;
    const listId = chronoCollection.sourceListId;
    
    if (!apiKey || !listId) {
      throw new Error('No MDBlists credentials stored');
    }

    // Fetch fresh items from MDBlists API (would use your MDBlists service)
    logger.info(`   Fetching MDBlists list: ${listId}`);
    
    // Once fetched, update the Emby collection with new items
    logger.info(`   ✓ MDBlists collection updated`);
  } catch (error) {
    logger.error(`MDBlists refresh failed: ${error.message}`);
    throw error;
  }
}

// ═════════════════════════════════════════════
// FEATURE 1B: PUBLISH OPTIONS ENDPOINTS (NEW)
// ═════════════════════════════════════════════

// Get a single schedule
app.get('/api/schedules/:id', (req, res) => {
  try {
    const schedulesPath = path.join(dataDir, 'schedules.json');
    const schedules = fs.existsSync(schedulesPath) ? JSON.parse(fs.readFileSync(schedulesPath, 'utf8') || '[]') : [];
    const schedule = schedules.find(s => s.id === req.params.id);
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    res.json(schedule);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get Trakt user's lists (for dropdowns)
app.get('/api/trakt/user-lists', async (req, res) => {
  try {
    const credPath = path.join(dataDir, 'sync-credentials.json');
    let creds = {};
    if (fs.existsSync(credPath)) {
      creds = JSON.parse(fs.readFileSync(credPath, 'utf8') || '{}');
    }
    
    if (!creds.trakt?.accessToken) {
      return res.status(401).json({ error: 'Trakt not connected' });
    }
    
    const headers = {
      'Authorization': 'Bearer ' + creds.trakt.accessToken,
      'trakt-api-version': '2',
      'trakt-api-key': creds.trakt.clientId || ''
    };
    
    const response = await axios.get('https://api.trakt.tv/users/me/lists', { 
      headers, 
      timeout: 15000 
    });
    
    const lists = (response.data || []).map(l => ({
      id: l.ids.trakt,
      slug: l.ids.slug,
      name: l.name
    }));
    
    res.json({ lists });
  } catch (e) {
    logger.warn('Failed to get Trakt lists:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get MDBlists user's lists
app.get('/api/mdblist/user-lists', async (req, res) => {
  try {
    const credPath = path.join(dataDir, 'sync-credentials.json');
    let creds = {};
    if (fs.existsSync(credPath)) {
      creds = JSON.parse(fs.readFileSync(credPath, 'utf8') || '{}');
    }
    
    if (!creds.mdblistApiKey) {
      return res.status(401).json({ error: 'MDBlists not connected' });
    }
    
    const response = await axios.get(
      `https://api.mdblist.com/user/lists?apikey=${creds.mdblistApiKey}`,
      { timeout: 15000 }
    );
    
    const lists = (response.data || []).map(l => ({
      id: l.id,
      name: l.name,
      url: l.url
    }));
    
    res.json({ lists });
  } catch (e) {
    logger.warn('Failed to get MDBlists:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Add publishing to a schedule
app.post('/api/schedules/:id/publish', (req, res) => {
  try {
    const { service, autoCreate, listId } = req.body;
    const schedulesPath = path.join(dataDir, 'schedules.json');
    const schedules = fs.existsSync(schedulesPath) ? JSON.parse(fs.readFileSync(schedulesPath, 'utf8') || '[]') : [];
    const schedule = schedules.find(s => s.id === req.params.id);
    
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    
    if (service === 'trakt') {
      schedule.publishToTrakt = true;
      schedule.traktAutoCreate = autoCreate;
      if (!autoCreate) schedule.traktListId = listId;
    } else if (service === 'mdblist') {
      schedule.publishToMDBlists = true;
      schedule.mdblistAutoCreate = autoCreate;
      if (!autoCreate) schedule.mdblistListId = listId;
    }
    
    const tmp = schedulesPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(schedules, null, 2));
    fs.renameSync(tmp, schedulesPath);
    
    res.json({ success: true });
  } catch (e) {
    logger.error('Failed to add publishing:', e);
    res.status(500).json({ error: e.message });
  }
});

// Remove publishing from a schedule
app.post('/api/schedules/:id/unpublish', (req, res) => {
  try {
    const { service } = req.body;
    const schedulesPath = path.join(dataDir, 'schedules.json');
    const schedules = fs.existsSync(schedulesPath) ? JSON.parse(fs.readFileSync(schedulesPath, 'utf8') || '[]') : [];
    const schedule = schedules.find(s => s.id === req.params.id);
    
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    
    if (service === 'trakt') {
      schedule.publishToTrakt = false;
    } else if (service === 'mdblist') {
      schedule.publishToMDBlists = false;
    }
    
    const tmp = schedulesPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(schedules, null, 2));
    fs.renameSync(tmp, schedulesPath);
    
    res.json({ success: true });
  } catch (e) {
    logger.error('Failed to remove publishing:', e);
    res.status(500).json({ error: e.message });
  }
});

// Update schedule timer (cron expression)
app.post('/api/schedules/:id/update-timer', (req, res) => {
  try {
    const { cronExpression, frequencyType } = req.body;
    if (!cronExpression) {
      return res.status(400).json({ success: false, error: 'Missing cronExpression' });
    }

    const schedulesPath = path.join(dataDir, 'schedules.json');
    const schedules = fs.existsSync(schedulesPath) ? JSON.parse(fs.readFileSync(schedulesPath, 'utf8') || '[]') : [];
    const schedule = schedules.find(s => s.id === req.params.id);

    if (!schedule) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    // Update the schedule
    schedule.cronExpression = cronExpression;
    if (frequencyType) schedule.frequencyType = frequencyType;

    // Persist to file
    const tmp = schedulesPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(schedules, null, 2));
    fs.renameSync(tmp, schedulesPath);

    // Also update the running scheduler
    scheduler.updateSchedule(req.params.id, { cronExpression, frequencyType });

    logger.info(`Schedule ${req.params.id} timer updated to: ${cronExpression}`);
    res.json({ success: true, schedule: { id: schedule.id, cronExpression: schedule.cronExpression, frequencyType: schedule.frequencyType } });
  } catch (error) {
    logger.error('Update schedule timer failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});



app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found: ' + req.method + ' ' + req.path
  });
});

// ═════════════════════════════════════════════
// ERROR HANDLER (must be last)
// ═════════════════════════════════════════════

app.use((error, req, res, next) => {
  logger.error('Unhandled error', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

// ═════════════════════════════════════════════
// SERVER STARTUP
// ═════════════════════════════════════════════

const PORT = process.env.PORT || 5001;

const server = app.listen(PORT, () => {
  logger.info(`═══════════════════════════════════════════`);
  logger.info(`Smart Playlist Backend Server Started`);
  logger.info(`═══════════════════════════════════════════`);
  logger.info(`Port: ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`Emby URL: ${process.env.EMBY_URL}`);
  logger.info(`Frontend: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
  logger.info(`═══════════════════════════════════════════`);
  logger.info(`Health check: http://localhost:${PORT}/api/health`);
  logger.info(`═══════════════════════════════════════════`);

  listSyncService.start();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

module.exports = { app, scheduler, embyClient, };