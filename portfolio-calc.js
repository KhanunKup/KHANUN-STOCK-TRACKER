/**
 * portfolio-calc.js — StockTracker
 * Pure calculation functions: positions, TWR, performance.
 * No DOM access. No API calls. Receives data as arguments.
 */

import { fetchStockData, normalizeSymbol, rangeToDays } from './api.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find the most recent price in a history array on or before a given date string.
 * History must be sorted ascending by date.
 *
 * @param {Array<{date: string, price: number}>} history
 * @param {string} date  ISO date string "YYYY-MM-DD"
 * @returns {number|null}
 */
export function getPriceOnOrBefore(history, date) {
    if (!history || history.length === 0) return null;
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].date <= date && Number.isFinite(history[i].price)) {
            return history[i].price;
        }
    }
    return history[0].price;
}

// ─── Position Calculator ──────────────────────────────────────────────────────

/**
 * Compute current open positions from a list of transactions using
 * average-cost FIFO accounting.
 *
 * @param {Array} transactions  Raw portfolio array from state
 * @param {Object} currentPrices  Map of symbol -> current price
 * @returns {Object}  Map of symbol -> position object
 */
export function computePositions(transactions, currentPrices) {
    const positions = {};

    const sorted = [...transactions].sort(
        (a, b) => new Date(a.date) - new Date(b.date)
    );

    sorted.forEach(tx => {
        const symbol = normalizeSymbol(tx.symbol);
        const shares = parseFloat(tx.shares) || 0;
        const price = parseFloat(tx.price) || 0;

        if (!symbol || shares <= 0 || price <= 0) return;

        if (!positions[symbol]) {
            positions[symbol] = {
                symbol,
                company: tx.company || '',
                shares: 0,
                costBasis: 0,
                avgPrice: 0,
                currentPrice: 0,
                marketValue: 0,
                unrealizedGainLoss: 0,
                unrealizedGainPercent: 0,
                color: null,
                assetType: tx.assetType || 'stock'
            };
        }

        const position = positions[symbol];

        // Prefer first non-empty company name seen
        if (!position.company && tx.company) {
            position.company = tx.company;
        }

        // Always take the color from the most recent transaction (list is sorted asc)
        if (tx.color) {
            position.color = tx.color;
        }

        // Carry asset type forward (most recent wins)
        if (tx.assetType) {
            position.assetType = tx.assetType;
        }

        if (tx.type === 'buy') {
            position.shares += shares;
            position.costBasis += shares * price;
        } else {
            const sellShares = Math.min(shares, position.shares);
            const avgCost = position.shares > 0
                ? position.costBasis / position.shares
                : 0;
            position.shares -= sellShares;
            position.costBasis -= sellShares * avgCost;
            // Guard floating-point dust
            if (position.shares < 0.000001) {
                position.shares = 0;
                position.costBasis = 0;
            }
        }
    });

    // Second pass: compute derived market values
    Object.keys(positions).forEach(symbol => {
        const position = positions[symbol];
        if (position.shares > 0) {
            position.avgPrice = position.costBasis / position.shares;

            if (position.assetType === 'cash' || symbol === 'CASH') {
                // Cash is always worth $1 per unit — no market fluctuation
                position.assetType = 'cash';
                position.currentPrice = 1;
                position.marketValue = position.shares * 1;
                position.unrealizedGainLoss = 0;
                position.unrealizedGainPercent = 0;
            } else {
                // Fall back to avg cost if live price is unavailable
                position.currentPrice = currentPrices[symbol] ?? position.avgPrice;
                position.marketValue = position.shares * position.currentPrice;
                position.unrealizedGainLoss = position.marketValue - position.costBasis;
                position.unrealizedGainPercent = position.costBasis > 0
                    ? (position.unrealizedGainLoss / position.costBasis) * 100
                    : 0;
            }
        }
    });

    return positions;
}

// ─── TWR Performance ─────────────────────────────────────────────────────────

/**
 * Fetch market data for all portfolio symbols + benchmarks, then compute
 * Time-Weighted Return series for:
 *   - Your portfolio
 *   - S&P 500 (^GSPC)
 *   - Nasdaq 100 (^NDX)
 *
 * If a symbol has no data, it is excluded from TWR rather than using mock prices.
 *
 * @param {Array} transactions  Portfolio transactions
 * @param {number} days         Number of calendar days (7 | 30 | 90)
 * @returns {Promise<{labels, portfolio, sp500, nasdaq, currentPrices}>}
 */
