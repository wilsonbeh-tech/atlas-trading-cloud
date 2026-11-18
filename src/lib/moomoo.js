import { normalizePosition } from './planner.js';

const PROTOCOL_VERSION = '2025-06-18';

export class MCPClient {
  constructor({ url, token, timeoutMs = 30000 }) {
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.nextId = 1;
  }

  async connect() {
    const res = await this.#post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'atlas-moomoo-agent', version: '1.0.0' }
      }
    });
    this.sessionId = res.sessionId ?? this.sessionId;
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { expectResponse: false });
    return res.message?.result ?? {};
  }

  async callTool(name, args = {}) {
    const res = await this.#post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args }
    });
    const result = res.message?.result;
    if (res.message?.error) throw new Error(`MCP error for ${name}: ${JSON.stringify(res.message.error)}`);
    if (result?.isError) throw new Error(`Tool ${name} failed: ${textOf(result)}`);
    const text = textOf(result);
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  async #post(payload, { expectResponse = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`,
      'mcp-protocol-version': PROTOCOL_VERSION
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const sessionId = response.headers.get('mcp-session-id');
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`MCP HTTP ${response.status}: ${body.slice(0, 300)}`);
      }
      if (!expectResponse) return { message: null, sessionId };
      const text = await response.text();
      const message = parseBody(text, response.headers.get('content-type') ?? '');
      return { message, sessionId };
    } finally {
      clearTimeout(timer);
    }
  }
}

function textOf(result) {
  if (!result) return '';
  if (Array.isArray(result.content)) {
    return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  }
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

function parseBody(text, contentType) {
  if (!text.trim()) return null;
  if (contentType.includes('text/event-stream')) {
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    for (const line of lines.reverse()) {
      const raw = line.slice(5).trim();
      if (!raw) continue;
      try {
        const msg = JSON.parse(raw);
        if (msg.id !== undefined || msg.result || msg.error) return msg;
      } catch {
        // keep scanning earlier frames
      }
    }
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.at(-1) : parsed;
  } catch {
    return null;
  }
}

export class PaperBroker {
  constructor(client, { accountId, marketId }) {
    this.client = client;
    this.accountId = accountId;
    this.marketId = marketId;
  }

  static async connect({ url, token }) {
    if (!url || !token) {
      throw new Error('Set MOOMOO_MCP_URL and MOOMOO_MCP_TOKEN to use the HTTP transport');
    }
    const client = new MCPClient({ url, token });
    await client.connect();
    return client;
  }

  async accounts() {
    const res = await this.client.callTool('sim_trade_account_list');
    return res?.data?.accounts ?? [];
  }

  async cash() {
    const res = await this.client.callTool('sim_trade_cash_info', { acc_id: this.accountId });
    return res?.data ?? {};
  }

  async positions() {
    const res = await this.client.callTool('sim_trade_position_list', { acc_id: this.accountId, market: this.marketId });
    return (res?.data?.positions ?? []).map(normalizePosition);
  }

  async quotes(symbols) {
    const res = await this.client.callTool('quote_stock_quote', { code_list: symbols });
    const map = {};
    for (const q of res?.data?.quote_list ?? []) map[q.code] = q;
    return map;
  }

  async klines(symbol, end, num = 370) {
    const res = await this.client.callTool('quote_history_kline', { symbol, end, num, ktype: 2 });
    return res?.data?.kline_list ?? [];
  }

  async todaysOrders() {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const res = await this.client.callTool('sim_trade_history_order_list', {
      acc_id: this.accountId,
      market: this.marketId,
      time_begin: start.getTime() * 1000,
      time_end: Date.now() * 1000,
      page_size: 200
    });
    return res?.data?.orders ?? res?.data?.order_list ?? [];
  }

  async placeLimitOrder({ symbol, side, qty, price, note }) {
    return this.client.callTool('sim_trade_input_order', {
      acc_id: this.accountId,
      market: this.marketId,
      symbol,
      order_type: 1,
      order_side: side === 'BUY' ? 1 : 2,
      qty: String(qty),
      price: Number(price).toFixed(2),
      order_trade_time_type: 1,
      text: (note ?? '').slice(0, 100)
    });
  }

  async cancelOrder(orderId) {
    return this.client.callTool('sim_trade_cancel_order', {
      acc_id: this.accountId,
      market: this.marketId,
      order_id: orderId
    });
  }
}

export function pickAccount(accounts, cfg) {
  const tokens = (cfg.account.matchTokens ?? [cfg.account.matchTitle]).map((w) => String(w).toLowerCase());
  const byTitle = (needle) => accounts.find((a) => String(a.account_title ?? '').toLowerCase().includes(String(needle).toLowerCase()));
  const match = accounts.find((a) => {
    const t = String(a.account_title ?? '').toLowerCase();
    return tokens.every((w) => t.includes(w));
  });
  if (match) return { account: match, isCompetition: true };
  const fallback = byTitle(cfg.account.fallbackTitle);
  if (fallback) return { account: fallback, isCompetition: false };
  const us = accounts.find((a) => Number(a.market_id) === Number(cfg.account.marketId));
  return { account: us ?? null, isCompetition: false };
}
