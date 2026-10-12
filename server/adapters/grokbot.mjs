// adapters/grokbot.mjs — Grok Bot 渠道（配额 + 本地 Token 序列）
// Grok Bot 是 xAI 的产品，基于 Anysphere 的 Sand 架构运行。
// 配额（双源容错）：
//   1. 优先通过 Cursor 凭证（state.vscdb → cursorAuth/accessToken）调用 api2.cursor.sh。
//   2. 若无 Cursor 凭证或调用失败，自动回退读取桌面客户端本地持久化切片：
//      ~/Library/Application Support/Grok Bot/sand-client-persistence/ 下的 weekly-usage.cache。
// Token 序列（会话文本估算）：
//   扫描 sand-client-persistence/ 下的 transcript.replicas.* 会话切片。
//   按时间戳 timestampMs 和消息内容进行字符级 Token 估算归约，增量缓存至 server/.cache/grokbot-scan.json。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { swr, staleGate } from '../ttl.mjs';
import { localDate } from '../scan-util.mjs';
import { readCursorAuth } from './cursor.mjs';

const HOME = os.homedir();
const SAND_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus';
const WEEK_SEC = 7 * 86400;
const GROKBOT_DIR = path.join(HOME, 'Library', 'Application Support', 'Grok Bot');
const GROKBOT_DATA_DIR = path.join(GROKBOT_DIR, 'sand-client-persistence');
const VSCDB = path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const CACHE_FILE = fileURLToPath(new URL('../.cache/grokbot-scan.json', import.meta.url));
const SCAN_DAYS = 95;

class AuthExpired extends Error {}
class NotIncluded extends Error {}
class Unreadable extends Error {}

const pick = (o, camel) => o[camel] ?? o[camel.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())];

function parseTs(v) {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : null;
}

// RFC 4648 Base32 解码（用于还原 sand-client-persistence 中的切片 key）
function base32Decode(s) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, value = 0;
  const output = [];
  for (let i = 0; i < s.length; i++) {
    const idx = alphabet.indexOf(s[i].toLowerCase());
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output).toString('utf8');
}

// 导出供测试直接驱动
export function windowFromReply(j, now = Date.now()) {
  const pooled = pick(j, 'usesPooledEnterpriseAllowance');
  const zero = pick(j, 'includedLimitZero');
  const nonZero = pick(j, 'hasNonZeroIncludedLimit');
  const pct = pick(j, 'usagePercent');
  if (pooled == null && zero == null && nonZero == null) throw new Unreadable('grok bot reply has no allowance flags');
  if (pooled === true) throw new NotIncluded('组织共享额度，无个人份额');
  if (zero === true || nonZero !== true) throw new NotIncluded('当前套餐不含 Grok Bot');
  const used = Number(pct);
  if (pct == null || !Number.isFinite(used)) throw new Unreadable('grok bot reply has no usagePercent');

  // 显示口径对齐官方客户端（Grok Bot.app 的百分比格式化）：已用>0 且不足 1% 显示 1%，否则四舍五入到整数。
  // 原值（如 0.0x% 或精确小数）放进副标，避免「用了却显示 0%」。
  const clamped = Math.min(100, Math.max(0, used));
  const shown = clamped > 0 && clamped < 1 ? 1 : Math.round(clamped);
  const exact = clamped > 0 && clamped < 1 ? `实际 ${Number(clamped.toPrecision(2))}%` : (clamped % 1 !== 0 ? `实际 ${Math.round(clamped * 10) / 10}%` : null);

  const reset = parseTs(pick(j, 'nextResetTimestampUtc'));
  const start = parseTs(pick(j, 'currentPeriodStart'));
  return {
    windows: [{
      label: '周额度', windowSec: WEEK_SEC,
      usedPct: shown,
      timePct: start && reset && reset > start ? Math.min(100, Math.round(((now - start) / (reset - start)) * 100)) : null,
      resetInSec: reset ? Math.max(0, Math.round((reset - now) / 1000)) : null,
    }],
    source: j.__source || 'direct',
    note: [pick(j, 'grokPlanLabel')?.trim(), exact].filter(Boolean).join(' · ') || undefined,
  };
}