export async function calculateHistoricalPerformance(transactions, days = 30) {
    const txSymbols = transactions
        .map(tx => normalizeSymbol(tx.symbol))
        .filter(s => Boolean(s) && s !== 'CASH');

    const allSymbols = [...new Set([...txSymbols, '^GSPC', '^NDX'])];

    const rangeMap = { 7: '1wk', 30: '1mo', 90: '3mo' };
    const range = rangeMap[days] || '1mo';

    // Fetch all symbols concurrently
    const marketDataResults = await Promise.all(
        allSymbols.map(s => fetchStockData(s, range))
    );

    // Build historical price map — skip symbols that returned null
    const historicalPrices = {};
    allSymbols.forEach((s, i) => {
        const data = marketDataResults[i];
        if (data && data.history && data.history.length > 0) {
            historicalPrices[s] = data.history;
        } else {
            console.warn(`[portfolio-calc] No historical data for ${s} — excluded from TWR.`);
        }
    });

    // Build current prices map from live data only
    const currentPrices = {};
    allSymbols.forEach((s, i) => {
        const data = marketDataResults[i];
        if (data && Number.isFinite(data.currentPrice)) {
            currentPrices[s] = data.currentPrice;
        }
    });

    // Use S&P 500 dates as the canonical date axis; fall back to Nasdaq
    const benchmarkHistory =
        historicalPrices['^GSPC'] ||
        historicalPrices['^NDX'] ||
        null;

    if (!benchmarkHistory || benchmarkHistory.length < 2) {
        // Not enough data to draw any chart
        return {
            labels: [],
            portfolio: [],
            sp500: [],
            nasdaq: [],
            currentPrices
        };
    }

    const dates = benchmarkHistory.map(p => p.date);

    // Pre-compute daily holdings for each date
    const dailyHoldings = dates.map(date => {
        const holdings = {};
        transactions
            .filter(tx => tx.date <= date)
            .forEach(tx => {
                const symbol = normalizeSymbol(tx.symbol);
                const shares = parseFloat(tx.shares) || 0;
                if (!symbol || shares <= 0) return;
                if (tx.type === 'buy') {
                    holdings[symbol] = (holdings[symbol] || 0) + shares;
                } else {
                    holdings[symbol] = (holdings[symbol] || 0) - shares;
                }
            });
        return holdings;
    });

    // Build TWR index series (starting at 100)
    const portfolioTWR = [100];
    const sp500TWR = [100];
    const nasdaqTWR = [100];

    for (let i = 1; i < dates.length; i++) {
        const prevDate = dates[i - 1];
        const currDate = dates[i];
        const prevHoldings = dailyHoldings[i - 1];

        // Portfolio daily return (TWR method)
        let valueYesterday = 0;
        let valueTodayOldHoldings = 0;

        Object.keys(prevHoldings).forEach(symbol => {
            const shares = prevHoldings[symbol];
            // Skip CASH — it has no price history and shouldn't affect TWR
            if (symbol === 'CASH') return;
            if (shares <= 0 || !historicalPrices[symbol]) return;

            const prevPrice = getPriceOnOrBefore(historicalPrices[symbol], prevDate);
            const currPrice = getPriceOnOrBefore(historicalPrices[symbol], currDate);

            if (Number.isFinite(prevPrice) && Number.isFinite(currPrice)) {
                valueYesterday += shares * prevPrice;
                valueTodayOldHoldings += shares * currPrice;
            }
        });

        const dailyPortfolioReturn = valueYesterday > 0
            ? (valueTodayOldHoldings - valueYesterday) / valueYesterday
            : 0;

        portfolioTWR.push(portfolioTWR[portfolioTWR.length - 1] * (1 + dailyPortfolioReturn));

        // S&P 500 daily return
        const prevSp = getPriceOnOrBefore(historicalPrices['^GSPC'], prevDate);
        const currSp = getPriceOnOrBefore(historicalPrices['^GSPC'], currDate);
        const spReturn = (prevSp && prevSp > 0) ? (currSp - prevSp) / prevSp : 0;
        sp500TWR.push(sp500TWR[sp500TWR.length - 1] * (1 + spReturn));

        // Nasdaq 100 daily return
        const prevNdx = getPriceOnOrBefore(historicalPrices['^NDX'], prevDate);
        const currNdx = getPriceOnOrBefore(historicalPrices['^NDX'], currDate);
        const ndxReturn = (prevNdx && prevNdx > 0) ? (currNdx - prevNdx) / prevNdx : 0;
        nasdaqTWR.push(nasdaqTWR[nasdaqTWR.length - 1] * (1 + ndxReturn));
    }

    return {
        labels: dates,
        // Convert from index (100 = start) to percent return relative to start
        portfolio: portfolioTWR.map(v => v - 100),
        sp500: sp500TWR.map(v => v - 100),
        nasdaq: nasdaqTWR.map(v => v - 100),
        currentPrices
    };
}
