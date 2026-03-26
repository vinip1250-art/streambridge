'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { createAddon } = require('./lib/addon');
const cache  = require('./lib/cache');
const health = require('./lib/health');

const app  = express();
const PORT = process.env.PORT || 7005;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Prune do cache a cada 10 minutos
setInterval(() => cache.prune(), 10 * 60_000).unref();

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseConfig(encoded) {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function getPrimary(config) {
  if (!config) return null;
  if (config.jellyfinUrl) return config; // legado
  return config.primary ?? null;
}

function validateConfig(config) {
  const p = getPrimary(config);
  return p?.jellyfinUrl && p?.userId && p?.apiKey;
}

function getSecondary(config) {
  return config?.secondary?.jellyfinUrl ? config.secondary : null;
}

// ── Configuração ──────────────────────────────────────────────────────────────
app.get('/',          (_, res) => res.redirect('/configure'));
app.get('/configure', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'configure.html')));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status:    'ok',
  uptime:    process.uptime(),
  cache:     { size: cache.size },
  instances: health.getAll(),
  ts:        new Date().toISOString(),
}));

// ── Manifest sem config ───────────────────────────────────────────────────────
app.get('/manifest.json', (_, res) => res.json({
  id:          'com.streambridge.jellyfin',
  version:     '2.2.0',
  name:        'StreamBridge',
  description: 'Conecte seu servidor Jellyfin ao Stremio.',
  logo:        'https://jellyfin.org/images/logo.svg',
  resources:   [],
  types:       ['movie', 'series'],
  catalogs:    [],
  behaviorHints: { configurationRequired: true },
}));

// ── Manifest com config ───────────────────────────────────────────────────────
app.get('/:config/manifest.json', (req, res) => {
  const config = parseConfig(req.params.config);
  if (!validateConfig(config)) {
    return res.status(400).json({ error: 'Configuração inválida.' });
  }
  const p   = getPrimary(config);
  const sec = getSecondary(config);
  const addonName = sec
    ? `StreamBridge – ${p.serverName ?? 'Jellyfin'} + ${sec.serverName ?? 'Local'}`
    : `StreamBridge – ${p.serverName ?? 'Jellyfin'}`;

  res.json({
    id:          `com.streambridge.jellyfin.${p.userId}`,
    version:     '2.2.0',
    name:        addonName,
    description: sec
      ? `Multi-instância: ${p.serverName} (primário) + ${sec.serverName ?? 'PC Local'} (transcodificação HD).`
      : `Streams do servidor Jellyfin ${p.serverName ?? ''}.`,
    logo:      'https://jellyfin.org/images/logo.svg',
    resources: ['catalog', 'meta', 'stream'],
    types:     ['movie', 'series'],
    catalogs: [
      {
        type: 'movie', id: 'jellyfin-movies',
        name: `${p.serverName ?? 'Jellyfin'} – Filmes`,
        extra: [{ name: 'search', isRequired: false }],
      },
      {
        type: 'series', id: 'jellyfin-series',
        name: `${p.serverName ?? 'Jellyfin'} – Séries`,
        extra: [{ name: 'search', isRequired: false }],
      },
    ],
    behaviorHints: { configurationRequired: false },
  });
});

// ── Catalog ───────────────────────────────────────────────────────────────────
app.get('/:config/catalog/:type/:id.json', async (req, res) => {
  const config = parseConfig(req.params.config);
  if (!config) return res.status(400).json({ error: 'Configuração inválida.' });
  try {
    const result = await createAddon(config).catalog({
      type:  req.params.type,
      id:    req.params.id,
      extra: req.query,
    });
    res.json(result);
  } catch (err) {
    console.error('[catalog]', err.message);
    res.json({ metas: [] });
  }
});

// ── Meta ──────────────────────────────────────────────────────────────────────
app.get('/:config/meta/:type/:id.json', async (req, res) => {
  const config = parseConfig(req.params.config);
  if (!config) return res.status(400).json({ error: 'Configuração inválida.' });
  try {
    const result = await createAddon(config).meta({
      type: req.params.type,
      id:   req.params.id,
    });
    res.json(result);
  } catch (err) {
    console.error('[meta]', err.message);
    res.json({ meta: null });
  }
});

// ── Stream ────────────────────────────────────────────────────────────────────
app.get('/:config/stream/:type/:id.json', async (req, res) => {
  const config = parseConfig(req.params.config);
  if (!config) return res.status(400).json({ error: 'Configuração inválida.' });
  try {
    const result = await createAddon(config).stream({
      type: req.params.type,
      id:   req.params.id,
    });
    res.json(result);
  } catch (err) {
    console.error('[stream]', err.message);
    res.json({ streams: [] });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`StreamBridge v2.2 rodando em http://localhost:${PORT}`);
  console.log(`Configure:   http://localhost:${PORT}/configure`);
  console.log(`Health:      http://localhost:${PORT}/health`);
});
