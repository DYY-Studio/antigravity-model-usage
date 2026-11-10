// Historical session & usage statistics aggregator for Antigravity 2.0.
//
// Scans ~/.gemini/antigravity/conversation_summaries.db and conversations/*.db
// using Node's built-in node:sqlite (read-only) with per-database mtime:size
// caching, producing OpenChamber-style usage statistics plus Antigravity-native
// performance metrics (4-segment tokens, output TPS, median TTFT, compactions,
// and per-tool execution durations including MCP server.tool breakdown).

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GEMINI_DIR = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
const APP_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR || join(GEMINI_DIR, 'antigravity');
const SUMMARIES_DB = join(APP_DIR, 'conversation_summaries.db');
const CONVERSATIONS_DIR = join(APP_DIR, 'conversations');
const PRICING_CACHE_PATH = join(APP_DIR, 'model_usage_pricing_cache.json');
const PRICING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const OFFICIAL_PRICING_ENDPOINTS = {
  google: {
    mdUrl: 'https://aistudio.google.com/docs/pricing.md',
    pageUrl: 'https://aistudio.google.com/docs/pricing',
    label: 'Google AI Studio',
  },
  anthropic: {
    mdUrl: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
    pageUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    label: 'Anthropic Docs',
  },
};

const STEP_USER_INPUT = 14;
const STEP_PLANNER_RESPONSE = 15;
const STEP_ERROR_MESSAGE = 17;
const STEP_CHECKPOINT = 23;
const STEP_EPHEMERAL_MESSAGE = 90;
const STEP_SYSTEM_MESSAGE = 101;

const NON_TOOL_STEP_TYPES = new Set([
  0,
  2,
  STEP_USER_INPUT,
  STEP_PLANNER_RESPONSE,
  STEP_ERROR_MESSAGE,
  STEP_CHECKPOINT,
  STEP_EPHEMERAL_MESSAGE,
  STEP_SYSTEM_MESSAGE,
]);

const RANGE_DAYS = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

const EFFORT_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'tiered']);
const WORD_LABELS = { gpt: 'GPT', oss: 'OSS' };