// 本地客户端持久化缓存回退（无需 Cursor 凭证）
function readLocalWeeklyUsage() {
  if (!fs.existsSync(GROKBOT_DATA_DIR)) return null;
  let files = [];
  try {
    files = fs.readdirSync(GROKBOT_DATA_DIR).filter((f) => f.endsWith('.blob'));
  } catch { return null; }

  for (const f of files) {
    try {
      const decoded = base32Decode(f.slice(0, -5));
      if (decoded.includes('weekly-usage.cache')) {
        const raw = fs.readFileSync(path.join(GROKBOT_DATA_DIR, f), 'utf8');
        const j = JSON.parse(raw);
        const usage = j.value?.reading?.usage;
        if (usage && usage.percentUsed != null) {
          const now = Date.now();
          const reset = usage.nextResetMs;
          const resetInSec = reset && reset > now ? Math.max(0, Math.round((reset - now) / 1000)) : null;
          const res = windowFromReply({
            usesPooledEnterpriseAllowance: false,
            includedLimitZero: false,
            hasNonZeroIncludedLimit: usage.hasNonZeroIncludedLimit ?? true,
            usagePercent: usage.percentUsed,
            nextResetTimestampUtc: usage.nextResetMs,
            grokPlanLabel: usage.grokPlanLabel || 'SuperGrok',
            __source: 'local-cache',
          });
          if (res.windows?.[0] && resetInSec != null) {
            res.windows[0].timePct = Math.min(100, Math.max(0, Math.round((1 - resetInSec / WEEK_SEC) * 100)));
          }
          return res;
        }
      }
    } catch {}
  }
  return null;
}

async function fetchUsage() {
  let remoteErr = null;
  if (fs.existsSync(VSCDB)) {
    try {
      const auth = await readCursorAuth();
      const token = auth['cursorAuth/accessToken'];
      if (token) {
        const res = await fetch(SAND_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
          },
          body: '{}',
          signal: AbortSignal.timeout(12_000),
        });
        if (res.status === 401 || res.status === 403) throw new AuthExpired(`grok bot usage HTTP ${res.status}`);
        if (!res.ok) throw new Error(`grok bot usage HTTP ${res.status}`);
        return windowFromReply(await res.json());
      }
    } catch (e) {
      remoteErr = e;
    }
  }

  // 远端不可用时回退读取 Grok Bot 本地客户端切片缓存
  const local = readLocalWeeklyUsage();
  if (local) return local;

  if (remoteErr) throw remoteErr;
  throw new AuthExpired('no grokbot credentials');
}

// 混合文本 Tokenizer 估算（中文 ~1.5 字符/tok，代码英文 ~4 字符/tok）
function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0, ascii = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x2e80) cjk++;
    else ascii++;
  }
  return Math.max(1, Math.round(cjk / 1.5 + ascii / 4));
}

