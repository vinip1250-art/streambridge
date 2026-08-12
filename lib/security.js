'use strict';

const crypto = require('crypto');

function validateJellyfinUrl(url) {
  try {
    const parsed = new URL(url);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Invalid protocol');
    }

    const hostname = parsed.hostname.toLowerCase();
    const privateRanges = [
      /^localhost$/i,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^::1$/,
      /^fe80:/i,
    ];

    if (privateRanges.some(r => r.test(hostname))) {
      throw new Error('Private IP not allowed');
    }

    return parsed.href.replace(/\/$/, '');
  } catch {
    return null;
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

    const primary = isSafePlainObject(json.primary) ? json.primary : json;
    if (!primary.jellyfinUrl || typeof primary.jellyfinUrl !== 'string') return null;
    if (!primary.userId || typeof primary.userId !== 'string') return null;
    if (!primary.apiKey || typeof primary.apiKey !== 'string') return null;

    primary.jellyfinUrl = validateJellyfinUrl(primary.jellyfinUrl);
    if (!primary.jellyfinUrl) return null;

    if (isSafePlainObject(json.secondary) && json.secondary.jellyfinUrl) {
      json.secondary.jellyfinUrl = validateJellyfinUrl(json.secondary.jellyfinUrl);
      if (!json.secondary.jellyfinUrl) delete json.secondary;
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
  parseConfig,
  configHash,
  normalizeConfigToken,
  decodeConfigPayload,
};
