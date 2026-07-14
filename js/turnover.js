'use strict';

// ── Constantes ─────────────────────────────────────────────────────────────────

const MESES_LABEL = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

const TV_COLS = [
  { key: 'nome_curto', label: 'Fundo',                    num: false },
  { key: 'turnover',   label: 'Giro (compras+vendas/PL)', num: true  },
  { key: 'data_ref',   label: 'Data ref.',                num: false },
];

// ── Estado ─────────────────────────────────────────────────────────────────────

let _mesId, _meses, _turnoverData, _tableData;
let _sortCol        = 'turnover';
let _sortDir        = 'desc';
let _scaleType      = 'log';
let _chartRows      = null;
let _selectedFundos = null; // Set<string>

// ── Bootstrap ──────────────────────────────────────────────────────────────────

async function init() {
  document.getElementById('nav').innerHTML = czRenderNav('turnover');

  let idx;
  try {
    idx = await czLoadIndex();
  } catch (err) {
    czShowError('main-content', err.message);
    return;
  }

  _meses = idx.meses;
  _mesId = czResolveMes(_meses);

  document.getElementById('scale-toggle').addEventListener('click', () => {
    _scaleType = _scaleType === 'log' ? 'linear' : 'log';
    document.getElementById('scale-toggle').textContent =
      _scaleType === 'log' ? 'Escala: Log' : 'Escala: Linear';
    renderChart();
  });

  document.getElementById('chips-filter').addEventListener('input', e => {
    const q = e.target.value.trim().toUpperCase();
    document.querySelectorAll('#chips-wrap .tv-chip').forEach(chip => {
      chip.style.display = !q || chip.dataset.fundo.toUpperCase().includes(q) ? '' : 'none';
    });
  });

  document.getElementById('chips-todos').addEventListener('click', () => {
    _selectedFundos = new Set(fundosDoMes(_mesId));
    document.querySelectorAll('#chips-wrap .tv-chip').forEach(c => c.classList.add('selected'));
    onSelectionChange();
  });

  document.getElementById('chips-nenhum').addEventListener('click', () => {
    _selectedFundos = new Set();
    document.querySelectorAll('#chips-wrap .tv-chip').forEach(c => c.classList.remove('selected'));
    onSelectionChange();
  });

  try {
    _turnoverData = await czLoadTurnover();
  } catch (err) {
    czShowError('main-content', err.message);
    return;
  }

  _chartRows = buildChartRows(_turnoverData);
  _selectedFundos = new Set(fundosDoMes(_mesId));

  renderChips();
  updateScaleToggle();
  renderChart();
  renderTabela();
}

// ── buildTableData ─────────────────────────────────────────────────────────────

// Exportada para testes
function buildTableData(dados, mesId) {
  return dados.fundos.map(f => {
    const h = (f.historico || []).find(h => h.mes_id === mesId);
    return {
      nome_curto: f.nome_curto,
      turnover:   h != null ? h.turnover : null,
      data_ref:   h != null ? h.data_ref : null,
    };
  }).filter(r => r.turnover !== null);
}

// ── buildChartRows ─────────────────────────────────────────────────────────────

// Retorna lista ordenada de fundos com dado no mês selecionado.
function fundosDoMes(mesId) {
  return buildTableData(_turnoverData, mesId).map(r => r.nome_curto).sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

// Exportada para testes
function buildChartRows(dados) {
  const rows = [];
  for (const f of dados.fundos) {
    for (const h of (f.historico || [])) {
      const [ano, mes] = h.mes_id.split('-');
      rows.push({
        nome_curto: f.nome_curto,
        mes_id:     h.mes_id,
        mes_label:  `${MESES_LABEL[parseInt(mes) - 1]}/${ano.slice(2)}`,
        turnover:   h.turnover,
      });
    }
  }
  return rows;
}

// ── buildChartSpec ─────────────────────────────────────────────────────────────

// Exportada para testes.
// Para escala log: zeros são filtrados antes de passar ao Vega-Lite — as linhas ficam
// com gaps nos meses de turnover zero, em vez de causar -Infinity na escala.
function buildChartSpec(rows, scaleType, width) {
  const specRows = scaleType === 'log' ? rows.filter(r => r.turnover > 0) : rows;

  const mesIds = [...new Set(rows.map(r => r.mes_id))].sort();
  const mesLabelsOrdered = mesIds.map(id => {
    const [ano, mes] = id.split('-');
    return `${MESES_LABEL[parseInt(mes) - 1]}/${ano.slice(2)}`;
  });

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: width || 700,
    height: 360,
    data: { values: specRows },
    params: [{
      name: 'hover',
      select: {
        type: 'point',
        fields: ['nome_curto'],
        on: 'pointerover',
        nearest: true,
        clear: 'pointerout'
      }
    }],
    mark: { type: 'line', point: { filled: true, size: 50, opacity: 0 }, strokeWidth: 1.5 },
    encoding: {
      x: {
        field: 'mes_label',
        type: 'ordinal',
        sort: mesLabelsOrdered,
        axis: { title: null, labelAngle: -30, labelFontSize: 10 }
      },
      y: {
        field: 'turnover',
        type: 'quantitative',
        scale: { type: scaleType },
        axis: { format: '.0%', title: null, gridColor: '#e2e4ea', tickCount: 6 }
      },
      color: {
        field: 'nome_curto',
        type: 'nominal',
        scale: { scheme: 'tableau20' },
        legend: null
      },
      opacity: {
        condition: { param: 'hover', value: 1 },
        value: 0.15
      },
      strokeWidth: {
        condition: { param: 'hover', value: 3 },
        value: 1.2
      },
      tooltip: [
        { field: 'nome_curto', title: 'Fundo' },
        { field: 'mes_label',  title: 'Mês' },
        { field: 'turnover',   title: 'Giro (compras+vendas/PL)', format: '.1%' }
      ]
    },
    config: {
      view: { stroke: null },
      axis: { domainColor: '#e2e4ea' }
    }
  };
}

