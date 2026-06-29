'use strict';

// ── Constantes ─────────────────────────────────────────────────────────────────

const RK_COLS = [
  { key: 'codigo',       label: 'Ativo',       num: false },
  { key: 'n_fundos',     label: 'Fundos',       num: true  },
  { key: 'peso_medio',   label: 'Peso médio',   num: true  },
  { key: 'peso_total',   label: 'Peso total',   num: true  },
  { key: 'n_aumentaram', label: '▲ Aumentaram', num: true  },
  { key: 'n_reduziram',  label: '▼ Reduziram',  num: true  },
  { key: 'n_entraram',   label: 'Entrou',       num: true  },
  { key: 'n_sairam',     label: 'Saiu',         num: true  },
];

const TM_TOP_N  = 6;
const TM_COLORS = ['#ef4444', '#22c55e', '#f59e0b', '#3b82f6', '#a855f7', '#14b8a6'];

let _mesId, _rankingData, _tableData;
let _sortCol = 'n_fundos';
let _sortDir = 'desc';
let _filterText = '';

// ── Bootstrap ──────────────────────────────────────────────────────────────────

async function init() {
  document.getElementById('nav').innerHTML = czRenderNav('ranking');

  let idx;
  try {
    idx = await czLoadIndex();
  } catch (err) {
    czShowError('main-content', err.message);
    return;
  }

  const meses = idx.meses;
  _mesId = czResolveMes(meses);

  document.getElementById('mes-container').innerHTML = czRenderMonthSelect(meses, _mesId);
  document.getElementById('mes-select').addEventListener('change', async e => {
    _mesId = e.target.value;
    await carregarMes(_mesId);
  });

  try {
    _rankingData = await czLoadRanking();
  } catch (err) {
    czShowError('main-content', err.message);
    return;
  }

  document.getElementById('busca-ativo').addEventListener('input', e => {
    _filterText = e.target.value.trim();
    renderTabela();
  });

  await carregarMes(_mesId);
}

// ── Extração de dados para o mês ───────────────────────────────────────────────

// Exportada para testes
function buildTableData(rankingData, mesId) {
  const rows = [];
  for (const ativo of rankingData.ativos) {
    const h = (ativo.historico || []).find(h => h.mes_id === mesId);
    if (!h) continue;
    rows.push({
      codigo:       ativo.codigo,
      n_fundos:     h.n_fundos,
      peso_medio:   h.peso_medio,
      peso_total:   h.peso_total,
      n_aumentaram: h.n_aumentaram,
      n_reduziram:  h.n_reduziram,
      n_entraram:   h.n_entraram,
      n_sairam:     h.n_sairam,
    });
  }
  return rows;
}

// ── Treemap ────────────────────────────────────────────────────────────────────

// Constrói o array flat de nós para Vega stratify+treemap.
//
// Filtra para fundos com dado genuíno no mes_id (mesma regra de calcular_overlap
// e .exportar_ranking: data_ref começa com mes_id). Fundos defasados são excluídos
// do treemap para manter consistência com n_fundos da tabela.
//
// Exportada para testes (Node.js).
function buildTreemapData(rankingData, raioXData, mesId) {
  // Fundos com dado genuíno neste mês
  const genuineCnpjs = new Set(
    raioXData.fundos
      .filter(f => f.data_ref && f.data_ref.startsWith(mesId))
      .map(f => f.cnpj)
  );

  // Mapa cnpj → { nome, posicoes }
  const fundoMap = {};
  for (const f of raioXData.fundos) {
    if (genuineCnpjs.has(f.cnpj)) {
      fundoMap[f.cnpj] = { nome: f.nome_curto, posicoes: f.posicoes || [] };
    }
  }

  // Top-N ativos por peso_total do mesId (ranking já filtrado por fundos genuínos)
  const sorted = [];
  for (const ativo of rankingData.ativos) {
    const h = (ativo.historico || []).find(h => h.mes_id === mesId);
    if (h && h.peso_total > 0) sorted.push({ codigo: ativo.codigo, peso_total: h.peso_total, n_fundos: h.n_fundos });
  }
  sorted.sort((a, b) => b.peso_total - a.peso_total);
  const topAtivos = sorted.slice(0, TM_TOP_N);

  // Para cada ativo top-N, coleta posições dos fundos genuínos
  const ativos = [];
  for (const { codigo, peso_total, n_fundos } of topAtivos) {
    const fundos = [];
    for (const info of Object.values(fundoMap)) {
      const pos = (info.posicoes || []).find(p => p.codigo === codigo && p.tamanho > 0);
      if (pos) fundos.push({ nome: info.nome, valor: pos.tamanho });
    }
    if (fundos.length > 0) ativos.push({ codigo, fundos, peso_total, n_fundos });
  }

  if (ativos.length === 0) return { nodes: [], ativos: [] };

  // Nós flat: raiz → ativo → fundo
  const nodes = [{ id: '__root__', parent: null, label: '', ativo: '', valor: 0, peso_total: 0, n_fundos: 0 }];
  for (const a of ativos) {
    nodes.push({ id: a.codigo, parent: '__root__', label: a.codigo, ativo: a.codigo, valor: 0, peso_total: a.peso_total, n_fundos: a.n_fundos });
    for (const f of a.fundos) {
      nodes.push({
        id:    `${a.codigo}::${f.nome}`,
        parent: a.codigo,
        label:  f.nome,
        ativo:  a.codigo,
        valor:  f.valor,
      });
    }
  }

  return { nodes, ativos: ativos.map(a => a.codigo) };
}

