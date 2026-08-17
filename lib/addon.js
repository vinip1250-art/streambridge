'use strict';

const crypto = require('crypto');
const cache  = require('./cache');
const health = require('./health');
const { configHash, isLocalUrl } = require('./security');

const CATALOG_TTL = parseInt(process.env.CATALOG_CACHE_TTL ?? '300000');
const META_TTL    = parseInt(process.env.META_CACHE_TTL    ?? '300000');
const STREAM_TTL  = parseInt(process.env.STREAM_CACHE_TTL  ?? '30000');
const IDMAP_TTL   = 60 * 60_000;
const IDMAP_FAIL  =  5 * 60_000;
const REMOTE_STREAM_TTL = 6 * 60 * 60_000;
const BASE_URL    = process.env.BASE_URL || 'http://localhost:7005';
const DEBUG       = process.env.DEBUG === 'true';

// ── Helpers ───────────────────────────────────────────────────────────────────

function jfHeaders(apiKey) {
  return { 'X-MediaBrowser-Token': apiKey, Accept: 'application/json' };
}

async function jfFetch(url, apiKey, timeoutMs = 5_000) {
  const res = await fetch(url, {
    headers: jfHeaders(apiKey),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${url}`);
  return res.json();
}

async function jfPostJson(url, apiKey, body = {}, timeoutMs = 8_000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...jfHeaders(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${url}`);
  return res.json();
}

async function getPlaybackInfo(inst, itemId) {
  const params = new URLSearchParams({
    UserId: inst.userId,
    StartTimeTicks: '0',
    IsPlayback: 'true',
    AutoOpenLiveStream: 'true',
    MaxStreamingBitrate: '140000000',
  });
  const url = `${inst.jellyfinUrl}/Items/${itemId}/PlaybackInfo?${params}`;

  try {
    return await jfPostJson(url, inst.apiKey, {
      UserId: inst.userId,
      DeviceProfile: {},
    });
  } catch (err) {
    if (DEBUG) console.warn(`[playback-info] POST fallback: ${err.message}`);
    return jfFetch(url, inst.apiKey, 8_000);
  }
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

function streamContainer(value) {
  const raw = String(value || '').split(',')[0].trim().toLowerCase();
  const safe = raw.replace(/[^a-z0-9]/g, '');
  if (!safe) return 'mp4';
  if (safe === 'mpegts') return 'ts';
  if (safe === 'matroska') return 'mkv';
  return safe;
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function firstPlayableSource(...groups) {
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    const source = group.find(s => s?.DirectStreamUrl || s?.TranscodingUrl || s?.Path || s?.Id);
    if (source) return source;
  }
  return null;
}

function getMediaSourceInfo(item, playbackInfo = null) {
  const source = firstPlayableSource(playbackInfo?.MediaSources, item?.MediaSources);
  const directUrl = source?.DirectStreamUrl || source?.TranscodingUrl || null;
  const remoteUrl = isHttpUrl(source?.Path) ? source.Path : null;

  return {
    id: source?.Id || item?.Id,
    container: streamContainer(source?.Container || item?.Container || (directUrl && 'm3u8')),
    directUrl,
    remoteUrl,
    headers: source?.RequiredHttpHeaders && typeof source.RequiredHttpHeaders === 'object'
      ? source.RequiredHttpHeaders
      : {},
  };
}

async function cacheProxySource(userKey, source) {
  const token = crypto.randomBytes(18).toString('base64url');
  await cache.set(`source:${userKey}:${token}`, source, REMOTE_STREAM_TTL);
  return token;
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

  const ok = (i) => !!(i && i.jellyfinUrl && i.userId && i.apiKey);
  let primary   = ok(config?.primary) ? config.primary : null;
  let secondary = config?.secondary?.jellyfinUrl ? config.secondary : null;

  // Aceita apenas uma das instâncias: se só a secondary está configurada,
  // promove-a para primary para que manifesto/catálogo/stream funcionem.
  if (!primary && ok(secondary)) {
    primary   = secondary;
    secondary = null;
  }

  return { primary, secondary };
}

// Instâncias locais primeiro (estável), para que a UI mostre a instância local
// antes da remota e suas fontes vençam a deduplicação de catálogo/meta/stream.
function sortInstances(insts) {
  return [...insts].sort(
    (a, b) => (isLocalUrl(b.jellyfinUrl) ? 1 : 0) - (isLocalUrl(a.jellyfinUrl) ? 1 : 0)
  );
}

// Remove campos internos (_role etc.) antes de embutir no configB64 do proxy.
function stripRole(inst) {
  if (!inst) return null;
  const { _role, ...rest } = inst;
  return rest;
}

// ── Cache de "dono" do itemId ─────────────────────────────────────────────────
// Armazena qual instância gerou cada UUID para rotear stream/meta corretamente.

async function setOwner(userKey, itemId, role) {
  await cache.set(`owner:${userKey}:${itemId}`, role, IDMAP_TTL);
}

async function getOwner(userKey, itemId) {
  return (await cache.get(`owner:${userKey}:${itemId}`)) ?? 'unknown';
}

// ── Resolução de ID entre instâncias ─────────────────────────────────────────
// Dado um ID da sourceInst, encontra o ID equivalente na targetInst
// por título+ano (filmes/séries) ou SeriesName+S/E (episódios).

async function resolveId(userKey, sourceId, sourceInst, targetInst) {
  const mapKey = `idmap:${userKey}:${sourceId}:${targetInst.jellyfinUrl}`;
  const cached = await cache.get(mapKey);
  if (typeof cached === 'string' && cached) return cached;

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

    if (!targetId && DEBUG) console.warn(`[idmap] "${item.Name}" não encontrado em ${targetInst.jellyfinUrl}`);
    await cache.set(mapKey, targetId, targetId ? IDMAP_TTL : IDMAP_FAIL);
    return targetId;
  } catch (err) {
    if (DEBUG) console.warn(`[idmap] Erro: ${err.message}`);
    await cache.set(mapKey, null, IDMAP_FAIL);
    return null;
  }
}

// ── Merge de episódios ────────────────────────────────────────────────────────
// Busca episódios das duas instâncias e une por S/E number.
// Episódios exclusivos de cada instância são adicionados normalmente.
// Episódios em ambas: usa o ID do ownerInst; armazena cross-reference bidirecional.

async function mergeEpisodes(userKey, seriesId, ownerInst, otherInst) {
  const ownerRole = ownerInst === 'primary_placeholder' ? 'primary' : ownerInst._role;

  // Resolve série ID na outra instância
  const otherSeriesId = otherInst
    ? await resolveId(userKey, seriesId, ownerInst, otherInst)
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
    await setOwner(userKey, ep.Id, ownerInst._role);
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
    await setOwner(userKey, ep.Id, otherInst._role);

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
      await cache.set(`idmap:${userKey}:${ownerEpId}:${otherInst.jellyfinUrl}`, ep.Id, IDMAP_TTL);
      await cache.set(`idmap:${userKey}:${ep.Id}:${ownerInst.jellyfinUrl}`, ownerEpId, IDMAP_TTL);
    }
  }

  return Array.from(epMap.values()).sort((a, b) => {
    if (a.season !== b.season) return a.season - b.season;
    return a.episode - b.episode;
  });
}

