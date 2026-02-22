const JellyfinClient = require('./jellyfin');

/**
 * Cria uma instância do addon para um config específico de usuário.
 * Retorna handlers para { catalog, stream }.
 */
function createAddon(config) {
  const client = new JellyfinClient(config);
  const serverName = config.serverName || 'Jellyfin';

  // ── STREAM HANDLER ─────────────────────────────────────────────────────────

  async function stream({ type, id }) {
    // id para séries: tt1234567:S:E  (ex: tt1234567:1:2)
    // id para filmes: tt1234567
    let stremioId = id;
    let season = null;
    let episode = null;

    if (type === 'series') {
      const parts = id.split(':');
      // Formato: idBase:season:episode  (pode ter prefixo como tt ou tmdb)
      // Stremio usa: "tt1234567:1:2" ou "tmdb:12345:1:2"
      if (parts.length >= 3) {
        episode = parseInt(parts[parts.length - 1]);
        season = parseInt(parts[parts.length - 2]);
        stremioId = parts.slice(0, parts.length - 2).join(':');
      }
    }

    const items = await client.resolveStremioId(stremioId);
    if (!items.length) return { streams: [] };

    const streams = [];

    for (const item of items) {
      try {
        let targetItem = item;

        // Para séries: precisamos encontrar o episódio específico
        if (type === 'series' && season !== null && episode !== null) {
          const ep = await client.getEpisode(item.Id, season, episode);
          if (!ep) continue;
          targetItem = ep;
        }

        // MediaSources podem ter múltiplas versões (4K, 1080p, etc.)
        const mediaSources = targetItem.MediaSources || [];

        if (!mediaSources.length) {
          // Fallback: stream direto pelo ID do item
          streams.push(buildStream(client, targetItem.Id, targetItem, serverName, null));
          continue;
        }

        for (const source of mediaSources) {
          const stream = buildStream(client, source.Id || targetItem.Id, targetItem, serverName, source);
          if (stream) streams.push(stream);
        }
      } catch (err) {
        console.error('[stream] erro ao processar item', item.Id, err.message);
      }
    }

    return { streams };
  }

  // ── CATALOG HANDLER ────────────────────────────────────────────────────────

  async function catalog({ type, id, extra = {} }) {
    const search = extra.search || '';
    const skip = extra.skip ? parseInt(extra.skip) : 0;

    const items = await client.getLibrary(type, search, skip);

    const metas = items.map(item => {
      const stremioId = getStremioIdFromItem(item);
      return {
        id: stremioId,
        type,
        name: item.Name,
        poster: client.imageUrl(item.Id, 'Primary'),
        background: client.imageUrl(item.Id, 'Backdrop'),
        description: item.Overview || '',
        year: item.ProductionYear || null,
        genres: item.Genres || [],
      };
    });

    return { metas };
  }

  return { stream, catalog };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Constrói o objeto de stream do Stremio.
 * Usa `url` (não `externalUrl`) para reproduzir no player interno (ExoPlayer).
 * O token é passado via query param na própria URL.
 */
function buildStream(client, sourceId, item, serverName, mediaSource) {
  // Qualidade detectada do nome do source ou da resolução
  let qualityLabel = '';
  if (mediaSource) {
    const height = getVideoHeight(mediaSource);
    if (height) {
      if (height >= 2160) qualityLabel = '4K';
      else if (height >= 1080) qualityLabel = '1080p';
      else if (height >= 720) qualityLabel = '720p';
      else qualityLabel = `${height}p`;
    }
    if (mediaSource.Name && mediaSource.Name !== item.Name) {
      qualityLabel = qualityLabel
        ? `${qualityLabel} – ${mediaSource.Name}`
        : mediaSource.Name;
    }
  }

  const title = qualityLabel
    ? `📺 ${serverName}\n${qualityLabel}`
    : `📺 ${serverName}`;

  const streamUrl = client.streamUrl(sourceId);

  // Legendas embutidas
  const subtitles = client.extractSubtitles(mediaSource ? [mediaSource] : []);

  return {
    // ⚠️ Usar `url` (não `externalUrl`) para tocar no player interno do Stremio
    url: streamUrl,
    title,
    name: serverName,
    // subtitles são passadas como campo separado para o Stremio carregar
    subtitles: subtitles.length ? subtitles : undefined,
    behaviorHints: {
      // notWebReady: true avisa ao Stremio que a URL não é MP4 direto via HTTPS
      // mas NÃO força player externo — apenas usa o streaming server local do Stremio
      notWebReady: true,
      bingeGroup: `jellyfin-${item.SeriesId || item.Id}`,
    },
  };
}

function getVideoHeight(mediaSource) {
  try {
    const streams = mediaSource.MediaStreams || [];
    const video = streams.find(s => s.Type === 'Video');
    return video ? video.Height : null;
  } catch {
    return null;
  }
}

/**
 * Gera um ID de Stremio a partir de um item do Jellyfin.
 * Prefere IMDb > TMDb > TVDb > ID nativo do Jellyfin.
 */
function getStremioIdFromItem(item) {
  const providers = item.ProviderIds || {};
  if (providers.Imdb) return providers.Imdb;
  if (providers.Tmdb) return `tmdb:${providers.Tmdb}`;
  if (providers.Tvdb) return `tvdb:${providers.Tvdb}`;
  // Fallback para ID nativo (o catálogo usa jellyfin: como prefixo)
  return `jellyfin:${item.Id}`;
}

module.exports = { createAddon };
