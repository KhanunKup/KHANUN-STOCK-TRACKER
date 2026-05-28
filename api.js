/**
 * api.js — StockTracker
 * Handles all external data fetching with:
 *  - Yahoo Finance v8 via dual-proxy race (corsproxy.io + allorigins.win)
 *  - Stooq CSV as fallback
 *  - 15-minute localStorage cache
 *  - No mock data — returns null on total failure
 */

export const MARKET_CACHE_PREFIX = 'stocktracker_market_cache';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function normalizeSymbol(symbol) {
    return String(symbol || '').trim().toUpperCase();
}

export function rangeToDays(range) {
    if (range === '1wk') return 7;
    if (range === '1mo') return 30;
    if (range === '3mo') return 90;
    return 30;
}

function formatDate(date) {
    return date.toISOString().split('T')[0];
}

function formatDateForStooq(date) {
    return formatDate(date).replaceAll('-', '');
}

/**
 * Fetch with an abort-based timeout.
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getCacheKey(symbol, range) {
    return `${MARKET_CACHE_PREFIX}:${normalizeSymbol(symbol)}:${range}`;
}

export function getCachedMarketData(symbol, range) {
    try {
        const raw = localStorage.getItem(getCacheKey(symbol, range));
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (Date.now() - cached.savedAt > CACHE_TTL_MS) return null;
        return cached.data;
    } catch {
        return null;
    }
}

export function setCachedMarketData(symbol, range, data) {
    try {
        localStorage.setItem(
            getCacheKey(symbol, range),
            JSON.stringify({ savedAt: Date.now(), data })
        );
    } catch {
        // Ignore quota errors silently
    }
}

// ─── Yahoo Finance (dual-proxy race) ─────────────────────────────────────────

/**
 * Build a Yahoo Finance v8 chart URL for a symbol + range.
 * Uses interval=1d for daily OHLCV data.
 */
function buildYahooUrl(symbol, range) {
    const interval = range === '1wk' ? '1d' : '1d';
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
}

/**
 * Attempt Yahoo Finance via corsproxy.io (lower latency).
 */
async function fetchYahooCorsProxy(symbol, range) {
    const yahooUrl = buildYahooUrl(symbol, range);
    const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(yahooUrl)}`;
    const response = await fetchWithTimeout(proxyUrl, {}, 5000);
    if (!response.ok) throw new Error(`corsproxy.io HTTP ${response.status}`);
    const parsed = await response.json();
    return parseYahooResponse(parsed, symbol);
}

/**
 * Attempt Yahoo Finance via allorigins.win (existing reliable proxy).
 */
async function fetchYahooAllOrigins(symbol, range) {
    const yahooUrl = buildYahooUrl(symbol, range);
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(yahooUrl)}`;
    const response = await fetchWithTimeout(proxyUrl, {}, 6000);
    if (!response.ok) throw new Error(`allorigins HTTP ${response.status}`);
    const envelope = await response.json();
    const parsed = JSON.parse(envelope.contents);
    return parseYahooResponse(parsed, symbol);
}

/**
 * Parse a Yahoo Finance v8 chart JSON payload into our standard format.
 */
function parseYahooResponse(parsed, symbol) {
    if (parsed?.chart?.error) {
        throw new Error(parsed.chart.error.description || 'Yahoo chart error');
    }

    const result = parsed?.chart?.result?.[0];
    if (!result) throw new Error('Yahoo: no result in response');

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];

    const history = timestamps
        .map((t, i) => {
            const price = parseFloat(closes[i]);
            if (!Number.isFinite(price)) return null;
            return { date: new Date(t * 1000).toISOString().split('T')[0], price };
        })
        .filter(Boolean);

    if (history.length === 0) throw new Error('Yahoo: empty history after parsing');

    // Prefer the live streaming price from meta; fall back to last close
    const currentPrice = Number.isFinite(result.meta?.regularMarketPrice)
        ? result.meta.regularMarketPrice
        : history[history.length - 1].price;

    return {
        symbol: normalizeSymbol(symbol),
        currentPrice,
        history,
        source: 'yahoo'
    };
}

