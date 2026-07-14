'use strict';

// ── Constantes ─────────────────────────────────────────────────────────────────

const PAD_LEFT_S   = 140;
const PAD_BOTTOM_S = 96;
const PAD_TOP_S    = 8;
const PAD_RIGHT_S  = 10;

// Nomes abreviados para os eixos do heatmap (nomes completos ficam no tooltip).
const SETOR_ABBREV = {
  'Administração de empresas e empreendimentos':                            'Administração',
  'Agricultura, pecuária, silvicultura, pesca e caça':                      'Agricultura',
  'Artes, entretenimento e recreação':                                      'Artes/Recreação',
  'Assistência médica e social':                                            'Saúde',
  'Comércio atacadista':                                                    'Com. Atacadista',
  'Comércio varejista':                                                     'Com. Varejista',
  'Construção':                                                             'Construção',
  'Educacão':                                                               'Educação',
  'Empresa de eletricidade, gás e água':                                    'Utilidades',
  'Hotel e restaurante':                                                    'Hotel/Restaurante',
  'Imobiliária e locadora de outros bens':                                  'Imobiliária',
  'Indústria manufatureira':                                                'Manufatura',
  'Informação':                                                             'Informação',
  'Mineração, exploração de pedreiras e extração de petróleo e gás':       'Mineração/Petróleo',
  'Serviços de apoio a empresas e gerenciamento de resíduos e remediação': 'Serv. Apoio/Resíduos',
  'Serviços financeiros e seguros':                                         'Financeiro/Seguros',
  'Serviços profissionais, científicos e técnicos':                         'Serv. Profissional',
  'Transporte e armazenamento':                                             'Transporte',
  'Exterior/Não classificado':                                              'Exterior/N.Class.',
};

// ── Estado ─────────────────────────────────────────────────────────────────────

let _mesId;
let _idx;
let _setoresData  = null;
let _vegaHeatmap  = null;
let _vegaBars     = null;
let _setorSel     = null;

// ── Funções puras (espelhadas em test_setores_js.js) ──────────────────────────

// Constrói array flat para o heatmap Vega: uma linha por (fundo × setor).
function buildSetoresFlat(setoresData) {
  const rows = [];
  for (const f of setoresData.fundos) {
    for (const setor of setoresData.setores) {
      rows.push({
        fundo:      f.nome_curto,
        setor:      SETOR_ABBREV[setor] || setor,
        setor_full: setor,
        peso:       f.pesos[setor] || 0,
      });
    }
  }
  return rows;
}

// Retorna fundos para um setor ordenados por peso desc, somente peso > 0.
// Exportada para testes.
function buildBarsData(setoresData, setorNome) {
  return setoresData.fundos
    .map(f => ({ nome_curto: f.nome_curto, peso: f.pesos[setorNome] || 0 }))
    .filter(f => f.peso > 0)
    .sort((a, b) => b.peso - a.peso);
}

// ── Spec Vega — heatmap fundo × setor ─────────────────────────────────────────

function buildHeatmapSpec(flatData, fundos, setores, cellSize) {
  const abbrevSetores = setores.map(s => SETOR_ABBREV[s] || s);
  const W = cellSize * fundos.length;
  const H = cellSize * setores.length;

  return {
    $schema: 'https://vega.github.io/schema/vega/v5.json',
    width:   W,
    height:  H,
    padding: { top: PAD_TOP_S, bottom: PAD_BOTTOM_S, left: PAD_LEFT_S, right: PAD_RIGHT_S },
    background: 'transparent',
    data: [{ name: 'grid', values: flatData }],
    scales: [
      {
        name:    'x',
        type:    'band',
        domain:  fundos,
        range:   [0, { signal: 'width' }],
        padding: 0,
      },
      {
        name:    'y',
        type:    'band',
        domain:  abbrevSetores,
        range:   [0, { signal: 'height' }],
        padding: 0,
      },
      {
        // Domínio fixo [0, 0.5] para comparabilidade entre meses.
        // Pesos acima de 50% (ex.: VERBIER em Manufatura) são clamped para azul máximo.
        name:   'color',
        type:   'linear',
        domain: [0, 0.5],
        range:  ['#f0f4ff', '#1d4ed8'],
        clamp:  true,
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
        labelFontSize: 9,
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
            x:      { scale: 'x', field: 'fundo' },
            width:  { scale: 'x', band: 1 },
            y:      { scale: 'y', field: 'setor' },
            height: { scale: 'y', band: 1 },
            fill:        { scale: 'color', field: 'peso' },
            stroke:      { value: '#ffffff' },
            strokeWidth: { value: 0.5 },
            tooltip: {
              signal: "datum.fundo + ' × ' + datum.setor_full + ' — ' + format(datum.peso, '.1%') + ' do PL'",
            },
          },
        },
      },
    ],
  };
}

