/**
 * app.js — StockTracker (Main Orchestrator)
 * Manages global state, wires up events, and coordinates modules.
 *
 * Modules:
 *   api.js            — fetching, caching
 *   portfolio-calc.js — TWR, positions
 *   ui.js             — DOM / rendering
 *   charts.js         — Chart.js wrappers
 */

import { fetchCurrentPrice, normalizeSymbol } from './api.js';
import { computePositions, calculateHistoricalPerformance } from './portfolio-calc.js';
import {
    switchView,
    showDashboardEmpty,
    showDashboardLoading,
    renderDashboardStats,
    showApiWarning,
    clearApiWarning,
    updatePositionsTable,
    renderChartLegend,
    renderHistory,
    loadTransactionIntoForm,
    resetSubmitButton
} from './ui.js';
import { updateDoughnutChart, updateLineChart } from './charts.js';

// ─── Global State ─────────────────────────────────────────────────────────────

const STORAGE_KEY = 'stocktracker_data';

let portfolioData = { portfolio: [] };
let currentTimeframe = '30D';
let editingTransactionId = null;

// ─── DOM References ───────────────────────────────────────────────────────────

const formTransaction = document.getElementById('form-transaction');
const submitButton = formTransaction.querySelector('button[type="submit"]');
const symbolInput = document.querySelector('input[name="symbol"]');
const companyInput = document.querySelector('input[name="company"]');
const logoInput = document.querySelector('input[name="logo"]');
const priceInput = document.querySelector('input[name="price"]');
const dateInput = document.querySelector('input[name="date"]');
const colorInput = document.querySelector('input[name="color"]');
const assetTypeRadios = document.querySelectorAll('input[name="assetType"]');
const sharesLabel = document.getElementById('shares-label');
const priceLabel = document.getElementById('price-label');
const chartCanvas = document.getElementById('portfolio-chart');
const performanceCanvas = document.getElementById('performance-chart');
const timeToggles = document.querySelectorAll('.time-toggle');

// ─── Persistence ──────────────────────────────────────────────────────────────

function savePortfolio() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(portfolioData));
}

async function loadPortfolio() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try {
            portfolioData = JSON.parse(saved);
            portfolioData.portfolio = Array.isArray(portfolioData.portfolio)
                ? portfolioData.portfolio
                : [];
            await renderUI();
            return;
        } catch (e) {
            console.error('[app] Failed to parse localStorage data', e);
        }
    }

    // Fall back to portfolio.json (useful for first-load seeding)
    try {
        const response = await fetch('portfolio.json');
        if (response.ok) {
            const text = await response.text();
            portfolioData = text.trim() ? JSON.parse(text) : { portfolio: [] };
            portfolioData.portfolio = Array.isArray(portfolioData.portfolio)
                ? portfolioData.portfolio
                : [];
        }
    } catch {
        // portfolio.json not found — start empty
        portfolioData = { portfolio: [] };
    }

    await renderUI();
}

// ─── Render Orchestration ─────────────────────────────────────────────────────

async function renderUI() {
    renderHistory(portfolioData.portfolio, {
        onEdit: startEditTransaction,
        onDelete: deleteTransaction
    });
    await renderDashboard();
    lucide.createIcons();
}

async function renderDashboard() {
    if (portfolioData.portfolio.length === 0) {
        showDashboardEmpty();
        return;
    }

    showDashboardLoading();

    const days = parseInt(currentTimeframe, 10) || 30;
    const perfData = await calculateHistoricalPerformance(portfolioData.portfolio, days);
    const { currentPrices } = perfData;

    // Identify symbols that came back without data (for UI warning)
    const txSymbols = [...new Set(
        portfolioData.portfolio.map(tx => normalizeSymbol(tx.symbol))
    )];
    const failedSymbols = txSymbols.filter(s => currentPrices[s] === undefined);

    const positions = computePositions(portfolioData.portfolio, currentPrices);
    const activePositions = Object.values(positions).filter(p => p.shares > 0);

    const currentMarketValue = activePositions.reduce((sum, p) => sum + p.marketValue, 0);
    const totalCostBasis = activePositions.reduce((sum, p) => sum + p.costBasis, 0);

    // Render stats cards
    renderDashboardStats(currentMarketValue, totalCostBasis, activePositions.length);

    // Show/clear API warning banner
    if (failedSymbols.length > 0) {
        showApiWarning(failedSymbols);
    } else {
        clearApiWarning();
    }

    // Update charts and tables
    updateDoughnutChart(chartCanvas, activePositions);
    renderChartLegend(activePositions);
    updatePositionsTable(activePositions);
    updateLineChart(performanceCanvas, perfData);
}

