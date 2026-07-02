'use strict';

// ── Constantes ─────────────────────────────────────────────────────────────────

// Espaço reservado para labels dos eixos (fora da área de células)
const PAD_LEFT   = 84;
const PAD_BOTTOM = 96;
const PAD_TOP    = 8;
const PAD_RIGHT  = 10;

// ── Estado ─────────────────────────────────────────────────────────────────────

let _mesId;
let _idx;
let _allFundos = null;  // lista canônica de 39 nomes, ordem alfabética
let _vegaView  = null;
let _selectedPair = null;  // [fundoA, fundoB] normalizados (ordem alf.) ou null

// ── Funções puras (lógica de grade — espelhadas em test_overlap_js.js) ─────────

// Constrói lookup de overlap e conjunto de fundos com dado a partir do overlap.json.
// Chave do lookup: [nome_a, nome_b].sort().join('|') — invariante à ordem do par.
function buildGrid(overlapData) {
  const grid = {};
  const fundosComDado = new Set();
  for (const p of overlapData.pares) {
    const key = [p.nome_a, p.nome_b].sort().join('|');
    grid[key] = p.overlap;
    fundosComDado.add(p.nome_a);
    fundosComDado.add(p.nome_b);
  }
  return { grid, fundosComDado };
}

// Monta o array flat 39×39 para o Vega.
// tipo: 'diag' (diagonal), 'data' (overlap real), 'nodata' (fundo defasado)
// Exportada para testes.
function buildFlatGrid(allFundos, grid, fundosComDado) {
  const rows = [];
  for (let i = 0; i < allFundos.length; i++) {
    for (let j = 0; j < allFundos.length; j++) {
      const fA = allFundos[i], fB = allFundos[j];
      if (i === j) {
        rows.push({ fundo_a: fA, fundo_b: fB, tipo: 'diag', overlap: null });
      } else {
        const key = [fA, fB].sort().join('|');
        const bothHaveData = fundosComDado.has(fA) && fundosComDado.has(fB);
        if (bothHaveData && grid[key] !== undefined) {
          rows.push({ fundo_a: fA, fundo_b: fB, tipo: 'data', overlap: grid[key] });
        } else {
          rows.push({ fundo_a: fA, fundo_b: fB, tipo: 'nodata', overlap: null });
        }
      }
    }
  }
  return rows;
}

// Retorna ativos em comum entre dois fundos, ordenados por min(peso_A, peso_B) desc.
// Exportada para testes.
function buildCommonAssets(fundoA, fundoB, raioXData) {
  const fa = raioXData.fundos.find(f => f.nome_curto === fundoA);
  const fb = raioXData.fundos.find(f => f.nome_curto === fundoB);
  if (!fa || !fb) return [];
  const mapA = {};
  for (const p of (fa.posicoes || [])) if (p.tamanho > 0) mapA[p.codigo] = p.tamanho;
  const result = [];
  for (const p of (fb.posicoes || [])) {
    if (p.tamanho > 0 && mapA[p.codigo]) {
      result.push({
        codigo:   p.codigo,
        peso_a:   mapA[p.codigo],
        peso_b:   p.tamanho,
        min_peso: Math.min(p.tamanho, mapA[p.codigo]),
      });
    }
  }
  return result.sort((a, b) => b.min_peso - a.min_peso);
}