// ── Spec Vega-Lite — barras por setor ─────────────────────────────────────────

function buildBarsSpec(barsData, containerW) {
  // Desconta margem para labels do eixo Y (nomes dos fundos, max ~12 chars)
  const chartW = Math.max(300, containerW - 120);

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width:   chartW,
    height:  { step: 24 },
    background: 'transparent',
    data: { values: barsData },
    mark: { type: 'bar', color: '#1d4ed8', cornerRadiusEnd: 3 },
    encoding: {
      y: {
        field: 'nome_curto',
        type:  'ordinal',
        sort:  null,
        axis:  {
          title:      null,
          labelFontSize: 9.5,
          labelColor: '#6b7280',
          labelFont:  'Segoe UI, system-ui, sans-serif',
        },
      },
      x: {
        field: 'peso',
        type:  'quantitative',
        axis:  {
          format:    '.0%',
          title:     null,
          gridColor: '#e5e7eb',
          labelFontSize: 9,
          labelColor: '#6b7280',
          labelFont:  'Segoe UI, system-ui, sans-serif',
        },
      },
      tooltip: [
        { field: 'nome_curto', title: 'Fundo',          type: 'nominal' },
        { field: 'peso',       title: 'Peso no setor',  type: 'quantitative', format: '.2%' },
      ],
    },
    config: {
      view: { stroke: null },
      axis: { domainColor: '#e5e7eb' },
    },
  };
}

// ── Render heatmap ─────────────────────────────────────────────────────────────

function _debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function renderHeatmap(setoresData, nExpected) {
  if (_vegaHeatmap) {
    try { _vegaHeatmap.finalize(); } catch (e) { /* ignora */ }
    _vegaHeatmap = null;
  }

  const wrap = document.getElementById('heatmap-wrap');
  wrap.innerHTML = '<div class="ui-loading">Carregando heatmap…</div>';

  const fundos  = setoresData.fundos.map(f => f.nome_curto);
  const setores = setoresData.setores;

  // Nota de cobertura parcial
  const notaEl = document.getElementById('heatmap-nota');
  if (notaEl) {
    const mesRef = _idx.meses.find(m => m.id === _mesId);
    const nMax   = nExpected;
    if (notaEl) {
      if (fundos.length < nMax) {
        notaEl.textContent = `Em ${mesRef ? mesRef.label : _mesId}, apenas ${fundos.length} de ${nMax} fundos já divulgaram carteira.`;
        notaEl.style.display = 'block';
      } else {
        notaEl.textContent = '';
        notaEl.style.display = 'none';
      }
    }
  }

  const flatData = buildSetoresFlat(setoresData);
  wrap.innerHTML = '';

  const outer    = document.getElementById('heatmap-outer');
  const containerW = (outer ? outer.clientWidth : 0) || 800;
  const cellSize = Math.max(14, Math.floor((containerW - PAD_LEFT_S - PAD_RIGHT_S) / fundos.length));

  const spec = buildHeatmapSpec(flatData, fundos, setores, cellSize);

  try {
    const result = await vegaEmbed('#heatmap-wrap', spec, { actions: false, renderer: 'svg' });
    _vegaHeatmap = result.view;
  } catch (err) {
    wrap.innerHTML = `<div class="ui-error">Erro ao renderizar heatmap.<br><small>${err}</small></div>`;
  }
}

// ── Render barras ──────────────────────────────────────────────────────────────