// ─── Transaction CRUD ─────────────────────────────────────────────────────────

function startEditTransaction(id) {
    const tx = portfolioData.portfolio.find(item => item.id === id);
    if (!tx) return;
    editingTransactionId = id;
    loadTransactionIntoForm(formTransaction, tx, submitButton);
    switchView('add');
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
        editingTransactionId = null;
        resetSubmitButton(submitButton);
    }
}

// ─── Form Submit ──────────────────────────────────────────────────────────────

formTransaction.addEventListener('submit', async e => {
    e.preventDefault();

    const formData = new FormData(formTransaction);
    const assetType = formData.get('assetType') || 'stock';
    const transactionData = {
        id: editingTransactionId || Date.now().toString(),
        symbol: assetType === 'cash' ? 'CASH' : normalizeSymbol(formData.get('symbol')),
        company: formData.get('company'),
        logo: formData.get('logo'),
        type: formData.get('type'),
        shares: parseFloat(formData.get('shares')),
        price: parseFloat(formData.get('price')),
        date: formData.get('date'),
        notes: formData.get('notes'),
        color: formData.get('color') || '#3b82f6',
        assetType
    };

    if (
        !transactionData.symbol ||
        !Number.isFinite(transactionData.shares) ||
        !Number.isFinite(transactionData.price)
    ) {
        alert('Please enter a valid symbol, shares, and price.');
        return;
    }

    if (transactionData.shares <= 0 || transactionData.price <= 0) {
        alert('Shares and price must be greater than 0.');
        return;
    }

    if (editingTransactionId) {
        portfolioData.portfolio = portfolioData.portfolio.map(tx =>
            tx.id === editingTransactionId ? transactionData : tx
        );
    } else {
        portfolioData.portfolio.push(transactionData);
    }

    savePortfolio();
    await renderUI();
    switchView('dashboard');

    formTransaction.reset();
    editingTransactionId = null;
    resetSubmitButton(submitButton);
    setAssetTypeUI('stock');
    dateInput.value = new Date().toISOString().split('T')[0];
});

// ─── Asset Type Toggle ──────────────────────────────────────────────────

function setAssetTypeUI(type) {
    if (type === 'cash') {
        symbolInput.value = 'CASH';
        symbolInput.readOnly = true;
        symbolInput.classList.add('bg-slate-100', 'text-slate-400');
        companyInput.value = 'Cash';
        companyInput.readOnly = true;
        logoInput.value = '';
        logoInput.readOnly = true;
        if (sharesLabel) sharesLabel.textContent = 'Amount (Units)';
        if (priceLabel) priceLabel.textContent = 'Price per Unit ($)';
        priceInput.value = '1';
    } else {
        symbolInput.readOnly = false;
        symbolInput.classList.remove('bg-slate-100', 'text-slate-400');
        companyInput.readOnly = false;
        logoInput.readOnly = false;
        if (sharesLabel) sharesLabel.textContent = 'Number of Shares';
        if (priceLabel) priceLabel.textContent = 'Price per Share ($)';
        // Only clear if it was previously set to CASH
        if (normalizeSymbol(symbolInput.value) === 'CASH') {
            symbolInput.value = '';
            companyInput.value = '';
            priceInput.value = '';
        }
    }
    lucide.createIcons();
}

assetTypeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
        setAssetTypeUI(radio.value);
    });
});

// ─── Symbol Blur — Auto-fill Price ───────────────────────────────────────

symbolInput.addEventListener('blur', async () => {
    const symbol = normalizeSymbol(symbolInput.value);
    if (!symbol || symbol === 'CASH') return;

    symbolInput.classList.add('animate-pulse');
    const price = await fetchCurrentPrice(symbol);

    if (price !== null && Number.isFinite(price)) {
        priceInput.value = price.toFixed(2);
    }
    // If null — leave field blank; user can enter price manually

    symbolInput.classList.remove('animate-pulse');
});

// ─── Navigation ───────────────────────────────────────────────────────────────

document.getElementById('nav-dashboard').addEventListener('click', () => switchView('dashboard'));
document.getElementById('nav-add').addEventListener('click', () => switchView('add'));
document.getElementById('nav-history').addEventListener('click', () => switchView('history'));

// ─── Timeframe Toggle ─────────────────────────────────────────────────────────

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

// ─── Init ─────────────────────────────────────────────────────────────────────

lucide.createIcons();

// Pre-fill today's date in the form
if (dateInput) {
    dateInput.value = new Date().toISOString().split('T')[0];
}

loadPortfolio();
