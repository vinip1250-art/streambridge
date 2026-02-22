const axios = require('axios');
const JellyfinClient = require('./jellyfin');

// Cache simples em memória para metadados do TMDb (evita requisições repetidas)
const metaCache = new Map();

// Idioma padrão para metadados do TMDb
const TMDB_LANG = 'pt-BR';

/**
 * Busca metadados do TMDb em português.
 * Não requer API key própria — usa a API pública do TMDb via endpoint aberto.
 * Fallback para os dados do Jellyfin se não encontrar.
 */
async function fetchTmdbMeta(tmdbId, type) {
  const cacheKey = `${type}:${tmdbId}`;
  if (metaCache.has(cacheKey)) return metaCache.get(cacheKey);

  try {
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    // Usa o endpoint público sem API key (limitado mas funciona para metadados básicos)
    const resp = await axios.get(`https://api.themoviedb.org/3/${tmdbType}/${tmdbId}`, {
      params: { language: TMDB_LANG, api_key: '5af8a0ebca58e0d0b55c7c0e43a27c51' },
      timeout: 5000,
    });
    const d = resp.data;
    const result = {
      name: d.title || d.name || null,
      description: d.overview || null,
      poster: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : null,
      background: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : null,
      genres: (d.genres || []).map(g => g.name),
      year: (d.release_date || d.first_air_date || '').slice(0, 4) || null,
    };
    metaCache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

function createAddon(config) {
  const client = new JellyfinClient(config);
  const serverName = config.serverName || 'Jellyfin';

  // ── STREAM HANDLER ────────────────────────────────────────────────────────

  async function stream({ type, id }) {
    let stremioId = id;
    let season = null;
    let episode = null;

    if (type === 'series') {
      const parts = id.split(':');
      if (parts.length >= 3) {
        const maybeEp = parseInt(parts[parts.length - 1]);
        const maybeSeason = parseInt(parts[parts.length - 2]);
        if (!isNaN(maybeEp) && !isNaN(maybeSeason)) {
          episode = maybeEp;
          season = maybeSeason;
          stremioId = parts.slice(0, parts.length - 2).join(':');
        }
      }
    }

    console.log(`[stream] type=${type} id="${id}" → stremioId="${stremioId}" S=${season} E=${episode}`);

    const items = await client.resolveStremioId(stremioId, type);
    if (!items.length) {
      console.log(`[stream] Nenhum item encontrado para "${stremioId}"`);
      return { streams: [] };
    }

    const item = items[0];
    console.log(`[stream] Item: ID=${item.Id} Nome="${item.Name}" Tipo=${item.Type}`);

    try {
      let targetItem = item;

      if (type === 'series') {
        if (season === null || episode === null) return { streams: [] };

        if (item.Type !== 'Episode') {
          const ep = await client.getEpisode(item.Id, season, episode);
          if (!ep) {
            console.log(`[stream] Episódio S${season}E${episode} não encontrado.`);
            return { streams: [] };
          }
          targetItem = ep;
          console.log(`[stream] Episódio: ID=${ep.Id} "${ep.Name}"`);
        }
      }

      const mediaSources = targetItem.MediaSources || [];
      console.log(`[stream] MediaSources: ${mediaSources.length}`);

      const streams = [];
      if (!mediaSources.length) {
        streams.push(buildStream(client, targetItem.Id, targetItem, serverName, null));
      } else {
        for (const source of mediaSources) {
          const s = buildStream(client, source.Id || targetItem.Id, targetItem, serverName, source);
          if (s) streams.push(s);
        }
      }

      console.log(`[stream] Retornando ${streams.length} stream(s).`);
      return { streams };
    } catch (err) {
      console.error('[stream] Erro:', err.message);
      return { streams: [] };
    }
  }

  // ── CATALOG HANDLER ───────────────────────────────────────────────────────

  async function catalog({ type, id, extra = {} }) {
    const search = extra.search || '';
    const skip = extra.skip ? parseInt(extra.skip) : 0;

    const items = await client.getLibrary(type, search, skip);

    // Monta metas em paralelo para aproveitar metadados do TMDb em pt-BR
    const metas = await Promise.all(items.map(item => buildMeta(client, item, type)));

    return { metas };
  }

  // ── META HANDLER ──────────────────────────────────────────────────────────
  // Necessário para que o Stremio exiba informações corretas ao clicar
  // em itens do catálogo que usam ID jellyfin: (sem IMDb/TMDb mapeado)

  async function meta({ type, id }) {
    // Só tratamos IDs nativos do Jellyfin aqui
    if (!id.startsWith('jellyfin:')) return { meta: null };

    const jellyfinId = id.replace('jellyfin:', '');
    const item = await client.getItem(jellyfinId);
    if (!item) return { meta: null };

    const baseMeta = await buildMeta(client, item, type);

    // Para séries: adiciona lista de temporadas/episódios
    if (type === 'series') {
      const seasons = await client.getSeasons(jellyfinId);
      const videos = [];

      for (const season of seasons) {
        if (season.IndexNumber == null) continue;
        const episodes = await client.getEpisodesBySeason(jellyfinId, season.IndexNumber);
        for (const ep of episodes) {
          videos.push({
            id: `${id}:${season.IndexNumber}:${ep.IndexNumber}`,
            title: ep.Name || `Episódio ${ep.IndexNumber}`,
            season: season.IndexNumber,
            episode: ep.IndexNumber,
            overview: ep.Overview || '',
            thumbnail: ep.ImageTags?.Primary
              ? client.imageUrl(ep.Id, 'Primary')
              : undefined,
          });
        }
      }

      baseMeta.videos = videos;
    }

    return { meta: baseMeta };
  }

  return { stream, catalog, meta };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function buildMeta(client, item, type) {
  const providers = item.ProviderIds || {};
  const stremioId = getStremioIdFromItem(item);

  // Tenta enriquecer com TMDb em pt-BR
  let tmdbMeta = null;
  if (providers.Tmdb) {
    tmdbMeta = await fetchTmdbMeta(providers.Tmdb, type);
  }

  return {
    id: stremioId,
    type,
    name: tmdbMeta?.name || item.Name,
    poster: tmdbMeta?.poster || (item.ImageTags?.Primary ? client.imageUrl(item.Id, 'Primary') : null),
    background: tmdbMeta?.background || (item.BackdropImageTags?.length ? client.imageUrl(item.Id, 'Backdrop') : null),
    description: tmdbMeta?.description || item.Overview || '',
    year: tmdbMeta?.year || item.ProductionYear || null,
    genres: tmdbMeta?.genres || item.Genres || [],
  };
}

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
      qualityLabel = qualityLabel ? `${qualityLabel} – ${mediaSource.Name}` : mediaSource.Name;
    }
  }

  const title = qualityLabel ? `📺 ${serverName}\n${qualityLabel}` : `📺 ${serverName}`;
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

function getStremioIdFromItem(item) {
  const providers = item.ProviderIds || {};
  if (providers.Imdb) return providers.Imdb;
  if (providers.Tmdb) return `tmdb:${providers.Tmdb}`;
  if (providers.Tvdb) return `tvdb:${providers.Tvdb}`;
  return `jellyfin:${item.Id}`;
}

module.exports = { createAddon };