async function renderBars(setorNome) {
  if (!_setoresData) return;

  if (_vegaBars) {
    try { _vegaBars.finalize(); } catch (e) { /* ignora */ }
    _vegaBars = null;
  }

  const wrap = document.getElementById('bars-wrap');
  if (!wrap) return;

  const barsData = buildBarsData(_setoresData, setorNome);

  if (barsData.length === 0) {
    wrap.innerHTML = '<div class="ui-empty">Nenhum fundo com exposição a este setor no mês selecionado.</div>';
    return;
  }

  // Limpa antes do rAF para medir o contêiner vazio
  wrap.innerHTML = '';

  requestAnimationFrame(async () => {
    const outer    = document.getElementById('bars-outer');
    const containerW = (outer ? (outer.clientWidth || outer.offsetWidth) : 0) || 700;
    const spec = buildBarsSpec(barsData, containerW);

    try {
      const result = await vegaEmbed('#bars-wrap', spec, { actions: false, renderer: 'svg' });
      _vegaBars = result.view;

      const ref = outer || wrap;
      const handler = _debounce(() => {
        const nw = Math.max(300, (ref.clientWidth || ref.offsetWidth || 700) - 120);
        _vegaBars.signal('width', nw).run();
      }, 200);
      if (window._czStResizeHandler) window.removeEventListener('resize', window._czStResizeHandler);
      window._czStResizeHandler = handler;
      window.addEventListener('resize', handler);
    } catch (err) {
      wrap.innerHTML = `<div class="ui-error">Erro ao renderizar gráfico.<br><small>${err}</small></div>`;
    }
  });
}

// ── Seletor de setor ───────────────────────────────────────────────────────────

function renderSetorSelect(setores, selected) {
  const opts = setores.map(s =>
    `<option value="${s}"${s === selected ? ' selected' : ''}>${s}</option>`
  ).join('');
  const sel = document.getElementById('setor-select');
  if (sel) sel.innerHTML = opts;
}

// ── Carregamento por mês ───────────────────────────────────────────────────────

async function carregarMes(mesId) {
  _mesId = mesId;
  czPushParams({ mes: mesId });

  const wrapH = document.getElementById('heatmap-wrap');
  const wrapB = document.getElementById('bars-wrap');
  if (wrapH) wrapH.innerHTML = '<div class="ui-loading">Carregando…</div>';
  if (wrapB) wrapB.innerHTML = '<div class="ui-loading">Carregando…</div>';

  let setoresData, raioX;
  try {
    [setoresData, raioX] = await Promise.all([czLoadSetores(mesId), czLoadRaioX(mesId)]);
  } catch (err) {
    if (wrapH) wrapH.innerHTML = `<div class="ui-error">Erro ao carregar dados de setores.<br><small>${err.message}</small></div>`;
    return;
  }
  _setoresData = setoresData;

  // Popula setor select na primeira carga; mantém seleção atual nas seguintes
  const setorAtual = _setorSel && setoresData.setores.includes(_setorSel)
    ? _setorSel
    : setoresData.setores[0];
  _setorSel = setorAtual;
  renderSetorSelect(setoresData.setores, setorAtual);

  await renderHeatmap(setoresData, raioX.fundos.length);
  await renderBars(setorAtual);
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

async function init() {
  document.getElementById('nav').innerHTML = czRenderNav('setores');

  let idx;
  try {
    idx = await czLoadIndex();
  } catch (err) {
    document.getElementById('heatmap-wrap').innerHTML =
      `<div class="ui-error">Erro ao carregar índice.<br><small>${err.message}</small></div>`;
    return;
  }

  _idx   = idx;
  _mesId = czResolveMes(idx.meses);

  document.getElementById('mes-container').innerHTML =
    czRenderMonthSelect(idx.meses, _mesId);
  document.getElementById('mes-select').addEventListener('change', async e => {
    await carregarMes(e.target.value);
  });

  document.getElementById('setor-select').addEventListener('change', e => {
    _setorSel = e.target.value;
    renderBars(_setorSel);
  });

  await carregarMes(_mesId);
}

document.addEventListener('DOMContentLoaded', init);