// Token 序列增量扫描：读取 sand-client-persistence/ 目录下所有会话 transcript replicas
function scan() {
  const cache = (() => {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (c.v !== 1) throw new Error('rebuild cache');
      return c;
    } catch { return { v: 1, files: {}, rows: {} }; }
  })();

  if (!fs.existsSync(GROKBOT_DATA_DIR)) return Object.values(cache.rows);

  let blobFiles = [];
  try {
    blobFiles = fs.readdirSync(GROKBOT_DATA_DIR).filter((f) => f.endsWith('.blob'));
  } catch { blobFiles = []; }

  const cutoffMs = Date.now() - SCAN_DAYS * 86400000;
  const keepAfter = localDate(cutoffMs);

  for (const f of blobFiles) {
    const decoded = base32Decode(f.slice(0, -5));
    if (!decoded.includes('transcript.replicas')) continue;

    const fullPath = path.join(GROKBOT_DATA_DIR, f);
    let st;
    try { st = fs.statSync(fullPath); } catch { continue; }
    if (st.mtimeMs < cutoffMs) continue;

    const rec = cache.files[fullPath];
    if (rec && rec.mtimeMs === st.mtimeMs && rec.size === st.size) {
      continue; // 未变动直接复用
    }

    // 解析会话文件
    try {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const j = JSON.parse(raw);
      const entries = j.value?.entries || [];
      const dailyMap = {};

      for (const e of entries) {
        const ms = e.timestampMs;
        if (!ms) continue;
        const text = e.message?.content || e.content || e.richText || '';
        if (!text) continue;

        const date = localDate(ms);
        if (date < keepAfter) continue;

        const tok = estimateTokens(text);
        const cur = dailyMap[date] || (dailyMap[date] = { input: 0, output: 0 });
        const isUser = e.kind === 'message' || e.author === 'user' || e.role === 'user';
        if (isUser) cur.input += tok;
        else cur.output += tok;
      }

      cache.files[fullPath] = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        daily: dailyMap,
      };
    } catch {}
  }

  // 重构 rows
  const newRows = {};
  for (const [p, fileRec] of Object.entries(cache.files)) {
    if (!fs.existsSync(p)) {
      delete cache.files[p];
      continue;
    }
    for (const [date, val] of Object.entries(fileRec.daily || {})) {
      if (date < keepAfter) continue;
      const key = `${date}|grok-bot`;
      const row = newRows[key] || (newRows[key] = {
        date, model: 'grok-bot', cwd: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      });
      row.input += val.input;
      row.output += val.output;
    }
  }
  cache.rows = newRows;

  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {}

  return Object.values(cache.rows);
}

export function createGrokBotAdapter() {
  const gate = staleGate(60_000, 30 * 60_000, fetchUsage);
  const rowsCache = swr(5 * 60_000, async () => scan());
  let lastOk = 0, lastLatency = 0;

  return {
    id: 'grokbot', name: 'Grok Bot', color: '#fb7185',
    warm() { gate({}).catch(() => {}); rowsCache.warm(); },
    async quota() {
      const hasLocal = fs.existsSync(GROKBOT_DATA_DIR);
      const hasCursor = fs.existsSync(VSCDB);
      if (!hasLocal && !hasCursor) {
        return { status: 'unconfigured', kind: 'windows', windows: [], note: '未检测到 Grok Bot 使用记录' };
      }

      const t0 = Date.now();
      try {
        const r = await gate({});
        lastLatency = Date.now() - t0; lastOk = Date.now();
        const base = { kind: 'windows', windows: r.data.windows, source: r.data.source, note: r.data.note };
        if (r.stale) {
          const mins = Math.max(1, Math.round(r.ageMs / 60000));
          return { ...base, status: 'stale', note: `数据为 ${mins} 分钟前 · 查询失败重试中` };
        }
        return { ...base, status: 'online' };
      } catch (e) {
        if (e instanceof AuthExpired) {
          return { status: 'offline', kind: 'windows', windows: [], note: '未登录 Grok Bot 或凭证已过期' };
        }
        if (e instanceof NotIncluded) {
          return { status: 'offline', kind: 'windows', windows: [], note: e.message };
        }
        if (e instanceof Unreadable) {
          return { status: 'offline', kind: 'windows', windows: [], note: '接口回包读不懂（可能已改版）' };
        }
        throw e;
      }
    },
    async usageRows() { return rowsCache.get(); },
    health() {
      const hasLocal = fs.existsSync(GROKBOT_DATA_DIR);
      const hasCursor = fs.existsSync(VSCDB);
      if (!hasLocal && !hasCursor) return { state: 'unconfigured', latencyMs: 0 };
      return { state: lastOk ? 'operational' : 'degraded', latencyMs: Math.round(lastLatency) };
    },
  };
}
