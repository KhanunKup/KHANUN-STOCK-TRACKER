/**
 * ui.js — StockTracker
 * All DOM manipulation, view switching, table rendering, and error display.
 * No external API calls. No chart logic.
 */

import { normalizeSymbol } from './api.js';

// ─── Cached DOM references ────────────────────────────────────────────────────

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

const historyTableBody = document.getElementById('history-table-body');
const historyTableContainer = document.getElementById('history-table-container');
const historyEmpty = document.getElementById('history-empty');
const dashboardEmpty = document.getElementById('dashboard-empty');
const dashboardActive = document.getElementById('dashboard-active');
const dashboardStats = document.getElementById('dashboard-stats');
const positionsTableContainer = document.getElementById('positions-table-container');
const chartLegend = document.getElementById('chart-legend');

// ─── View Switching ───────────────────────────────────────────────────────────

/**
 * Show the named view and mark its nav button active.
 * @param {'dashboard'|'add'|'history'} viewName
 */
export function switchView(viewName) {
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

// ─── Dashboard State ──────────────────────────────────────────────────────────

/** Show the "portfolio is empty" placeholder on dashboard. */
export function showDashboardEmpty() {
    dashboardEmpty.classList.remove('hidden');
    dashboardActive.classList.add('hidden');
}

/** Reveal the dashboard active section and show a loading skeleton. */
export function showDashboardLoading() {
    dashboardEmpty.classList.add('hidden');
    dashboardActive.classList.remove('hidden');
    dashboardStats.innerHTML = `
        <div class="col-span-3 text-center py-10 text-slate-400 animate-pulse font-medium">
            Loading portfolio metrics…
        </div>`;
}

// ─── Dashboard Stats Cards ────────────────────────────────────────────────────

/**
 * Render the three KPI cards: Total Value, Unrealized Gain/Loss, Active Positions.
 * @param {number} currentMarketValue
 * @param {number} totalCostBasis
 * @param {number} activePositionCount
 */
export function renderDashboardStats(currentMarketValue, totalCostBasis, activePositionCount) {
    const totalGainLoss = currentMarketValue - totalCostBasis;
    const totalGainPercent = totalCostBasis > 0
        ? (totalGainLoss / totalCostBasis) * 100
        : 0;
    const gainPositive = totalGainLoss >= 0;

    dashboardStats.innerHTML = `
        <div class="bg-slate-800/50 p-8 rounded-3xl border border-slate-700/50">
            <p class="text-slate-400 text-sm font-medium mb-2 uppercase tracking-wider">Total Portfolio Value</p>
            <p class="text-4xl font-bold text-white">$${currentMarketValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
        </div>

        <div class="bg-slate-800/50 p-8 rounded-3xl border border-slate-700/50">
            <p class="text-slate-400 text-sm font-medium mb-2 uppercase tracking-wider">Unrealized Gain/Loss</p>
            <p class="text-4xl font-bold ${gainPositive ? 'text-emerald-400' : 'text-rose-400'}">
                ${gainPositive ? '+' : '-'}$${Math.abs(totalGainLoss).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </p>
            <p class="text-xs ${gainPositive ? 'text-emerald-500/70' : 'text-rose-500/70'} mt-2 font-bold uppercase tracking-widest">
                ${gainPositive ? '▲' : '▼'} ${Math.abs(totalGainPercent).toFixed(2)}%
            </p>
        </div>

        <div class="bg-slate-800/50 p-8 rounded-3xl border border-slate-700/50">
            <p class="text-slate-400 text-sm font-medium mb-2 uppercase tracking-wider">Active Positions</p>
            <p class="text-4xl font-bold text-white">${activePositionCount}</p>
        </div>
    `;
}

// ─── API Error Banner ─────────────────────────────────────────────────────────

/**
 * Show a non-blocking warning banner inside dashboardStats when
 * one or more symbols could not be fetched.
 * @param {string[]} failedSymbols  Array of symbols that returned null
 */
export function showApiWarning(failedSymbols) {
    if (!failedSymbols || failedSymbols.length === 0) {
        clearApiWarning();
        return;
    }

    // Remove existing banner first
    clearApiWarning();

    const banner = document.createElement('div');
    banner.id = 'api-warning-banner';
    banner.className = [
        'col-span-3 flex items-start gap-3 px-5 py-4 rounded-2xl',
        'bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm'
    ].join(' ');

    banner.innerHTML = `
        <i data-lucide="alert-triangle" class="w-4 h-4 mt-0.5 shrink-0 text-amber-400"></i>
        <span>
            <strong class="font-semibold">Price data unavailable</strong> for
            <span class="font-mono">${failedSymbols.join(', ')}</span>.
            Live API unreachable — values shown use last available cost basis.
        </span>
    `;

    dashboardStats.insertAdjacentElement('afterend', banner);
    lucide.createIcons();
}

/** Remove the API warning banner if present. */
export function clearApiWarning() {
    document.getElementById('api-warning-banner')?.remove();
}

// ─── Positions Table ──────────────────────────────────────────────────────────

/**
 * Render the position-detail table inside the dashboard.
 * @param {Object[]} activePositions  Array of position objects with shares > 0
 */
export function updatePositionsTable(activePositions) {
    if (!positionsTableContainer) return;

    if (activePositions.length === 0) {
        positionsTableContainer.innerHTML = `
            <div class="text-center py-8 text-slate-400">No active positions.</div>
        `;
        return;
    }

    const rows = activePositions.map(pos => {
        const gainPositive = pos.unrealizedGainLoss >= 0;
        const priceDisplay = Number.isFinite(pos.currentPrice)
            ? `$${pos.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : '<span class="text-slate-500">—</span>';

        return `
            <tr class="bg-slate-900/40 rounded-xl">
                <td class="px-4 py-4 rounded-l-xl">
                    <div class="font-bold text-white">${pos.symbol}</div>
                    <div class="text-xs text-slate-500">${pos.company || ''}</div>
                </td>
                <td class="px-4 py-4 text-right text-slate-300">
                    ${pos.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                </td>
                <td class="px-4 py-4 text-right text-slate-300">
                    $${pos.avgPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td class="px-4 py-4 text-right text-slate-300">${priceDisplay}</td>
                <td class="px-4 py-4 text-right text-slate-300">
                    $${pos.costBasis.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td class="px-4 py-4 text-right font-bold text-white">
                    $${pos.marketValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td class="px-4 py-4 text-right rounded-r-xl">
                    <div class="font-bold ${gainPositive ? 'text-emerald-400' : 'text-rose-400'}">
                        ${gainPositive ? '+' : '-'}$${Math.abs(pos.unrealizedGainLoss).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <div class="text-xs ${gainPositive ? 'text-emerald-500/70' : 'text-rose-500/70'}">
                        ${gainPositive ? '+' : '-'}${Math.abs(pos.unrealizedGainPercent).toFixed(2)}%
                    </div>
                </td>
            </tr>
        `;
    }).join('');

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
            <tbody>${rows}</tbody>
        </table>
    `;
}

// ─── Chart Legend ─────────────────────────────────────────────────────────────

/**
 * Render the doughnut chart legend.
 * @param {Object[]} activePositions
 * @param {string[]} colors  Color palette array
 */
export function renderChartLegend(activePositions, colors) {
    if (!chartLegend) return;
    const totalValue = activePositions.reduce((sum, p) => sum + p.marketValue, 0);
    chartLegend.innerHTML = '';

    activePositions.forEach((pos, i) => {
        const percent = totalValue > 0 ? (pos.marketValue / totalValue) * 100 : 0;
        const item = document.createElement('div');
        item.className = 'flex items-center gap-2';
        item.innerHTML = `
            <div class="w-3 h-3 rounded-full shrink-0" style="background-color: ${colors[i % colors.length]}"></div>
            <div class="min-w-0">
                <div class="text-sm text-slate-300 font-semibold leading-tight">${pos.symbol}</div>
                <div class="text-[11px] text-slate-500 leading-tight">
                    ${percent.toFixed(1)}% · $${pos.marketValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
            </div>
        `;
        chartLegend.appendChild(item);
    });
}

// ─── History Table ────────────────────────────────────────────────────────────

/**
 * Render the transaction history table.
 * @param {Object[]} transactions  Portfolio array (will be sorted newest-first internally)
 * @param {{ onEdit: Function, onDelete: Function }} callbacks
 */
export function renderHistory(transactions, { onEdit, onDelete }) {
    if (transactions.length === 0) {
        historyEmpty.classList.remove('hidden');
        historyTableContainer.classList.add('hidden');
        return;
    }

    historyEmpty.classList.add('hidden');
    historyTableContainer.classList.remove('hidden');
    historyTableBody.innerHTML = '';

    [...transactions]
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .forEach(tx => {
            const row = document.createElement('tr');
            row.className = 'bg-slate-50 rounded-xl overflow-hidden group hover:bg-slate-100 transition-colors';

            const symbol = normalizeSymbol(tx.symbol);
            const shares = parseFloat(tx.shares) || 0;
            const price = parseFloat(tx.price) || 0;
            const total = shares * price;
            const isBuy = tx.type === 'buy';

            row.innerHTML = `
                <td class="px-6 py-4 text-sm text-slate-500 font-medium">${tx.date}</td>
                <td class="px-6 py-4">
                    <div class="flex items-center gap-3">
                        ${tx.logo
                            ? `<img src="${tx.logo}" alt="${symbol}" class="w-8 h-8 rounded-lg object-contain bg-white border border-slate-200">`
                            : `<div class="w-8 h-8 rounded-lg bg-slate-200 flex items-center justify-center font-bold text-[10px] text-slate-400">${symbol.charAt(0)}</div>`
                        }
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
                        <button type="button" data-action="edit" data-id="${tx.id}"
                            class="px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 text-xs font-bold hover:bg-blue-100 transition-colors">
                            Edit
                        </button>
                        <button type="button" data-action="delete" data-id="${tx.id}"
                            class="px-3 py-1.5 rounded-lg bg-rose-50 text-rose-700 text-xs font-bold hover:bg-rose-100 transition-colors">
                            Delete
                        </button>
                    </div>
                </td>
            `;

            historyTableBody.appendChild(row);
        });

    lucide.createIcons();

    // Delegate click events on freshly rendered rows
    historyTableBody.addEventListener('click', e => {
        const button = e.target.closest('button[data-action]');
        if (!button) return;
        const { action, id } = button.dataset;
        if (action === 'edit') onEdit(id);
        if (action === 'delete') onDelete(id);
    }, { once: true }); // Re-registered each render to avoid stacking
}

// ─── Form Helpers ─────────────────────────────────────────────────────────────

/**
 * Populate the Add Transaction form for editing an existing transaction.
 * @param {HTMLFormElement} form
 * @param {Object} tx  Transaction to load into the form
 * @param {HTMLButtonElement} submitButton
 */
export function loadTransactionIntoForm(form, tx, submitButton) {
    form.querySelector('input[name="symbol"]').value = tx.symbol || '';
    form.querySelector('input[name="company"]').value = tx.company || '';
    form.querySelector('input[name="logo"]').value = tx.logo || '';
    form.querySelector('input[name="shares"]').value = tx.shares || '';
    form.querySelector('input[name="price"]').value = tx.price || '';
    form.querySelector('input[name="date"]').value = tx.date || '';
    form.querySelector('textarea[name="notes"]').value = tx.notes || '';

    const typeInput = form.querySelector(`input[name="type"][value="${tx.type}"]`);
    if (typeInput) typeInput.checked = true;

    if (submitButton) {
        submitButton.textContent = 'Update Transaction';
        submitButton.classList.remove('bg-blue-600', 'hover:bg-blue-700', 'shadow-blue-200');
        submitButton.classList.add('bg-amber-500', 'hover:bg-amber-600', 'shadow-amber-200');
    }

    lucide.createIcons();
}

/**
 * Reset the form submit button back to "Save Transaction" mode.
 * @param {HTMLButtonElement} submitButton
 */
export function resetSubmitButton(submitButton) {
    if (!submitButton) return;
    submitButton.textContent = 'Save Transaction';
    submitButton.classList.remove('bg-amber-500', 'hover:bg-amber-600', 'shadow-amber-200');
    submitButton.classList.add('bg-blue-600', 'hover:bg-blue-700', 'shadow-blue-200');
}
