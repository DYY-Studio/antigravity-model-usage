// Historical session & usage statistics aggregator for Antigravity 2.0.
//
// Scans ~/.gemini/antigravity/conversation_summaries.db and conversations/*.db
// using Node's built-in node:sqlite (read-only) with per-database mtime:size
// caching, producing OpenChamber-style usage statistics plus Antigravity-native
// performance metrics (4-segment tokens, output TPS, median TTFT, compactions,
// and per-tool execution durations including MCP server.tool breakdown).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const GEMINI_DIR = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
const APP_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR || join(GEMINI_DIR, 'antigravity');
const SUMMARIES_DB = join(APP_DIR, 'conversation_summaries.db');
const CONVERSATIONS_DIR = join(APP_DIR, 'conversations');

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

// Public API equivalent rates in USD per 1M tokens: { input, output (incl. reasoning), cacheRead, benchmark }
function getModelPricingPerMillion(modelID, displayName, providerID) {
  const key = `${modelID || ''} ${displayName || ''}`.toLowerCase();
  if (key.includes('claude-opus') || key.includes('claude opus')) {
    return {
      input: 5.0,
      output: 25.0,
      cacheRead: 0.5,
      benchmark: 'Anthropic Claude Opus API',
    };
  }
  if (key.includes('claude-sonnet') || key.includes('claude sonnet')) {
    return {
      input: 3.0,
      output: 15.0,
      cacheRead: 0.3,
      benchmark: 'Anthropic Claude Sonnet API',
    };
  }
  if (key.includes('claude-haiku') || key.includes('claude haiku')) {
    return {
      input: 1.0,
      output: 5.0,
      cacheRead: 0.1,
      benchmark: 'Anthropic Claude Haiku API',
    };
  }
  if (key.includes('gpt-oss')) {
    return {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.0375,
      benchmark: 'Open-weight 120B API equivalent',
    };
  }
  if (key.includes('flash-lite') || key.includes('flash lite') || key.includes('tab_') || key.includes('chat_')) {
    return {
      input: 0.1,
      output: 0.4,
      cacheRead: 0.025,
      benchmark: 'Google Gemini Flash-Lite API',
    };
  }
  if (key.includes('flash')) {
    return {
      input: 0.3,
      output: 2.5,
      cacheRead: 0.075,
      benchmark: 'Google Gemini Flash API',
    };
  }
  if (key.includes('argon') || key.includes('pro') || providerID === 'google') {
    return {
      input: 1.25,
      output: 10.0,
      cacheRead: 0.3125,
      benchmark: 'Google Gemini Pro API (<=200k tier)',
    };
  }
  return {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.25,
    benchmark: 'Standard public API benchmark',
  };
}

function estimateTokensCost(tokens, pricing) {
  return (
    (tokens.input * pricing.input +
      (tokens.output + tokens.reasoning) * pricing.output +
      tokens.cacheRead * pricing.cacheRead) /
    1_000_000
  );
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

  await refreshStatsModelCatalog(options.lsRequest, force);

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

        filteredCost += estimateTokensCost(
          { input: ev.input, output: ev.output, reasoning: ev.reasoning, cacheRead: ev.cacheRead },
          mInfo.pricing
        );

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

  const models = Array.from(modelMap.values()).map((m) => {
    const cost = estimateTokensCost(m.tokens, m._pricing);
    return {
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
      cost: Number(cost.toFixed(4)),
      avgOutputTps: m._durSec > 0 ? Number((m._timedOut / m._durSec).toFixed(1)) : null,
      pricing: m._pricing,
    };
  });
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
      const inputCost = (tokens.input * p.input) / 1_000_000;
      const outputCost = (tokens.output * p.output) / 1_000_000;
      const reasoningCost = (tokens.reasoning * p.output) / 1_000_000;
      const cacheReadCost = (tokens.cacheRead * p.cacheRead) / 1_000_000;
      const cacheSaved = (tokens.cacheRead * Math.max(0, p.input - p.cacheRead)) / 1_000_000;
      const uncachedTotal =
        ((tokens.input + tokens.cacheRead) * p.input + (tokens.output + tokens.reasoning) * p.output) / 1_000_000;

      selectedModel = {
        ...spec,
        pricing: {
          input: p.input,
          output: p.output,
          cacheRead: p.cacheRead,
          benchmark: p.benchmark,
          cacheDiscountPct,
        },
        costBreakdown: {
          input: Number(inputCost.toFixed(4)),
          output: Number(outputCost.toFixed(4)),
          reasoning: Number(reasoningCost.toFixed(4)),
          outputTotal: Number((outputCost + reasoningCost).toFixed(4)),
          cacheRead: Number(cacheReadCost.toFixed(4)),
          total: Number(filteredCost.toFixed(4)),
          cacheSaved: Number(cacheSaved.toFixed(4)),
          uncachedTotal: Number(uncachedTotal.toFixed(4)),
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

  return {
    range: { from: effectiveFrom, to: window.to },
    rangeKey,
    project: projectFilter || '__all__',
    projects: Array.from(projectsMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
    model: modelFilter || '__all__',
    modelFamilies,
    selectedModel,
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
