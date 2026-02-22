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
    // Stremio passa séries como:
    //   "tt1234567:1:2"       → IMDb, S01E02
    //   "tmdb:12345:1:2"      → TMDb, S01E02
    //   "tvdb:12345:1:2"      → TVDb, S01E02
    //   "jellyfin:XXXXX:1:2"  → ID nativo, S01E02
    // Filmes:
    //   "tt1234567" / "tmdb:12345" / "jellyfin:XXXXX"

    let stremioId = id;
    let season = null;
    let episode = null;

    if (type === 'series') {
      const parts = id.split(':');
      // Mínimo de 3 partes para ter season:episode no final
      if (parts.length >= 3) {
        const maybeEp = parseInt(parts[parts.length - 1]);
        const maybeSeason = parseInt(parts[parts.length - 2]);

        // Valida que os dois últimos segmentos são números
        if (!isNaN(maybeEp) && !isNaN(maybeSeason)) {
          episode = maybeEp;
          season = maybeSeason;
          stremioId = parts.slice(0, parts.length - 2).join(':');
        }
      }
    }

    console.log(`[stream] Recebido: type=${type} id="${id}" → stremioId="${stremioId}" season=${season} episode=${episode}`);

    const items = await client.resolveStremioId(stremioId, type);

    if (!items.length) {
      console.log(`[stream] Nenhum item encontrado para stremioId="${stremioId}"`);
      return { streams: [] };
    }

    const item = items[0];
    console.log(`[stream] Item encontrado: Jellyfin ID=${item.Id} Nome="${item.Name}" Tipo=${item.Type}`);

    const streams = [];

    try {
      let targetItem = item;

      if (type === 'series') {
        if (season === null || episode === null) {
          console.log(`[stream] Série sem season/episode no ID — não é possível reproduzir sem especificar episódio.`);
          return { streams: [] };
        }

        // Se o item retornado for um episódio diretamente (não deveria, mas por segurança)
        if (item.Type === 'Episode') {
          targetItem = item;
        } else {
          // Busca o episódio específico dentro da série
          const ep = await client.getEpisode(item.Id, season, episode);
          if (!ep) {
            console.log(`[stream] Episódio S${season}E${episode} não encontrado na série ${item.Id}.`);
            return { streams: [] };
          }
          targetItem = ep;
          console.log(`[stream] Episódio: ID=${ep.Id} Nome="${ep.Name}"`);
        }
      }

      const mediaSources = targetItem.MediaSources || [];
      console.log(`[stream] MediaSources encontrados: ${mediaSources.length}`);

      if (!mediaSources.length) {
        // Fallback: monta stream direto pelo ID do item
        console.log(`[stream] Sem MediaSources, usando fallback com item ID direto.`);
        streams.push(buildStream(client, targetItem.Id, targetItem, serverName, null));
      } else {
        for (const source of mediaSources) {
          const s = buildStream(client, source.Id || targetItem.Id, targetItem, serverName, source);
          if (s) streams.push(s);
        }
      }
    } catch (err) {
      console.error('[stream] Erro ao processar item', item.Id, err.message);
    }

    console.log(`[stream] Retornando ${streams.length} stream(s).`);
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
 * Usa `url` (não `externalUrl`) para reproduzir no player interno (ExoPlayer/VLC).
 * O token é passado via query param na própria URL.
 */
function buildStream(client, sourceId, item, serverName, mediaSource) {
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
  const subtitles = client.extractSubtitles(mediaSource ? [mediaSource] : []);

  return {
    url: streamUrl,
    title,
    name: serverName,
    subtitles: subtitles.length ? subtitles : undefined,
    behaviorHints: {
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
  return `jellyfin:${item.Id}`;
}

module.exports = { createAddon };
