/**
 * Strict validation of a generate request. Only the fields the app sends are accepted;
 * anything else is refused with the path of the first problem, so mistakes are easy to find
 * and nothing unexpected is ever forwarded with the server's key.
 */
import { HttpError } from './http.mjs';

export const LIMITS = Object.freeze({
  contents: 32,
  parts: 16,
  systemParts: 8,
  tools: 2,
  stopSequences: 5,
  schemaDepth: 16,
  schemaNodes: 2000,
});

const IMAGE_TYPES = /^(image\/(png|jpeg|webp|heic|heif|gif)|application\/pdf)$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'];
const MIME_OUT = ['text/plain', 'application/json'];

const fail = (path, message) => { throw new HttpError(400, 'invalid_request', `${String(path).slice(0, 160)}: ${message}`); };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function object(v, path, allowed) {
  if (!isObject(v)) fail(path, 'must be an object');
  for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(`${path}.${k}`, 'is not an accepted field');
  return v;
}

function array(v, path, min, max) {
  if (!Array.isArray(v)) fail(path, 'must be a list');
  if (v.length < min || v.length > max) fail(path, `must have ${min} to ${max} items`);
  return v;
}

function string(v, path, { min = 0, max = Infinity } = {}) {
  if (typeof v !== 'string') fail(path, 'must be text');
  if (v.length < min || v.length > max) fail(path, `must be ${min} to ${max} characters`);
  return v;
}

function number(v, path, min, max, integer = false) {
  if (typeof v !== 'number' || !Number.isFinite(v) || (integer && !Number.isInteger(v))) fail(path, integer ? 'must be a whole number' : 'must be a number');
  if (v < min || v > max) fail(path, `must be from ${min} to ${max}`);
  return v;
}

function part(v, path) {
  object(v, path, ['text', 'inlineData']);
  const keys = Object.keys(v);
  if (keys.length !== 1) fail(path, 'must have exactly one of text or inlineData');
  if ('text' in v) return { text: string(v.text, `${path}.text`) };
  const d = object(v.inlineData, `${path}.inlineData`, ['mimeType', 'data']);
  const mimeType = string(d.mimeType, `${path}.inlineData.mimeType`);
  if (!IMAGE_TYPES.test(mimeType)) fail(`${path}.inlineData.mimeType`, 'must be an image or PDF type');
  const data = string(d.data, `${path}.inlineData.data`, { min: 4 });
  if (data.length % 4 !== 0 || !BASE64.test(data)) fail(`${path}.inlineData.data`, 'must be base64');
  return { inlineData: { mimeType, data } };
}

function content(v, path) {
  object(v, path, ['role', 'parts']);
  const role = v.role ?? 'user';
  if (role !== 'user' && role !== 'model') fail(`${path}.role`, 'must be user or model');
  const parts = array(v.parts, `${path}.parts`, 1, LIMITS.parts).map((p, i) => part(p, `${path}.parts[${i}]`));
  return { role, parts };
}

/** A response schema is passed through as data, bounded in depth and size. */
function responseSchema(v, path) {
  if (!isObject(v)) fail(path, 'must be an object');
  let nodes = 0;
  const walk = (x, depth) => {
    if (++nodes > LIMITS.schemaNodes) fail(path, 'is too large');
    if (depth > LIMITS.schemaDepth) fail(path, 'is nested too deeply');
    if (Array.isArray(x)) x.forEach((y) => walk(y, depth + 1));
    else if (isObject(x)) Object.values(x).forEach((y) => walk(y, depth + 1));
  };
  walk(v, 0);
  return v;
}

