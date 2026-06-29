'use strict';

const RX_TOP_N    = 20;
const RX_LIMIAR   = 0.04; // 4 p.p.

let _mesId, _fundoNome, _raioXData;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  document.getElementById('nav').innerHTML = czRenderNav('raio_x');

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
    await carregarMes(_mesId, _fundoNome);
  });

  document.getElementById('fundo-select').addEventListener('change', e => {
    renderFundo(e.target.value);
  });

  await carregarMes(_mesId, czGetParam('fundo'));
}

// ── Carregamento por mês ──────────────────────────────────────────────────────

async function carregarMes(mesId, fundoParam) {
  czShowLoading('main-content', 'Carregando posições…');
  try {
    _raioXData = await czLoadRaioX(mesId);
  } catch (err) {
    czShowError('main-content', err.message);
    return;
  }

  const fundos  = _raioXData.fundos;
  const sorted  = [...fundos].sort((a, b) => a.nome_curto.localeCompare(b.nome_curto, 'pt-BR'));

  // Popula o dropdown de fundos
  const fundoSel = document.getElementById('fundo-select');
  fundoSel.innerHTML = sorted.map(f =>
    `<option value="${f.nome_curto}">${f.nome_curto}</option>`
  ).join('');

  // Resolve fundo selecionado
  _fundoNome = (fundoParam && fundos.find(f => f.nome_curto === fundoParam))
    ? fundoParam
    : sorted[0].nome_curto;
  fundoSel.value = _fundoNome;

  // Revela o seletor de fundo (estava oculto antes dos dados chegarem)
  document.getElementById('fundo-select-wrap').style.display = 'block';

  renderFundo(_fundoNome);
}

// ── Render principal ──────────────────────────────────────────────────────────