/**
 * Race both Yahoo proxies — fastest valid response wins.
 * If both reject, the returned Promise rejects.
 */
async function fetchFromYahooRace(symbol, range) {
    // Promise.any resolves with the first fulfillment, ignores individual rejections
    return Promise.any([
        fetchYahooCorsProxy(symbol, range),
        fetchYahooAllOrigins(symbol, range)
    ]);
}

// ─── Stooq CSV (fallback) ─────────────────────────────────────────────────────

function toStooqSymbol(symbol) {
    const s = normalizeSymbol(symbol);
    if (s === '^GSPC') return '^spx';
    if (s === '^NDX') return '^ndx';
    if (s.startsWith('^')) return s.toLowerCase();
    return `${s.toLowerCase()}.us`;
}

function parseStooqCsv(csvText) {
    const lines = csvText.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];

    const headers = lines[0].split(',');
    const dateIndex = headers.indexOf('Date');
    const closeIndex = headers.indexOf('Close');
    if (dateIndex === -1 || closeIndex === -1) return [];

    return lines
        .slice(1)
        .map(line => {
            const cols = line.split(',');
            const date = cols[dateIndex];
            const price = parseFloat(cols[closeIndex]);
            if (!date || !Number.isFinite(price)) return null;
            return { date, price };
        })
        .filter(Boolean);
}

async function fetchFromStooq(symbol, range) {
    const days = rangeToDays(range);
    const today = new Date();
    const start = new Date();
    start.setDate(today.getDate() - Math.max(days * 3, 14));

    const stooqSymbol = toStooqSymbol(symbol);
    const d1 = formatDateForStooq(start);
    const d2 = formatDateForStooq(today);

    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&d1=${d1}&d2=${d2}&i=d`;
    const response = await fetchWithTimeout(url, {}, 5000);
    if (!response.ok) throw new Error(`Stooq HTTP ${response.status}`);

    const csv = await response.text();
    const history = parseStooqCsv(csv).slice(-(days + 1));
    if (history.length === 0) throw new Error('Stooq: no data rows');

    return {
        symbol: normalizeSymbol(symbol),
        currentPrice: history[history.length - 1].price,
        history,
        source: 'stooq'
    };
}

// ─── Main Public API ──────────────────────────────────────────────────────────

/**
 * Fetch stock/index historical data + current price.
 *
 * Priority:
 *   1. localStorage cache (15-min TTL)
 *   2. Yahoo Finance (dual-proxy race — corsproxy.io vs allorigins.win)
 *   3. Stooq CSV
 *   4. Returns null — caller handles gracefully, NO mock data injected
 *
 * @param {string} symbol  Ticker (e.g. "AAPL", "^GSPC")
 * @param {string} range   Yahoo range string: "1wk" | "1mo" | "3mo"
 * @returns {Promise<{symbol, currentPrice, history, source}|null>}
 */
export async function fetchStockData(symbol, range = '1mo') {
    const s = normalizeSymbol(symbol);

    // 1. Cache hit
    const cached = getCachedMarketData(s, range);
    if (cached) return cached;

    // 2. Yahoo (dual-proxy race)
    try {
        const data = await fetchFromYahooRace(s, range);
        setCachedMarketData(s, range, data);
        return data;
    } catch (err) {
        console.warn(`[api] Yahoo failed for ${s}:`, err.message);
    }

    // 3. Stooq fallback
    try {
        const data = await fetchFromStooq(s, range);
        setCachedMarketData(s, range, data);
        return data;
    } catch (err) {
        console.warn(`[api] Stooq failed for ${s}:`, err.message);
    }

    // 4. Total failure — return null, no mock injected
    console.error(`[api] All sources failed for ${s}. No price available.`);
    return null;
}

/**
 * Convenience: fetch only the current price for a symbol.
 * Uses a short '5d' window for reliability.
 * Returns null if unavailable.
 *
 * @param {string} symbol
 * @returns {Promise<number|null>}
 */
export async function fetchCurrentPrice(symbol) {
    const data = await fetchStockData(symbol, '5d');
    return data?.currentPrice ?? null;
}
