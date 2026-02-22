const express = require('express');
const cors = require('cors');
const path = require('path');
const { createAddon } = require('./lib/addon');

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseConfig(encoded) {
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

// ─── Página de configuração ──────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.redirect('/configure');
});

app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// ─── Rotas sem config (manifest padrão sem recursos configurados) ─────────────

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'com.streambridge.jellyfin',
    version: '2.0.0',
    name: 'StreamBridge',
    description: 'Conecte seu servidor Jellyfin ao Stremio.',
    logo: 'https://jellyfin.org/images/logo.svg',
    resources: [],
    types: ['movie', 'series'],
    catalogs: [],
    behaviorHints: { configurationRequired: true },
  });
});

// ─── Rotas com config embutida na URL ─────────────────────────────────────────

// Manifest
app.get('/:config/manifest.json', (req, res) => {
  const config = parseConfig(req.params.config);
  if (!config || !config.jellyfinUrl || !config.userId || !config.apiKey) {
    return res.status(400).json({ error: 'Configuração inválida.' });
  }

  const serverName = config.serverName || 'Jellyfin';

  res.json({
    id: `com.streambridge.jellyfin.${config.userId}`,
    version: '2.0.0',
    name: `StreamBridge – ${serverName}`,
    description: `Streams e catálogo do seu servidor Jellyfin (${serverName}).`,
    logo: 'https://jellyfin.org/images/logo.svg',
    resources: ['catalog', 'stream'],
    types: ['movie', 'series'],
    catalogs: [
      {
        type: 'movie',
        id: 'jellyfin-movies',
        name: `${serverName} – Filmes`,
        extra: [{ name: 'search', isRequired: false }],
      },
      {
        type: 'series',
        id: 'jellyfin-series',
        name: `${serverName} – Séries`,
        extra: [{ name: 'search', isRequired: false }],
      },
    ],
    behaviorHints: { configurationRequired: false },
  });
});

// Catalog
app.get('/:config/catalog/:type/:id.json', async (req, res) => {
  const config = parseConfig(req.params.config);
  if (!config) return res.status(400).json({ error: 'Configuração inválida.' });

  const { type, id } = req.params;
  const search = req.query.search || '';

  try {
    const addon = createAddon(config);
    const result = await addon.catalog({ type, id, extra: { search } });
    res.json(result);
  } catch (err) {
    console.error('[catalog]', err.message);
    res.json({ metas: [] });
  }
});

// Streams
app.get('/:config/stream/:type/:id.json', async (req, res) => {
  const config = parseConfig(req.params.config);
  if (!config) return res.status(400).json({ error: 'Configuração inválida.' });

  const { type, id } = req.params;

  try {
    const addon = createAddon(config);
    const result = await addon.stream({ type, id });
    res.json(result);
  } catch (err) {
    console.error('[stream]', err.message);
    res.json({ streams: [] });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`StreamBridge rodando em http://localhost:${PORT}`);
  console.log(`Configure em: http://localhost:${PORT}/configure`);
});
