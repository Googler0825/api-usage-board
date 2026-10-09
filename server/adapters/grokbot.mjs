// adapters/grokbot.mjs — Grok Bot 渠道（仅配额，无 token 序列）
// Grok Bot 是 xAI 的产品，经 Cursor 售卖、计在 Cursor 账号上（Cursor 内部协议名 "Sand"）。
//   它不是 Grok CLI / SuperGrok 那份额度——不读 ~/.grok，凭证和接口都是 Cursor 的。
// 凭证：复用 cursor.mjs 的 readCursorAuth（state.vscdb → cursorAuth/accessToken，只进内存）。
// 配额：POST api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus（Connect 协议，Bearer）。
//   未公开接口，字段全按可选解析；驼峰/下划线两种写法都读。
// 映射（参照 Pulse GrokBotUsageService 的结论）：
//   - usagePercent 是「已用」0..100；缺失 ≠ 0（显式存在语义）。
//   - 套餐「不含」时接口也回 0% + 升级文案，直接画会得到一条假的空条。
//     必须 !usesPooledEnterpriseAllowance && !includedLimitZero && hasNonZeroIncludedLimit 才出窗口。
//   - 回包常不带 nextResetTimestampUtc：有就用，没有 resetInSec=null；
//     绝不用 currentPeriodStart+7天 推算（官方客户端也不推）。「周」来自 xAI 文档，只作窗口长度标注。
//   - 回包一个相关字段都没有 = 读不懂（不是「不含」），避免字段改名变成对订阅的错误断言。
// Cursor 登录过期（401/403）→ offline + 副标；其他失败走 stale（≤30min 旧快照）。
import { staleGate } from '../ttl.mjs';
import { readCursorAuth } from './cursor.mjs';

const SAND_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus';
const WEEK_SEC = 7 * 86400;

class AuthExpired extends Error {}
class NotIncluded extends Error {}
class Unreadable extends Error {}

const pick = (o, camel) => o[camel] ?? o[camel.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())];

function parseTs(v) {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : null;
}

// 导出供测试直接驱动
export function windowFromReply(j, now = Date.now()) {
  const pooled = pick(j, 'usesPooledEnterpriseAllowance');
  const zero = pick(j, 'includedLimitZero');
  const nonZero = pick(j, 'hasNonZeroIncludedLimit');
  const pct = pick(j, 'usagePercent');
  if (pooled == null && zero == null && nonZero == null) throw new Unreadable('grok bot reply has no allowance flags');
  if (pooled === true) throw new NotIncluded('组织共享额度，无个人份额');
  if (zero === true || nonZero !== true) throw new NotIncluded('当前 Cursor 套餐不含 Grok Bot');
  const used = Number(pct);
  if (pct == null || !Number.isFinite(used)) throw new Unreadable('grok bot reply has no usagePercent');

  const reset = parseTs(pick(j, 'nextResetTimestampUtc'));
  const start = parseTs(pick(j, 'currentPeriodStart'));
  return {
    windows: [{
      label: '周额度', windowSec: WEEK_SEC,
      usedPct: Math.round(Math.min(100, Math.max(0, used)) * 10) / 10,
      timePct: start && reset && reset > start ? Math.min(100, Math.round(((now - start) / (reset - start)) * 100)) : null,
      resetInSec: reset ? Math.max(0, Math.round((reset - now) / 1000)) : null,
    }],
    source: 'direct',
    note: pick(j, 'grokPlanLabel')?.trim() || undefined,
  };
}

async function fetchUsage() {
  const auth = await readCursorAuth();
  const token = auth['cursorAuth/accessToken'];
  if (!token) throw new AuthExpired('no cursor credentials');
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

export function createGrokBotAdapter() {
  const gate = staleGate(60_000, 30 * 60_000, fetchUsage);
  let lastOk = 0, lastLatency = 0;

  return {
    id: 'grokbot', name: 'Grok Bot', color: '#fb7185', tokenData: false,
    warm() { gate({}).catch(() => {}); },
    async quota() {
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
          return { status: 'offline', kind: 'windows', windows: [], note: 'Cursor 凭证过期，重新打开 Cursor 登录' };
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
    async usageRows() { return []; },
    health() {
      return { state: lastOk ? 'operational' : 'degraded', latencyMs: Math.round(lastLatency) };
    },
  };
}