// Constrói a spec Vega (não Vega-Lite) para o heatmap 39×39.
// cellSize em pixels; a grade terá cellSize * allFundos.length de largura e altura.
// Exportada para testes.
function buildHeatmapSpec(flatGrid, allFundos, cellSize) {
  const W = cellSize * allFundos.length;

  return {
    $schema: 'https://vega.github.io/schema/vega/v5.json',
    width:   W,
    height:  W,
    padding: { top: PAD_TOP, bottom: PAD_BOTTOM, left: PAD_LEFT, right: PAD_RIGHT },
    background: 'transparent',
    data: [{ name: 'grid', values: flatGrid }],
    scales: [
      {
        name:    'x',
        type:    'band',
        domain:  allFundos,
        range:   [0, { signal: 'width' }],
        padding: 0,
      },
      {
        name:    'y',
        type:    'band',
        domain:  allFundos,
        range:   [0, { signal: 'height' }],
        padding: 0,
      },
      {
        // Escala sqrt branco → navy, domínio fixo [0,1].
        // sqrt comprime o extremo superior e expande os valores baixos,
        // tornando pares de 5-15% já visivelmente coloridos sem perder
        // comparabilidade entre meses (domínio fixo independe do mês).
        name:   'color',
        type:   'sqrt',
        domain: [0, 1],
        range:  ['#f0f4ff', '#1d4ed8'],
      },
    ],
    axes: [
      {
        orient:        'bottom',
        scale:         'x',
        labelAngle:    -45,
        labelAlign:    'right',
        labelBaseline: 'middle',
        labelFontSize: 8.5,
        labelColor:    '#6b7280',
        labelFont:     'Segoe UI, system-ui, sans-serif',
        tickSize:      0,
        domainOpacity: 0,
        labelOverlap:  false,
      },
      {
        orient:        'left',
        scale:         'y',
        labelFontSize: 8.5,
        labelColor:    '#6b7280',
        labelFont:     'Segoe UI, system-ui, sans-serif',
        tickSize:      0,
        domainOpacity: 0,
        labelOverlap:  false,
      },
    ],
    marks: [
      {
        type: 'rect',
        from: { data: 'grid' },
        encode: {
          update: {
            x:      { scale: 'x', field: 'fundo_b' },
            width:  { scale: 'x', band: 1 },
            y:      { scale: 'y', field: 'fundo_a' },
            height: { scale: 'y', band: 1 },
            fill: [
              { test: "datum.tipo === 'diag'",   value: '#9ca3af' },
              { test: "datum.tipo === 'nodata'", value: '#e2e4ea' },
              { scale: 'color', field: 'overlap' },
            ],
            stroke:      { value: '#ffffff' },
            strokeWidth: { value: 0.5 },
            cursor: {
              signal: "datum.tipo === 'data' ? 'pointer' : 'default'",
            },
            tooltip: {
              signal: [
                "datum.tipo === 'diag'   ? null :",
                "datum.tipo === 'nodata' ? (datum.fundo_a + ' × ' + datum.fundo_b + ' — sem dado neste mês') :",
                "(datum.fundo_a + ' × ' + datum.fundo_b + ' — Overlap: ' + format(datum.overlap, '.1%'))",
              ].join(' '),
            },
          },
        },
      },
    ],
  };
}

// ── Render heatmap ─────────────────────────────────────────────────────────────

async function renderHeatmap(mesId) {
  if (_vegaView) {
    try { _vegaView.finalize(); } catch (e) { /* ignora */ }
    _vegaView = null;
  }

  const wrap = document.getElementById('heatmap-wrap');
  wrap.innerHTML = '<div class="ui-loading">Carregando heatmap…</div>';

  let overlapData;
  try {
    overlapData = await czLoadOverlap(mesId);
  } catch (err) {
    wrap.innerHTML = `<div class="ui-error">Erro ao carregar overlap.<br><small>${err.message}</small></div>`;
    return;
  }

  const { grid, fundosComDado } = buildGrid(overlapData);
  const nComDado = fundosComDado.size;

  // Nota quando há menos de 39 fundos com dado no mês
  const notaEl = document.getElementById('heatmap-nota');
  if (notaEl) {
    if (nComDado < _allFundos.length) {
      const mes = _idx.meses.find(m => m.id === mesId);
      notaEl.textContent = `Em ${mes ? mes.label : mesId}, ${nComDado} de ${_allFundos.length} fundos já divulgaram carteira — células cinzas indicam fundos ainda em período de sigilo.`;
      notaEl.style.display = 'block';
    } else {
      notaEl.textContent = '';
      notaEl.style.display = 'none';
    }
  }

  const flatGrid = buildFlatGrid(_allFundos, grid, fundosComDado);

  wrap.innerHTML = '';

  // Mede a largura disponível e calcula cellSize (mín. 12px)
  const outer = document.getElementById('heatmap-outer');
  const containerW = (outer ? outer.clientWidth : 0) || 800;
  const cellSize = Math.max(Math.floor((containerW - PAD_LEFT - PAD_RIGHT) / _allFundos.length), 12);

  const spec = buildHeatmapSpec(flatGrid, _allFundos, cellSize);

  try {
    const result = await vegaEmbed('#heatmap-wrap', spec, { actions: false, renderer: 'svg' });
    _vegaView = result.view;

    _vegaView.addEventListener('click', (_event, item) => {
      if (!item || !item.datum || item.datum.tipo !== 'data') return;
      const d = item.datum;

      // Normaliza par em ordem alfabética para toggle consistente
      const [fA, fB] = [d.fundo_a, d.fundo_b].sort();

      if (_selectedPair && _selectedPair[0] === fA && _selectedPair[1] === fB) {
        // Mesma célula (ou espelho) → fecha painel
        _selectedPair = null;
        document.getElementById('detalhe-wrap').innerHTML = '';
        return;
      }

      _selectedPair = [fA, fB];
      mostrarDetalhe(fA, fB, d.overlap, mesId);
    });
  } catch (err) {
    wrap.innerHTML = `<div class="ui-error">Erro ao renderizar heatmap.<br><small>${err}</small></div>`;
  }
}

