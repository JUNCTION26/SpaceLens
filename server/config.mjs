/**
 * Reads and validates settings from the environment once, at startup.
 * Every problem is collected and reported together, so a bad deploy fails in one go
 * with a readable list instead of crashing later on the first request.
 */

export const DEFAULT_ORIGINS = [
  'https://junction26.github.io',
  'http://localhost:5180',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5180',
];

/** Fast and mid-size text models the app routes between. Larger models stay off unless listed. */
export const DEFAULT_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-4-hydrogen',
];

import { DEFAULT_IMAGE_MODELS, DEFAULT_TTS_MODELS } from './media.mjs';

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,62}$/;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'];

/** @param {Record<string, string | undefined>} env */
export function loadConfig(env = process.env) {
  const problems = [];
  const str = (name, fallback = '') => (env[name] ?? '').trim() || fallback;
  const int = (name, fallback, min, max) => {
    const raw = str(name);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}`);
      return fallback;
    }
    return n;
  };
  const bool = (name, fallback) => {
    const raw = str(name).toLowerCase();
    if (!raw) return fallback;
    if (['1', 'true', 'yes'].includes(raw)) return true;
    if (['0', 'false', 'no'].includes(raw)) return false;
    problems.push(`${name} must be true or false`);
    return fallback;
  };
  const list = (name, fallback) => {
    const raw = str(name);
    return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : fallback;
  };

  const apiKey = str('GEMINI_API_KEY');
  if (!apiKey) problems.push('GEMINI_API_KEY is required');
  else if (apiKey.length < 20 || /\s/.test(apiKey)) problems.push('GEMINI_API_KEY does not look like an API key');

  const origins = list('ALLOWED_ORIGINS', DEFAULT_ORIGINS);
  for (const o of origins) if (!isOriginPattern(o)) problems.push(`ALLOWED_ORIGINS entry is not an origin: ${o}`);

  const models = list('MODEL_ALLOWLIST', DEFAULT_MODELS);
  for (const m of models) if (!MODEL_ID.test(m)) problems.push(`MODEL_ALLOWLIST entry is not a model id: ${m}`);
  if (!models.length) problems.push('MODEL_ALLOWLIST must name at least one model');

  const imageModels = list('IMAGE_MODEL_ALLOWLIST', DEFAULT_IMAGE_MODELS);
  for (const m of imageModels) if (!MODEL_ID.test(m)) problems.push(`IMAGE_MODEL_ALLOWLIST entry is not a model id: ${m}`);
  const ttsModels = list('TTS_MODEL_ALLOWLIST', DEFAULT_TTS_MODELS);
  for (const m of ttsModels) if (!MODEL_ID.test(m)) problems.push(`TTS_MODEL_ALLOWLIST entry is not a model id: ${m}`);

  const logLevel = str('LOG_LEVEL', 'info').toLowerCase();
  if (!LOG_LEVELS.includes(logLevel)) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

  const clientIpHeader = str('CLIENT_IP_HEADER').toLowerCase();
  if (clientIpHeader && !/^[a-z0-9-]+$/.test(clientIpHeader)) problems.push('CLIENT_IP_HEADER must be a header name');

  const config = {
    port: int('PORT', 8787, 0, 65535),
    host: str('HOST', '0.0.0.0'),
    apiKey,
    allowedOrigins: origins,
    modelAllowlist: [...new Set(models)],
    requireOrigin: bool('REQUIRE_ORIGIN', true),
    rateLimit: {
      burst: int('RATE_LIMIT_BURST', 20, 1, 10_000),
      perMinute: int('RATE_LIMIT_PER_MINUTE', 30, 1, 100_000),
      dailyBudget: int('RATE_LIMIT_DAILY', 3000, 1, 10_000_000),
    },
    media: {
      imageModels: [...new Set(imageModels)],
      ttsModels: [...new Set(ttsModels)],
      burst: int('MEDIA_RATE_BURST', 3, 1, 1000),
      perMinute: int('MEDIA_RATE_PER_MINUTE', 4, 1, 10_000),
      dailyBudget: int('MEDIA_RATE_DAILY', 300, 1, 1_000_000),
      maxBodyBytes: int('MEDIA_MAX_BODY_BYTES', 4_000_000, 1024, 20_000_000),
    },
    maxBodyBytes: int('MAX_BODY_BYTES', 8_000_000, 1024, 20_000_000),
    upstreamTimeoutMs: int('UPSTREAM_TIMEOUT_MS', 120_000, 1000, 600_000),
    modelsCacheMs: int('MODELS_CACHE_MS', 10 * 60_000, 0, 24 * 3600_000),
    clientIpHeader,
    trustedProxyHops: int('TRUSTED_PROXY_HOPS', 1, 1, 10),
    logLevel,
  };
  if (problems.length) throw new ConfigError(problems);
  return Object.freeze(config);
}

/** "https://a.example", or a local dev pattern with any port: "http://localhost:*". */
export function isOriginPattern(value) {
  const anyPort = value.endsWith(':*');
  const base = anyPort ? value.slice(0, -2) : value;
  try {
    const u = new URL(base);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === base && !(anyPort && u.port);
  } catch {
    return false;
  }
}