function renderFundo(nomeCurto) {
  _fundoNome = nomeCurto;
  czPushParams({ mes: _mesId, fundo: nomeCurto });

  const fundo = _raioXData.fundos.find(f => f.nome_curto === nomeCurto);
  if (!fundo) return;

  // Guarda contra dado carregado forward pelo pipeline: o JSON de um mês pode
  // conter um fundo com data_ref de meses anteriores (pipeline carrega última posição
  // disponível mesmo quando não há dado novo). Nesse caso exibimos aviso, não os dados.
  const dataRefMes = fundo.data_ref ? fundo.data_ref.substring(0, 7) : null;
  if (dataRefMes && dataRefMes !== _mesId) {
    const ultimaPos = fundo.data_ref ? czMesLabel(dataRefMes) : '—';
    document.getElementById('main-content').innerHTML = `
      <div class="stat-row">
        <div class="stat-pill neu">sem dados para ${czMesLabel(_mesId)}</div>
        <div class="stat-pill">última posição disponível: <strong>${ultimaPos}</strong></div>
      </div>
    `;
    return;
  }

  // Torna o conteúdo visível (estava com loading)
  document.getElementById('main-content').innerHTML = `
    <div id="stat-row" class="stat-row"></div>
    <div class="section-title" id="chart-title"></div>
    <div id="chart-legend" class="chart-legend"></div>
    <div id="chart-wrap" class="chart-wrap"></div>
    <div id="entradas-saidas"></div>
    <div id="destaques"></div>
    <div id="tabela-posicoes"></div>
  `;

  renderStats(fundo);
  const posicoes = fundo.posicoes || [];
  renderChart(posicoes, fundo.data_ref, fundo.data_ref_anterior);
  renderEntradasSaidas(posicoes);
  renderDestaques(posicoes);
  renderTabelaCompleta(posicoes);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function renderStats(fundo) {
  const pos    = fundo.posicoes || [];
  const ativas = pos.filter(p => p.tamanho > 0).length;
  const novas  = pos.filter(p => p.novo).length;
  const saidas = pos.filter(p => p.saiu).length;

  document.getElementById('stat-row').innerHTML = `
    <div class="stat-pill"><strong>${fundo.data_ref}</strong>&ensp;referência atual</div>
    ${fundo.data_ref_anterior
      ? `<div class="stat-pill"><strong>${fundo.data_ref_anterior}</strong>&ensp;mês anterior</div>`
      : '<div class="stat-pill neu">sem mês anterior</div>'}
    <div class="stat-pill"><strong>${ativas}</strong>&ensp;posições ativas</div>
    ${novas  ? `<div class="stat-pill" style="border-color:#86efac"><strong class="pos">${novas}</strong>&ensp;entradas</div>`  : ''}
    ${saidas ? `<div class="stat-pill" style="border-color:#fca5a5"><strong class="neg">${saidas}</strong>&ensp;saídas</div>` : ''}
  `;
}

// ── Gráfico Vega-Lite ─────────────────────────────────────────────────────────

// width:'container' falhou duas vezes (vega-embed usa display:inline-block no wrapper,
// que colapsa para 0px antes do layout estar pronto). Medimos clientWidth diretamente.
function _debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function renderChart(posicoes, dataRef, dataRefAnt) {
  const topN = posicoes
    .filter(p => p.tamanho > 0)
    .sort((a, b) => b.tamanho - a.tamanho)
    .slice(0, RX_TOP_N)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  const titulo = `Top ${Math.min(RX_TOP_N, topN.length)} posições — ${czMesLabel(_mesId)}`;
  document.getElementById('chart-title').textContent = titulo;

  if (topN.length === 0) {
    document.getElementById('chart-wrap').innerHTML = '<div class="ui-empty">Sem posições para exibir.</div>';
    document.getElementById('chart-legend').innerHTML = '';
    return;
  }

  const temAnterior = topN.some(p => p.tamanho_anterior != null);
  document.getElementById('chart-legend').innerHTML = `
    <span class="legend-item"><span class="legend-dot" style="background:#3b82f6"></span>Atual${dataRef ? ` (${dataRef})` : ''}</span>
    ${temAnterior ? `<span class="legend-item"><span class="legend-dot" style="background:#d1d5db"></span>Anterior${dataRefAnt ? ` (${dataRefAnt})` : ''}</span>` : ''}
  `;

  // Converte para long format: uma linha por série (Atual / Anterior).
  // Omite a linha "Anterior" quando não há dado — não inventa zero.
  const longData = [];
  for (const p of topN) {
    longData.push({ codigo: p.codigo, rank: p.rank, serie: 'Atual',    valor: p.tamanho });
    if (p.tamanho_anterior != null)
      longData.push({ codigo: p.codigo, rank: p.rank, serie: 'Anterior', valor: p.tamanho_anterior });
  }

  const chartWrap = document.getElementById('chart-wrap');
  const chartWidth = (chartWrap.clientWidth || chartWrap.offsetWidth || 620) - 32;

  // Barras agrupadas lado a lado via yOffset (Vega-Lite v5).
  // A abordagem anterior usava layer com dois campos (tamanho/tamanho_anterior)
  // na mesma posição Y: a barra azul sempre cobria a cinza quando era maior.
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: chartWidth,
    height: { step: 36 },
    data: { values: longData },
    mark: { type: 'bar' },
    encoding: {
      y: {
        field: 'codigo', type: 'nominal',
        sort: { field: 'rank', order: 'ascending' },
        axis: { title: null, labelFontSize: 11, labelLimit: 150 }
      },
      yOffset: {
        field: 'serie',
        sort: ['Atual', 'Anterior']
      },
      x: {
        field: 'valor', type: 'quantitative',
        scale: { domainMin: 0 },
        axis: { format: '.0%', title: null, gridColor: '#e2e4ea', tickCount: 5 }
      },
      color: {
        field: 'serie',
        scale: { domain: ['Atual', 'Anterior'], range: ['#3b82f6', '#d1d5db'] },
        legend: null
      },
      tooltip: [
        { field: 'codigo', title: 'Ativo' },
        { field: 'serie',  title: 'Série' },
        { field: 'valor',  title: 'Peso', format: '.2%' }
      ]
    },
    config: {
      view: { stroke: null },
      axis: { domainColor: '#e2e4ea' }
    }
  };

  if (window._czRxResizeHandler) {
    window.removeEventListener('resize', window._czRxResizeHandler);
    window._czRxResizeHandler = null;
  }

  vegaEmbed('#chart-wrap', spec, { actions: false, renderer: 'svg' })
    .then(({ view }) => {
      window._czRxResizeHandler = _debounce(() => {
        const w = (chartWrap.clientWidth || chartWrap.offsetWidth || 620) - 32;
        view.signal('width', w).run();
      }, 200);
      window.addEventListener('resize', window._czRxResizeHandler);
    })
    .catch(err => {
      document.getElementById('chart-wrap').innerHTML =
        `<div class="ui-error">Erro ao renderizar gráfico.<br><small>${err}</small></div>`;
    });
}

// ── Entradas e Saídas ─────────────────────────────────────────────────────────