// Constrói a spec Vega (não Vega-Lite) para o treemap.
// Separada de renderTreemap para ser instanciável em testes Node.js.
//
// Exportada para testes.
function buildVegaSpec(nodes, ativos, width, height) {
  return {
    $schema: 'https://vega.github.io/schema/vega/v5.json',
    width,
    height,
    padding: 0,
    background: 'transparent',
    data: [{
      name: 'tree',
      values: nodes,
      transform: [
        { type: 'stratify', key: 'id', parentKey: 'parent' },
        {
          type:         'treemap',
          field:        'valor',
          method:       'squarify',
          ratio:        1.618,
          paddingInner: 2,
          paddingOuter: 0,
          round:        true,
          size:         [{ signal: 'width' }, { signal: 'height' }],
        },
      ],
    }],
    scales: [{
      name:   'color',
      type:   'ordinal',
      domain: ativos,
      range:  TM_COLORS.slice(0, ativos.length),
    }],
    marks: [
      // Retângulos — folhas coloridas (depth=2); transparente para nós internos
      {
        type: 'rect',
        from: { data: 'tree' },
        encode: {
          update: {
            x:   { field: 'x0' }, y:   { field: 'y0' },
            x2:  { field: 'x1' }, y2:  { field: 'y1' },
            fill: [
              { test: 'datum.depth !== 2', value: 'transparent' },
              { scale: 'color', field: 'ativo' },
            ],
            stroke:      { value: 'white' },
            strokeWidth: [
              { test: 'datum.depth !== 2', value: 0 },
              { value: 1 },
            ],
            tooltip: { signal: "datum.depth === 1 ? {'Ativo': datum.label, 'Peso total': format(datum.peso_total, '.1%'), 'Fundos': datum.n_fundos} : datum.depth === 2 ? {'Ativo': datum.ativo, 'Fundo': datum.label, 'Posição': format(datum.valor, '.2%')} : null" },
          },
        },
      },
      // Rótulos — 3 níveis: tamanho padrão (11px) / encolhe (8–11px) / oculto (tooltip)
      {
        type: 'text',
        from: { data: 'tree' },
        encode: {
          update: {
            x:        { signal: '(datum.x0 + datum.x1) / 2' },
            y:        { signal: '(datum.y0 + datum.y1) / 2' },
            align:    { value: 'center' },
            baseline: { value: 'middle' },
            fill: [
              { test: 'datum.depth === 1', value: 'rgba(0,0,0,0.30)' },
              { value: 'white' },
            ],
            text: [
              { test: 'datum.depth < 1', value: '' },
              // Ativo: oculta se largura < 8px OU fonte final (cap por altura) não cabe na altura
              { test: "datum.depth === 1 && ((datum.x1-datum.x0-4)/(length(datum.label)*0.58) < 8 || min((datum.x1-datum.x0-4)/(length(datum.label)*0.58),clamp((datum.y1-datum.y0)*0.22,14,44))*1.3>(datum.y1-datum.y0))", value: '' },
              { test: 'datum.depth === 1', field: 'label' },
              // Fundo: oculta se largura < 8px OU fonte final (cap 11px) não cabe na altura
              { test: "(datum.x1-datum.x0-4)/(length(datum.label)*0.58) < 8 || clamp((datum.x1-datum.x0-4)/(length(datum.label)*0.58),8,11)*1.3>(datum.y1-datum.y0)", value: '' },
              { field: 'label' },
            ],
            fontSize: [
              { test: 'datum.depth < 1', value: 0 },
              // Ativo: escala com altura (14–44px) como teto; encolhe se largura limitar
              { test: 'datum.depth === 1', signal: 'min((datum.x1 - datum.x0 - 4) / (length(datum.label) * 0.58) < 8 ? 0 : (datum.x1 - datum.x0 - 4) / (length(datum.label) * 0.58), clamp((datum.y1 - datum.y0) * 0.22, 14, 44))' },
              // Fundo: teto fixo 11px; encolhe até 8px; abaixo de 8px → oculto pelo test acima
              { signal: 'clamp((datum.x1 - datum.x0 - 4) / (length(datum.label) * 0.58), 8, 11)' },
            ],
            fontWeight: { signal: "datum.depth === 1 ? 'bold' : 'normal'" },
            fontStyle:  { signal: "datum.depth === 1 ? 'italic' : 'normal'" },
            tooltip:   { signal: "datum.depth === 1 ? {'Ativo': datum.label, 'Peso total': format(datum.peso_total, '.1%'), 'Fundos': datum.n_fundos} : datum.depth === 2 ? {'Ativo': datum.ativo, 'Fundo': datum.label, 'Posição': format(datum.valor, '.2%')} : null" },
          },
        },
      },
    ],
  };
}