function generationConfig(v, path) {
  object(v, path, ['temperature', 'topP', 'topK', 'maxOutputTokens', 'responseMimeType', 'responseSchema', 'stopSequences', 'thinkingConfig', 'seed']);
  const out = {};
  if (v.temperature !== undefined) out.temperature = number(v.temperature, `${path}.temperature`, 0, 2);
  if (v.topP !== undefined) out.topP = number(v.topP, `${path}.topP`, 0, 1);
  if (v.topK !== undefined) out.topK = number(v.topK, `${path}.topK`, 1, 1000, true);
  if (v.maxOutputTokens !== undefined) out.maxOutputTokens = number(v.maxOutputTokens, `${path}.maxOutputTokens`, 1, 65_536, true);
  if (v.seed !== undefined) out.seed = number(v.seed, `${path}.seed`, -2_147_483_648, 2_147_483_647, true);
  if (v.responseMimeType !== undefined) {
    if (!MIME_OUT.includes(v.responseMimeType)) fail(`${path}.responseMimeType`, `must be ${MIME_OUT.join(' or ')}`);
    out.responseMimeType = v.responseMimeType;
  }
  if (v.responseSchema !== undefined) out.responseSchema = responseSchema(v.responseSchema, `${path}.responseSchema`);
  if (v.stopSequences !== undefined) {
    out.stopSequences = array(v.stopSequences, `${path}.stopSequences`, 1, LIMITS.stopSequences).map((s, i) => string(s, `${path}.stopSequences[${i}]`, { min: 1, max: 64 }));
  }
  if (v.thinkingConfig !== undefined) {
    const t = object(v.thinkingConfig, `${path}.thinkingConfig`, ['thinkingLevel', 'thinkingBudget', 'includeThoughts']);
    const tc = {};
    if (t.thinkingLevel !== undefined) {
      if (typeof t.thinkingLevel !== 'string' || !THINKING_LEVELS.includes(t.thinkingLevel.toLowerCase())) fail(`${path}.thinkingConfig.thinkingLevel`, `must be one of ${THINKING_LEVELS.join(', ')}`);
      tc.thinkingLevel = t.thinkingLevel;
    }
    if (t.thinkingBudget !== undefined) tc.thinkingBudget = number(t.thinkingBudget, `${path}.thinkingConfig.thinkingBudget`, -1, 32_768, true);
    if (t.includeThoughts !== undefined) {
      if (typeof t.includeThoughts !== 'boolean') fail(`${path}.thinkingConfig.includeThoughts`, 'must be true or false');
      tc.includeThoughts = t.includeThoughts;
    }
    out.thinkingConfig = tc;
  }
  return out;
}

/** Search grounding is the only tool the app uses; function calling is not forwarded. */
function tool(v, path) {
  object(v, path, ['google_search', 'googleSearch']);
  const keys = Object.keys(v);
  if (keys.length !== 1) fail(path, 'must name exactly one tool');
  const cfg = v[keys[0]];
  if (!isObject(cfg) || Object.keys(cfg).length) fail(`${path}.${keys[0]}`, 'must be an empty object');
  return { google_search: {} };
}

/**
 * @returns {{ model: string, body: object }} the model and the exact upstream body to forward.
 * @throws {HttpError} 400 with the path of the first problem.
 */
export function validateGenerate(input, modelAllowlist) {
  object(input, 'body', ['model', 'contents', 'generationConfig', 'systemInstruction', 'tools']);
  const model = string(input.model, 'model', { min: 1, max: 64 });
  if (!modelAllowlist.includes(model)) throw new HttpError(400, 'model_not_allowed', 'This model is not available on this server.');

  const body = {
    contents: array(input.contents, 'contents', 1, LIMITS.contents).map((c, i) => content(c, `contents[${i}]`)),
  };
  if (input.systemInstruction !== undefined) {
    const s = object(input.systemInstruction, 'systemInstruction', ['role', 'parts']);
    if (s.role !== undefined && s.role !== 'system' && s.role !== 'user') fail('systemInstruction.role', 'must be system or user');
    body.systemInstruction = {
      parts: array(s.parts, 'systemInstruction.parts', 1, LIMITS.systemParts).map((p, i) => {
        object(p, `systemInstruction.parts[${i}]`, ['text']);
        return { text: string(p.text, `systemInstruction.parts[${i}].text`) };
      }),
    };
  }
  if (input.tools !== undefined) body.tools = array(input.tools, 'tools', 0, LIMITS.tools).map((t, i) => tool(t, `tools[${i}]`));
  if (input.generationConfig !== undefined) body.generationConfig = generationConfig(input.generationConfig, 'generationConfig');
  return { model, body };
}
