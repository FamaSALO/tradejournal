(function () {
  'use strict';
  const NS = window.TJ;
  const U = NS.utils;
  const charts = {};

  const FONT = '"Inter", "Segoe UI", Arial, sans-serif';
  const GRID = 'rgba(148, 178, 212, 0.09)';
  const MUTED = '#617185';
  const POS = '#31e3aa';
  const NEG = '#ff6b81';

  function prepare(canvas) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    return { ctx: ctx, w: rect.width, h: rect.height };
  }

  function hexToRgba(hex, alpha) {
    const clean = hex.replace('#', '');
    const value = parseInt(clean, 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function drawEmpty(canvas, message) {
    const env = prepare(canvas);
    if (!env) return;
    const ctx = env.ctx;
    ctx.fillStyle = 'rgba(148, 178, 212, 0.06)';
    ctx.fillRect(0, env.h / 2 - 0.5, env.w, 1);
    ctx.fillStyle = MUTED;
    ctx.font = '10.5px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message || 'Нет данных за выбранный период', env.w / 2, env.h / 2 - 14);
    canvas._tjMove = null;
    canvas._tjLeave = null;
  }

  function bindHover(canvas) {
    if (canvas._tjBound) return;
    canvas._tjBound = true;
    canvas.addEventListener('mousemove', function (event) {
      if (!canvas._tjMove) return;
      const rect = canvas.getBoundingClientRect();
      canvas._tjMove(event.clientX - rect.left, event.clientY - rect.top);
    });
    canvas.addEventListener('mouseleave', function () {
      if (canvas._tjLeave) canvas._tjLeave();
    });
  }

  function tooltipFor(canvas) {
    if (!canvas.parentElement) return null;
    return canvas.parentElement.querySelector('.chart-tooltip');
  }

  function showTooltip(tooltip, html, x, y, w, h) {
    if (!tooltip) return;
    tooltip.innerHTML = html;
    tooltip.classList.add('show');
    const width = tooltip.offsetWidth || 150;
    const height = tooltip.offsetHeight || 60;
    let left = x + 14;
    if (left + width > w - 6) left = x - width - 14;
    left = Math.max(6, Math.min(left, w - width - 6));
    let top = y - height - 10;
    if (top < 4) top = y + 14;
    top = Math.max(4, Math.min(top, h - height - 4));
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }

  function hideTooltip(tooltip) {
    if (tooltip) tooltip.classList.remove('show');
  }

  function moneyTick(value) {
    return U.compactMoney(value);
  }

  function niceStep(value) {
    if (!isFinite(value) || value <= 0) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(value)));
    const fraction = value / exp;
    let multiplier = 1;
    if (fraction > 5) multiplier = 10;
    else if (fraction > 2.5) multiplier = 5;
    else if (fraction > 2) multiplier = 2.5;
    else if (fraction > 1) multiplier = 2;
    return multiplier * exp;
  }

  function axisDate(label) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(label || '')) return U.formatDate(label, 'short');
    return label || '';
  }

  function roundedBar(ctx, x, y, w, h, radius, positive) {
    const r = Math.min(radius, w / 2, h);
    ctx.beginPath();
    if (positive) {
      ctx.moveTo(x, y + h);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h);
    } else {
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + h - r);
      ctx.quadraticCurveTo(x, y + h, x + r, y + h);
      ctx.lineTo(x + w - r, y + h);
      ctx.quadraticCurveTo(x + w, y + h, x + w, y + h - r);
      ctx.lineTo(x + w, y);
    }
    ctx.closePath();
    ctx.fill();
  }

  /* ============================ Equity ============================ */
  charts.equity = function (canvas, points, opts) {
    opts = opts || {};
    if (!canvas) return;
    if (!points || points.length < 2) {
      drawEmpty(canvas, opts.emptyText || 'Пока нет закрытых сделок за период');
      hideTooltip(tooltipFor(canvas));
      return;
    }

    const env = prepare(canvas);
    if (!env) return;
    const ctx = env.ctx;
    const w = env.w;
    const h = env.h;
    const tooltip = tooltipFor(canvas);
    const pad = { l: 54, r: 12, t: 14, b: 24 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    const values = points.map(function (p) { return p.value; });
    let min = Math.min.apply(null, values);
    let max = Math.max.apply(null, values);
    if (min === max) {
      const delta = Math.max(1, Math.abs(max) * 0.01);
      min -= delta;
      max += delta;
    }
    const step = niceStep((max - min) / 4);
    min = Math.floor(min / step) * step;
    max = Math.ceil(max / step) * step;
    const gridLevels = Math.max(1, Math.round((max - min) / step));

    const xAt = function (index) {
      return pad.l + (points.length === 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
    };
    const yAt = function (value) {
      return pad.t + ((max - value) / (max - min)) * plotH;
    };

    const isPositive = values[values.length - 1] >= values[0];
    const color = isPositive ? POS : NEG;

    ctx.font = '9px ' + FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= gridLevels; i++) {
      const value = min + ((max - min) * i) / gridLevels;
      const y = yAt(value);
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l, Math.round(y) + 0.5);
      ctx.lineTo(w - pad.r, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.fillText(moneyTick(value), pad.l - 8, y);
    }

    const labelCount = w < 420 ? 3 : 5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = MUTED;
    ctx.font = '9px ' + FONT;
    const used = new Set();
    for (let i = 0; i < labelCount; i++) {
      const index = Math.round((i / (labelCount - 1)) * (points.length - 1));
      if (used.has(index)) continue;
      used.add(index);
      const label = axisDate(points[index].label);
      ctx.fillText(label, xAt(index), h - pad.b + 7);
    }

    const areaGradient = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
    areaGradient.addColorStop(0, hexToRgba(color, 0.2));
    areaGradient.addColorStop(0.7, hexToRgba(color, 0.05));
    areaGradient.addColorStop(1, hexToRgba(color, 0));

    const draw = function (hoverIndex) {
      ctx.clearRect(0, 0, w, h);

      for (let i = 0; i <= gridLevels; i++) {
        const value = min + ((max - min) * i) / gridLevels;
        const y = yAt(value);
        ctx.strokeStyle = GRID;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.l, Math.round(y) + 0.5);
        ctx.lineTo(w - pad.r, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.fillStyle = MUTED;
        ctx.font = '9px ' + FONT;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(moneyTick(value), pad.l - 8, y);
      }

      ctx.beginPath();
      points.forEach(function (point, index) {
        const x = xAt(index);
        const y = yAt(point.value);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.lineTo(xAt(points.length - 1), h - pad.b);
      ctx.lineTo(xAt(0), h - pad.b);
      ctx.closePath();
      ctx.fillStyle = areaGradient;
      ctx.fill();

      ctx.beginPath();
      points.forEach(function (point, index) {
        const x = xAt(index);
        const y = yAt(point.value);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = hexToRgba(color, 0.4);
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;

      const lastX = xAt(points.length - 1);
      const lastY = yAt(points[points.length - 1].value);
      ctx.beginPath();
      ctx.arc(lastX, lastY, 8, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(color, 0.14);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(lastX, lastY, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      ctx.fillStyle = MUTED;
      ctx.font = '9px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const usedLabels = new Set();
      for (let i = 0; i < labelCount; i++) {
        const index = Math.round((i / (labelCount - 1)) * (points.length - 1));
        if (usedLabels.has(index)) continue;
        usedLabels.add(index);
        ctx.fillText(axisDate(points[index].label), xAt(index), h - pad.b + 7);
      }

      if (hoverIndex !== null && hoverIndex !== undefined) {
        const point = points[hoverIndex];
        const x = xAt(hoverIndex);
        const y = yAt(point.value);
        ctx.strokeStyle = 'rgba(148, 178, 212, 0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, pad.t);
        ctx.lineTo(x, h - pad.b);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.strokeStyle = hexToRgba(color, 0.5);
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    };

    draw(null);
    bindHover(canvas);
    canvas._tjMove = function (mx) {
      const index = Math.max(0, Math.min(points.length - 1, Math.round(((mx - pad.l) / plotW) * (points.length - 1))));
      draw(index);
      const point = points[index];
      const pnlMeta = point.meta ? U.escapeHtml(point.meta) : '';
      const valueClass = point.value >= points[0].value ? 'pos' : 'neg';
      const label = point.label && /^\d{4}-\d{2}-\d{2}$/.test(point.label) ? U.formatDate(point.label, 'long') : (point.label || '');
      const html = '<div class="tt-label">' + U.escapeHtml(label) + '</div>' +
        '<strong class="' + valueClass + '">' + U.escapeHtml(U.money(point.value)) + '</strong>' +
        (pnlMeta ? '<div class="tt-meta">' + pnlMeta + '</div>' : '');
      showTooltip(tooltip, html, xAt(index), yAt(point.value), w, h);
    };
    canvas._tjLeave = function () {
      draw(null);
      hideTooltip(tooltip);
    };
  };

  /* ============================ Bars ============================ */
  charts.bars = function (canvas, points, opts) {
    opts = opts || {};
    if (!canvas) return;
    if (!points || !points.length) {
      drawEmpty(canvas, opts.emptyText || 'Нет сделок за выбранный период');
      hideTooltip(tooltipFor(canvas));
      return;
    }

    const env = prepare(canvas);
    if (!env) return;
    const ctx = env.ctx;
    const w = env.w;
    const h = env.h;
    const tooltip = tooltipFor(canvas);
    const pad = { l: 52, r: 10, t: 12, b: 25 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    const values = points.map(function (p) { return p.value; });
    let min = Math.min.apply(null, values.concat([0]));
    let max = Math.max.apply(null, values.concat([0]));
    if (min === max) {
      drawEmpty(canvas, opts.emptyText || 'Нет данных');
      return;
    }
    const step = niceStep((max - min) / 5);
    min = Math.floor(min / step) * step;
    max = Math.ceil(max / step) * step;
    const zeroY = pad.t + ((max - 0) / (max - min)) * plotH;
    const yAt = function (value) {
      return pad.t + ((max - value) / (max - min)) * plotH;
    };

    const slot = plotW / points.length;
    const barWidth = Math.max(3, Math.min(36, slot * 0.62));
    const totalPositive = values.some(function (v) { return v > 0; });
    const totalNegative = values.some(function (v) { return v < 0; });

    const draw = function (hoverIndex) {
      ctx.clearRect(0, 0, w, h);

      const gridValues = [];
      for (let value = max; value >= min - step * 0.001; value -= step) {
        gridValues.push(Math.abs(value) < step * 1e-9 ? 0 : value);
      }
      const seen = new Set();
      ctx.font = '9px ' + FONT;
      gridValues.forEach(function (value) {
        const key = Math.round(value * 100);
        if (seen.has(key)) return;
        seen.add(key);
        const y = yAt(value);
        if (y < pad.t - 4 || y > h - pad.b + 4) return;
        ctx.strokeStyle = Math.abs(value) < 0.0001 ? 'rgba(148, 178, 212, 0.18)' : GRID;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.l, Math.round(y) + 0.5);
        ctx.lineTo(w - pad.r, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.fillStyle = MUTED;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(moneyTick(value), pad.l - 8, y);
      });

      if (hoverIndex !== null && hoverIndex !== undefined) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
        ctx.fillRect(pad.l + slot * hoverIndex + 1, pad.t, Math.max(2, slot - 2), plotH);
      }

      points.forEach(function (point, index) {
        const value = point.value;
        const x = pad.l + slot * index + (slot - barWidth) / 2;
        const barH = Math.max(2, Math.abs(value) / (max - min) * plotH);
        const positive = value >= 0;
        const y = positive ? zeroY - barH : zeroY;

        let fill;
        if (Math.abs(value) < 0.0001) {
          fill = 'rgba(148, 178, 212, 0.22)';
        } else if (positive) {
          const gradient = ctx.createLinearGradient(0, y, 0, zeroY);
          gradient.addColorStop(0, hoverIndex === index ? '#67f7cb' : POS);
          gradient.addColorStop(1, 'rgba(20, 143, 107, 0.5)');
          fill = gradient;
        } else {
          const gradient = ctx.createLinearGradient(0, zeroY, 0, y + barH);
          gradient.addColorStop(0, 'rgba(170, 47, 65, 0.55)');
          gradient.addColorStop(1, hoverIndex === index ? '#ff8fa0' : NEG);
          fill = gradient;
        }
        ctx.fillStyle = fill;
        const height = Math.max(2, barH);
        roundedBar(ctx, x, positive ? zeroY - height : zeroY, barWidth, height, Math.min(4, barWidth / 2), positive);
      });

      ctx.fillStyle = MUTED;
      ctx.font = '9px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const labelStep = Math.ceil(points.length / (w < 460 ? 4 : 8));
      points.forEach(function (point, index) {
        if (index % labelStep !== 0 && index !== points.length - 1) return;
        const x = pad.l + slot * index + slot / 2;
        ctx.fillText(axisDate(point.label), x, h - pad.b + 7);
      });

      // обводка нулевой линии поверх баров
      ctx.strokeStyle = 'rgba(148, 178, 212, 0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l, Math.round(zeroY) + 0.5);
      ctx.lineTo(w - pad.r, Math.round(zeroY) + 0.5);
      ctx.stroke();
    };

    draw(null);
    bindHover(canvas);
    canvas._tjMove = function (mx) {
      const index = Math.max(0, Math.min(points.length - 1, Math.floor((mx - pad.l) / slot)));
      draw(index);
      const point = points[index];
      const value = point.value;
      const cl = value >= 0 ? 'pos' : 'neg';
      const label = point.label && /^\d{4}-\d{2}-\d{2}$/.test(point.label) ? U.formatDate(point.label, 'long') : point.label;
      const html = '<div class="tt-label">' + U.escapeHtml(label) + '</div>' +
        '<strong class="' + cl + '">' + U.escapeHtml(U.money(value, { sign: true })) + '</strong>' +
        (point.meta ? '<div class="tt-meta">' + U.escapeHtml(point.meta) + '</div>' : '');
      const valueY = value >= 0 ? yAt(value) : yAt(value);
      showTooltip(tooltip, html, pad.l + slot * index + slot / 2, valueY, w, h);
    };
    canvas._tjLeave = function () {
      draw(null);
      hideTooltip(tooltip);
    };
  };

  /* ============================ Donut ============================ */
  charts.donut = function (canvas, segments) {
    if (!canvas) return;
    const env = prepare(canvas);
    if (!env) return;
    const ctx = env.ctx;
    const w = env.w;
    const h = env.h;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.max(10, Math.min(w, h) / 2 - 13);
    const lineWidth = Math.max(10, Math.min(20, radius * 0.3));
    const total = segments.reduce(function (acc, s) { return acc + Math.max(0, s.value); }, 0);

    const drawRing = function (start, end, color) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius, start, end);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.stroke();
    };

    drawRing(0, Math.PI * 2, 'rgba(148, 178, 212, 0.08)');

    if (!total) return;

    let angle = -Math.PI / 2;
    const gap = Math.min(0.05, (Math.PI * 2) / (total * 6));
    segments.forEach(function (segment) {
      if (!segment.value || segment.value <= 0) return;
      const sweep = (segment.value / total) * Math.PI * 2;
      const start = angle + gap / 2;
      const end = angle + sweep - gap / 2;
      if (end > start) drawRing(start, end, segment.color);
      angle += sweep;
    });
  };

  NS.charts = charts;
})();