function renderTreemap(nodes, ativos, containerId) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;

  if (!nodes || nodes.length <= 1) {
    wrap.innerHTML = '<div class="ui-empty">Sem dados de convicção para o mês selecionado.</div>';
    return;
  }

  const W = Math.max((wrap.clientWidth || wrap.offsetWidth || 640) - 2, 320);
  const H = Math.round(W * 0.50);
  wrap.style.height = H + 'px';

  const spec = buildVegaSpec(nodes, ativos, W, H);
  vegaEmbed('#' + containerId, spec, { actions: false, renderer: 'svg' })
    .catch(err => {
      wrap.innerHTML =
        `<div class="ui-error">Erro ao renderizar treemap.<br><small>${err}</small></div>`;
    });
}

// ── Sort e filtro ──────────────────────────────────────────────────────────────

// Exportada para testes
function sortRows(rows, col, dir) {
  const factor = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = a[col], vb = b[col];
    if (typeof va === 'string') return factor * va.localeCompare(vb, 'pt-BR');
    return factor * (va - vb);
  });
}

// Exportada para testes
function filterRows(rows, text) {
  if (!text) return rows;
  const q = text.toUpperCase();
  return rows.filter(r => r.codigo.toUpperCase().includes(q));
}

// ── Carregamento por mês ───────────────────────────────────────────────────────

async function carregarMes(mesId) {
  _tableData = buildTableData(_rankingData, mesId);
  czPushParams({ mes: mesId });

  const theadHtml = RK_COLS.map(c => {
    const cls = c.key === _sortCol ? ` class="sorted-${_sortDir}"` : '';
    return `<th data-col="${c.key}"${cls}>${c.label}</th>`;
  }).join('');

  document.getElementById('main-content').innerHTML = `
    <div id="stat-row" class="stat-row">
      <div class="stat-pill"><strong id="stat-n-ativos">—</strong>&ensp;ativos</div>
    </div>
    <div class="section-title">Top ${TM_TOP_N} ativos por convicção — ${czMesLabel(mesId)}</div>
    <div id="treemap-wrap" class="treemap-wrap"><div class="ui-loading">Carregando treemap…</div></div>
    <div class="cz-table-wrap">
      <table class="cz-table">
        <thead id="ranking-thead"><tr>${theadHtml}</tr></thead>
        <tbody id="ranking-tbody"></tbody>
      </table>
    </div>
  `;

  document.getElementById('ranking-thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    const col = th.dataset.col;
    _sortDir = (_sortCol === col && _sortDir === 'desc') ? 'asc' : 'desc';
    _sortCol = col;
    renderTabela();
  });

  renderTabela();

  // Carrega raio_x.json para o treemap (pode estar em cache se já foi carregado nesta sessão)
  let raioX = null;
  try {
    raioX = await czLoadRaioX(mesId);
  } catch (err) {
    console.warn('Treemap: raio_x.json indisponível —', err.message);
  }

  if (raioX) {
    const { nodes, ativos } = buildTreemapData(_rankingData, raioX, mesId);
    renderTreemap(nodes, ativos, 'treemap-wrap');
  } else {
    const wrap = document.getElementById('treemap-wrap');
    if (wrap) wrap.innerHTML = '<div class="ui-empty">Treemap indisponível.</div>';
  }
}

// ── Render tabela ──────────────────────────────────────────────────────────────

function renderTabela() {
  const visible = sortRows(filterRows(_tableData, _filterText), _sortCol, _sortDir);

  document.querySelectorAll('#ranking-thead th[data-col]').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.col === _sortCol) th.classList.add('sorted-' + _sortDir);
  });

  document.getElementById('stat-n-ativos').textContent = visible.length;

  if (visible.length === 0) {
    document.getElementById('ranking-tbody').innerHTML =
      `<tr><td colspan="${RK_COLS.length}" style="text-align:center;padding:20px;color:var(--text2)">Nenhum ativo encontrado.</td></tr>`;
    return;
  }

  const fmtDelta = (v, cls) =>
    v > 0 ? `<span class="${cls}">${v}</span>` : '<span class="neu">—</span>';

  document.getElementById('ranking-tbody').innerHTML = visible.map(r => `
    <tr>
      <td class="mono">${r.codigo}</td>
      <td class="num">${r.n_fundos}</td>
      <td class="num">${czFmtPct(r.peso_medio, 2)}</td>
      <td class="num">${czFmtPct(r.peso_total, 1)}</td>
      <td class="num">${fmtDelta(r.n_aumentaram, 'pos')}</td>
      <td class="num">${fmtDelta(r.n_reduziram,  'neg')}</td>
      <td class="num">${fmtDelta(r.n_entraram,   'pos')}</td>
      <td class="num">${fmtDelta(r.n_sairam,     'neg')}</td>
    </tr>`).join('');
}

// ── Start ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
