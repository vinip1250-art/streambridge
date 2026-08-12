'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const rateLimit = require('express-rate-limit');
const { createAddon } = require('./lib/addon');
const cache  = require('./lib/cache');
const health = require('./lib/health');
const { parseConfig, configHash } = require('./lib/security');

const app  = express();
const PORT = process.env.PORT || 7005;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DEBUG = process.env.DEBUG === 'true';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);

// Prune do cache a cada 10 minutos
setInterval(() => cache.prune(), 10 * 60_000).unref();

// ── Rate Limiters ─────────────────────────────────────────────────────────────

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  skip: (req) => req.path.includes('/proxy/') || req.path.includes('/proxy-source/'),
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const streamLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many stream requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  message: { error: 'Too many proxy requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function getEncodedConfig(req) {
  return req.params.config ?? req.params[0] ?? '';
}

function safeToken(value) {
  const token = String(value || '');
  return /^[A-Za-z0-9_.:-]+$/.test(token) ? token : null;
}

async function fetchStreamHeaders(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

function getInstance(config, role) {
  return role === 'secondary' ? getSecondary(config) : getPrimary(config);
}

function resolveSourceUrl(inst, source) {
  const url = String(source?.url || '');
  if (source?.isRelative) {
    const resolved = new URL(url, inst.jellyfinUrl);
    if (!resolved.searchParams.has('api_key')) resolved.searchParams.set('api_key', inst.apiKey);
    return resolved.toString();
  }

  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid source protocol');
  return parsed.toString();
}

async function pipeUpstreamStream(upstreamUrl, req, res, headers = {}) {
  const streamHeaders = {
    'User-Agent': 'StreamBridge/2.3',
    ...headers,
  };
  if (req.headers.range) streamHeaders.Range = req.headers.range;

  const streamRes = await fetchStreamHeaders(upstreamUrl, { headers: streamHeaders });

  if (!streamRes.ok) {
    return res.status(streamRes.status).send('Upstream error');
  }

  res.status(streamRes.status);
  res.setHeader('Content-Type', streamRes.headers.get('content-type') || 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');

  for (const header of ['content-length', 'content-range', 'last-modified', 'etag']) {
    const value = streamRes.headers.get(header);
    if (value) res.setHeader(header, value);
  }

  if (!streamRes.body) return res.end();

  await pipeline(Readable.fromWeb(streamRes.body), res);
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
  types:       [],
  catalogs:    [],
  behaviorHints: { configurationRequired: true, configurationURL: `${BASE_URL}/configure` },
}));

// ── Manifest com config ───────────────────────────────────────────────────────
app.get(/^\/(.+)\/manifest\.json$/, async (req, res) => {
  const config = parseConfig(getEncodedConfig(req));
  if (!validateConfig(config)) {
    return res.status(400).json({ error: 'Configuração inválida.' });
  }

  const p = getPrimary(config);
  const sec = getSecondary(config);
  const addonName = sec
    ? `StreamBridge – ${p.serverName ?? 'Jellyfin'} + ${sec.serverName ?? 'Local'}`
    : `StreamBridge – ${p.serverName ?? 'Jellyfin'}`;

  try {
    const addon = createAddon(config);
    const catalogs = [
      ...(await addon.getDynamicCatalogs(p, 'primary')),
      ...(sec ? await addon.getDynamicCatalogs(sec, 'secondary') : []),
    ];

    res.json({
      id:          `com.streambridge.jellyfin.${p.userId}`,
      version:     '2.3.0',
      name:        addonName,
      description: sec
        ? `Multi-instância: ${p.serverName} (primário) + ${sec.serverName ?? 'PC Local'} (transcodificação HD).`
        : `Streams do servidor Jellyfin ${p.serverName ?? ''}.`,
      logo:      'https://jellyfin.org/images/logo.svg',
      resources: ['catalog', 'meta', 'stream'],
      types:     ['movie', 'series'],
      catalogs,
      behaviorHints: { configurationRequired: false },
    });
  } catch (err) {
    if (DEBUG) console.error('[manifest]', err.message);
    res.status(500).json({ error: 'Failed to load catalogs' });
  }
});