// ── Chips ──────────────────────────────────────────────────────────────────────

function renderChips() {
  const wrap = document.getElementById('chips-wrap');
  if (!wrap || !_turnoverData) return;

  const nomes = fundosDoMes(_mesId);

  wrap.innerHTML = nomes.map(nome =>
    `<button class="tv-chip${_selectedFundos.has(nome) ? ' selected' : ''}" data-fundo="${nome}">${nome}</button>`
  ).join('');

  wrap.querySelectorAll('.tv-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const fundo = chip.dataset.fundo;
      if (_selectedFundos.has(fundo)) {
        _selectedFundos.delete(fundo);
        chip.classList.remove('selected');
      } else {
        _selectedFundos.add(fundo);
        chip.classList.add('selected');
      }
      onSelectionChange();
    });
  });
}

function onSelectionChange() {
  updateScaleToggle();
  renderChart();
}

// ── Lógica de escala log ────────────────────────────────────────────────────────

// Log inválido quando algum fundo selecionado tem TODOS os seus valores = 0.
// (ENCORE/FAMA/EQUITAS têm zeros isolados — ok; ficam com gaps na linha log.)
function fundosComTodosZeros() {
  if (!_chartRows || !_selectedFundos) return [];
  return [..._selectedFundos].filter(nome =>
    !_chartRows.some(r => r.nome_curto === nome && r.turnover > 0)
  );
}

function updateScaleToggle() {
  const btn   = document.getElementById('scale-toggle');
  const nota  = document.getElementById('log-nota');
  const zeros = fundosComTodosZeros();

  if (zeros.length > 0) {
    if (_scaleType === 'log') _scaleType = 'linear';
    if (btn) { btn.textContent = 'Escala: Linear'; btn.disabled = true; }
    if (nota) {
      nota.textContent =
        `${zeros.join(', ')} tem turnover zero em todos os meses — deselecione esse fundo para habilitar a escala log.`;
    }
  } else {
    if (btn) {
      btn.disabled = false;
      btn.textContent = _scaleType === 'log' ? 'Escala: Log' : 'Escala: Linear';
    }
    if (nota) nota.textContent = '';
  }
}

// ── Render gráfico ─────────────────────────────────────────────────────────────

