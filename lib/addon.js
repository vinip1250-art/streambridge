'use strict';

const cache  = require('./cache');
const health = require('./health');

const CATALOG_TTL = parseInt(process.env.CATALOG_CACHE_TTL ?? '300000');
const META_TTL    = parseInt(process.env.META_CACHE_TTL    ?? '300000');
const STREAM_TTL  = parseInt(process.env.STREAM_CACHE_TTL  ?? '30000');
const IDMAP_TTL   = 60 * 60_000;
const IDMAP_FAIL  =  5 * 60_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function jfHeaders(apiKey) {
  return { 'X-MediaBrowser-Token': apiKey, Accept: 'application/json' };
}

async function jfFetch(url, apiKey, timeoutMs = 10_000) {
  const res = await fetch(url, {
    headers: jfHeaders(apiKey),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${url}`);
  return res.json();
}

function toPreview(item, inst) {
  return {
    id:          `jellyfin:${item.Id}`,
    type:        item.Type === 'Series' ? 'series' : 'movie',
    name:        item.Name,
    year:        item.ProductionYear,
    poster:      item.ImageTags?.Primary
      ? `${inst.jellyfinUrl}/Items/${item.Id}/Images/Primary?api_key=${inst.apiKey}&maxHeight=600`
      : undefined,
    description: item.Overview,
    genres:      item.Genres ?? [],
    imdbRating:  item.CommunityRating,
    runtime:     item.RunTimeTicks
      ? `${Math.round(item.RunTimeTicks / 600_000_000)} min`
      : undefined,
  };
}

function normalize(config) {
  if (config?.jellyfinUrl) {
    return {
      primary: {
        jellyfinUrl: config.jellyfinUrl,
        userId:      config.userId,
        apiKey:      config.apiKey,
        serverName:  config.serverName ?? 'VPS',
      },
      secondary: null,
    };
  }
  return {
    primary:   config?.primary ?? null,
    secondary: config?.secondary?.jellyfinUrl ? config.secondary : null,
  };
}

// ── Cache de "dono" do itemId ─────────────────────────────────────────────────
// Armazena qual instância gerou cada UUID para rotear stream/meta corretamente.

function setOwner(itemId, role) {
  cache.set(`owner:${itemId}`, role, IDMAP_TTL);
}

function getOwner(itemId) {
  return cache.get(`owner:${itemId}`) ?? 'unknown';
}

// ── Resolução de ID entre instâncias ─────────────────────────────────────────
// Dado um ID da sourceInst, encontra o ID equivalente na targetInst
// por título+ano (filmes/séries) ou SeriesName+S/E (episódios).

async function resolveId(sourceId, sourceInst, targetInst) {
  const mapKey = `idmap:${sourceId}:${targetInst.jellyfinUrl}`;
  const cached = cache.get(mapKey);
  if (cached !== undefined) return cached;

  try {
    const item = await jfFetch(
      `${sourceInst.jellyfinUrl}/Users/${sourceInst.userId}/Items/${sourceId}` +
      `?Fields=SeriesName,ParentIndexNumber,IndexNumber`,
      sourceInst.apiKey, 5_000,
    );

    let targetId = null;

    if (item.Type === 'Episode') {
      const seriesSearch = await jfFetch(
        `${targetInst.jellyfinUrl}/Users/${targetInst.userId}/Items` +
        `?SearchTerm=${encodeURIComponent(item.SeriesName)}&IncludeItemTypes=Series&Recursive=true&Limit=5`,
        targetInst.apiKey, 5_000,
      );
      const series =
        seriesSearch.Items?.find(s => s.Name.toLowerCase() === item.SeriesName.toLowerCase()) ??
        seriesSearch.Items?.[0];

      if (series) {
        const epList = await jfFetch(
          `${targetInst.jellyfinUrl}/Shows/${series.Id}/Episodes` +
          `?UserId=${targetInst.userId}&Season=${item.ParentIndexNumber}&Fields=IndexNumber`,
          targetInst.apiKey, 5_000,
        );
        targetId = epList.Items?.find(e => e.IndexNumber === item.IndexNumber)?.Id ?? null;
      }
    } else {
      const p = new URLSearchParams({
        SearchTerm: item.Name, IncludeItemTypes: item.Type,
        Recursive: 'true', Limit: '5',
      });
      if (item.ProductionYear) p.set('Years', String(item.ProductionYear));

      const results = await jfFetch(
        `${targetInst.jellyfinUrl}/Users/${targetInst.userId}/Items?${p}`,
        targetInst.apiKey, 5_000,
      );
      targetId =
        results.Items?.find(i => i.Name.toLowerCase() === item.Name.toLowerCase())?.Id ??
        results.Items?.[0]?.Id ?? null;
    }

    if (!targetId) console.warn(`[idmap] "${item.Name}" não encontrado em ${targetInst.jellyfinUrl}`);
    cache.set(mapKey, targetId, targetId ? IDMAP_TTL : IDMAP_FAIL);
    return targetId;
  } catch (err) {
    console.warn(`[idmap] Erro: ${err.message}`);
    cache.set(mapKey, null, IDMAP_FAIL);
    return null;
  }
}

// ── Merge de episódios ────────────────────────────────────────────────────────
// Busca episódios das duas instâncias e une por S/E number.
// Episódios exclusivos de cada instância são adicionados normalmente.
// Episódios em ambas: usa o ID do ownerInst; armazena cross-reference bidirecional.

async function mergeEpisodes(seriesId, ownerInst, otherInst) {
  const ownerRole = ownerInst === 'primary_placeholder' ? 'primary' : ownerInst._role;

  // Resolve série ID na outra instância
  const otherSeriesId = otherInst
    ? await resolveId(seriesId, ownerInst, otherInst)
    : null;

  const [ownerResult, otherResult] = await Promise.allSettled([
    jfFetch(
      `${ownerInst.jellyfinUrl}/Shows/${seriesId}/Episodes` +
      `?UserId=${ownerInst.userId}&Fields=Overview,ImageTags`,
      ownerInst.apiKey,
    ),
    otherInst && otherSeriesId
      ? jfFetch(
          `${otherInst.jellyfinUrl}/Shows/${otherSeriesId}/Episodes` +
          `?UserId=${otherInst.userId}&Fields=Overview,ImageTags`,
          otherInst.apiKey,
        )
      : Promise.resolve(null),
  ]);

  const ownerEps = ownerResult.status === 'fulfilled' ? (ownerResult.value?.Items ?? []) : [];
  const otherEps = otherResult.status === 'fulfilled' ? (otherResult.value?.Items ?? []) : [];

  if (ownerResult.status === 'rejected') console.warn('[merge] owner eps error:', ownerResult.reason?.message);
  if (otherResult.status === 'rejected') console.warn('[merge] other eps error:', otherResult.reason?.message);

  const epMap = new Map(); // `S{n}E{n}` → video object

  for (const ep of ownerEps) {
    const key = `S${ep.ParentIndexNumber ?? 0}E${ep.IndexNumber ?? 0}`;
    setOwner(ep.Id, ownerInst._role);
    epMap.set(key, {
      id:        `jellyfin:${ep.Id}`,
      title:     ep.Name ?? `Ep ${ep.IndexNumber}`,
      season:    ep.ParentIndexNumber ?? 1,
      episode:   ep.IndexNumber ?? 0,
      overview:  ep.Overview,
      thumbnail: ep.ImageTags?.Primary
        ? `${ownerInst.jellyfinUrl}/Items/${ep.Id}/Images/Primary?api_key=${ownerInst.apiKey}`
        : undefined,
    });
  }

  for (const ep of otherEps) {
    const key = `S${ep.ParentIndexNumber ?? 0}E${ep.IndexNumber ?? 0}`;
    setOwner(ep.Id, otherInst._role);

    if (!epMap.has(key)) {
      // Episódio exclusivo da outra instância
      epMap.set(key, {
        id:        `jellyfin:${ep.Id}`,
        title:     ep.Name ?? `Ep ${ep.IndexNumber}`,
        season:    ep.ParentIndexNumber ?? 1,
        episode:   ep.IndexNumber ?? 0,
        overview:  ep.Overview,
        thumbnail: ep.ImageTags?.Primary
          ? `${otherInst.jellyfinUrl}/Items/${ep.Id}/Images/Primary?api_key=${otherInst.apiKey}`
          : undefined,
      });
    } else {
      // Episódio em ambas → armazena cross-reference bidirecional
      const ownerEpId = epMap.get(key).id.slice(9);
      cache.set(`idmap:${ownerEpId}:${otherInst.jellyfinUrl}`, ep.Id, IDMAP_TTL);
      cache.set(`idmap:${ep.Id}:${ownerInst.jellyfinUrl}`, ownerEpId, IDMAP_TTL);
    }
  }

  return Array.from(epMap.values()).sort((a, b) => {
    if (a.season !== b.season) return a.season - b.season;
    return a.episode - b.episode;
  });
}

// ── Addon factory ─────────────────────────────────────────────────────────────

function createAddon(rawConfig) {
  const { primary, secondary } = normalize(rawConfig);

  // Anota role nas instâncias para uso em mergeEpisodes
  if (primary)   primary._role   = 'primary';
  if (secondary) secondary._role = 'secondary';

  // ── catalog ──────────────────────────────────────────────────────────────────
  async function catalog({ type, id, extra = {} }) {
    const ck = `catalog:${primary.jellyfinUrl}:${type}:${id}:${extra.search ?? ''}`;
    const hit = cache.get(ck);
    if (hit) return hit;

    const itemType = type === 'movie' ? 'Movie' : 'Series';

    function buildUrl(inst) {
      const p = new URLSearchParams({
        IncludeItemTypes: itemType, Recursive: 'true',
        Fields: 'Overview,Genres,ImageTags,CommunityRating,RunTimeTicks,ProductionYear',
        SortBy: 'SortName', SortOrder: 'Ascending', Limit: '500',
      });
      if (extra.search) p.set('SearchTerm', extra.search);
      return `${inst.jellyfinUrl}/Users/${inst.userId}/Items?${p}`;
    }

    const [primaryData, secondaryData] = await Promise.allSettled([
      jfFetch(buildUrl(primary), primary.apiKey),
      secondary ? jfFetch(buildUrl(secondary), secondary.apiKey) : Promise.resolve(null),
    ]);

    const primaryItems   = primaryData.status   === 'fulfilled' ? (primaryData.value?.Items   ?? []) : [];
    const secondaryItems = secondaryData.status === 'fulfilled' ? (secondaryData.value?.Items ?? []) : [];

    if (primaryData.status   === 'rejected') console.warn('[catalog] primary error:',   primaryData.reason?.message);
    if (secondaryData.status === 'rejected') console.warn('[catalog] secondary error:', secondaryData.reason?.message);

    const dedupeKey = item => `${item.Name.toLowerCase().trim()}:${item.ProductionYear ?? ''}`;
    const seen  = new Map(); // dedupeKey → primaryId
    const metas = [];

    for (const item of primaryItems) {
      setOwner(item.Id, 'primary');
      seen.set(dedupeKey(item), item.Id);
      metas.push(toPreview(item, primary));
    }

    for (const item of secondaryItems) {
      const key = dedupeKey(item);
      setOwner(item.Id, 'secondary');

      if (!seen.has(key)) {
        // Exclusivo do secondary
        metas.push(toPreview(item, secondary));
        seen.set(key, item.Id);
      } else {
        // Existe em ambos — armazena cross-reference no catalog
        const primaryId = seen.get(key);
        cache.set(`idmap:${primaryId}:${secondary.jellyfinUrl}`, item.Id, IDMAP_TTL);
        cache.set(`idmap:${item.Id}:${primary.jellyfinUrl}`, primaryId, IDMAP_TTL);
      }
    }

    metas.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    const result = { metas };
    cache.set(ck, result, CATALOG_TTL);
    return result;
  }

  // ── meta ──────────────────────────────────────────────────────────────────────
  async function meta({ type, id }) {
    if (!id.startsWith('jellyfin:')) return { meta: null };
    const itemId = id.slice(9);
    const ck = `meta:${itemId}`;
    const hit = cache.get(ck);
    if (hit) return hit;

    const owner    = getOwner(itemId);
    const ownerInst = (owner === 'secondary' && secondary) ? secondary : primary;
    const otherInst = ownerInst === primary ? secondary : primary;

    let item = null;
    let usedInst = ownerInst;

    // Tenta instância dona; fallback para a outra
    try {
      const p = new URLSearchParams({
        Fields: 'Overview,Genres,ImageTags,BackdropImageTags,CommunityRating,RunTimeTicks,ProductionYear,Studios,People',
      });
      item = await jfFetch(
        `${ownerInst.jellyfinUrl}/Users/${ownerInst.userId}/Items/${itemId}?${p}`,
        ownerInst.apiKey,
      );
    } catch (err) {
      console.warn(`[meta] ${ownerInst._role} error: ${err.message}`);
      if (otherInst) {
        try {
          const otherId = await resolveId(itemId, ownerInst, otherInst);
          if (otherId) {
            const p = new URLSearchParams({
              Fields: 'Overview,Genres,ImageTags,BackdropImageTags,CommunityRating,RunTimeTicks,ProductionYear,Studios,People',
            });
            item = await jfFetch(
              `${otherInst.jellyfinUrl}/Users/${otherInst.userId}/Items/${otherId}?${p}`,
              otherInst.apiKey,
            );
            usedInst = otherInst;
          }
        } catch (err2) {
          console.warn(`[meta] ${otherInst._role} fallback error: ${err2.message}`);
        }
      }
    }

    if (!item) return { meta: null };

    const nativeId = item.Id;
    const m = {
      id:          `jellyfin:${itemId}`,
      type:        item.Type === 'Series' ? 'series' : 'movie',
      name:        item.Name,
      year:        item.ProductionYear,
      poster:      item.ImageTags?.Primary
        ? `${usedInst.jellyfinUrl}/Items/${nativeId}/Images/Primary?api_key=${usedInst.apiKey}&maxHeight=600`
        : undefined,
      background:  item.BackdropImageTags?.length
        ? `${usedInst.jellyfinUrl}/Items/${nativeId}/Images/Backdrop/0?api_key=${usedInst.apiKey}`
        : undefined,
      description: item.Overview,
      genres:      item.Genres ?? [],
      imdbRating:  item.CommunityRating,
      runtime:     item.RunTimeTicks
        ? `${Math.round(item.RunTimeTicks / 600_000_000)} min`
        : undefined,
      cast:        (item.People ?? []).filter(p => p.Type === 'Actor').slice(0, 10).map(p => p.Name),
      director:    (item.People ?? []).filter(p => p.Type === 'Director').map(p => p.Name),
      studio:      (item.Studios ?? []).map(s => s.Name).join(', ') || undefined,
    };

    if (type === 'series') {
      // Mescla episódios de ambas instâncias
      m.videos = await mergeEpisodes(itemId, ownerInst, otherInst ?? null);
    }

    const result = { meta: m };
    cache.set(ck, result, META_TTL);
    return result;
  }

  // ── stream ────────────────────────────────────────────────────────────────────
  // Secondary primeiro (Nitro5 → melhor transcodificação).
  // Usa cache de owner para rotear o ID correto a cada instância.
  async function stream({ type, id }) {
    if (!id.startsWith('jellyfin:')) return { streams: [] };
    const requestedId = id.slice(9);
    const ck = `stream:${requestedId}`;
    const hit = cache.get(ck);
    if (hit) return hit;

    const streams = [];
    const owner = getOwner(requestedId);

    const ordered = [
      secondary ? { ...secondary, role: 'secondary' } : null,
      { ...primary, role: 'primary' },
    ].filter(Boolean);

    for (const inst of ordered) {
      if (inst.role === 'secondary') {
        const alive = await health.ping(inst.jellyfinUrl, inst.apiKey);
        if (!alive) {
          console.log(`[stream] ${inst.serverName} offline – pulando.`);
          continue;
        }
      }

      try {
        let nativeId;

        if (inst.role === 'secondary') {
          if (owner === 'secondary') {
            // UUID pertence ao secondary → usa direto
            nativeId = requestedId;
          } else {
            // UUID pertence ao primary → cross-reference
            nativeId = await resolveId(requestedId, primary, inst);
            if (!nativeId) {
              console.log(`[stream] ${inst.serverName}: sem cross-ref – pulando.`);
              continue;
            }
          }
        } else {
          // primary
          if (owner === 'secondary' && secondary) {
            // UUID pertence ao secondary → cross-reference para primary
            nativeId = await resolveId(requestedId, secondary, inst);
            if (!nativeId) {
              console.log(`[stream] primary: item exclusivo do secondary sem cross-ref – pulando.`);
              continue;
            }
          } else {
            // UUID do primary (ou unknown) → usa direto
            nativeId = requestedId;
          }
        }

        // Confirma existência na instância
        await jfFetch(
          `${inst.jellyfinUrl}/Users/${inst.userId}/Items/${nativeId}?Fields=Id`,
          inst.apiKey, 3_000,
        );

        const serverName = inst.serverName?.trim() || (inst.role === 'secondary' ? 'Local' : 'VPS');
        const icon       = inst.role === 'secondary' ? '🖥️' : '☁️';

        streams.push({
          url:   `${inst.jellyfinUrl}/Videos/${nativeId}/stream` +
                 `?api_key=${inst.apiKey}&static=true&mediaSourceId=${nativeId}`,
          name:  `${icon} ${serverName}`,
          title: 'StreamBridge',
          behaviorHints: { notWebReady: false },
        });

        console.log(`[stream] ${icon} ${serverName} (owner:${owner}) → ${nativeId}`);
      } catch (err) {
        console.warn(`[stream] ${inst.role} error: ${err.message}`);
      }
    }

    const result = { streams };
    cache.set(ck, result, STREAM_TTL);
    return result;
  }

  return { catalog, meta, stream };
}

module.exports = { createAddon };