// ── Painel de detalhe ──────────────────────────────────────────────────────────

async function mostrarDetalhe(fundoA, fundoB, overlap, mesId) {
  const wrap = document.getElementById('detalhe-wrap');
  if (!wrap) return;

  const titulo = `${fundoA} × ${fundoB} — Overlap: ${czFmtPct(overlap, 1)}`;

  wrap.innerHTML = `
    <div style="background:var(--bg2);border:1.5px solid var(--border);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow);margin-top:16px">
      <div style="font-size:1.0em;font-weight:700;color:var(--navy);margin-bottom:12px">${titulo}</div>
      <div class="ui-loading" style="padding:20px 0;font-size:.85em">Carregando ativos em comum…</div>
    </div>`;

  let raioX;
  try {
    raioX = await czLoadRaioX(mesId);
  } catch (err) {
    wrap.innerHTML = `
      <div style="background:var(--bg2);border:1.5px solid var(--border);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow);margin-top:16px">
        <div style="font-size:1.0em;font-weight:700;color:var(--navy);margin-bottom:12px">${titulo}</div>
        <div class="ui-error" style="margin-top:8px">Erro ao carregar posições.<br><small>${err.message}</small></div>
      </div>`;
    return;
  }

  const comuns = buildCommonAssets(fundoA, fundoB, raioX);

  if (comuns.length === 0) {
    wrap.innerHTML = `
      <div style="background:var(--bg2);border:1.5px solid var(--border);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow);margin-top:16px">
        <div style="font-size:1.0em;font-weight:700;color:var(--navy);margin-bottom:12px">${titulo}</div>
        <div class="ui-empty" style="padding:20px 0">Nenhum ativo em comum encontrado.</div>
      </div>`;
    return;
  }

  const tbody = comuns.map(c => `
    <tr>
      <td class="mono">${c.codigo}</td>
      <td class="num">${czFmtPct(c.peso_a, 2)}</td>
      <td class="num">${czFmtPct(c.peso_b, 2)}</td>
      <td class="num"><strong>${czFmtPct(c.min_peso, 2)}</strong></td>
    </tr>`).join('');

  wrap.innerHTML = `
    <div style="background:var(--bg2);border:1.5px solid var(--border);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow);margin-top:16px">
      <div style="font-size:1.0em;font-weight:700;color:var(--navy);margin-bottom:12px">${titulo}</div>
      <div class="cz-table-wrap">
        <table class="cz-table">
          <thead>
            <tr>
              <th>Ativo</th>
              <th>${fundoA}</th>
              <th>${fundoB}</th>
              <th>Mínimo</th>
            </tr>
          </thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Carregamento por mês ───────────────────────────────────────────────────────

async function carregarMes(mesId) {
  _mesId = mesId;
  _selectedPair = null;
  document.getElementById('detalhe-wrap').innerHTML = '';
  czPushParams({ mes: mesId });
  await renderHeatmap(mesId);
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

async function init() {
  document.getElementById('nav').innerHTML = czRenderNav('overlap');

  let idx;
  try {
    idx = await czLoadIndex();
  } catch (err) {
    document.getElementById('heatmap-wrap').innerHTML =
      `<div class="ui-error">Erro ao carregar índice.<br><small>${err.message}</small></div>`;
    return;
  }

  _idx   = idx;
  const meses = idx.meses;
  _mesId = czResolveMes(meses);

  document.getElementById('mes-container').innerHTML = czRenderMonthSelect(meses, _mesId);
  document.getElementById('mes-select').addEventListener('change', async e => {
    await carregarMes(e.target.value);
  });

  // Deriva lista canônica de fundos do mês mais recente com 39 fundos
  const mesRef = [...meses].reverse().find(m => m.n_fundos === Math.max(...meses.map(m => m.n_fundos)));
  try {
    const raioX = await czLoadRaioX((mesRef || meses[meses.length - 1]).id);
    _allFundos = raioX.fundos.map(f => f.nome_curto).sort();
  } catch (err) {
    document.getElementById('heatmap-wrap').innerHTML =
      `<div class="ui-error">Erro ao carregar lista de fundos.<br><small>${err.message}</small></div>`;
    return;
  }

  await carregarMes(_mesId);
}

document.addEventListener('DOMContentLoaded', init);
