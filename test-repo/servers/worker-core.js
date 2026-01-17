const fs = require('fs');
const Papa = require('papaparse');
const YAML = require('js-yaml');
const Fuse = require('fuse.js');
const dayjs = require('dayjs');
const _ = require('lodash');

const path = require('path');
const DATA_ROOT = path.join(process.cwd(), '../data');
const DEFAULT_REMOTE_URL = 'https://jsonplaceholder.typicode.com/todos/1';
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function makeId(length = 10) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return out;
}

const sampleCache = new Map();

function readText(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (err) {
    return null;
  }
}

function getSample(name) {
  if (sampleCache.has(name)) return sampleCache.get(name);
  let path = null;
  if (name === 'csv') path = `${DATA_ROOT}/sample.csv`;
  if (name === 'yaml') path = `${DATA_ROOT}/sample.yaml`;
  if (name === 'json') path = `${DATA_ROOT}/sample.json`;
  if (name === 'people') path = `${DATA_ROOT}/people.json`;
  const text = path ? readText(path) : null;
  if (text !== null) sampleCache.set(name, text);
  return text;
}

function summarizeKeys(obj) {
  if (!obj) return [];
  if (Array.isArray(obj) && obj.length > 0) return Object.keys(obj[0]);
  return Object.keys(obj);
}

async function handleParse(params) {
  const format = (params.format || 'csv').toLowerCase();
  const raw = params.raw || getSample(format) || '';
  if (!raw) {
    return { ok: false, error: `No sample data for ${format}.` };
  }

  if (format === 'csv') {
    const parsed = Papa.parse(raw, { header: true, skipEmptyLines: true });
    return {
      ok: true,
      format,
      rows: parsed.data.length,
      fields: parsed.meta.fields || [],
      preview: parsed.data.slice(0, 3)
    };
  }

  if (format === 'yaml') {
    const parsed = YAML.load(raw);
    return {
      ok: true,
      format,
      keys: summarizeKeys(parsed),
      preview: parsed
    };
  }

  if (format === 'json') {
    const parsed = JSON.parse(raw);
    return {
      ok: true,
      format,
      keys: summarizeKeys(parsed),
      preview: parsed
    };
  }

  return { ok: false, error: `Unsupported format: ${format}` };
}

async function handleGenerate(params) {
  const seed = Number(params.seed || 7);
  const createdAt = dayjs().format('YYYY-MM-DD HH:mm:ss');
  const id = makeId(10);
  const list = JSON.parse(getSample('people') || '[]');
  const sample = _.sampleSize(list, Math.min(seed, list.length));
  const roles = _.countBy(sample, 'role');

  const report = {
    id,
    createdAt,
    sampleSize: sample.length,
    roleBreakdown: roles,
    highlight: sample[0] || null
  };

  return {
    ok: true,
    report,
    note: 'Generated report can be saved to OPFS from the UI output.'
  };
}

async function handleRemote(params) {
  const url = params.url || DEFAULT_REMOTE_URL;
  const res = await fetch(url);
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  let json = null;
  if (contentType.includes('application/json')) {
    try { json = JSON.parse(text); } catch (e) { json = null; }
  }
  const summary = {
    url,
    status: res.status,
    contentType,
    size: text.length,
    keys: json ? summarizeKeys(json) : []
  };

  const savePath = `${DATA_ROOT}/remote-cache.json`;
  return {
    ok: true,
    summary,
    savePath,
    payloadPreview: json || text.slice(0, 240)
  };
}

async function handleSearch(params) {
  const query = (params.query || 'nova').toLowerCase();
  const list = JSON.parse(getSample('people') || '[]');
  const fuse = new Fuse(list, {
    includeScore: true,
    keys: ['name', 'role', 'location', 'tags']
  });
  const results = fuse.search(query).slice(0, 5).map(r => ({
    score: r.score,
    item: r.item
  }));

  return {
    ok: true,
    query,
    hits: results.length,
    results
  };
}

async function handleWrite(params) {
  const filename = params.filename || 'report.txt';
  const path = `${DATA_ROOT}/${filename}`;
  const content = `Report generated at ${dayjs().format('YYYY-MM-DD HH:mm:ss')}.\n` +
    `Suggestion: save this to OPFS using Nano or copy into a file.\n` +
    `ID: ${makeId(8)}\n`;

  return {
    ok: true,
    suggestedPath: path,
    content
  };
}

async function runAction(action, params = {}) {
  switch (action) {
    case 'parse':
      return await handleParse(params);
    case 'generate':
      return await handleGenerate(params);
    case 'remote':
      return await handleRemote(params);
    case 'search':
      return await handleSearch(params);
    case 'write':
      return await handleWrite(params);
    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}

module.exports = {
  runAction,
  DEFAULT_REMOTE_URL
};