// Built-in fallback model enum mapping when catalog/gen_metadata has no label.
const BUILTIN_ENUM_MODELS = new Map([
  [1417, { slug: 'gemini-4-argon-high', displayName: 'Gemini 4 Argon (High)', providerID: 'google' }],
  [1418, { slug: 'gemini-4-argon-medium', displayName: 'Gemini 4 Argon (Medium)', providerID: 'google' }],
  [1419, { slug: 'gemini-4-argon-low', displayName: 'Gemini 4 Argon (Low)', providerID: 'google' }],
  [1402, { slug: 'claude-opus-5-5-high', displayName: 'Claude Opus 5.5 (High)', providerID: 'anthropic' }],
  [1401, { slug: 'claude-opus-5-5-medium', displayName: 'Claude Opus 5.5 (Medium)', providerID: 'anthropic' }],
  [1400, { slug: 'claude-opus-5-5-low', displayName: 'Claude Opus 5.5 (Low)', providerID: 'anthropic' }],
  [1405, { slug: 'claude-sonnet-5-5-high', displayName: 'Claude Sonnet 5.5 (High)', providerID: 'anthropic' }],
  [1404, { slug: 'claude-sonnet-5-5-medium', displayName: 'Claude Sonnet 5.5 (Medium)', providerID: 'anthropic' }],
  [1403, { slug: 'claude-sonnet-5-5-low', displayName: 'Claude Sonnet 5.5 (Low)', providerID: 'anthropic' }],
  [1318, { slug: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)', providerID: 'google' }],
  [1319, { slug: 'gemini-3.8-flash-medium', displayName: 'Gemini 3.8 Flash (Medium)', providerID: 'google' }],
  [1320, { slug: 'gemini-3.8-flash-low', displayName: 'Gemini 3.8 Flash (Low)', providerID: 'google' }],
  [1322, { slug: 'gemini-3.8-flash-tiered', displayName: 'Gemini 3.8 Flash (Tiered)', providerID: 'google' }],
  [1198, { slug: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash Lite', providerID: 'google' }],
  [1050, { slug: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite', providerID: 'google' }],
  [1021, { slug: 'gemini-3.1-flash-image', displayName: 'Gemini 3.1 Flash Image', providerID: 'google' }],
  [1018, { slug: 'gemini-3-flash', displayName: 'Gemini 3 Flash', providerID: 'google' }],
]);

// --- Minimal Protobuf Wire Decoder -------------------------------------------

function readVarint(buf, pos) {
  let val = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const b = buf[pos++];
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [val, pos];
    shift += 7n;
    if (shift > 70n) throw new Error('Varint overflow');
  }
  throw new Error('Truncated varint');
}

class WireMsg {
  constructor(buf) {
    this.fields = new Map();
    if (!buf || !buf.length) return;
    let pos = 0;
    const len = buf.length;
    while (pos < len) {
      let tag;
      try {
        [tag, pos] = readVarint(buf, pos);
      } catch {
        break;
      }
      const fn = Number(tag >> 3n);
      const wt = Number(tag & 7n);
      let val;
      try {
        if (wt === 0) {
          [val, pos] = readVarint(buf, pos);
        } else if (wt === 2) {
          let l;
          [l, pos] = readVarint(buf, pos);
          const n = Number(l);
          if (n < 0 || pos + n > len) break;
          val = buf.subarray(pos, pos + n);
          pos += n;
        } else if (wt === 1) {
          if (pos + 8 > len) break;
          val = buf.subarray(pos, pos + 8);
          pos += 8;
        } else if (wt === 5) {
          if (pos + 4 > len) break;
          val = buf.subarray(pos, pos + 4);
          pos += 4;
        } else {
          break;
        }
      } catch {
        break;
      }
      let arr = this.fields.get(fn);
      if (!arr) {
        arr = [];
        this.fields.set(fn, arr);
      }
      arr.push(val);
    }
  }

  has(fn) {
    return this.fields.has(fn);
  }

  int(fn, signed32 = false) {
    const arr = this.fields.get(fn);
    if (!arr || !arr.length) return 0;
    let v = arr[arr.length - 1];
    if (typeof v !== 'bigint') return 0;
    if (signed32 && v >= 1n << 63n) v -= 1n << 64n;
    return Number(v);
  }

  bytes(fn) {
    const arr = this.fields.get(fn);
    if (!arr || !arr.length) return Buffer.alloc(0);
    const v = arr[arr.length - 1];
    return Buffer.isBuffer(v) || v instanceof Uint8Array
      ? Buffer.from(v.buffer, v.byteOffset, v.byteLength)
      : Buffer.alloc(0);
  }

  str(fn) {
    return this.bytes(fn).toString('utf8');
  }

  msg(fn) {
    return this.has(fn) ? new WireMsg(this.bytes(fn)) : null;
  }

  msgs(fn) {
    const arr = this.fields.get(fn);
    if (!arr || !arr.length) return [];
    return arr
      .filter((v) => Buffer.isBuffer(v) || v instanceof Uint8Array)
      .map((v) => new WireMsg(Buffer.from(v.buffer, v.byteOffset, v.byteLength)));
  }
}

function pbSeconds(msg) {
  if (!msg) return 0;
  return msg.int(1) + msg.int(2) / 1e9;
}

// --- Model Resolution & Pricing ----------------------------------------------

function formatSlugLabel(slug) {
  if (!slug) return 'Unknown Model';
  const parts = slug.split('-').filter(Boolean);
  let effort = '';
  if (parts.length > 1 && EFFORT_LEVELS.has(parts[parts.length - 1].toLowerCase())) {
    const raw = parts.pop();
    effort = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  }
  const words = [];
  for (const p of parts) {
    const low = p.toLowerCase();
    if (/^\d+$/.test(p) && words.length > 0 && /\d$/.test(words[words.length - 1])) {
      words[words.length - 1] += `.${p}`;
    } else if (WORD_LABELS[low]) {
      words.push(WORD_LABELS[low]);
    } else if (/^\d/.test(p)) {
      words.push(p.toUpperCase());
    } else {
      words.push(p.charAt(0).toUpperCase() + p.slice(1));
    }
  }
  const label = words.join(' ').replace('GPT OSS', 'GPT-OSS');
  return effort ? `${label} (${effort})` : label;
}

function splitNameAndVariant(fullDisplayName, slug) {
  const parts = (slug || '').split('-').filter(Boolean);
  let familyID = slug || 'unknown';
  let slugVariant = null;
  if (parts.length > 1 && EFFORT_LEVELS.has(parts[parts.length - 1].toLowerCase())) {
    const raw = parts[parts.length - 1];
    familyID = parts.slice(0, -1).join('-');
    slugVariant = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  }
  const m = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(fullDisplayName || '');
  if (m) {
    return { displayName: m[1].trim(), variant: m[2].trim(), familyID };
  }
  if (slugVariant) {
    return {
      displayName: fullDisplayName || formatSlugLabel(familyID),
      variant: slugVariant,
      familyID,
    };
  }
  return { displayName: fullDisplayName || formatSlugLabel(slug), variant: null, familyID };
}

function inferProviderID(slug, displayName, apiProviderEnum) {
  const s = `${slug || ''} ${displayName || ''}`.toLowerCase();
  if (s.includes('claude') || s.includes('anthropic')) return 'anthropic';
  if (s.includes('gpt') || s.includes('openai')) return 'openai';
  if (s.includes('gemini') || s.includes('google') || apiProviderEnum === 24) return 'google';
  return 'google';
}

function providerDisplayName(providerID) {
  if (providerID === 'anthropic') return 'Anthropic';
  if (providerID === 'openai') return 'OpenAI';
  if (providerID === 'google') return 'Google';
  return providerID || 'Unknown';
}

// --- Official Public API Pricing (Live Markdown + Cache + Explicit Fallback) ---

function normalizeModelSlug(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-(minimal|low|medium|high|xhigh|max|tiered|preview|customtools)$/g, '')
    .replace(/^-+|-+$/g, '');
}

function parseDateBound(text, kind) {
  const re =
    kind === 'through'
      ? /through\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i
      : /starting\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i;
  const m = String(text || '').match(re);
  if (!m) return null;
  const d = new Date(`${m[1]} ${kind === 'through' ? '23:59:59 UTC' : '00:00:00 UTC'}`);
  return Number.isNaN(d.getTime()) ? null : { raw: m[1], ts: d.getTime() };
}

function parseAiStudioCell(cellText) {
  const lines = String(cellText || '')
    .split('\n')
    .map((l) => l.replace(/\{%.*?%\}/g, '').replace(/\\/g, '').trim())
    .filter(Boolean);

  let baseRate = null;
  let overThresholdRate = null;
  let thresholdTokens = null;
  const datedRules = [];

  for (const line of lines) {
    if (/storage price|per hour|explicit caching|implicit caching|equivalent to/i.test(line)) continue;
    if (/\((?:audio|images?|video)\)/i.test(line) && !/text/i.test(line)) continue;
    const priceMatch = line.match(/\$([0-9]+(?:\.[0-9]+)?)/);
    if (!priceMatch) continue;
    const price = Number(priceMatch[1]);
    if (!Number.isFinite(price)) continue;

    const leMatch = line.match(/prompts?\s*<=\s*(\d+)k/i);
    if (leMatch) {
      baseRate = price;
      thresholdTokens = Number(leMatch[1]) * 1000;
      continue;
    }
    const gtMatch = line.match(/prompts?\s*>\s*(\d+)k/i);
    if (gtMatch) {
      overThresholdRate = price;
      thresholdTokens = Number(gtMatch[1]) * 1000;
      continue;
    }

    const through = parseDateBound(line, 'through');
    const starting = parseDateBound(line, 'starting');
    if (through || starting) {
      datedRules.push({
        price,
        throughRaw: through?.raw || null,
        throughTs: through?.ts || null,
        startingRaw: starting?.raw || null,
        startingTs: starting?.ts || null,
      });
      continue;
    }
    if (baseRate === null) {
      baseRate = price;
    }
  }

  return { baseRate, overThresholdRate, thresholdTokens, datedRules };
}

export function parseAiStudioPricingMarkdown(md) {
  const sections = String(md || '').split(/^##\s+/m).slice(1);
  const models = [];
  for (const sec of sections) {
    const firstLine = sec.split('\n')[0] || '';
    const title = firstLine
      .replace(/\{%.*?%\}/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
      .trim();
    const idMatch = firstLine.match(/id="([^"]+)"/);
    const sectionId = idMatch ? idMatch[1] : '';
    const headerBlock = sec.split(/\{%\s*hr\s*\/%\}/i)[0] || firstLine;
    const codeIds = [...headerBlock.matchAll(/`(gemini-[^`]+)`/g)].map((m) => m[1]);
    const tabMatch = sec.match(/\{%\s*tab\s+title="Standard"\s*%\}([\s\S]*?)\{%\s*\/tab\s*%\}/i);
    const block = tabMatch ? tabMatch[1] : sec;

    const rowRegex =
      /\*\s*(Input price|Output price[^\n]*|Context caching price)\s*\n\s*\*\s*([^\n]+)\s*\n\s*\*\s*([\s\S]*?)(?=\n\s*---|\n\s*\{%\s*\/table)/gi;
    let input = null;
    let output = null;
    let cacheRead = null;
    for (const m of block.matchAll(rowRegex)) {
      const feature = m[1].toLowerCase();
      const parsed = parseAiStudioCell(m[3]);
      if (feature.startsWith('input')) input = parsed;
      else if (feature.startsWith('output')) output = parsed;
      else if (feature.startsWith('context caching')) cacheRead = parsed;
    }
    if (
      input &&
      (input.baseRate != null || input.datedRules.length) &&
      output &&
      (output.baseRate != null || output.datedRules.length)
    ) {
      const cleanTitle = title.replace(/\s*\([^)]+\)\s*$/, '').trim();
      const aliases = new Set([
        normalizeModelSlug(title),
        normalizeModelSlug(cleanTitle),
        normalizeModelSlug(sectionId),
        ...codeIds.map(normalizeModelSlug),
      ]);
      models.push({
        providerID: 'google',
        title,
        sectionId: sectionId || normalizeModelSlug(title),
        aliases: [...aliases].filter(Boolean),
        input,
        output,
        cacheRead: cacheRead || { baseRate: 0, overThresholdRate: null, thresholdTokens: null, datedRules: [] },
      });
    }
  }
  return models;
}

export function parseClaudePricingMarkdown(md) {
  const byTitle = new Map();
  const tableMatch = String(md || '').match(/##\s+Model pricing[\s\S]*?(\|[\s\S]*?)\n\n/);
  if (!tableMatch) return [];
  const lines = tableMatch[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'));
  for (const line of lines.slice(2)) {
    const cols = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cols.length < 6) continue;
    const rawCell = cols[0].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
    const isUpTo = /prompts?\s+up\s+to\s+([\d,]+)\s+tokens/i.exec(rawCell);
    const isOver = /prompts?\s+over\s+([\d,]+)\s+tokens/i.exec(rawCell);
    const cleanTitle = rawCell.replace(/\s*\(.*$/, '').trim();
    const parsePrice = (s) => {
      const m = String(s || '').match(/\$([0-9]+(?:\.[0-9]+)?)/);
      return m ? Number(m[1]) : null;
    };
    const inp = parsePrice(cols[1]);
    const cr = parsePrice(cols[4]);
    const out = parsePrice(cols[5]);
    if (inp == null || out == null) continue;

    let entry = byTitle.get(cleanTitle);
    if (!entry) {
      entry = {
        providerID: 'anthropic',
        title: cleanTitle,
        sectionId: normalizeModelSlug(cleanTitle),
        aliases: [normalizeModelSlug(cleanTitle)],
        input: { baseRate: inp, overThresholdRate: null, thresholdTokens: null, datedRules: [] },
        output: { baseRate: out, overThresholdRate: null, thresholdTokens: null, datedRules: [] },
        cacheRead: { baseRate: cr ?? 0, overThresholdRate: null, thresholdTokens: null, datedRules: [] },
      };
      byTitle.set(cleanTitle, entry);
    }
    if (isUpTo) {
      const th = Number(isUpTo[1].replace(/,/g, ''));
      entry.input.baseRate = inp;
      entry.output.baseRate = out;
      entry.cacheRead.baseRate = cr ?? 0;
      entry.input.thresholdTokens = th;
    } else if (isOver) {
      const th = Number(isOver[1].replace(/,/g, ''));
      entry.input.overThresholdRate = inp;
      entry.output.overThresholdRate = out;
      entry.cacheRead.overThresholdRate = cr ?? 0;
      entry.input.thresholdTokens = th;
    }
  }
  return [...byTitle.values()];
}

const fFlat = (baseRate) => ({ baseRate, overThresholdRate: null, thresholdTokens: null, datedRules: [] });
const fTier = (baseRate, overThresholdRate, thresholdTokens) => ({
  baseRate,
  overThresholdRate,
  thresholdTokens,
  datedRules: [],
});
const fDate = (p1, throughRaw, throughTs, p2, startingRaw, startingTs) => ({
  baseRate: null,
  overThresholdRate: null,
  thresholdTokens: null,
  datedRules: [
    { price: p1, throughRaw, throughTs, startingRaw: null, startingTs: null },
    { price: p2, throughRaw: null, throughTs: null, startingRaw, startingTs },
  ],
});
const bModel = (providerID, title, sectionId, aliases, input, output, cacheRead) => ({
  providerID,
  title,
  sectionId,
  aliases,
  input,
  output,
  cacheRead,
});

const BUNDLED_OFFICIAL_PRICING = {
  snapshotDate: '2026-11-10',
  google: [
    bModel(
      'google',
      'Gemini 4 Argon',
      'gemini-4-argon',
      ['gemini-4-argon'],
      fDate(2.0, 'November 30, 2026', 1796083199000, 4.0, 'December 1, 2026', 1796083200000),
      fDate(10.0, 'November 30, 2026', 1796083199000, 20.0, 'December 1, 2026', 1796083200000),
      fDate(0.1, 'November 30, 2026', 1796083199000, 0.2, 'December 1, 2026', 1796083200000)
    ),
    bModel(
      'google',
      'Gemini 3.8 Flash',
      'gemini-3.8-flash',
      ['gemini-3-8-flash'],
      fDate(0.75, 'December 31, 2026', 1798761599000, 1.5, 'January 1, 2027', 1798761600000),
      fDate(3.75, 'December 31, 2026', 1798761599000, 7.5, 'January 1, 2027', 1798761600000),
      fDate(0.075, 'December 31, 2026', 1798761599000, 0.15, 'January 1, 2027', 1798761600000)
    ),
    bModel('google', 'Gemini 3.5 Flash-Lite', 'gemini-3.5-flash-lite', ['gemini-3-5-flash-lite'], fFlat(0.3), fFlat(2.5), fFlat(0.03)),
    bModel('google', 'Gemini 3.1 Flash-Lite', 'gemini-3.1-flash-lite', ['gemini-3-1-flash-lite'], fFlat(0.25), fFlat(1.5), fFlat(0.025)),
    bModel('google', 'Gemini 3.1 Pro Preview', 'gemini-3.1-pro-preview', ['gemini-3-1-pro', 'gemini-3-1-pro-preview'], fTier(2.0, 4.0, 200000), fTier(12.0, 18.0, 200000), fTier(0.2, 0.4, 200000)),
    bModel('google', 'Gemini 3.1 Flash Image (Nano Banana 2)', 'gemini-3.1-flash-image', ['gemini-3-1-flash-image', 'gemini-3-1-flash-image-nano-banana-2'], fFlat(0.5), fFlat(3.0), fFlat(0)),
    bModel('google', 'Gemini 3 Flash Preview', 'gemini-3-flash-preview', ['gemini-3-flash'], fFlat(0.5), fFlat(3.0), fFlat(0.05)),
    bModel('google', 'Gemini 2.5 Pro', 'gemini-2.5-pro', ['gemini-2-5-pro'], fTier(1.25, 2.5, 200000), fTier(10.0, 15.0, 200000), fTier(0.125, 0.25, 200000)),
    bModel('google', 'Gemini 2.5 Flash', 'gemini-2.5-flash', ['gemini-2-5-flash'], fFlat(0.3), fFlat(2.5), fFlat(0.03)),
  ],
  anthropic: [
    bModel('anthropic', 'Claude Opus 5.5', 'claude-opus-5-5', ['claude-opus-5-5'], fFlat(4.0), fFlat(20.0), fFlat(0.2)),
    bModel('anthropic', 'Claude Opus 4.6', 'claude-opus-4-6', ['claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5'], fFlat(5.0), fFlat(25.0), fFlat(0.5)),
    bModel('anthropic', 'Claude Sonnet 5.5', 'claude-sonnet-5-5', ['claude-sonnet-5-5'], fFlat(2.0), fFlat(10.0), fFlat(0.1)),
    bModel('anthropic', 'Claude Sonnet 4.6', 'claude-sonnet-4-6', ['claude-sonnet-4-6', 'claude-sonnet-4-5'], fFlat(3.0), fFlat(15.0), fFlat(0.3)),
    bModel('anthropic', 'Claude Haiku 5.5', 'claude-haiku-5-5', ['claude-haiku-5-5'], fTier(0.1, 0.5, 100000), fTier(0.5, 2.5, 100000), fTier(0.01, 0.05, 100000)),
  ],
};

const COMMON_LOCAL_PROXY_PORTS = [7890, 7897, 10808, 10809, 6152, 1087];

function checkLocalPort(port, host = '127.0.0.1', timeoutMs = 120) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

function sanitizeProxyUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = `http://${s}`;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || !u.port) return null;
    return `${u.protocol}//${u.username ? `${encodeURIComponent(u.username)}:${encodeURIComponent(u.password)}@` : ''}${u.hostname}:${u.port}`;
  } catch {
    return null;
  }
}

async function detectOsSystemProxy() {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('scutil', ['--proxy'], { timeout: 800 });
      const getVal = (k) => {
        const m = stdout.match(new RegExp(`\\b${k}\\s*:\\s*([^\\s\\n]+)`));
        return m ? m[1].trim() : '';
      };
      if (getVal('HTTPSEnable') === '1' && getVal('HTTPSProxy') && getVal('HTTPSPort')) {
        return sanitizeProxyUrl(`http://${getVal('HTTPSProxy')}:${getVal('HTTPSPort')}`);
      }
      if (getVal('HTTPEnable') === '1' && getVal('HTTPProxy') && getVal('HTTPPort')) {
        return sanitizeProxyUrl(`http://${getVal('HTTPProxy')}:${getVal('HTTPPort')}`);
      }
    } else if (process.platform === 'win32') {
      const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const { stdout } = await execFileAsync('reg', ['query', regKey], { timeout: 1000, windowsHide: true });
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(stdout);
      const serverMatch = stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
      if (enabled && serverMatch) {
        const raw = serverMatch[1].trim();
        const part =
          raw.match(/(?:https=)\s*([^;]+)/i)?.[1] ||
          raw.match(/(?:http=)\s*([^;]+)/i)?.[1] ||
          raw.split(';')[0];
        return sanitizeProxyUrl(part);
      }
    } else if (process.platform === 'linux') {
      const { stdout: modeOut } = await execFileAsync('gsettings', ['get', 'org.gnome.system.proxy', 'mode'], {
        timeout: 800,
      });
      if (/manual/i.test(modeOut)) {
        const { stdout: hostOut } = await execFileAsync('gsettings', ['get', 'org.gnome.system.proxy.http', 'host'], {
          timeout: 800,
        });
        const { stdout: portOut } = await execFileAsync('gsettings', ['get', 'org.gnome.system.proxy.http', 'port'], {
          timeout: 800,
        });
        const host = hostOut.replace(/['"\s]/g, '');
        const port = portOut.replace(/['"\s]/g, '');
        if (host && Number(port) > 0) return sanitizeProxyUrl(`http://${host}:${port}`);
      }
    }
  } catch {
    // Ignore OS system proxy detection failures.
  }
  return null;
}

async function resolveProxyCandidates() {
  const seen = new Set();
  const add = (p) => {
    if (!seen.has(p)) seen.add(p);
  };

  const envProxy = sanitizeProxyUrl(
    process.env.MODEL_USAGE_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy
  );
  if (envProxy) add(envProxy);

  const sysProxy = await detectOsSystemProxy();
  if (sysProxy) add(sysProxy);

  const probed = await Promise.all(
    COMMON_LOCAL_PROXY_PORTS.map(async (port) => ((await checkLocalPort(port)) ? `http://127.0.0.1:${port}` : null))
  );
  for (const p of probed) {
    if (p) add(p);
  }

  add(null); // Direct fallback
  return [...seen];
}

function httpsGetText(targetUrl, proxyUrl, timeoutMs = 6000, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };

    const target = new URL(targetUrl);
    if (target.protocol !== 'https:') {
      finish(new Error(`Disallowed protocol: ${target.protocol}`));
      return;
    }

    const timer = setTimeout(() => finish(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);

    const onResponse = (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return finish(new Error('Too many redirects'));
        const nextUrl = new URL(res.headers.location, targetUrl).toString();
        httpsGetText(nextUrl, proxyUrl, timeoutMs, redirectsLeft - 1).then((v) => finish(null, v), finish);
        return;
      }
      if (code < 200 || code >= 300) {
        res.resume();
        return finish(new Error(`HTTP ${code}`));
      }
      const chunks = [];
      let len = 0;
      res.on('data', (c) => {
        len += c.length;
        if (len > 4 * 1024 * 1024) {
          res.destroy(new Error('Response exceeds 4MB'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
      res.on('error', finish);
    };

    const headers = {
      Host: target.host,
      'User-Agent': 'Antigravity-ModelUsage/1.0',
      Accept: 'text/markdown, text/plain, */*',
      'Accept-Encoding': 'identity',
      Connection: 'close',
    };

    if (!proxyUrl) {
      const req = https.get(targetUrl, { headers }, onResponse);
      req.on('error', finish);
      return;
    }

    const proxy = new URL(proxyUrl);
    const targetPort = Number(target.port) || 443;
    const connectHeaders = { Host: `${target.hostname}:${targetPort}` };
    if (proxy.username) {
      const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`).toString('base64');
      connectHeaders['Proxy-Authorization'] = `Basic ${auth}`;
    }

    const connectReq = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port),
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: connectHeaders,
    });
    connectReq.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return finish(new Error(`Proxy CONNECT HTTP ${res.statusCode}`));
      }
      if (head && head.length) socket.unshift(head);
      const req = https.request(
        {
          hostname: target.hostname,
          port: targetPort,
          path: target.pathname + target.search,
          method: 'GET',
          headers,
          socket,
          agent: false,
          servername: target.hostname,
        },
        onResponse
      );
      req.on('error', finish);
      req.end();
    });
    connectReq.on('error', finish);
    connectReq.end();
  });
}

async function fetchAllowedPricingMarkdown(providerKey, proxyCandidates) {
  const endpoint = OFFICIAL_PRICING_ENDPOINTS[providerKey];
  if (!endpoint) throw new Error(`Unknown pricing provider: ${providerKey}`);

  const candidates = proxyCandidates || (await resolveProxyCandidates());
  let lastErr = null;
  for (const proxy of candidates) {
    try {
      const text = await httpsGetText(endpoint.mdUrl, proxy, 6000);
      if (text && text.length > 500) {
        return { text, via: proxy ? `proxy (${proxy})` : 'direct' };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`Failed to fetch ${endpoint.mdUrl}`);
}

function readPricingDiskCache() {
  try {
    if (!existsSync(PRICING_CACHE_PATH)) return null;
    const raw = JSON.parse(readFileSync(PRICING_CACHE_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

function writePricingDiskCache(data) {
  try {
    writeFileSync(PRICING_CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // Non-fatal if disk cache cannot be written.
  }
}

let pricingState = {
  loadedAt: 0,
  google: {
    models: BUNDLED_OFFICIAL_PRICING.google,
    status: 'bundled-fallback',
    updatedAt: BUNDLED_OFFICIAL_PRICING.snapshotDate,
    url: OFFICIAL_PRICING_ENDPOINTS.google.pageUrl,
    fallbackReason: 'Not yet fetched',
  },
  anthropic: {
    models: BUNDLED_OFFICIAL_PRICING.anthropic,
    status: 'bundled-fallback',
    updatedAt: BUNDLED_OFFICIAL_PRICING.snapshotDate,
    url: OFFICIAL_PRICING_ENDPOINTS.anthropic.pageUrl,
    fallbackReason: 'Not yet fetched',
  },
};

export async function refreshOfficialPricingCatalog(force = false) {
  const nowMs = Date.now();
  if (!force && pricingState.loadedAt > 0 && nowMs - pricingState.loadedAt < PRICING_CACHE_TTL_MS) {
    return pricingState;
  }

  const diskCache = readPricingDiskCache();
  if (!force && diskCache?.fetchedAtMs && nowMs - diskCache.fetchedAtMs < PRICING_CACHE_TTL_MS) {
    if (Array.isArray(diskCache.google?.models) && diskCache.google.models.length > 0 &&
        Array.isArray(diskCache.anthropic?.models) && diskCache.anthropic.models.length > 0) {
      pricingState = {
        loadedAt: diskCache.fetchedAtMs,
        google: {
          models: diskCache.google.models,
          status: 'cached',
          updatedAt: diskCache.google.updatedAt || new Date(diskCache.fetchedAtMs).toISOString(),
          url: OFFICIAL_PRICING_ENDPOINTS.google.pageUrl,
          fallbackReason: null,
        },
        anthropic: {
          models: diskCache.anthropic.models,
          status: 'cached',
          updatedAt: diskCache.anthropic.updatedAt || new Date(diskCache.fetchedAtMs).toISOString(),
          url: OFFICIAL_PRICING_ENDPOINTS.anthropic.pageUrl,
          fallbackReason: null,
        },
      };
      return pricingState;
    }
  }

  const proxyCandidates = await resolveProxyCandidates();
  const [gRes, cRes] = await Promise.allSettled([
    fetchAllowedPricingMarkdown('google', proxyCandidates),
    fetchAllowedPricingMarkdown('anthropic', proxyCandidates),
  ]);

  const fetchedIso = new Date(nowMs).toISOString();
  let nextGoogle = null;
  if (gRes.status === 'fulfilled') {
    const parsed = parseAiStudioPricingMarkdown(gRes.value.text);
    if (parsed.length > 0) {
      nextGoogle = {
        models: parsed,
        status: 'live',
        updatedAt: fetchedIso,
        url: OFFICIAL_PRICING_ENDPOINTS.google.pageUrl,
        fallbackReason: null,
      };
    }
  }
  if (!nextGoogle) {
    const errMsg = gRes.status === 'rejected' ? (gRes.reason?.message || 'Fetch failed') : 'Empty pricing table';
    if (Array.isArray(diskCache?.google?.models) && diskCache.google.models.length > 0) {
      nextGoogle = {
        models: diskCache.google.models,
        status: 'cached-fallback',
        updatedAt: diskCache.google.updatedAt || null,
        url: OFFICIAL_PRICING_ENDPOINTS.google.pageUrl,
        fallbackReason: `Live fetch failed (${errMsg.slice(0, 120)}); using cached pricing`,
      };
    } else {
      nextGoogle = {
        models: BUNDLED_OFFICIAL_PRICING.google,
        status: 'bundled-fallback',
        updatedAt: BUNDLED_OFFICIAL_PRICING.snapshotDate,
        url: OFFICIAL_PRICING_ENDPOINTS.google.pageUrl,
        fallbackReason: `Live fetch failed (${errMsg.slice(0, 120)}); using bundled snapshot (${BUNDLED_OFFICIAL_PRICING.snapshotDate})`,
      };
    }
  }

  let nextAnthropic = null;
  if (cRes.status === 'fulfilled') {
    const parsed = parseClaudePricingMarkdown(cRes.value.text);
    if (parsed.length > 0) {
      nextAnthropic = {
        models: parsed,
        status: 'live',
        updatedAt: fetchedIso,
        url: OFFICIAL_PRICING_ENDPOINTS.anthropic.pageUrl,
        fallbackReason: null,
      };
    }
  }
  if (!nextAnthropic) {
    const errMsg = cRes.status === 'rejected' ? (cRes.reason?.message || 'Fetch failed') : 'Empty pricing table';
    if (Array.isArray(diskCache?.anthropic?.models) && diskCache.anthropic.models.length > 0) {
      nextAnthropic = {
        models: diskCache.anthropic.models,
        status: 'cached-fallback',
        updatedAt: diskCache.anthropic.updatedAt || null,
        url: OFFICIAL_PRICING_ENDPOINTS.anthropic.pageUrl,
        fallbackReason: `Live fetch failed (${errMsg.slice(0, 120)}); using cached pricing`,
      };
    } else {
      nextAnthropic = {
        models: BUNDLED_OFFICIAL_PRICING.anthropic,
        status: 'bundled-fallback',
        updatedAt: BUNDLED_OFFICIAL_PRICING.snapshotDate,
        url: OFFICIAL_PRICING_ENDPOINTS.anthropic.pageUrl,
        fallbackReason: `Live fetch failed (${errMsg.slice(0, 120)}); using bundled snapshot (${BUNDLED_OFFICIAL_PRICING.snapshotDate})`,
      };
    }
  }

  pricingState = {
    loadedAt: nowMs,
    google: nextGoogle,
    anthropic: nextAnthropic,
  };

  if (nextGoogle.status === 'live' || nextAnthropic.status === 'live') {
    writePricingDiskCache({
      fetchedAtMs: nowMs,
      google: { models: nextGoogle.models, updatedAt: nextGoogle.updatedAt },
      anthropic: { models: nextAnthropic.models, updatedAt: nextAnthropic.updatedAt },
    });
  }

  return pricingState;
}

function resolveFieldRate(fieldRule, nowMs = Date.now()) {
  if (!fieldRule) return { rate: 0, overThresholdRate: null, thresholdTokens: null, activeRule: null, futureRule: null };
  let rate = fieldRule.baseRate;
  let activeRule = null;
  let futureRule = null;
  const rules = Array.isArray(fieldRule.datedRules) ? fieldRule.datedRules : [];
  if (rules.length > 0) {
    activeRule =
      rules.find((r) => {
        if (r.throughTs && nowMs > r.throughTs) return false;
        if (r.startingTs && nowMs < r.startingTs) return false;
        return true;
      }) || rules[0];
    rate = activeRule.price;
    futureRule = rules.find((r) => r !== activeRule && r.startingTs && nowMs < r.startingTs) || null;
  }
  return {
    rate: Number.isFinite(rate) ? rate : 0,
    overThresholdRate: Number.isFinite(fieldRule.overThresholdRate) ? fieldRule.overThresholdRate : null,
    thresholdTokens: fieldRule.thresholdTokens || null,
    activeRule,
    futureRule,
  };
}

function matchCatalogEntry(modelID, displayName, providerID) {
  const normSlug = normalizeModelSlug(modelID);
  const normName = normalizeModelSlug(String(displayName || '').replace(/\([^)]*\)/g, ''));
  const allEntries = [...pricingState.google.models, ...pricingState.anthropic.models];

  const exact = allEntries.find(
    (e) => e.aliases.includes(normSlug) || (normName && e.aliases.includes(normName))
  );
  if (exact) return exact;

  const key = `${modelID || ''} ${displayName || ''}`.toLowerCase();
  const findById = (id) => allEntries.find((e) => e.sectionId === id || e.aliases.includes(id));

  if (key.includes('claude-opus') || key.includes('claude opus')) {
    return findById('claude-opus-5-5') || allEntries.find((e) => e.sectionId.startsWith('claude-opus'));
  }
  if (key.includes('claude-sonnet') || key.includes('claude sonnet')) {
    return findById('claude-sonnet-5-5') || allEntries.find((e) => e.sectionId.startsWith('claude-sonnet'));
  }
  if (key.includes('claude-haiku') || key.includes('claude haiku')) {
    return findById('claude-haiku-5-5') || allEntries.find((e) => e.sectionId.startsWith('claude-haiku'));
  }
  if (key.includes('argon')) {
    return findById('gemini-4-argon');
  }
  if (key.includes('3.8-flash') || key.includes('3-8-flash')) {
    return findById('gemini-3.8-flash');
  }
  if (key.includes('3.1-flash-lite') || key.includes('3-1-flash-lite')) {
    return findById('gemini-3.1-flash-lite');
  }
  if (key.includes('flash-lite') || key.includes('flash lite') || key.includes('tab_') || key.includes('chat_')) {
    return findById('gemini-3.5-flash-lite') || findById('gemini-3.1-flash-lite');
  }
  if (key.includes('flash')) {
    return findById('gemini-3.8-flash') || findById('gemini-3-flash-preview');
  }
  if (key.includes('pro') || providerID === 'google') {
    return findById('gemini-3.1-pro-preview') || findById('gemini-4-argon');
  }
  return null;
}

function getModelPricingPerMillion(modelID, displayName, providerID, nowMs = Date.now()) {
  const key = `${modelID || ''} ${displayName || ''}`.toLowerCase();
  if (key.includes('gpt-oss')) {
    return {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.0375,
      overThreshold: null,
      scheduleNote: null,
      benchmark: 'Open-weight 120B API equivalent (Standard)',
      sourceStatus: 'builtin',
      sourceUrl: null,
      sourceUpdatedAt: null,
      fallbackReason: null,
    };
  }

  const matched = matchCatalogEntry(modelID, displayName, providerID);
  if (matched) {
    const provState = matched.providerID === 'anthropic' ? pricingState.anthropic : pricingState.google;
    const inp = resolveFieldRate(matched.input, nowMs);
    const out = resolveFieldRate(matched.output, nowMs);
    const cr = resolveFieldRate(matched.cacheRead, nowMs);

    const thresholdTokens = inp.thresholdTokens || out.thresholdTokens || cr.thresholdTokens || null;
    const hasOverThreshold =
      thresholdTokens &&
      (inp.overThresholdRate != null || out.overThresholdRate != null || cr.overThresholdRate != null);

    let scheduleNote = null;
    if (inp.activeRule?.throughRaw && inp.futureRule?.startingRaw) {
      scheduleNote = `Promo through ${inp.activeRule.throughRaw} · Starting ${inp.futureRule.startingRaw}: $${inp.futureRule.price} in / $${out.futureRule?.price ?? out.rate} out / $${cr.futureRule?.price ?? cr.rate} cache`;
    } else if (inp.activeRule?.startingRaw) {
      scheduleNote = `Effective since ${inp.activeRule.startingRaw}`;
    }

    const provLabel = matched.providerID === 'anthropic' ? 'Anthropic Docs' : 'Google AI Studio';
    const bracketSuffix = hasOverThreshold ? ` · <=${Math.round(thresholdTokens / 1000)}k / >${Math.round(thresholdTokens / 1000)}k` : '';

    return {
      input: inp.rate,
      output: out.rate,
      cacheRead: cr.rate,
      overThreshold: hasOverThreshold
        ? {
            thresholdTokens,
            input: inp.overThresholdRate ?? inp.rate,
            output: out.overThresholdRate ?? out.rate,
            cacheRead: cr.overThresholdRate ?? cr.rate,
          }
        : null,
      scheduleNote,
      benchmark: `${provLabel} · ${matched.title} (Standard${bracketSuffix})`,
      sourceStatus: provState.status,
      sourceUrl:
        matched.providerID === 'anthropic'
          ? `${OFFICIAL_PRICING_ENDPOINTS.anthropic.pageUrl}#model-pricing`
          : `${OFFICIAL_PRICING_ENDPOINTS.google.pageUrl}#${matched.sectionId}`,
      sourceUpdatedAt: provState.updatedAt,
      fallbackReason: provState.fallbackReason,
    };
  }

  return {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.25,
    overThreshold: null,
    scheduleNote: null,
    benchmark: 'Standard public API benchmark',
    sourceStatus: 'builtin',
    sourceUrl: null,
    sourceUpdatedAt: null,
    fallbackReason: null,
  };
}

function estimateStepCostBreakdown(tokens, pricing) {
  const promptTokens = (tokens.input || 0) + (tokens.cacheRead || 0);
  const isOver = Boolean(pricing.overThreshold && promptTokens > pricing.overThreshold.thresholdTokens);
  const rates = isOver ? pricing.overThreshold : pricing;
  const inputCost = ((tokens.input || 0) * rates.input) / 1_000_000;
  const outputCost = ((tokens.output || 0) * rates.output) / 1_000_000;
  const reasoningCost = ((tokens.reasoning || 0) * rates.output) / 1_000_000;
  const cacheReadCost = ((tokens.cacheRead || 0) * rates.cacheRead) / 1_000_000;
  const totalCost = inputCost + outputCost + reasoningCost + cacheReadCost;
  const cacheSaved = ((tokens.cacheRead || 0) * Math.max(0, rates.input - rates.cacheRead)) / 1_000_000;
  const uncachedTotal =
    (promptTokens * rates.input + ((tokens.output || 0) + (tokens.reasoning || 0)) * rates.output) / 1_000_000;
  return {
    isOver,
    inputCost,
    outputCost,
    reasoningCost,
    cacheReadCost,
    totalCost,
    cacheSaved,
    uncachedTotal,
  };
}

// --- Caching & Database Readers ----------------------------------------------

const dbCache = new Map(); // cid -> { stamp, parsed }
const observedEnumModels = new Map(BUILTIN_ENUM_MODELS); // enumId -> { slug, displayName, providerID }
let catalogUpdatedAt = 0;

export async function refreshStatsModelCatalog(lsRequest, force = false) {
  if (!lsRequest) return;
  if (!force && Date.now() - catalogUpdatedAt < 10 * 60 * 1000) return;
  catalogUpdatedAt = Date.now();
  try {
    const resp = await lsRequest('GetAvailableModels', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity' },
    });
    const models = resp?.response?.models || resp?.models || {};
    for (const [slug, info] of Object.entries(models)) {
      const mStr = String(info?.model || '');
      const match = /^MODEL_PLACEHOLDER_M(\d+)$/.exec(mStr);
      if (!match) continue;
      const enumId = 1000 + Number(match[1]);
      const mp = String(info?.modelProvider || '');
      const providerID = mp.includes('ANTHROPIC')
        ? 'anthropic'
        : mp.includes('OPENAI')
          ? 'openai'
          : 'google';
      const displayName = info?.displayName || formatSlugLabel(slug);
      observedEnumModels.set(enumId, { slug, displayName, providerID });
    }
  } catch {
    // Keep built-in & gen_metadata-derived model mappings on failure.
  }
}

function fileStamp(path) {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '-';
  }
}

function normalizeUriToPath(uri) {
  const s = String(uri || '').trim();
  if (!s) return '';
  if (s.startsWith('file:')) {
    try {
      return fileURLToPath(s);
    } catch {
      let p = decodeURIComponent(s.replace(/^file:\/\//, ''));
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      return p;
    }
  }
  return s;
}

function readConversationSummariesMap() {
  const map = new Map();
  if (!existsSync(SUMMARIES_DB)) return map;
  let db;
  try {
    db = new DatabaseSync(SUMMARIES_DB, { readOnly: true });
    const rows = db
      .prepare('SELECT conversation_id, workspace_uris, parent_conversation_id FROM conversation_summaries')
      .all();
    for (const r of rows) {
      const cid = String(r.conversation_id || '').trim();
      if (!cid) continue;
      let uris = [];
      try {
        const parsed = JSON.parse(r.workspace_uris || '[]');
        if (Array.isArray(parsed)) {
          uris = parsed.map(normalizeUriToPath).filter(Boolean);
        }
      } catch {
        const single = normalizeUriToPath(r.workspace_uris);
        if (single) uris = [single];
      }
      map.set(cid, {
        parentConversationId: String(r.parent_conversation_id || '').trim(),
        workspaces: uris,
      });
    }
    // Inherit parent's workspaces if a subagent row had empty workspace_uris.
    for (const [, info] of map) {
      if (info.workspaces.length === 0 && info.parentConversationId) {
        const parent = map.get(info.parentConversationId);
        if (parent && parent.workspaces.length > 0) {
          info.workspaces = parent.workspaces;
        }
      }
    }
  } catch {
    // Fallback to per-DB trajectory_metadata_blob if summaries DB is locked/unavailable.
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
  return map;
}

function parseConversationDb(cid, dbPath) {
  const stamp = `v2|${fileStamp(dbPath)}|${fileStamp(`${dbPath}-wal`)}`;
  const cached = dbCache.get(cid);
  if (cached && cached.stamp === stamp) {
    return cached.parsed;
  }

  let db;
  const events = [];
  let fallbackParentId = '';

  try {
    db = new DatabaseSync(dbPath, { readOnly: true });

    try {
      const tmbRow = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
      if (tmbRow?.data) {
        const tmb = new WireMsg(tmbRow.data);
        fallbackParentId = tmb.str(5) || '';
      }
    } catch {
      // Optional table
    }

    try {
      const genRows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 5').all();
      for (const gr of genRows) {
        if (!gr?.data) continue;
        const g = new WireMsg(gr.data);
        const chat = g.msg(1);
        const planner = g.msg(3);
        const u = chat ? chat.msg(4) : null;
        if (!u) continue;
        const enumId = u.int(1);
        if (!enumId) continue;
        const slug = (planner ? planner.str(28) : '') || (chat ? chat.str(19) : '');
        const disp = chat ? chat.str(21) : '';
        const existing = observedEnumModels.get(enumId);
        if (!existing || (slug && !existing.slug) || (disp && !existing.displayName)) {
          const fullDisp = disp || existing?.displayName || formatSlugLabel(slug);
          const finalSlug = slug || existing?.slug || `model-${enumId}`;
          observedEnumModels.set(enumId, {
            slug: finalSlug,
            displayName: fullDisp,
            providerID: inferProviderID(finalSlug, fullDisp, u.int(6)),
          });
        }
      }
    } catch {
      // Optional table
    }

    const stepRows = db.prepare('SELECT idx, step_type, status, metadata FROM steps ORDER BY idx').all();
    for (const r of stepRows) {
      const stype = Number(r.step_type || 0);
      const status = Number(r.status || 0);
      const md = r.metadata ? new WireMsg(r.metadata) : null;
      if (!md) continue;

      const tsSec =
        pbSeconds(md.msg(1)) ||
        pbSeconds(md.msg(6)) ||
        pbSeconds(md.msg(7)) ||
        pbSeconds(md.msg(8));
      if (tsSec <= 0) continue;
      const tsMs = Math.round(tsSec * 1000);

      if (stype === STEP_USER_INPUT) {
        events.push({ tsMs, kind: 'prompt' });
        continue;
      }

      if (stype === STEP_PLANNER_RESPONSE || stype === STEP_CHECKPOINT) {
        const isCompaction = stype === STEP_CHECKPOINT && (status === 3 || status === 5);
        const u = md.msg(9);
        if (u) {
          const input = u.int(2);
          const totalOut = u.int(3);
          const cacheRead = u.int(5);
          const reasoning = u.int(9);
          const respOut = u.int(10) || Math.max(0, totalOut - reasoning);
          if (input > 0 || totalOut > 0 || cacheRead > 0) {
            let durSec = 0;
            let ttftMs = null;
            if (stype === STEP_PLANNER_RESPONSE && totalOut > 0) {
              const t1 = pbSeconds(md.msg(1));
              const t6 = pbSeconds(md.msg(6));
              const tEnd = pbSeconds(md.msg(7)) || pbSeconds(md.msg(8));
              if (t1 > 0 && tEnd > t1) {
                durSec = tEnd - t1;
                if (t6 >= t1 && t6 - t1 <= durSec) {
                  ttftMs = (t6 - t1) * 1000;
                }
              }
            }
            events.push({
              tsMs,
              kind: 'model',
              isCompaction,
              modelEnum: u.int(1),
              apiProvider: u.int(6),
              input,
              output: respOut,
              reasoning,
              cacheRead,
              durSec,
              ttftMs,
            });
            continue;
          }
        }
        if (isCompaction) {
          events.push({ tsMs, kind: 'compaction' });
        }
        continue;
      }

      if (!NON_TOOL_STEP_TYPES.has(stype)) {
        const tc = md.msg(4);
        let tname = tc ? tc.str(2) : '';
        if (!tname) continue;
        if (tname === 'call_mcp_tool') {
          try {
            const args = JSON.parse(tc.str(3) || '{}');
            if (args.ServerName && args.ToolName) {
              tname = `${args.ServerName}.${args.ToolName}`;
            } else if (args.ToolName) {
              tname = String(args.ToolName);
            }
          } catch {
            // Keep call_mcp_tool if JSON is malformed
          }
        }

        const m26 = md.msg(26);
        let tRun = 0;
        let tDone = 0;
        let lastTransStatus = 0;
        if (m26) {
          for (const tr of m26.msgs(1)) {
            const code = tr.int(1);
            const ts = pbSeconds(tr.msg(2));
            if (code) lastTransStatus = code;
            if (code === 2 && ts > 0) tRun = ts;
            else if (code === 3 && ts > 0) tDone = ts;
          }
        }
        // status === 5 is STATUS_CLEARED (compacted historical steps); recover their terminal state from m26.
        const effectiveStatus = status === 5 ? (lastTransStatus || 3) : status;

        let state = 'unfinished';
        let durMs = null;
        if (effectiveStatus === 3) {
          state = 'succeeded';
          if (tRun > 0 && tDone >= tRun) {
            durMs = (tDone - tRun) * 1000;
          }
        } else if (effectiveStatus === 4 || effectiveStatus === 7) {
          state = 'failed';
        }

        events.push({
          tsMs,
          kind: 'tool',
          name: tname,
          state,
          durMs,
        });
      }
    }

    // Associate prompts with the subsequent model response and tools/compactions with the preceding model response.
    let prevEnum = 0;
    let prevProv = 0;
    for (const ev of events) {
      if (ev.kind === 'model') {
        prevEnum = ev.modelEnum;
        prevProv = ev.apiProvider;
      } else {
        ev._prevEnum = prevEnum;
        ev._prevProv = prevProv;
      }
    }
    let nextEnum = 0;
    let nextProv = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.kind === 'model') {
        nextEnum = ev.modelEnum;
        nextProv = ev.apiProvider;
      } else if (ev.kind === 'prompt') {
        ev.modelEnum = nextEnum || ev._prevEnum || 0;
        ev.apiProvider = nextEnum ? nextProv : (ev._prevProv || 0);
        delete ev._prevEnum;
        delete ev._prevProv;
      } else {
        ev.modelEnum = ev._prevEnum || nextEnum || 0;
        ev.apiProvider = ev._prevEnum ? ev._prevProv : (nextProv || 0);
        delete ev._prevEnum;
        delete ev._prevProv;
      }
    }
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }

  const parsed = { cid, fallbackParentId, events };
  dbCache.set(cid, { stamp, parsed });
  return parsed;
}

// --- Date & Streak Helpers ---------------------------------------------------

function computeRangeWindow(range, nowMs) {
  const days = RANGE_DAYS[range];
  if (!days) {
    return { from: null, to: nowMs };
  }
  const now = new Date(nowMs);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (days - 1));
  return { from: start.getTime(), to: nowMs };
}

function makeDayFormatter(timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return (tsMs) => fmt.format(new Date(tsMs));
  } catch {
    return (tsMs) => {
      const d = new Date(tsMs);
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${m}-${day}`;
    };
  }
}

function computeLongestStreak(sortedDates) {
  if (!sortedDates.length) return 0;
  let longest = 1;
  let current = 1;
  for (let i = 1; i < sortedDates.length; i++) {
    const [y1, m1, d1] = sortedDates[i - 1].split('-').map(Number);
    const [y2, m2, d2] = sortedDates[i].split('-').map(Number);
    const utc1 = Date.UTC(y1, m1 - 1, d1);
    const utc2 = Date.UTC(y2, m2 - 1, d2);
    const diffDays = Math.round((utc2 - utc1) / 86_400_000);
    if (diffDays === 1) {
      current += 1;
      if (current > longest) longest = current;
    } else if (diffDays > 1) {
      current = 1;
    }
  }
  return longest;
}

function computeMedian(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const val = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Number(val.toFixed(1));
}

function resolveModelInfo(modelEnum, apiProvider) {
  const known = observedEnumModels.get(modelEnum);
  const slug = known?.slug || (modelEnum ? `model-${modelEnum}` : 'unknown');
  const fullDisp = known?.displayName || formatSlugLabel(slug);
  const providerID = known?.providerID || inferProviderID(slug, fullDisp, apiProvider);
  const { displayName, variant, familyID } = splitNameAndVariant(fullDisp, slug);
  const pricing = getModelPricingPerMillion(slug, fullDisp, providerID);
  const key = `${providerID}/${slug}`;
  const familyKey = `family:${providerID}/${familyID}`;
  return {
    key,
    familyKey,
    familyID,
    providerID,
    providerName: providerDisplayName(providerID),
    modelID: slug,
    displayName,
    variant,
    pricing,
  };
}

function matchesModelFilter(mInfo, modelFilter) {
  if (!modelFilter) return true;
  if (!mInfo) return false;
  if (modelFilter.startsWith('family:')) {
    return mInfo.familyKey === modelFilter;
  }
  return mInfo.key === modelFilter || mInfo.modelID === modelFilter;
}

function resolveSelectedModelSpec(modelFilter, models) {
  if (!modelFilter) return null;
  const isFamily = modelFilter.startsWith('family:');
  let matched = models.find((m) => (isFamily ? m.familyKey === modelFilter : m.key === modelFilter || m.modelID === modelFilter));
  if (!matched) {
    for (const [enumId, info] of observedEnumModels.entries()) {
      const mInfo = resolveModelInfo(enumId, 0);
      if (matchesModelFilter(mInfo, modelFilter)) {
        matched = { ...mInfo, _pricing: mInfo.pricing };
        break;
      }
    }
  }
  if (!matched) return null;
  const pricing = matched.pricing || matched._pricing || getModelPricingPerMillion(matched.modelID, matched.displayName, matched.providerID);
  const fullLabel = isFamily
    ? `${matched.displayName} (All variants)`
    : matched.variant
      ? `${matched.displayName} (${matched.variant})`
      : matched.displayName;
  return {
    filterKey: modelFilter,
    isFamily,
    providerID: matched.providerID,
    providerName: matched.providerName,
    modelID: isFamily ? matched.familyID : matched.modelID,
    familyID: matched.familyID,
    familyKey: matched.familyKey,
    displayName: matched.displayName,
    variant: isFamily ? 'All variants' : matched.variant,
    fullLabel,
    pricing,
  };
}

// --- Main Report Computation -------------------------------------------------

export async function computeUsageStatsReport(options = {}) {
  const rangeKey = RANGE_DAYS[options.range] ? options.range : 'all';
  const projectFilter = options.project && options.project !== '__all__' ? String(options.project) : null;
  const modelFilter = options.model && options.model !== '__all__' ? String(options.model) : null;
  const timeZone = options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const force = Boolean(options.force);

  await Promise.all([
    refreshStatsModelCatalog(options.lsRequest, force),
    refreshOfficialPricingCatalog(force),
  ]);

  const summariesMap = readConversationSummariesMap();
  const projectsMap = new Map();
  for (const [, info] of summariesMap) {
    for (const ws of info.workspaces) {
      if (!projectsMap.has(ws)) {
        projectsMap.set(ws, {
          id: ws,
          name: basename(ws) || ws,
          path: ws,
        });
      }
    }
  }

  const nowMs = Date.now();
  const window = computeRangeWindow(rangeKey, nowMs);
  const dayKeyOf = makeDayFormatter(timeZone);

  const files = existsSync(CONVERSATIONS_DIR)
    ? readdirSync(CONVERSATIONS_DIR).filter((f) => f.endsWith('.db'))
    : [];

  let sessions = 0;
  let subagents = 0;
  let prompts = 0;
  let steps = 0;
  let compactions = 0;

  const tokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    total: 0,
  };

  let filteredCost = 0;
  const filteredBreakdown = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheSaved: 0,
    uncachedTotal: 0,
    overThresholdSteps: 0,
    overThresholdTokens: 0,
  };
  let timedOutTokens = 0;
  let totalGenDurSec = 0;
  const ttftSamples = [];

  const activityMap = new Map(); // YYYY-MM-DD -> steps
  const modelMap = new Map(); // modelKey -> entry (across all models in range + project)
  const toolMap = new Map(); // toolName -> entry
  const toolTotals = {
    calls: 0,
    succeeded: 0,
    failed: 0,
    unfinished: 0,
  };

  let earliestEventMs = null;

  for (const f of files) {
    const cid = f.slice(0, -3);
    const parsed = parseConversationDb(cid, join(CONVERSATIONS_DIR, f));
    const summaryInfo = summariesMap.get(cid);
    const isSubagent = Boolean(summaryInfo?.parentConversationId || parsed.fallbackParentId);
    const workspaces = summaryInfo?.workspaces || [];

    if (projectFilter && !workspaces.includes(projectFilter)) {
      continue;
    }

    let activeInWindow = false;

    for (const ev of parsed.events) {
      if (ev.tsMs >= window.to) continue;
      if (window.from !== null && ev.tsMs < window.from) continue;

      const mInfo = ev.modelEnum ? resolveModelInfo(ev.modelEnum, ev.apiProvider) : null;

      // Always record model usage into modelMap for the current (range, project)
      // so the Models selector and comparison list stay complete when a model is selected.
      if (ev.kind === 'model' && mInfo) {
        const evTotal = ev.input + ev.output + ev.reasoning + ev.cacheRead;
        const stepCost = estimateStepCostBreakdown(ev, mInfo.pricing);
        let mEntry = modelMap.get(mInfo.key);
        if (!mEntry) {
          mEntry = {
            key: mInfo.key,
            familyKey: mInfo.familyKey,
            familyID: mInfo.familyID,
            providerID: mInfo.providerID,
            providerName: mInfo.providerName,
            modelID: mInfo.modelID,
            displayName: mInfo.displayName,
            variant: mInfo.variant,
            steps: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, total: 0 },
            cost: 0,
            _timedOut: 0,
            _durSec: 0,
            _pricing: mInfo.pricing,
          };
          modelMap.set(mInfo.key, mEntry);
        }
        mEntry.steps += 1;
        mEntry.tokens.input += ev.input;
        mEntry.tokens.output += ev.output;
        mEntry.tokens.reasoning += ev.reasoning;
        mEntry.tokens.cacheRead += ev.cacheRead;
        mEntry.tokens.total += evTotal;
        mEntry.cost += stepCost.totalCost;
        if (ev.durSec > 0) {
          mEntry._timedOut += ev.output + ev.reasoning;
          mEntry._durSec += ev.durSec;
        }
      }

      if (modelFilter && !matchesModelFilter(mInfo, modelFilter)) {
        continue;
      }

      activeInWindow = true;
      if (earliestEventMs === null || ev.tsMs < earliestEventMs) {
        earliestEventMs = ev.tsMs;
      }

      if (ev.kind === 'prompt') {
        prompts += 1;
      } else if (ev.kind === 'compaction') {
        compactions += 1;
      } else if (ev.kind === 'model' && mInfo) {
        steps += 1;
        if (ev.isCompaction) compactions += 1;

        const evTotal = ev.input + ev.output + ev.reasoning + ev.cacheRead;
        tokens.input += ev.input;
        tokens.output += ev.output;
        tokens.reasoning += ev.reasoning;
        tokens.cacheRead += ev.cacheRead;
        tokens.total += evTotal;

        const stepCost = estimateStepCostBreakdown(ev, mInfo.pricing);
        filteredCost += stepCost.totalCost;
        filteredBreakdown.input += stepCost.inputCost;
        filteredBreakdown.output += stepCost.outputCost;
        filteredBreakdown.reasoning += stepCost.reasoningCost;
        filteredBreakdown.cacheRead += stepCost.cacheReadCost;
        filteredBreakdown.cacheSaved += stepCost.cacheSaved;
        filteredBreakdown.uncachedTotal += stepCost.uncachedTotal;
        if (stepCost.isOver) {
          filteredBreakdown.overThresholdSteps += 1;
          filteredBreakdown.overThresholdTokens += evTotal;
        }

        const dayKey = dayKeyOf(ev.tsMs);
        activityMap.set(dayKey, (activityMap.get(dayKey) || 0) + 1);

        if (ev.durSec > 0) {
          const outProduced = ev.output + ev.reasoning;
          timedOutTokens += outProduced;
          totalGenDurSec += ev.durSec;
          if (ev.ttftMs !== null) {
            ttftSamples.push(ev.ttftMs);
          }
        }
      } else if (ev.kind === 'tool') {
        toolTotals.calls += 1;
        toolTotals[ev.state] += 1;

        let tEntry = toolMap.get(ev.name);
        if (!tEntry) {
          tEntry = {
            name: ev.name,
            calls: 0,
            succeeded: 0,
            failed: 0,
            unfinished: 0,
            _durations: [],
          };
          toolMap.set(ev.name, tEntry);
        }
        tEntry.calls += 1;
        tEntry[ev.state] += 1;
        if (ev.durMs !== null) {
          tEntry._durations.push(ev.durMs);
        }
      }
    }

    if (activeInWindow) {
      if (isSubagent) subagents += 1;
      else sessions += 1;
    }
  }

  const activity = Array.from(activityMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, daySteps]) => ({ date, steps: daySteps }));

  const activeDays = activity.length;
  const streak = computeLongestStreak(activity.map((d) => d.date));

  const models = Array.from(modelMap.values()).map((m) => ({
    key: m.key,
    familyKey: m.familyKey,
    familyID: m.familyID,
    providerID: m.providerID,
    providerName: m.providerName,
    modelID: m.modelID,
    displayName: m.displayName,
    variant: m.variant,
    steps: m.steps,
    tokens: m.tokens,
    cost: Number(m.cost.toFixed(4)),
    avgOutputTps: m._durSec > 0 ? Number((m._timedOut / m._durSec).toFixed(1)) : null,
    pricing: m._pricing,
  }));
  models.sort((a, b) => b.tokens.total - a.tokens.total);

  const familyMap = new Map();
  for (const m of models) {
    let f = familyMap.get(m.familyKey);
    if (!f) {
      f = {
        familyKey: m.familyKey,
        familyID: m.familyID,
        providerID: m.providerID,
        providerName: m.providerName,
        displayName: m.displayName,
        variantsCount: 0,
        tokensTotal: 0,
      };
      familyMap.set(m.familyKey, f);
    }
    f.variantsCount += 1;
    f.tokensTotal += m.tokens.total;
  }
  const modelFamilies = Array.from(familyMap.values()).sort((a, b) => b.tokensTotal - a.tokensTotal);

  let selectedModel = null;
  if (modelFilter) {
    const spec = resolveSelectedModelSpec(modelFilter, models);
    if (spec) {
      const p = spec.pricing;
      const cacheDiscountPct = p.input > 0 ? Math.round((1 - p.cacheRead / p.input) * 100) : 0;

      selectedModel = {
        ...spec,
        pricing: {
          input: p.input,
          output: p.output,
          cacheRead: p.cacheRead,
          overThreshold: p.overThreshold || null,
          scheduleNote: p.scheduleNote || null,
          benchmark: p.benchmark,
          cacheDiscountPct,
          sourceStatus: p.sourceStatus || 'builtin',
          sourceUrl: p.sourceUrl || null,
          sourceUpdatedAt: p.sourceUpdatedAt || null,
          fallbackReason: p.fallbackReason || null,
        },
        costBreakdown: {
          input: Number(filteredBreakdown.input.toFixed(4)),
          output: Number(filteredBreakdown.output.toFixed(4)),
          reasoning: Number(filteredBreakdown.reasoning.toFixed(4)),
          outputTotal: Number((filteredBreakdown.output + filteredBreakdown.reasoning).toFixed(4)),
          cacheRead: Number(filteredBreakdown.cacheRead.toFixed(4)),
          total: Number(filteredCost.toFixed(4)),
          cacheSaved: Number(filteredBreakdown.cacheSaved.toFixed(4)),
          uncachedTotal: Number(filteredBreakdown.uncachedTotal.toFixed(4)),
          overThresholdSteps: filteredBreakdown.overThresholdSteps,
          overThresholdTokens: filteredBreakdown.overThresholdTokens,
        },
      };
    }
  }

  const toolUsage = Array.from(toolMap.values())
    .map((t) => ({
      name: t.name,
      calls: t.calls,
      succeeded: t.succeeded,
      failed: t.failed,
      unfinished: t.unfinished,
      durationP50: computeMedian(t._durations),
    }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  const effectiveFrom = window.from !== null ? window.from : (earliestEventMs ?? nowMs);
  const gStat = pricingState.google;
  const cStat = pricingState.anthropic;
  const hasFallback = Boolean(gStat.fallbackReason || cStat.fallbackReason);

  return {
    range: { from: effectiveFrom, to: window.to },
    rangeKey,
    project: projectFilter || '__all__',
    projects: Array.from(projectsMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
    model: modelFilter || '__all__',
    modelFamilies,
    selectedModel,
    pricingSources: {
      hasFallback,
      google: {
        status: gStat.status,
        updatedAt: gStat.updatedAt,
        url: gStat.url,
        fallbackReason: gStat.fallbackReason,
      },
      anthropic: {
        status: cStat.status,
        updatedAt: cStat.updatedAt,
        url: cStat.url,
        fallbackReason: cStat.fallbackReason,
      },
    },
    sessions,
    subagents,
    prompts,
    steps,
    compactions,
    tokens,
    cost: Number(filteredCost.toFixed(2)),
    performance: {
      avgOutputTps: totalGenDurSec > 0 ? Number((timedOutTokens / totalGenDurSec).toFixed(1)) : null,
      ttftP50Ms: computeMedian(ttftSamples),
    },
    activeDays,
    streak,
    activity,
    models,
    tools: {
      totals: toolTotals,
      usage: toolUsage,
    },
    updatedAt: new Date(nowMs).toISOString(),
  };
}