// ── Catalog ───────────────────────────────────────────────────────────────────
app.get(/^\/(.+)\/catalog\/([^/]+)\/([^/]+)\.json$/, async (req, res) => {
  const config = parseConfig(getEncodedConfig(req));
  if (!config) return res.status(400).json({ error: 'Configuração inválida.' });
  try {
    const result = await createAddon(config).catalog({
      type:  req.params[1],
      id:    req.params[2],
      extra: req.query,
    });
    res.json(result);
  } catch (err) {
    console.error('[catalog]', err.message);
    res.json({ metas: [] });
  }
});

// ── Meta ──────────────────────────────────────────────────────────────────────
app.get(/^\/(.+)\/meta\/([^/]+)\/([^/]+)\.json$/, async (req, res) => {
  const config = parseConfig(getEncodedConfig(req));
  if (!config) return res.status(400).json({ error: 'Configuração inválida.' });
  try {
    const result = await createAddon(config).meta({
      type: req.params[1],
      id:   req.params[2],
    });
    res.json(result);
  } catch (err) {
    console.error('[meta]', err.message);
    res.json({ meta: null });
  }
});

// ── Stream ────────────────────────────────────────────────────────────────────
app.get(/^\/(.+)\/stream\/([^/]+)\/([^/]+)\.json$/, streamLimiter, async (req, res) => {
  const config = parseConfig(getEncodedConfig(req));
  if (!config) return res.status(400).json({ error: 'Configuração inválida.' });
  try {
    const result = await createAddon(config).stream({
      type: req.params[1],
      id:   req.params[2],
    });
    res.json(result);
  } catch (err) {
    if (DEBUG) console.error('[stream]', err.message);
    res.json({ streams: [] });
  }
});

// ── Proxy Seguro ──────────────────────────────────────────────────────────────
app.get(/^\/(.+)\/proxy\/([^/]+)\/([^/]+)\/stream\.([^/]+)$/, proxyLimiter, async (req, res) => {
  const config = parseConfig(getEncodedConfig(req));
  if (!validateConfig(config)) return res.status(400).send('Invalid config');

  const inst = getInstance(config, req.params[1]);
  if (!inst) return res.status(404).send('Instance not found');

  try {
    const itemId = safeToken(req.params[2]);
    const ext = safeToken(req.params[3]);
    const mediaSourceId = safeToken(req.query.msid) || itemId;

    if (!itemId || !ext || !mediaSourceId) {
      return res.status(400).send('Invalid stream parameters');
    }

    const streamParams = new URLSearchParams({
      MediaSourceId: mediaSourceId,
      Static: 'true',
      api_key: inst.apiKey,
    });
    const streamUrl = `${inst.jellyfinUrl}/Videos/${itemId}/stream.${ext}?${streamParams}`;

    await pipeUpstreamStream(streamUrl, req, res);
  } catch (err) {
    if (DEBUG) console.error('[proxy]', err.message);
    if (res.headersSent) return res.destroy();
    res.status(500).send('Proxy error');
  }
});

// ── Proxy de fontes geradas por PlaybackInfo/plugins ─────────────────────────
app.get(/^\/(.+)\/proxy-source\/([^/]+)\/stream\.([^/]+)$/, proxyLimiter, async (req, res) => {
  const config = parseConfig(getEncodedConfig(req));
  if (!validateConfig(config)) return res.status(400).send('Invalid config');

  try {
    const token = safeToken(req.params[1]);
    if (!token) return res.status(400).send('Invalid source token');

    const source = await cache.get(`source:${configHash(config)}:${token}`);
    if (!source?.url) return res.status(404).send('Source expired');

    const inst = getInstance(config, source.role);
    if (source.isRelative && !inst) return res.status(404).send('Instance not found');

    const upstreamUrl = resolveSourceUrl(inst, source);
    const headers = source.headers && typeof source.headers === 'object'
      ? { ...source.headers }
      : {};
    if (source.isRelative && inst) headers['X-MediaBrowser-Token'] = inst.apiKey;

    await pipeUpstreamStream(upstreamUrl, req, res, headers);
  } catch (err) {
    if (DEBUG) console.error('[proxy-source]', err.message);
    if (res.headersSent) return res.destroy();
    res.status(500).send('Proxy source error');
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`StreamBridge v2.3 rodando em ${BASE_URL}`);
  console.log(`Configure:   ${BASE_URL}/configure`);
  console.log(`Health:      ${BASE_URL}/health`);
  console.log(`Redis:       ${process.env.REDIS_URL || 'localhost:6379'}`);
  console.log(`Debug:       ${DEBUG ? 'enabled' : 'disabled'}`);
});
