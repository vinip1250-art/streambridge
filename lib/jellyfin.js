const axios = require('axios');

/**
 * Cliente para a API do Jellyfin.
 * Todas as chamadas autenticam via query param ?api_key=TOKEN
 * para que a URL final possa ser reproduzida diretamente pelo ExoPlayer.
 */
class JellyfinClient {
  constructor({ jellyfinUrl, userId, apiKey }) {
    this.baseUrl = jellyfinUrl.replace(/\/$/, '');
    this.userId = userId;
    this.apiKey = apiKey;
  }

  // Monta URL autenticada para reprodução direta
  streamUrl(itemId) {
    return `${this.baseUrl}/Videos/${itemId}/stream?static=true&api_key=${this.apiKey}`;
  }

  // Monta URL de poster/thumbnail
  imageUrl(itemId, type = 'Primary') {
    return `${this.baseUrl}/Items/${itemId}/Images/${type}?api_key=${this.apiKey}&maxHeight=600`;
  }

  // Requisição genérica à API
  async get(path, params = {}) {
    const url = `${this.baseUrl}${path}`;
    const response = await axios.get(url, {
      params: { api_key: this.apiKey, ...params },
      timeout: 10000,
    });
    return response.data;
  }

  // ── Busca itens por providerIds (IMDb, TMDb, etc.) ──────────────────────────

  async findByProviderId(providerId, providerValue, itemType = null) {
    try {
      const includeTypes = itemType
        ? itemType === 'movie' ? 'Movie' : 'Series'
        : 'Movie,Series';

      const data = await this.get(`/Users/${this.userId}/Items`, {
        AnyProviderIdEquals: `${providerId}.${providerValue}`,
        IncludeItemTypes: includeTypes,
        Fields: 'ProviderIds,MediaSources,Path',
        Recursive: true,
        Limit: 1,
      });
      return data.Items || [];
    } catch {
      return [];
    }
  }

  // Resolve IMDb/TMDb/Tvdb/Anidb para itens do Jellyfin
  async resolveStremioId(stremioId, type = null) {
    let items = [];

    if (stremioId.startsWith('tt')) {
      items = await this.findByProviderId('Imdb', stremioId, type);
    } else if (stremioId.startsWith('tmdb:')) {
      items = await this.findByProviderId('Tmdb', stremioId.replace('tmdb:', ''), type);
    } else if (stremioId.startsWith('tvdb:')) {
      items = await this.findByProviderId('Tvdb', stremioId.replace('tvdb:', ''), type);
    } else if (stremioId.startsWith('anidb:')) {
      items = await this.findByProviderId('AniDb', stremioId.replace('anidb:', ''), type);
    } else if (stremioId.startsWith('jellyfin:')) {
      const jellyfinId = stremioId.replace('jellyfin:', '');
      try {
        const item = await this.get(`/Users/${this.userId}/Items/${jellyfinId}`, {
          Fields: 'ProviderIds,MediaSources,Path',
        });
        items = [item];
      } catch {
        items = [];
      }
    }

    return items;
  }

  // ── Episódio específico ─────────────────────────────────────────────────────

  // SeasonNumber filtra corretamente por temporada na API do Jellyfin
  async getEpisode(seriesId, season, episode) {
    try {
      const data = await this.get(`/Shows/${seriesId}/Episodes`, {
        UserId: this.userId,
        SeasonNumber: season,
        Fields: 'MediaSources,Path,ProviderIds',
      });
      const episodes = data.Items || [];
      console.log(`[getEpisode] seriesId=${seriesId} S${season}E${episode} — ${episodes.length} eps retornados pela API`);
      const found = episodes.find(e => e.IndexNumber === episode) || null;
      if (!found) console.log(`[getEpisode] Episódio E${episode} não encontrado. Índices disponíveis:`, episodes.map(e => e.IndexNumber));
      return found;
    } catch (err) {
      console.error(`[getEpisode] erro:`, err.message);
      return null;
    }
  }

  // ── Catálogo ────────────────────────────────────────────────────────────────

  async getLibrary(type, search = '', skip = 0, limit = 50) {
    const includeType = type === 'movie' ? 'Movie' : 'Series';
    const params = {
      UserId: this.userId,
      IncludeItemTypes: includeType,
      Recursive: true,
      Fields: 'ProviderIds,Overview,Genres',
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      StartIndex: skip,
      Limit: limit,
    };
    if (search) {
      params.SearchTerm = search;
    }
    try {
      const data = await this.get(`/Users/${this.userId}/Items`, params);
      return data.Items || [];
    } catch {
      return [];
    }
  }

  // ── Legendas ────────────────────────────────────────────────────────────────

  getSubtitleUrl(itemId, subtitleIndex) {
    return `${this.baseUrl}/Videos/${itemId}/Subtitles/${subtitleIndex}/Stream.srt?api_key=${this.apiKey}`;
  }

  extractSubtitles(mediaSources) {
    if (!mediaSources || !mediaSources.length) return [];
    const source = mediaSources[0];
    const streams = source.MediaStreams || [];
    return streams
      .filter(s => s.Type === 'Subtitle' && s.IsExternal !== false)
      .map(s => ({
        id: String(s.Index),
        url: this.getSubtitleUrl(source.Id, s.Index),
        lang: s.Language || 'und',
        label: s.DisplayTitle || s.Language || 'Legenda',
      }));
  }
}

module.exports = JellyfinClient;
