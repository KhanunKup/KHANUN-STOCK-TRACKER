/**
 * StockTracker - Fixed Portfolio Logic
 * - Uses current market value for allocation/value
 * - Correctly shows MU 0.5 shares @ current price 900 = $450 market value
 * - Adds manual price overrides for slow/inaccurate APIs
 * - Adds cache + deterministic fallback prices
 */

document.addEventListener('DOMContentLoaded', () => {
    lucide.createIcons();

    const STORAGE_KEY = 'stocktracker_data';
    const MARKET_CACHE_PREFIX = 'stocktracker_market_cache';

    /**
     * Manual current prices
     * If API price is slow/wrong, put the correct current price here.
     * Example:
     * MU bought 0.5 shares, current price 900 -> market value = 450
     */
    const MANUAL_PRICES = {
        MU: 915.03,
        DDOG: 221.94,
        RBRK: 66.29,
        NET: 211.84
    };

    const FORCE_MANUAL_PRICE_OVERRIDE = false;  // false will fetch price frist then go use manual
    /**
     * Fallback anchors for common symbols.
     * Used when live fetch fails.
     */
    const FALLBACK_ANCHORS = {
        AAPL: 185.50,
        MSFT: 415.25,
        NVDA: 875.00,
        AMZN: 180.10,
        GOOGL: 170.15,
        TSLA: 175.40,

        MU: 915.03,
        DDOG: 221.94,
        RBRK: 66.29,
        NET: 211.84,

        ARM: 120.00,
        ASML: 720.00,
        CRWD: 350.00,
        UBER: 85.00,
        PANW: 190.00,
        META: 620.00,
        ZS: 310.00,
        SHOP: 110.00,
        TOST: 38.00,

        '^GSPC': 5250.00,
        '^NDX': 18400.00
    };


    let portfolioData = { portfolio: [] };
    let portfolioChart = null;
    let performanceChart = null;
    let currentTimeframe = '30D';

    const views = {
        dashboard: document.getElementById('view-dashboard'),
        add: document.getElementById('view-add'),
        history: document.getElementById('view-history')
    };

    const navBtns = {
        dashboard: document.getElementById('nav-dashboard'),
        add: document.getElementById('nav-add'),
        history: document.getElementById('nav-history')
    };

    const formTransaction = document.getElementById('form-transaction');
    const historyTableBody = document.getElementById('history-table-body');
    const historyTableContainer = document.getElementById('history-table-container');
    const historyEmpty = document.getElementById('history-empty');
    const dashboardEmpty = document.getElementById('dashboard-empty');
    const dashboardActive = document.getElementById('dashboard-active');
    const dashboardStats = document.getElementById('dashboard-stats');
    const chartCanvas = document.getElementById('portfolio-chart');
    const performanceCanvas = document.getElementById('performance-chart');
    const chartLegend = document.getElementById('chart-legend');
    const timeToggles = document.querySelectorAll('.time-toggle');
    const positionsTableContainer = document.getElementById('positions-table-container');

    let editingTransactionId = null;
    const submitButton = formTransaction.querySelector('button[type="submit"]');


    const symbolInput = document.querySelector('input[name="symbol"]');
    const priceInput = document.querySelector('input[name="price"]');

    function normalizeSymbol(symbol) {
        return String(symbol || '').trim().toUpperCase();
    }

    function rangeToDays(range) {
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

    function getAnchorPrice(symbol) {
        const s = normalizeSymbol(symbol);

        if (MANUAL_PRICES[s]) {
            return MANUAL_PRICES[s];
        }

        if (FALLBACK_ANCHORS[s]) {
            return FALLBACK_ANCHORS[s];
        }

        const seed = s.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
        return seed % 150 + 50;
    }

    function seededRandom(seedText) {
        let hash = 0;

        for (let i = 0; i < seedText.length; i++) {
            hash = ((hash << 5) - hash) + seedText.charCodeAt(i);
            hash |= 0;
        }

        const value = Math.sin(hash) * 10000;
        return value - Math.floor(value);
    }

    function generateDateSeries(days) {
        const dates = [];
        const today = new Date();

        for (let i = days; i >= 0; i--) {
            const d = new Date();
            d.setDate(today.getDate() - i);
            dates.push(formatDate(d));
        }

        return dates;
    }

    /**
     * Deterministic fallback historical prices.
     * The last price always equals the anchor/current fallback price.
     * This avoids random chart changes every render.
     */
    function getHistoricalPrices(symbols, days = 30) {
        const prices = {};
        const dates = generateDateSeries(days);

        symbols.forEach(symbol => {
            const s = normalizeSymbol(symbol);
            const finalPrice = getAnchorPrice(s);
            const volatility = s.startsWith('^') ? 0.006 : 0.018;

            let price = finalPrice;
            const reversed = [];

            for (let i = dates.length - 1; i >= 0; i--) {
                const date = dates[i];

                reversed.push({
                    date,
                    price: Math.max(price, 0.01)
                });

                const noise = seededRandom(`${s}-${date}`);
                const dailyReturn = (noise - 0.48) * volatility;

                price = price / (1 + dailyReturn);
            }

            prices[s] = reversed.reverse();
        });

        return prices;
    }

    async function fetchWithTimeout(url, options = {}, timeout = 2500) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {
            return await fetch(url, {
                ...options,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }
    }

    function getCacheKey(symbol, range) {
        return `${MARKET_CACHE_PREFIX}:${normalizeSymbol(symbol)}:${range}`;
    }

    function getCachedMarketData(symbol, range) {
        try {
            const raw = localStorage.getItem(getCacheKey(symbol, range));
            if (!raw) return null;

            const cached = JSON.parse(raw);
            const maxAge = 15 * 60 * 1000;

            if (Date.now() - cached.savedAt > maxAge) {
                return null;
            }

            return cached.data;
        } catch {
            return null;
        }
    }

    function setCachedMarketData(symbol, range, data) {
        try {
            localStorage.setItem(
                getCacheKey(symbol, range),
                JSON.stringify({
                    savedAt: Date.now(),
                    data
                })
            );
        } catch {
            // Ignore cache errors
        }
    }

    function toStooqSymbol(symbol) {
        const s = normalizeSymbol(symbol);

        if (s === '^GSPC') return '^spx';
        if (s === '^NDX') return '^ndx';

        if (s.startsWith('^')) {
            return s.toLowerCase();
        }

        return `${s.toLowerCase()}.us`;
    }

    function parseStooqCsv(csvText) {
        const lines = csvText.trim().split(/\r?\n/).filter(Boolean);

        if (lines.length < 2) {
            return [];
        }

        const headers = lines[0].split(',');
        const dateIndex = headers.indexOf('Date');
        const closeIndex = headers.indexOf('Close');

        if (dateIndex === -1 || closeIndex === -1) {
            return [];
        }

        return lines.slice(1).map(line => {
            const cols = line.split(',');
            const date = cols[dateIndex];
            const price = parseFloat(cols[closeIndex]);

            if (!date || !Number.isFinite(price)) {
                return null;
            }

            return { date, price };
        }).filter(Boolean);
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

        const response = await fetchWithTimeout(url, {}, 2500);

        if (!response.ok) {
            throw new Error('Stooq response error');
        }

        const csv = await response.text();
        const history = parseStooqCsv(csv).slice(-(days + 1));

        if (history.length === 0) {
            throw new Error('No Stooq data');
        }

        return {
            symbol: normalizeSymbol(symbol),
            currentPrice: history[history.length - 1].price,
            history
        };
    }

    async function fetchFromYahooProxy(symbol, range) {
        const interval = '1d';
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(yahooUrl)}`;

        const response = await fetchWithTimeout(proxyUrl, {}, 3000);

        if (!response.ok) {
            throw new Error('Yahoo proxy error');
        }

        const data = await response.json();
        const parsed = JSON.parse(data.contents);

        if (parsed.chart.error) {
            throw new Error(parsed.chart.error.description || 'Yahoo chart error');
        }

        const result = parsed.chart.result?.[0];

        if (!result) {
            throw new Error('Yahoo no result');
        }

        const timestamps = result.timestamp || [];
        const quotes = result.indicators?.quote?.[0]?.close || [];

        const history = timestamps.map((t, i) => {
            const price = parseFloat(quotes[i]);

            if (!Number.isFinite(price)) {
                return null;
            }

            return {
                date: new Date(t * 1000).toISOString().split('T')[0],
                price
            };
        }).filter(Boolean);

        if (history.length === 0) {
            throw new Error('Yahoo empty history');
        }

        const currentPrice = Number.isFinite(result.meta?.regularMarketPrice)
            ? result.meta.regularMarketPrice
            : history[history.length - 1].price;

        return {
            symbol: normalizeSymbol(symbol),
            currentPrice,
            history
        };
    }

    async function fetchStockData(symbol, range = '1mo') {
        const s = normalizeSymbol(symbol);
        const days = rangeToDays(range);

        if (FORCE_MANUAL_PRICE_OVERRIDE && MANUAL_PRICES[s]) {
            const history = getHistoricalPrices([s], days)[s];

            return {
                symbol: s,
                currentPrice: MANUAL_PRICES[s],
                history,
                source: 'manual'
            };
        }

        const cached = getCachedMarketData(s, range);

        if (cached) {
            return cached;
        }

        try {
            const data = await fetchFromStooq(s, range);
            setCachedMarketData(s, range, data);
            return data;
        } catch {
            // Try Yahoo next
        }

        try {
            const data = await fetchFromYahooProxy(s, range);
            setCachedMarketData(s, range, data);
            return data;
        } catch (error) {
            console.warn(`Live fetch failed for ${s}. Using fallback/manual price.`, error);
        }

        if (MANUAL_PRICES[s]) {
            const history = getHistoricalPrices([s], days)[s];

            return {
                symbol: s,
                currentPrice: MANUAL_PRICES[s],
                history,
                source: 'manual-fallback'
            };
        }

        return null;
    }


    function getPriceOnOrBefore(history, date) {
        if (!history || history.length === 0) {
            return null;
        }

        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].date <= date && Number.isFinite(history[i].price)) {
                return history[i].price;
            }
        }

        return history[0].price;
    }

    symbolInput.addEventListener('blur', async () => {
        const symbol = normalizeSymbol(symbolInput.value);

        if (!symbol) return;

        symbolInput.classList.add('animate-pulse');

        const data = await fetchStockData(symbol, '1d');

        if (data && Number.isFinite(data.currentPrice)) {
            priceInput.value = data.currentPrice.toFixed(2);
        } else {
            priceInput.value = getAnchorPrice(symbol).toFixed(2);
        }

        symbolInput.classList.remove('animate-pulse');
    });

    function switchView(viewName) {
        Object.keys(views).forEach(key => {
            if (key === viewName) {
                views[key].classList.remove('hidden');
                navBtns[key].classList.add('active');
            } else {
                views[key].classList.add('hidden');
                navBtns[key].classList.remove('active');
            }
        });

        lucide.createIcons();
    }

    navBtns.dashboard.addEventListener('click', () => switchView('dashboard'));
    navBtns.add.addEventListener('click', () => switchView('add'));
    navBtns.history.addEventListener('click', () => switchView('history'));

    timeToggles.forEach(btn => {
        btn.addEventListener('click', () => {
            timeToggles.forEach(b => {
                b.classList.remove('bg-blue-600', 'text-white');
                b.classList.add('hover:bg-slate-600/50');
            });

            btn.classList.add('bg-blue-600', 'text-white');
            btn.classList.remove('hover:bg-slate-600/50');

            currentTimeframe = btn.dataset.time;
            renderDashboard();
        });
    });

    async function loadPortfolio() {
        const savedData = localStorage.getItem(STORAGE_KEY);

        if (savedData) {
            try {
                portfolioData = JSON.parse(savedData);

                portfolioData.portfolio = Array.isArray(portfolioData.portfolio)
                    ? portfolioData.portfolio
                    : [];

                renderUI();
                return;
            } catch (e) {
                console.error('Error parsing localStorage data', e);
            }
        }

        try {
            const response = await fetch('portfolio.json');

            if (response.ok) {
                const text = await response.text();

                if (text.trim()) {
                    portfolioData = JSON.parse(text);
                } else {
                    portfolioData = { portfolio: [] };
                }

                portfolioData.portfolio = Array.isArray(portfolioData.portfolio)
                    ? portfolioData.portfolio
                    : [];

                renderUI();
                return;
            }
        } catch (error) {
            console.warn('Could not load portfolio.json, starting with empty state.', error);
        }

        portfolioData = { portfolio: [] };
        renderUI();
    }

    function savePortfolio() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(portfolioData));
    }

    async function calculateHistoricalPerformance(days = 30) {
        const transactionSymbols = portfolioData.portfolio
            .map(tx => normalizeSymbol(tx.symbol))
            .filter(Boolean);

        const symbols = [...new Set([...transactionSymbols, '^GSPC', '^NDX'])];

        const rangeMap = {
            7: '1wk',
            30: '1mo',
            90: '3mo'
        };

        const range = rangeMap[days] || '1mo';
        const marketData = await Promise.all(symbols.map(s => fetchStockData(s, range)));

        const fallback = getHistoricalPrices(symbols, days);
        const historicalPrices = {};

        symbols.forEach((s, i) => {
            const data = marketData[i];

            if (data && data.history && data.history.length > 0) {
                historicalPrices[s] = data.history;
            } else {
                historicalPrices[s] = fallback[s];
            }
        });

        const dates = historicalPrices['^GSPC'] && historicalPrices['^GSPC'].length > 1
            ? historicalPrices['^GSPC'].map(p => p.date)
            : fallback['^GSPC'].map(p => p.date);

        const portfolioTWR = [100];
        const sp500TWR = [100];
        const nasdaqTWR = [100];

        const dailyHoldings = dates.map(date => {
            const holdings = {};

            portfolioData.portfolio
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

        for (let i = 1; i < dates.length; i++) {
            const prevDate = dates[i - 1];
            const currentDate = dates[i];
            const prevHoldings = dailyHoldings[i - 1];

            let valueYesterday = 0;
            let valueTodayOfOldHoldings = 0;

            Object.keys(prevHoldings).forEach(symbol => {
                const shares = prevHoldings[symbol];

                if (shares <= 0) return;

                const prevPrice = getPriceOnOrBefore(historicalPrices[symbol], prevDate);
                const currentPrice = getPriceOnOrBefore(historicalPrices[symbol], currentDate);

                if (Number.isFinite(prevPrice) && Number.isFinite(currentPrice)) {
                    valueYesterday += shares * prevPrice;
                    valueTodayOfOldHoldings += shares * currentPrice;
                }
            });

            const dailyPortfolioReturn = valueYesterday > 0
                ? (valueTodayOfOldHoldings - valueYesterday) / valueYesterday
                : 0;

            portfolioTWR.push(portfolioTWR[portfolioTWR.length - 1] * (1 + dailyPortfolioReturn));

            const prevSp = getPriceOnOrBefore(historicalPrices['^GSPC'], prevDate);
            const currSp = getPriceOnOrBefore(historicalPrices['^GSPC'], currentDate);

            const prevNdx = getPriceOnOrBefore(historicalPrices['^NDX'], prevDate);
            const currNdx = getPriceOnOrBefore(historicalPrices['^NDX'], currentDate);

            const spReturn = prevSp > 0 ? (currSp - prevSp) / prevSp : 0;
            const ndxReturn = prevNdx > 0 ? (currNdx - prevNdx) / prevNdx : 0;

            sp500TWR.push(sp500TWR[sp500TWR.length - 1] * (1 + spReturn));
            nasdaqTWR.push(nasdaqTWR[nasdaqTWR.length - 1] * (1 + ndxReturn));
        }

        const currentPrices = {};

        symbols.forEach((s, i) => {
            if (
                !FORCE_MANUAL_PRICE_OVERRIDE &&
                marketData[i] &&
                Number.isFinite(marketData[i].currentPrice)
            ) {
                currentPrices[s] = marketData[i].currentPrice;
            } else if (MANUAL_PRICES[s]) {
                currentPrices[s] = MANUAL_PRICES[s];
            } else {
                const last = historicalPrices[s]?.[historicalPrices[s].length - 1];
                currentPrices[s] = last ? last.price : getAnchorPrice(s);
            }
        });


        return {
            labels: dates,
            portfolio: portfolioTWR.map(v => v - 100),
            sp500: sp500TWR.map(v => v - 100),
            nasdaq: nasdaqTWR.map(v => v - 100),
            currentPrices
        };
    }

    function computePositions(currentPrices) {
        const positions = {};

        const sortedTransactions = [...portfolioData.portfolio].sort((a, b) => {
            return new Date(a.date) - new Date(b.date);
        });

        sortedTransactions.forEach(tx => {
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
                    unrealizedGainPercent: 0
                };
            }

            const position = positions[symbol];

            if (!position.company && tx.company) {
                position.company = tx.company;
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

                if (position.shares < 0.000001) {
                    position.shares = 0;
                    position.costBasis = 0;
                }
            }
        });

        Object.keys(positions).forEach(symbol => {
            const position = positions[symbol];

            if (position.shares > 0) {
                position.avgPrice = position.costBasis / position.shares;
                position.currentPrice = currentPrices[symbol] || position.avgPrice;
                position.marketValue = position.shares * position.currentPrice;
                position.unrealizedGainLoss = position.marketValue - position.costBasis;
                position.unrealizedGainPercent = position.costBasis > 0
                    ? (position.unrealizedGainLoss / position.costBasis) * 100
                    : 0;
            }
        });

        return positions;
    }


    async function renderUI() {
        renderHistory();
        await renderDashboard();
        lucide.createIcons();
    }

    function renderHistory() {
        if (portfolioData.portfolio.length === 0) {
            historyEmpty.classList.remove('hidden');
            historyTableContainer.classList.add('hidden');
            return;
        }

        historyEmpty.classList.add('hidden');
        historyTableContainer.classList.remove('hidden');
        historyTableBody.innerHTML = '';

        [...portfolioData.portfolio]
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .forEach(tx => {
                const row = document.createElement('tr');
                row.className = 'bg-slate-50 rounded-xl overflow-hidden mb-4 group hover:bg-slate-100 transition-colors';

                const symbol = normalizeSymbol(tx.symbol);
                const shares = parseFloat(tx.shares) || 0;
                const price = parseFloat(tx.price) || 0;
                const total = shares * price;
                const isBuy = tx.type === 'buy';

                row.innerHTML = `
                <td class="px-6 py-4 text-sm text-slate-500 font-medium">${tx.date}</td>
                <td class="px-6 py-4">
                    <div class="flex items-center gap-3">
                        ${tx.logo ? `<img src="${tx.logo}" alt="${symbol}" class="w-8 h-8 rounded-lg object-contain bg-white border border-slate-200">` : `<div class="w-8 h-8 rounded-lg bg-slate-200 flex items-center justify-center font-bold text-[10px] text-slate-400">${symbol.charAt(0)}</div>`}
                        <div>
                            <div class="font-bold text-slate-900">${symbol}</div>
                            <div class="text-[10px] text-slate-400 uppercase font-bold">${tx.company || ''}</div>
                        </div>
                    </div>
                </td>
                <td class="px-6 py-4">
                    <span class="flex items-center gap-1 text-xs font-bold uppercase ${isBuy ? 'text-emerald-600' : 'text-rose-600'}">
                        <i data-lucide="${isBuy ? 'trending-up' : 'trending-down'}" class="w-3 h-3"></i>
                        ${tx.type}
                    </span>
                </td>
                <td class="px-6 py-4 text-sm text-right font-medium text-slate-600">${shares}</td>
                <td class="px-6 py-4 text-sm text-right font-medium text-slate-600">$${price.toFixed(2)}</td>
                <td class="px-6 py-4 text-sm text-right font-bold text-slate-900">$${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                <td class="px-6 py-4 text-right">
                    <div class="flex justify-end gap-2">
                        <button 
                            type="button"
                            data-action="edit"
                            data-id="${tx.id}"
                            class="px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 text-xs font-bold hover:bg-blue-100 transition-colors">
                            Edit
                        </button>
                        <button 
                            type="button"
                            data-action="delete"
                            data-id="${tx.id}"
                            class="px-3 py-1.5 rounded-lg bg-rose-50 text-rose-700 text-xs font-bold hover:bg-rose-100 transition-colors">
                            Delete
                        </button>
                    </div>
                </td>
            `;

                historyTableBody.appendChild(row);
            });

        lucide.createIcons();
    }

    function resetFormMode() {
        editingTransactionId = null;

        if (submitButton) {
            submitButton.textContent = 'Save Transaction';
            submitButton.classList.remove('bg-amber-500', 'hover:bg-amber-600', 'shadow-amber-200');
            submitButton.classList.add('bg-blue-600', 'hover:bg-blue-700', 'shadow-blue-200');
        }
    }

    function startEditTransaction(id) {
        const tx = portfolioData.portfolio.find(item => item.id === id);

        if (!tx) return;

        editingTransactionId = id;

        formTransaction.querySelector('input[name="symbol"]').value = tx.symbol || '';
        formTransaction.querySelector('input[name="company"]').value = tx.company || '';
        formTransaction.querySelector('input[name="logo"]').value = tx.logo || '';
        formTransaction.querySelector('input[name="shares"]').value = tx.shares || '';
        formTransaction.querySelector('input[name="price"]').value = tx.price || '';
        formTransaction.querySelector('input[name="date"]').value = tx.date || '';
        formTransaction.querySelector('textarea[name="notes"]').value = tx.notes || '';

        const typeInput = formTransaction.querySelector(`input[name="type"][value="${tx.type}"]`);

        if (typeInput) {
            typeInput.checked = true;
        }

        if (submitButton) {
            submitButton.textContent = 'Update Transaction';
            submitButton.classList.remove('bg-blue-600', 'hover:bg-blue-700', 'shadow-blue-200');
            submitButton.classList.add('bg-amber-500', 'hover:bg-amber-600', 'shadow-amber-200');
        }

        switchView('add');
        lucide.createIcons();
    }

    function deleteTransaction(id) {
        const tx = portfolioData.portfolio.find(item => item.id === id);

        if (!tx) return;

        const confirmed = confirm(`Delete ${tx.type.toUpperCase()} transaction for ${tx.symbol}?`);

        if (!confirmed) return;

        portfolioData.portfolio = portfolioData.portfolio.filter(item => item.id !== id);

        savePortfolio();
        renderUI();

        if (editingTransactionId === id) {
            formTransaction.reset();
            resetFormMode();
        }
    }

    historyTableBody.addEventListener('click', (e) => {
        const button = e.target.closest('button[data-action]');

        if (!button) return;

        const action = button.dataset.action;
        const id = button.dataset.id;

        if (action === 'edit') {
            startEditTransaction(id);
        }

        if (action === 'delete') {
            deleteTransaction(id);
        }
    });


    function updatePositionsTable(activePositions) {
        if (!positionsTableContainer) return;

        if (activePositions.length === 0) {
            positionsTableContainer.innerHTML = `
            <div class="text-center py-8 text-slate-400">
                No active positions.
            </div>
        `;
            return;
        }

        positionsTableContainer.innerHTML = `
        <table class="w-full text-left border-separate border-spacing-y-3">
            <thead>
                <tr class="text-slate-400 text-xs uppercase tracking-wider">
                    <th class="px-4 py-2">Symbol</th>
                    <th class="px-4 py-2 text-right">Shares</th>
                    <th class="px-4 py-2 text-right">Avg Cost</th>
                    <th class="px-4 py-2 text-right">Current Price</th>
                    <th class="px-4 py-2 text-right">Cost Basis</th>
                    <th class="px-4 py-2 text-right">Market Value</th>
                    <th class="px-4 py-2 text-right">Gain/Loss</th>
                </tr>
            </thead>
            <tbody>
                ${activePositions.map(position => {
            const gainPositive = position.unrealizedGainLoss >= 0;

            return `
                        <tr class="bg-slate-900/40 rounded-xl">
                            <td class="px-4 py-4 rounded-l-xl">
                                <div class="font-bold text-white">${position.symbol}</div>
                                <div class="text-xs text-slate-500">${position.company || ''}</div>
                            </td>
                            <td class="px-4 py-4 text-right text-slate-300">${position.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                            <td class="px-4 py-4 text-right text-slate-300">$${position.avgPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td class="px-4 py-4 text-right text-slate-300">$${position.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td class="px-4 py-4 text-right text-slate-300">$${position.costBasis.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td class="px-4 py-4 text-right font-bold text-white">$${position.marketValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td class="px-4 py-4 text-right rounded-r-xl">
                                <div class="font-bold ${gainPositive ? 'text-emerald-400' : 'text-rose-400'}">
                                    ${gainPositive ? '+' : '-'}$${Math.abs(position.unrealizedGainLoss).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </div>
                                <div class="text-xs ${gainPositive ? 'text-emerald-500/70' : 'text-rose-500/70'}">
                                    ${gainPositive ? '+' : '-'}${Math.abs(position.unrealizedGainPercent).toFixed(2)}%
                                </div>
                            </td>
                        </tr>
                    `;
        }).join('')}
            </tbody>
        </table>
    `;
    }


    async function renderDashboard() {
        if (portfolioData.portfolio.length === 0) {
            dashboardEmpty.classList.remove('hidden');
            dashboardActive.classList.add('hidden');
            return;
        }

        dashboardEmpty.classList.add('hidden');
        dashboardActive.classList.remove('hidden');

        dashboardStats.innerHTML = '<div class="col-span-3 text-center py-10 text-slate-400 animate-pulse font-medium">Loading portfolio metrics...</div>';

        const days = parseInt(currentTimeframe, 10) || 30;
        const perfData = await calculateHistoricalPerformance(days);
        const currentPrices = perfData.currentPrices;

        const positions = computePositions(currentPrices);
        const activePositions = Object.values(positions).filter(p => p.shares > 0);

        const currentMarketValue = activePositions.reduce((sum, p) => sum + p.marketValue, 0);
        const totalCostBasis = activePositions.reduce((sum, p) => sum + p.costBasis, 0);
        const totalGainLoss = currentMarketValue - totalCostBasis;
        const totalGainPercent = totalCostBasis > 0
            ? (totalGainLoss / totalCostBasis) * 100
            : 0;

        dashboardStats.innerHTML = `
            <div class="bg-slate-800/50 p-8 rounded-3xl border border-slate-700/50">
                <p class="text-slate-400 text-sm font-medium mb-2 uppercase tracking-wider">Total Portfolio Value</p>
                <p class="text-4xl font-bold text-white">$${currentMarketValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
            </div>

            <div class="bg-slate-800/50 p-8 rounded-3xl border border-slate-700/50">
                <p class="text-slate-400 text-sm font-medium mb-2 uppercase tracking-wider">Unrealized Gain/Loss</p>
                <p class="text-4xl font-bold ${totalGainLoss >= 0 ? 'text-emerald-400' : 'text-rose-400'}">
                    ${totalGainLoss >= 0 ? '+' : '-'}$${Math.abs(totalGainLoss).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </p>
                <p class="text-xs ${totalGainLoss >= 0 ? 'text-emerald-500/70' : 'text-rose-500/70'} mt-2 font-bold uppercase tracking-widest">
                    ${totalGainLoss >= 0 ? '▲' : '▼'} ${Math.abs(totalGainPercent).toFixed(2)}%
                </p>
            </div>

            <div class="bg-slate-800/50 p-8 rounded-3xl border border-slate-700/50">
                <p class="text-slate-400 text-sm font-medium mb-2 uppercase tracking-wider">Active Positions</p>
                <p class="text-4xl font-bold text-white">${activePositions.length}</p>
            </div>
        `;

        updateChart(activePositions);
        updatePositionsTable(activePositions);
        updatePerformanceChart(perfData);

    }

    /**
     * Allocation chart now uses current market value, not share count.
     * Example:
     * MU 0.5 shares × current price 900 = $450
     */
    function updateChart(activePositions) {
        const labels = activePositions.map(p => p.symbol);
        const data = activePositions.map(p => p.marketValue);
        const totalValue = data.reduce((sum, value) => sum + value, 0);

        const colors = [
            '#3b82f6',
            '#06b6d4',
            '#10b981',
            '#f59e0b',
            '#ef4444',
            '#8b5cf6',
            '#ec4899',
            '#14b8a6',
            '#64748b',
            '#f97316',
            '#84cc16'
        ];

        if (portfolioChart) {
            portfolioChart.destroy();
        }

        if (!chartCanvas) return;

        const hoverCenterPlugin = {
            id: 'hoverCenterPlugin',
            afterDraw(chart) {
                const { ctx, chartArea } = chart;

                if (!chartArea) return;

                const hoveredIndex = chart.$hoveredIndex;

                if (hoveredIndex === null || hoveredIndex === undefined) {
                    return;
                }

                const position = activePositions[hoveredIndex];

                if (!position) return;

                const value = position.marketValue;
                const percent = totalValue > 0 ? (value / totalValue) * 100 : 0;

                const centerX = (chartArea.left + chartArea.right) / 2;
                const centerY = (chartArea.top + chartArea.bottom) / 2;

                ctx.save();

                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';

                ctx.fillStyle = colors[hoveredIndex % colors.length];
                ctx.font = '700 26px Outfit, sans-serif';
                ctx.fillText(position.symbol, centerX, centerY - 42);

                ctx.fillStyle = '#94a3b8';
                ctx.font = '500 12px Outfit, sans-serif';
                ctx.fillText(position.company || 'Current Holding', centerX, centerY - 18);

                ctx.fillStyle = '#ffffff';
                ctx.font = '700 19px Outfit, sans-serif';
                ctx.fillText(
                    `$${value.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2
                    })}`,
                    centerX,
                    centerY + 10
                );

                ctx.fillStyle = '#cbd5e1';
                ctx.font = '600 12px Outfit, sans-serif';
                ctx.fillText(
                    `${percent.toFixed(1)}% of portfolio`,
                    centerX,
                    centerY + 36
                );

                ctx.restore();
            }
        };

        portfolioChart = new Chart(chartCanvas, {
            type: 'doughnut',
            data: {
                labels,
                datasets: [{
                    data,
                    backgroundColor: activePositions.map((_, i) => colors[i % colors.length]),
                    borderColor: '#1e293b',
                    borderWidth: 3,
                    hoverBorderColor: '#ffffff',
                    hoverBorderWidth: 3,
                    hoverOffset: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                cutout: '66%',
                radius: '92%',
                animation: {
                    animateRotate: true,
                    animateScale: true,
                    duration: 700,
                    easing: 'easeOutQuart'
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        enabled: false
                    }
                },
                onHover(event, elements, chart) {
                    const canvas = chart.canvas;

                    if (elements.length > 0) {
                        chart.$hoveredIndex = elements[0].index;
                        canvas.style.cursor = 'pointer';
                    } else {
                        chart.$hoveredIndex = null;
                        canvas.style.cursor = 'default';
                    }

                    chart.draw();
                }
            },
            plugins: [hoverCenterPlugin]
        });

        if (chartLegend) {
            chartLegend.innerHTML = '';

            activePositions.forEach((position, i) => {
                const percent = totalValue > 0 ? (position.marketValue / totalValue) * 100 : 0;

                const item = document.createElement('div');
                item.className = 'flex items-center gap-2';

                item.innerHTML = `
                <div class="w-3 h-3 rounded-full" style="background-color: ${colors[i % colors.length]}"></div>
                <div class="min-w-0">
                    <div class="text-sm text-slate-300 font-semibold leading-tight">${position.symbol}</div>
                    <div class="text-[11px] text-slate-500 leading-tight">
                        ${percent.toFixed(1)}% · $${position.marketValue.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                })}
                    </div>
                </div>
            `;

                chartLegend.appendChild(item);
            });
        }
    }

    function updatePerformanceChart(data) {
        if (performanceChart) {
            performanceChart.destroy();
        }

        if (!performanceCanvas) return;

        const allValues = [
            ...data.portfolio,
            ...data.sp500,
            ...data.nasdaq
        ].filter(Number.isFinite);

        const minValue = allValues.length ? Math.min(...allValues) : -5;
        const maxValue = allValues.length ? Math.max(...allValues) : 5;
        const padding = Math.max((maxValue - minValue) * 0.25, 2);

        const suggestedMin = Math.floor(minValue - padding);
        const suggestedMax = Math.ceil(maxValue + padding);

        const ctx = performanceCanvas.getContext('2d');

        const portfolioGradient = ctx.createLinearGradient(0, 0, 0, performanceCanvas.height || 320);
        portfolioGradient.addColorStop(0, 'rgba(16, 185, 129, 0.28)');
        portfolioGradient.addColorStop(0.45, 'rgba(16, 185, 129, 0.08)');
        portfolioGradient.addColorStop(1, 'rgba(16, 185, 129, 0)');

        const zeroLinePlugin = {
            id: 'zeroLinePlugin',
            afterDraw(chart) {
                const { ctx, chartArea, scales } = chart;

                if (!chartArea || !scales.y) return;

                const y = scales.y.getPixelForValue(0);

                if (y < chartArea.top || y > chartArea.bottom) return;

                ctx.save();
                ctx.beginPath();
                ctx.moveTo(chartArea.left, y);
                ctx.lineTo(chartArea.right, y);
                ctx.lineWidth = 1;
                ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
                ctx.setLineDash([5, 5]);
                ctx.stroke();
                ctx.restore();
            }
        };

        performanceChart = new Chart(performanceCanvas, {
            type: 'line',
            data: {
                labels: data.labels.map(d => new Date(d).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric'
                })),
                datasets: [
                    {
                        label: 'Your Portfolio',
                        data: data.portfolio,
                        borderColor: '#10b981',
                        backgroundColor: portfolioGradient,
                        borderWidth: 3,
                        pointRadius: 0,
                        pointHoverRadius: 5,
                        pointHoverBorderWidth: 3,
                        pointHoverBorderColor: '#ecfdf5',
                        pointHoverBackgroundColor: '#10b981',
                        tension: 0.35,
                        fill: true
                    },
                    {
                        label: 'S&P 500',
                        data: data.sp500,
                        borderColor: 'rgba(148, 163, 184, 0.75)',
                        backgroundColor: 'transparent',
                        borderWidth: 1.8,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        pointHoverBackgroundColor: '#94a3b8',
                        pointHoverBorderColor: '#e2e8f0',
                        pointHoverBorderWidth: 2,
                        borderDash: [6, 5],
                        tension: 0.35,
                        fill: false
                    },
                    {
                        label: 'Nasdaq 100',
                        data: data.nasdaq,
                        borderColor: 'rgba(96, 165, 250, 0.65)',
                        backgroundColor: 'transparent',
                        borderWidth: 1.8,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        pointHoverBackgroundColor: '#60a5fa',
                        pointHoverBorderColor: '#dbeafe',
                        pointHoverBorderWidth: 2,
                        borderDash: [3, 5],
                        tension: 0.35,
                        fill: false
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                animation: {
                    duration: 650,
                    easing: 'easeOutQuart'
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        align: 'end',
                        labels: {
                            color: '#cbd5e1',
                            usePointStyle: true,
                            pointStyle: 'line',
                            boxWidth: 28,
                            boxHeight: 8,
                            padding: 18,
                            font: {
                                family: 'Outfit',
                                size: 12,
                                weight: '600'
                            }
                        }
                    },
                    tooltip: {
                        enabled: true,
                        backgroundColor: 'rgba(15, 23, 42, 0.96)',
                        titleColor: '#ffffff',
                        bodyColor: '#cbd5e1',
                        borderColor: 'rgba(148, 163, 184, 0.25)',
                        borderWidth: 1,
                        padding: 12,
                        cornerRadius: 12,
                        displayColors: true,
                        boxWidth: 8,
                        boxHeight: 8,
                        usePointStyle: true,
                        callbacks: {
                            title(items) {
                                return items[0]?.label || '';
                            },
                            label(context) {
                                const value = context.parsed.y;
                                const sign = value >= 0 ? '+' : '';

                                return ` ${context.dataset.label}: ${sign}${value.toFixed(2)}%`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            display: false
                        },
                        border: {
                            display: false
                        },
                        ticks: {
                            color: '#64748b',
                            maxRotation: 0,
                            autoSkip: true,
                            maxTicksLimit: 6,
                            font: {
                                family: 'Outfit',
                                size: 11
                            }
                        }
                    },
                    y: {
                        suggestedMin,
                        suggestedMax,
                        border: {
                            display: false
                        },
                        grid: {
                            color: function (context) {
                                if (context.tick.value === 0) {
                                    return 'rgba(148, 163, 184, 0)';
                                }

                                return 'rgba(148, 163, 184, 0.08)';
                            }
                        },
                        ticks: {
                            color: '#64748b',
                            maxTicksLimit: 6,
                            padding: 8,
                            font: {
                                family: 'Outfit',
                                size: 11
                            },
                            callback: value => {
                                const sign = value >= 0 ? '+' : '';
                                return `${sign}${Number(value).toFixed(1)}%`;
                            }
                        }
                    }
                }
            },
            plugins: [zeroLinePlugin]
        });
    }


    formTransaction.addEventListener('submit', (e) => {
        e.preventDefault();

        const formData = new FormData(formTransaction);

        const transactionData = {
            id: editingTransactionId || Date.now().toString(),
            symbol: normalizeSymbol(formData.get('symbol')),
            company: formData.get('company'),
            logo: formData.get('logo'),
            type: formData.get('type'),
            shares: parseFloat(formData.get('shares')),
            price: parseFloat(formData.get('price')),
            date: formData.get('date'),
            notes: formData.get('notes')
        };

        if (!transactionData.symbol || !Number.isFinite(transactionData.shares) || !Number.isFinite(transactionData.price)) {
            alert('Please enter valid symbol, shares, and price.');
            return;
        }

        if (transactionData.shares <= 0 || transactionData.price <= 0) {
            alert('Shares and price must be greater than 0.');
            return;
        }

        if (editingTransactionId) {
            portfolioData.portfolio = portfolioData.portfolio.map(tx => {
                if (tx.id === editingTransactionId) {
                    return transactionData;
                }

                return tx;
            });
        } else {
            portfolioData.portfolio.push(transactionData);
        }

        savePortfolio();
        renderUI();
        switchView('dashboard');

        formTransaction.reset();
        resetFormMode();

        const dateInput = document.querySelector('input[name="date"]');

        if (dateInput) {
            dateInput.value = new Date().toISOString().split('T')[0];
        }
    });


    loadPortfolio();

    const dateInput = document.querySelector('input[name="date"]');

    if (dateInput) {
        dateInput.value = new Date().toISOString().split('T')[0];
    }
});
