'use strict';

const crypto = require('crypto');

function validateJellyfinUrl(url) {
  try {
    const parsed = new URL(url);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Invalid protocol');
    }

    const hostname = parsed.hostname.toLowerCase();
    if (!hostname) throw new Error('Empty hostname');

    // Instância local (localhost, IP privado, hostname docker/LAN) é permitida:
    // é o caso de uso principal (PC local priorizado com transcodificação).
    // Mantém-se apenas validação estrutural para barrar abuso óbvio.

    return parsed.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isLocalUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!host) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host);
    }
    if (!host.includes('.')) return true; // hostname docker / LAN
    if (/\.(local|lan|home|internal|corp)$/.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

function normalizeConfigToken(encoded) {
  const token = String(encoded || '').trim();
  if (!token) return null;

  const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
  return normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
}

function decodeConfigPayload(encoded) {
  const token = normalizeConfigToken(encoded);
  if (!token) return null;

  try {
    return Buffer.from(token, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function isSafePlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parseConfig(encoded) {
  try {
    const payload = decodeConfigPayload(encoded);
    if (!payload) return null;

    const json = JSON.parse(payload);
    if (!isSafePlainObject(json)) return null;

    const complete = (i) =>
      !!(i && typeof i.jellyfinUrl === 'string'
           && typeof i.userId === 'string'
           && typeof i.apiKey === 'string');

    // Aceita apenas UMA das instâncias: basta que primary OU secondary
    // esteja completo. Se só a secondary existir, mantém em secondary e o
    // route (getEffectiveConfig) a promove a primary ao consumir o config.
    const primary   = isSafePlainObject(json.primary) ? json.primary : (json.jellyfinUrl ? json : null);
    const secondary = isSafePlainObject(json.secondary) ? json.secondary : null;

    const pOk = complete(primary);
    const sOk = complete(secondary);
    if (!pOk && !sOk) return null;

    if (pOk) {
      primary.jellyfinUrl = validateJellyfinUrl(primary.jellyfinUrl);
      if (!primary.jellyfinUrl) return null;
    }
    if (sOk) {
      secondary.jellyfinUrl = validateJellyfinUrl(secondary.jellyfinUrl);
      if (!secondary.jellyfinUrl) delete json.secondary;
    }

    return json;
  } catch {
    return null;
  }
}

function configHash(config) {
  const str = JSON.stringify({
    p: config.primary?.userId || config.userId,
    s: config.secondary?.userId,
  });
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

module.exports = {
  validateJellyfinUrl,
  isLocalUrl,
  parseConfig,
  configHash,
  normalizeConfigToken,
  decodeConfigPayload,
};
