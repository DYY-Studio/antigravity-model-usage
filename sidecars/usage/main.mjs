// Sidecar backend for the Model Usage panel.
//
// Queries the local Antigravity Language Server for live model quota summaries
// (RetrieveUserQuotaSummary) and user plan/credit status (GetUserStatus,
// GetLoadCodeAssist) with zero LLM token consumption.

import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { computeUsageStatsReport } from './stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GEMINI_DIR = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
const CONFIG_PATH = join(GEMINI_DIR, 'config', 'config.json');

const AUTO_FORCE_REFRESH_MS = 60 * 1000;
const MANUAL_REFRESH_COOLDOWN_MS = 5 * 1000;

let lastForceRefreshAt = 0;

function lsRequest(method, body) {
  const addr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!addr || !csrf) {
    return Promise.reject(new Error('Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN'));
  }
  const base = new URL(addr.startsWith('http') ? addr : `http://${addr}`);
  const payload = JSON.stringify(body);
  const transport = base.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: base.hostname,
      port: base.port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 8000,
      rejectUnauthorized: false,
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method} returned HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (err) {
          reject(new Error(`${method} invalid JSON: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} timed out`)));
    req.on('error', reject);
    req.end(payload);
  });
}

function readUseAiCreditsSetting() {
  if (!existsSync(CONFIG_PATH)) {
    return { value: false, warning: null };
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return { value: Boolean(raw?.userSettings?.useAiCredits), warning: null };
  } catch (err) {
    return { value: null, warning: `Failed to read config.json useAiCredits: ${err.message}` };
  }
}

function normalizeGroups(rawGroups) {
  if (!Array.isArray(rawGroups)) return [];
  return rawGroups.map((group) => {
    const buckets = Array.isArray(group.buckets)
      ? group.buckets
        .filter((b) => b && b.displayName)
        .map((b) => {
          const disabled = Boolean(b.disabled);
          // Proto3 JSON omits remainingFraction when its float value is 0.0.
          const remainingFraction = disabled
            ? null
            : (typeof b.remainingFraction === 'number' ? b.remainingFraction : 0);
          return {
            bucketId: b.bucketId || '',
            displayName: b.displayName || '',
            description: b.description || '',
            window: b.window || '',
            remainingFraction,
            resetTime: b.resetTime || null,
            disabled,
          };
        })
      : [];
    return {
      displayName: group.displayName || '',
      description: group.description || '',
      buckets,
    };
  });
}

export async function fetchUsageReport(forceRequested = false) {
  const now = Date.now();
  const shouldForce = Boolean(
    (forceRequested && now - lastForceRefreshAt >= MANUAL_REFRESH_COOLDOWN_MS) ||
    (now - lastForceRefreshAt >= AUTO_FORCE_REFRESH_MS)
  );
  if (shouldForce) {
    lastForceRefreshAt = now;
  }

  const warnings = [];

  // Quota summary is primary and required; fail directly if unavailable.
  const quotaPromise = lsRequest('RetrieveUserQuotaSummary', { forceRefresh: shouldForce });

  const statusPromise = lsRequest('GetUserStatus', {
    metadata: { ideName: 'antigravity', extensionName: 'antigravity' },
  }).catch((err) => {
    warnings.push(`Plan status unavailable: ${err.message}`);
    return null;
  });

  const codeAssistPromise = shouldForce
    ? lsRequest('GetLoadCodeAssist', { forceRefresh: true }).catch((err) => {
      warnings.push(`Code Assist refresh failed: ${err.message}`);
      return null;
    })
    : Promise.resolve(null);

  const [quotaResp, statusResp, codeAssistResp] = await Promise.all([
    quotaPromise,
    statusPromise,
    codeAssistPromise,
  ]);

  const userStatus = statusResp?.userStatus || null;
  const tier = codeAssistResp?.response?.paidTier
    || userStatus?.userTier
    || codeAssistResp?.response?.currentTier
    || null;

  const creditSetting = readUseAiCreditsSetting();
  if (creditSetting.warning) {
    warnings.push(creditSetting.warning);
  }

  const creditEntry = Array.isArray(tier?.availableCredits)
    ? tier.availableCredits.find((c) => c.creditType === 'GOOGLE_ONE_AI' || c.creditType === 1)
    : null;

  const credits = creditEntry
    ? {
      available: Number(creditEntry.creditAmount ?? 0),
      minimumForUsage: Number(creditEntry.minimumCreditAmountForUsage ?? 0),
      overagesEnabled: creditSetting.value,
    }
    : null;

  const plan = tier
    ? {
      tierName: tier.description || tier.name || 'Unknown',
      upgradeText: tier.upgradeSubscriptionText || '',
      upgradeUri: tier.upgradeSubscriptionUri || '',
    }
    : null;

  return {
    groups: normalizeGroups(quotaResp?.response?.groups),
    quotaDescription: quotaResp?.response?.description || '',
    plan,
    credits,
    warnings,
    refreshedUpstream: shouldForce,
    updatedAt: new Date().toISOString(),
  };
}

function isSamePath(a, b) {
  const pa = resolve(a);
  const pb = resolve(b);
  return process.platform === 'win32' ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

const isMain = Boolean(process.argv[1] && isSamePath(fileURLToPath(import.meta.url), process.argv[1]));
if (isMain && process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const app = new SidecarApp();

  app.page('/', () => new Response(readFileSync(join(HERE, 'index.html'), 'utf8'), {
    contentType: 'text/html; charset=utf-8',
  }));

  app.api('/api/usage', async (data) => {
    try {
      const force = data?.force === '1' || data?.force === 'true' || data?.force === true;
      return await fetchUsageReport(force);
    } catch (err) {
      return { error: 'failed', message: err.message };
    }
  }, 'GET');

  app.api('/api/stats', async (data) => {
    try {
      const force = data?.force === '1' || data?.force === 'true' || data?.force === true;
      return await computeUsageStatsReport({
        range: data?.range || '30d',
        project: data?.project || '__all__',
        model: data?.model || '__all__',
        timezone: data?.tz || '',
        force,
        lsRequest,
      });
    } catch (err) {
      return { error: 'failed', message: err.message };
    }
  }, 'GET');

  app.run();
}