// width:'container' colapsa para 0px antes do layout estar pronto — medimos diretamente.
function _debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function renderChart() {
  const wrap = document.getElementById('chart-wrap');
  if (!wrap || !_turnoverData || !_selectedFundos || !_chartRows) return;

  // Remove resize handler anterior
  if (window._czTvResizeHandler) {
    window.removeEventListener('resize', window._czTvResizeHandler);
    window._czTvResizeHandler = null;
  }

  if (_selectedFundos.size === 0) {
    wrap.innerHTML = '<div class="ui-empty">Nenhum fundo selecionado.</div>';
    _updateChartNota('');
    _updateChartTitle(0);
    return;
  }

  // Captura estado atual antes do rAF — seleção ou escala pode mudar antes do frame
  const filteredRows = _chartRows.filter(r => _selectedFundos.has(r.nome_curto));
  const scaleType    = _scaleType;
  const n            = _selectedFundos.size;

  _updateChartTitle(n);
  _updateChartNota(scaleType === 'log'
    ? 'Escala logarítmica. Meses com turnover = 0% aparecem como gaps (ex.: ENCORE abr/25, FAMA em alguns meses).'
    : 'Escala linear. Fundos de alta rotatividade (ex.: LOGOS TR > 500%) comprimem a visualização dos demais.');

  // vegaEmbed cria um filho display:inline-block dentro de wrap; enquanto ele existir,
  // wrap.clientWidth mede a largura desse filho, não do contêiner. Limpar o innerHTML
  // antes do rAF garante que wrap seja um bloco vazio na hora da medição.
  wrap.innerHTML = '';

  requestAnimationFrame(() => {
    const w = Math.max((wrap.clientWidth || wrap.offsetWidth || 700) - 32, 320);
    const spec = buildChartSpec(filteredRows, scaleType, w);

    vegaEmbed('#chart-wrap', spec, { actions: false, renderer: 'svg' })
      .then(({ view }) => {
        const ref = wrap.parentElement || wrap;
        window._czTvResizeHandler = _debounce(() => {
          const nw = Math.max((ref.clientWidth || ref.offsetWidth || 700) - 32, 320);
          view.signal('width', nw).run();
        }, 200);
        window.addEventListener('resize', window._czTvResizeHandler);
      })
      .catch(err => {
        wrap.innerHTML =
          `<div class="ui-error">Erro ao renderizar gráfico.<br><small>${err}</small></div>`;
      });
  });
}

function _updateChartTitle(n) {
  const el = document.getElementById('chart-section-title');
  if (el) el.textContent = n === 0
    ? 'Histórico de giro'
    : `Histórico de giro — ${n} fundo${n !== 1 ? 's' : ''} selecionado${n !== 1 ? 's' : ''}`;
}

function _updateChartNota(text) {
  const el = document.getElementById('chart-nota');
  if (el) el.textContent = text;
}

// ── Render tabela ──────────────────────────────────────────────────────────────

function _sortRows(rows, col, dir) {
  const factor = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = a[col] ?? (dir === 'desc' ? -Infinity : Infinity);
    const vb = b[col] ?? (dir === 'desc' ? -Infinity : Infinity);
    if (typeof va === 'string') return factor * va.localeCompare(vb, 'pt-BR');
    return factor * (va - vb);
  });
}

function _renderTabelaBody() {
  return _sortRows(_tableData, _sortCol, _sortDir).map(r => `
    <tr>
      <td>${r.nome_curto}</td>
      <td class="num ${r.turnover > 1 ? 'alto' : ''}">${czFmtPct(r.turnover, 1)}</td>
      <td class="num">${r.data_ref || '—'}</td>
    </tr>`).join('');
}

function renderTabela() {
  if (!_turnoverData) return;
  _tableData = buildTableData(_turnoverData, _mesId);

  const el = document.getElementById('tabela-turnover');
  if (!el) return;

  const theadHtml = TV_COLS.map(c => {
    const cls = [c.num ? 'num' : '', c.key === _sortCol ? `sorted-${_sortDir}` : '']
      .filter(Boolean).join(' ');
    return `<th data-col="${c.key}"${cls ? ` class="${cls}"` : ''}>${c.label}</th>`;
  }).join('');

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
      <span class="section-title" style="margin:0">Turnover em — <strong>${_tableData.length}</strong> fundos</span>
      ${czRenderMonthSelect(_meses, _mesId)}
    </div>
    <div class="cz-table-wrap">
      <table class="cz-table">
        <thead><tr id="tv-thead">${theadHtml}</tr></thead>
        <tbody id="tv-tbody">${_renderTabelaBody()}</tbody>
      </table>
    </div>`;

  document.getElementById('mes-select').addEventListener('change', e => {
    _mesId = e.target.value;
    czPushParams({ mes: _mesId });
    _selectedFundos = new Set(fundosDoMes(_mesId));
    renderChips();
    renderTabela();
    renderChart();
  });

  document.getElementById('tv-thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    const col = th.dataset.col;
    _sortDir  = (_sortCol === col && _sortDir === 'desc') ? 'asc' : 'desc';
    _sortCol  = col;
    document.querySelectorAll('#tv-thead th[data-col]').forEach(t => {
      t.classList.remove('sorted-asc', 'sorted-desc');
      if (t.dataset.col === _sortCol) t.classList.add('sorted-' + _sortDir);
    });
    document.getElementById('tv-tbody').innerHTML = _renderTabelaBody();
  });
}

// ── Start ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