function renderEntradasSaidas(posicoes) {
  const novas  = posicoes.filter(p => p.novo).sort((a, b) => b.tamanho - a.tamanho);
  const saidas = posicoes.filter(p => p.saiu).sort((a, b) =>
    (b.tamanho_anterior || 0) - (a.tamanho_anterior || 0));

  if (novas.length === 0 && saidas.length === 0) {
    document.getElementById('entradas-saidas').innerHTML = '';
    return;
  }

  const renderCol = (itens, tipo) => {
    const classe = tipo === 'entrada' ? 'pos' : 'neg';
    const valFn  = tipo === 'entrada'
      ? p => czFmtPct(p.tamanho)
      : p => czFmtPct(p.tamanho_anterior);

    if (itens.length === 0)
      return `<div class="ui-empty" style="padding:10px 0;font-size:.83em">Nenhuma ${tipo} neste mês.</div>`;

    return itens.map(p => `
      <div class="es-item">
        <span class="es-codigo">${p.codigo}</span>
        <span class="${classe}">${valFn(p)}</span>
      </div>`).join('');
  };

  document.getElementById('entradas-saidas').innerHTML = `
    <div class="es-grid">
      <div class="es-col">
        <div class="section-title">▲ Entradas (${novas.length})</div>
        <div class="es-lista">${renderCol(novas, 'entrada')}</div>
      </div>
      <div class="es-col">
        <div class="section-title">▼ Saídas (${saidas.length})</div>
        <div class="es-lista">${renderCol(saidas, 'saida')}</div>
      </div>
    </div>`;
}

// ── Variações notáveis ────────────────────────────────────────────────────────

function renderDestaques(posicoes) {
  const dest = posicoes
    .filter(p => p.variacao != null && Math.abs(p.variacao) >= RX_LIMIAR && !p.novo && !p.saiu && p.tamanho > 0)
    .sort((a, b) => Math.abs(b.variacao) - Math.abs(a.variacao));

  const el = document.getElementById('destaques');

  if (dest.length === 0) {
    el.innerHTML = `<div class="section-title">Variações notáveis (|Δ| ≥ ${RX_LIMIAR * 100}p.p.)</div>
      <div class="ui-empty" style="padding:8px 0;font-size:.83em">Nenhuma variação acima do limiar.</div>`;
    return;
  }

  const rows = dest.map(p => `
    <tr>
      <td class="mono">${p.codigo}</td>
      <td class="num">${czFmtPct(p.tamanho)}</td>
      <td class="num">${czFmtPct(p.tamanho_anterior)}</td>
      <td class="num ${p.variacao > 0 ? 'pos' : 'neg'}">${czFmtDiff(p.variacao)}</td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="section-title">Variações notáveis (|Δ| ≥ ${RX_LIMIAR * 100}p.p.) — ${dest.length} ativo(s)</div>
    <div class="cz-table-wrap">
      <table class="cz-table">
        <thead><tr><th>Ativo</th><th class="num">Atual</th><th class="num">Anterior</th><th class="num">Variação</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Tabela completa ───────────────────────────────────────────────────────────

function renderTabelaCompleta(posicoes) {
  // Mostra ativas + saídas (tamanho=0 mas tamanho_anterior>0)
  const lista = [...posicoes]
    .filter(p => p.tamanho > 0 || p.saiu)
    .sort((a, b) => (b.tamanho || 0) - (a.tamanho || 0));

  const rows = lista.map(p => {
    const badge    = p.novo  ? '<span class="badge-novo">NOVA</span> '
                   : p.saiu ? '<span class="badge-saiu">SAIU</span> '
                   : '';
    const varClass = p.variacao == null ? ''
                   : p.variacao > 0 ? 'pos'
                   : p.variacao < 0 ? 'neg'
                   : '';
    return `
      <tr>
        <td class="mono">${badge}${p.codigo}</td>
        <td class="num">${czFmtPct(p.tamanho)}</td>
        <td class="num">${p.tamanho_anterior != null ? czFmtPct(p.tamanho_anterior) : '—'}</td>
        <td class="num ${varClass}">${czFmtDiff(p.variacao)}</td>
      </tr>`;
  }).join('');

  document.getElementById('tabela-posicoes').innerHTML = `
    <div class="section-title">Todas as posições (${lista.length})</div>
    <div class="cz-table-wrap">
      <table class="cz-table">
        <thead>
          <tr>
            <th>Ativo</th>
            <th class="num">Atual</th>
            <th class="num">Anterior</th>
            <th class="num">Variação</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
