/**
 * charts.js — StockTracker
 * Encapsulates all Chart.js logic.
 * - updateDoughnutChart: Portfolio allocation (doughnut)
 * - updateLineChart: Performance comparison (line)
 * No API calls. No DOM outside the passed canvas elements.
 */

// ─── Color Palette ────────────────────────────────────────────────────────────

export const CHART_COLORS = [
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

// ─── Doughnut Chart ───────────────────────────────────────────────────────────

/** @type {Chart|null} */
let portfolioChart = null;

/**
 * Create (or recreate) the doughnut allocation chart.
 *
 * @param {HTMLCanvasElement} canvasEl  The <canvas id="portfolio-chart"> element
 * @param {Object[]} activePositions   Positions with shares > 0
 * @returns {Chart}
 */
export function updateDoughnutChart(canvasEl, activePositions) {
    if (portfolioChart) {
        portfolioChart.destroy();
        portfolioChart = null;
    }

    if (!canvasEl || activePositions.length === 0) return null;

    const labels = activePositions.map(p => p.symbol);
    const data = activePositions.map(p => p.marketValue);
    const totalValue = data.reduce((sum, v) => sum + v, 0);

    // Custom plugin: draw hovered segment info in the donut center
    const hoverCenterPlugin = {
        id: 'hoverCenterPlugin',
        afterDraw(chart) {
            const { ctx, chartArea } = chart;
            if (!chartArea) return;

            const idx = chart.$hoveredIndex;
            if (idx === null || idx === undefined) return;

            const position = activePositions[idx];
            if (!position) return;

            const value = position.marketValue;
            const percent = totalValue > 0 ? (value / totalValue) * 100 : 0;
            const cx = (chartArea.left + chartArea.right) / 2;
            const cy = (chartArea.top + chartArea.bottom) / 2;

            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            // Symbol
            ctx.fillStyle = CHART_COLORS[idx % CHART_COLORS.length];
            ctx.font = '700 26px Outfit, sans-serif';
            ctx.fillText(position.symbol, cx, cy - 42);

            // Company
            ctx.fillStyle = '#94a3b8';
            ctx.font = '500 12px Outfit, sans-serif';
            ctx.fillText(position.company || 'Current Holding', cx, cy - 18);

            // Market value
            ctx.fillStyle = '#ffffff';
            ctx.font = '700 19px Outfit, sans-serif';
            ctx.fillText(
                `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                cx,
                cy + 10
            );

            // Percentage
            ctx.fillStyle = '#cbd5e1';
            ctx.font = '600 12px Outfit, sans-serif';
            ctx.fillText(`${percent.toFixed(1)}% of portfolio`, cx, cy + 36);

            ctx.restore();
        }
    };

    portfolioChart = new Chart(canvasEl, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor: activePositions.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
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
                legend: { display: false },
                tooltip: { enabled: false }
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

    return portfolioChart;
}

// ─── Line Chart ───────────────────────────────────────────────────────────────

/** @type {Chart|null} */
let performanceChart = null;

/**
 * Create (or recreate) the performance comparison line chart.
 *
 * @param {HTMLCanvasElement} canvasEl  The <canvas id="performance-chart"> element
 * @param {{ labels: string[], portfolio: number[], sp500: number[], nasdaq: number[] }} perfData
 * @returns {Chart|null}
 */
export function updateLineChart(canvasEl, perfData) {
    if (performanceChart) {
        performanceChart.destroy();
        performanceChart = null;
    }

    if (!canvasEl || !perfData || perfData.labels.length === 0) return null;

    const allValues = [
        ...perfData.portfolio,
        ...perfData.sp500,
        ...perfData.nasdaq
    ].filter(Number.isFinite);

    const minValue = allValues.length ? Math.min(...allValues) : -5;
    const maxValue = allValues.length ? Math.max(...allValues) : 5;
    const padding = Math.max((maxValue - minValue) * 0.25, 2);

    const suggestedMin = Math.floor(minValue - padding);
    const suggestedMax = Math.ceil(maxValue + padding);

    const ctx = canvasEl.getContext('2d');
    const portfolioGradient = ctx.createLinearGradient(0, 0, 0, canvasEl.height || 320);
    portfolioGradient.addColorStop(0, 'rgba(16, 185, 129, 0.28)');
    portfolioGradient.addColorStop(0.45, 'rgba(16, 185, 129, 0.08)');
    portfolioGradient.addColorStop(1, 'rgba(16, 185, 129, 0)');

    // Dashed zero-line plugin
    const zeroLinePlugin = {
        id: 'zeroLinePlugin',
        afterDraw(chart) {
            const { ctx: c, chartArea, scales } = chart;
            if (!chartArea || !scales.y) return;
            const y = scales.y.getPixelForValue(0);
            if (y < chartArea.top || y > chartArea.bottom) return;
            c.save();
            c.beginPath();
            c.moveTo(chartArea.left, y);
            c.lineTo(chartArea.right, y);
            c.lineWidth = 1;
            c.strokeStyle = 'rgba(148, 163, 184, 0.35)';
            c.setLineDash([5, 5]);
            c.stroke();
            c.restore();
        }
    };

    performanceChart = new Chart(canvasEl, {
        type: 'line',
        data: {
            labels: perfData.labels.map(d =>
                new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            ),
            datasets: [
                {
                    label: 'Your Portfolio',
                    data: perfData.portfolio,
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
                    data: perfData.sp500,
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
                    data: perfData.nasdaq,
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
            interaction: { mode: 'index', intersect: false },
            animation: { duration: 650, easing: 'easeOutQuart' },
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
                        font: { family: 'Outfit', size: 12, weight: '600' }
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
                        title: items => items[0]?.label || '',
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
                    grid: { display: false },
                    border: { display: false },
                    ticks: {
                        color: '#64748b',
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 6,
                        font: { family: 'Outfit', size: 11 }
                    }
                },
                y: {
                    suggestedMin,
                    suggestedMax,
                    border: { display: false },
                    grid: {
                        color(context) {
                            return context.tick.value === 0
                                ? 'rgba(148, 163, 184, 0)'
                                : 'rgba(148, 163, 184, 0.08)';
                        }
                    },
                    ticks: {
                        color: '#64748b',
                        maxTicksLimit: 6,
                        padding: 8,
                        font: { family: 'Outfit', size: 11 },
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

    return performanceChart;
}
