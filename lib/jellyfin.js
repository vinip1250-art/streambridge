const axios = require('axios');

class JellyfinClient {
  constructor({ jellyfinUrl, userId, apiKey }) {
    this.baseUrl = jellyfinUrl.replace(/\/$/, '');
    this.userId = userId;
    this.apiKey = apiKey;
  }

  streamUrl(itemId) {
    return `${this.baseUrl}/Videos/${itemId}/stream?static=true&api_key=${this.apiKey}`;
  }

  imageUrl(itemId, type = 'Primary') {
    return `${this.baseUrl}/Items/${itemId}/Images/${type}?api_key=${this.apiKey}&maxHeight=600`;
  }

  async get(path, params = {}) {
    const url = `${this.baseUrl}${path}`;
    const response = await axios.get(url, {
      params: { api_key: this.apiKey, ...params },
      timeout: 10000,
    });
    return response.data;
  }

  // ── Busca por providerId com filtro LOCAL ────────────────────────────────
  // AnyProviderIdEquals tem comportamento inconsistente no Jellyfin —
  // buscamos com filtro amplo e comparamos localmente para garantir precisão.

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
        Limit: 10, // pega alguns para filtrar localmente
      });

      const items = data.Items || [];

      // Filtro local: garante que o providerId bate exatamente
      const normalizedValue = String(providerValue).toLowerCase();
      const filtered = items.filter(item => {
        const providers = item.ProviderIds || {};
        // Tenta todas as variações de capitalização da chave
        for (const key of Object.keys(providers)) {
          if (key.toLowerCase() === providerId.toLowerCase()) {
            if (String(providers[key]).toLowerCase() === normalizedValue) {
              return true;
            }
          }
        }
        return false;
      });

      console.log(`[findByProviderId] ${providerId}=${providerValue} → API retornou ${items.length}, após filtro local: ${filtered.length}`);
      return filtered;
    } catch (err) {
      console.error(`[findByProviderId] erro:`, err.message);
      return [];
    }
  }

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

  // ── Episódio específico ──────────────────────────────────────────────────

  async getEpisode(seriesId, season, episode) {
    try {
      const data = await this.get(`/Shows/${seriesId}/Episodes`, {
        UserId: this.userId,
        SeasonNumber: season,
        Fields: 'MediaSources,Path,ProviderIds,IndexNumber,ParentIndexNumber',
      });

      const episodes = data.Items || [];
      console.log(`[getEpisode] seriesId=${seriesId} S${season}E${episode} — ${episodes.length} eps retornados`);

      if (episodes.length > 0) {
        console.log(`[getEpisode] IndexNumbers disponíveis:`, episodes.map(e => `E${e.IndexNumber}(${e.Name})`));
      }

      const found = episodes.find(e => e.IndexNumber === episode);
      if (!found) {
        console.log(`[getEpisode] E${episode} não encontrado. Tentando sem filtro de temporada...`);
        // Fallback: busca todos os episódios e filtra por temporada + episódio
        return this.getEpisodeFallback(seriesId, season, episode);
      }
      return found;
    } catch (err) {
      console.error(`[getEpisode] erro:`, err.message);
      return null;
    }
  }

  // Fallback: busca todos os episódios sem filtrar por temporada na API
  async getEpisodeFallback(seriesId, season, episode) {
    try {
      const data = await this.get(`/Shows/${seriesId}/Episodes`, {
        UserId: this.userId,
        Fields: 'MediaSources,Path,IndexNumber,ParentIndexNumber',
      });
      const episodes = data.Items || [];
      console.log(`[getEpisodeFallback] Total de episódios na série: ${episodes.length}`);

      const found = episodes.find(
        e => e.ParentIndexNumber === season && e.IndexNumber === episode
      );
      console.log(`[getEpisodeFallback] S${season}E${episode} ${found ? 'ENCONTRADO' : 'NÃO encontrado'}`);
      return found || null;
    } catch (err) {
      console.error(`[getEpisodeFallback] erro:`, err.message);
      return null;
    }
  }

  // ── Catálogo ─────────────────────────────────────────────────────────────

  async getLibrary(type, search = '', skip = 0, limit = 50) {
    const includeType = type === 'movie' ? 'Movie' : 'Series';
    const params = {
      UserId: this.userId,
      IncludeItemTypes: includeType,
      Recursive: true,
      Fields: 'ProviderIds,Overview,Genres,ImageTags,BackdropImageTags',
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      StartIndex: skip,
      Limit: limit,
    };
    if (search) params.SearchTerm = search;

    try {
      const data = await this.get(`/Users/${this.userId}/Items`, params);
      return data.Items || [];
    } catch {
      return [];
    }
  }

  // Busca item único com todos os metadados
  async getItem(jellyfinId) {
    try {
      return await this.get(`/Users/${this.userId}/Items/${jellyfinId}`, {
        Fields: 'ProviderIds,Overview,Genres,People,MediaSources,Path,ImageTags,BackdropImageTags',
      });
    } catch {
      return null;
    }
  }

  // Busca episódios de uma série para montar o meta completo
  async getSeasons(seriesId) {
    try {
      const data = await this.get(`/Shows/${seriesId}/Seasons`, {
        UserId: this.userId,
        Fields: 'IndexNumber',
      });
      return data.Items || [];
    } catch {
      return [];
    }
  }

  async getEpisodesBySeason(seriesId, seasonNumber) {
    try {
      const data = await this.get(`/Shows/${seriesId}/Episodes`, {
        UserId: this.userId,
        SeasonNumber: seasonNumber,
        Fields: 'IndexNumber,Overview,ImageTags',
      });
      return data.Items || [];
    } catch {
      return [];
    }
  }

  // ── Legendas ─────────────────────────────────────────────────────────────

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