// ── Busca catálogos dinâmicos do Jellyfin ────────────────────────────────────

async function getUserViews(inst, userKey) {
  const ck = `views:${userKey}:${inst.jellyfinUrl}`;
  const cached = await cache.get(ck);
  if (cached) return cached;
  
  try {
    const data = await jfFetch(
      `${inst.jellyfinUrl}/Users/${inst.userId}/Views`,
      inst.apiKey,
      5_000
    );
    
    const views = (data.Items || [])
      .filter(v => ['movies', 'tvshows', 'homevideos'].includes(v.CollectionType))
      .map(v => ({
        id: v.Id,
        name: v.Name,
        type: v.CollectionType === 'tvshows' ? 'series' : 'movie',
      }));
    
    await cache.set(ck, views, 3600_000); // 1h TTL
    return views;
  } catch (err) {
    if (DEBUG) console.error('[getUserViews]', err.message);
    // Fallback para catálogos estáticos
    return [
      { id: 'all-movies', name: 'Filmes', type: 'movie' },
      { id: 'all-series', name: 'Séries', type: 'series' },
    ];
  }
}

// ── Addon factory ─────────────────────────────────────────────────────────────

function createAddon(rawConfig) {
  const { primary, secondary } = normalize(rawConfig);
  const userKey = configHash(rawConfig);

  // Anota role nas instâncias para uso em mergeEpisodes
  if (primary)   primary._role   = 'primary';
  if (secondary) secondary._role = 'secondary';

  // ── getDynamicCatalogs ────────────────────────────────────────────────────────
  async function getDynamicCatalogs(inst, role = 'primary') {
    const views = await getUserViews(inst, userKey);
    return views.map(v => ({
      type: v.type,
      id: `${role}:view-${v.id}`,
      name: `${inst.serverName ?? 'Jellyfin'} – ${v.name}`,
      extra: [{ name: 'search', isRequired: false }],
    }));
  }

  // ── catalog ──────────────────────────────────────────────────────────────────
  async function catalog({ type, id, extra = {} }) {
    const ck = `catalog:${userKey}:${type}:${id}:${extra.search ?? ""}`;
    const hit = await cache.get(ck);
    if (hit) return hit;

    const itemType = type === 'movie' ? 'Movie' : 'Series';
    const scoped = /^(primary|secondary):view-(.+)$/.exec(id);
    const scope = scoped?.[1] ?? null;
    const viewId = scoped?.[2] ?? (id.startsWith('view-') ? id.replace('view-', '') : null);

    const targets = sortInstances(
      scope === "secondary"
        ? (secondary ? [{ inst: secondary, role: "secondary" }] : [])
        : scope === "primary"
          ? [{ inst: primary, role: "primary" }]
          : [
              { inst: primary, role: "primary" },
              ...(secondary ? [{ inst: secondary, role: "secondary" }] : []),
            ]
    );

    function buildUrl(inst) {
      const p = new URLSearchParams({
        IncludeItemTypes: itemType, Recursive: 'true',
        Fields: 'Overview,Genres,ImageTags,CommunityRating,RunTimeTicks,ProductionYear',
        SortBy: 'SortName', SortOrder: 'Ascending', Limit: '500',
      });
      if (viewId && scope) p.set("ParentId", viewId);
      if (extra.search) p.set("SearchTerm", extra.search);
      return `${inst.jellyfinUrl}/Users/${inst.userId}/Items?${p}`;
    }

    const results = await Promise.allSettled(
      targets.map(({ inst }) => jfFetch(buildUrl(inst), inst.apiKey, 8_000))
    );

    const metas = [];
    const dedupeKey = item => `${item.Name.toLowerCase().trim()}:${item.ProductionYear ?? ""}`;
    const seen = new Map();

    for (let i = 0; i < results.length; i++) {
      const target = targets[i];
      const result = results[i];
      const items = result.status === "fulfilled" ? (result.value?.Items ?? []) : [];

      if (result.status === "rejected" && DEBUG) console.warn(`[catalog] ${target.role} error: ${result.reason?.message}`);

      for (const item of items) {
        await setOwner(userKey, item.Id, target.role);

        const key = dedupeKey(item);
        if (!seen.has(key)) {
          metas.push(toPreview(item, target.inst));
          seen.set(key, item.Id);
        } else if (target.role === "secondary" && primary && secondary) {
          const primaryId = seen.get(key);
          await cache.set(`idmap:${userKey}:${primaryId}:${secondary.jellyfinUrl}`, item.Id, IDMAP_TTL);
          await cache.set(`idmap:${userKey}:${item.Id}:${primary.jellyfinUrl}`, primaryId, IDMAP_TTL);
        }
      }
    }

    metas.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    const result = { metas };
    await cache.set(ck, result, CATALOG_TTL);
    return result;
  }  // ── meta ──────────────────────────────────────────────────────────────────────
  async function meta({ type, id }) {
    if (!id.startsWith('jellyfin:')) return { meta: null };
    const itemId = id.slice(9);
    const ck = `meta:${userKey}:${itemId}`;
    const hit = await cache.get(ck);
    if (hit) return hit;

    const owner    = await getOwner(userKey, itemId);
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
      if (DEBUG) console.warn(`[meta] ${ownerInst._role} error: ${err.message}`);
      if (otherInst) {
        try {
          const otherId = await resolveId(userKey, itemId, ownerInst, otherInst);
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
          if (DEBUG) console.warn(`[meta] ${otherInst._role} fallback error: ${err2.message}`);
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
      m.videos = await mergeEpisodes(userKey, itemId, ownerInst, otherInst ?? null);
    }

    const result = { meta: m };
    await cache.set(ck, result, META_TTL);
    return result;
  }

  // ── stream ────────────────────────────────────────────────────────────────────
  // Secondary primeiro (Nitro5 → melhor transcodificação).
  // Usa cache de owner para rotear o ID correto a cada instância.
  async function stream({ type, id }) {
    if (!id.startsWith('jellyfin:')) return { streams: [] };
    const requestedId = id.slice(9);
    const ck = `stream:${userKey}:${requestedId}`;
    const hit = await cache.get(ck);
    if (hit) return hit;

    const streams = [];
    const owner = await getOwner(userKey, requestedId);

    const ordered = sortInstances([
      secondary ? { ...secondary, role: 'secondary' } : null,
      { ...primary, role: 'primary' },
    ].filter(Boolean));

    const configB64 = Buffer.from(JSON.stringify({
      primary:   stripRole(primary),
      secondary: stripRole(secondary),
    })).toString('base64url');

    for (const inst of ordered) {
      if (inst.role === 'secondary') {
        const alive = await health.ping(inst.jellyfinUrl, inst.apiKey);
        if (!alive) {
          if (DEBUG) console.log(`[stream] ${inst.serverName} offline – pulando.`);
          continue;
        }
      }

      try {
        let nativeId = requestedId;
        let item;

        // Tenta primeiro direto: este UUID pode ser nativo da instância
        // (owner cache expirou, item veio da outra instância, etc.)
        try {
          item = await jfFetch(
            `${inst.jellyfinUrl}/Users/${inst.userId}/Items/${nativeId}?Fields=MediaSources,Path,Container`,
            inst.apiKey, 3_000,
          );
        } catch {
          // Não é nativo desta instância → cruza a partir da instância dona
          const sourceInst = (owner === 'secondary' && secondary) ? secondary : primary;
          if (!sourceInst || sourceInst.jellyfinUrl === inst.jellyfinUrl) {
            if (DEBUG) console.log(`[stream] ${inst.serverName}: UUID não encontrado – pulando.`);
            continue;
          }
          nativeId = await resolveId(userKey, requestedId, sourceInst, inst);
          if (!nativeId) {
            if (DEBUG) console.log(`[stream] ${inst.serverName}: sem cross-ref – pulando.`);
            continue;
          }
          try {
            item = await jfFetch(
              `${inst.jellyfinUrl}/Users/${inst.userId}/Items/${nativeId}?Fields=MediaSources,Path,Container`,
              inst.apiKey, 3_000,
            );
          } catch {
            if (DEBUG) console.log(`[stream] ${inst.serverName}: item cross-ref não encontrado – pulando.`);
            continue;
          }
        }

        const playbackInfo = await getPlaybackInfo(inst, nativeId).catch(err => {
          if (DEBUG) console.warn(`[stream] playback-info ${inst.role}: ${err.message}`);
          return null;
        });
        const media = getMediaSourceInfo(item, playbackInfo);
        if (!media.id && !media.directUrl && !media.remoteUrl) throw new Error('MediaSource not found');

        const local       = isLocalUrl(inst.jellyfinUrl);
        const serverName = inst.serverName?.trim() || (local ? 'Local' : 'VPS');
        const icon       = local ? '🖥️' : '☁️';
        let proxyUrl;

        if (media.directUrl || media.remoteUrl) {
          const token = await cacheProxySource(userKey, {
            role: inst.role,
            url: media.directUrl || media.remoteUrl,
            isRelative: Boolean(media.directUrl),
            headers: media.headers,
          });
          proxyUrl = `${BASE_URL}/${configB64}/proxy-source/${token}/stream.${media.container}`;
        } else {
          proxyUrl = `${BASE_URL}/${configB64}/proxy/${inst.role}/${nativeId}/stream.${media.container}?msid=${encodeURIComponent(media.id)}`;
        }

        // URL de proxy seguro (sem API key exposta)
        streams.push({
          url:   proxyUrl,
          name:  `${icon} ${serverName}`,
          title: 'StreamBridge',
          behaviorHints: { notWebReady: false },
        });

        if (DEBUG) console.log(`[stream] ${icon} ${serverName} (owner:${owner}) → ${nativeId}`);
      } catch (err) {
        if (DEBUG) console.warn(`[stream] ${inst.role} error: ${err.message}`);
      }
    }

    const result = { streams };
    await cache.set(ck, result, STREAM_TTL);
    return result;
  }

  return { catalog, meta, stream, getDynamicCatalogs };
}

module.exports = { createAddon };
