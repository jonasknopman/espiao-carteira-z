'use strict';

const RX_TOP_N    = 20;
const RX_LIMIAR   = 0.04; // 4 p.p.

let _mesId, _fundoNome, _raioXData;
let _tabelaSortCol = 'tamanho';
let _tabelaSortDir = 'desc';
let _destSortCol   = 'variacao';
let _destSortDir   = 'desc';

// Histórico completo do fundo atualmente selecionado (para a evolução do ativo).
// Cacheado por fundo para não re-buscar ao trocar só o ativo selecionado.
let _fundoHistorico     = null;
let _fundoHistoricoNome = null;
let _ativoSelecionado   = null;

// Instância Vega ativa do gráfico de evolução — precisa de finalize() explícito
// antes de descartar/recriar (innerHTML sozinho deixa o runtime antigo órfão,
// causando corrupção visual no gráfico seguinte sobre o mesmo container).
let _evolChartView = null;

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
  _ativoSelecionado = null;
  if (_evolChartView) {
    _evolChartView.finalize();
    _evolChartView = null;
  }
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
    <div id="evolucao-ativo"></div>
    <div id="entradas-saidas"></div>
    <div id="destaques"></div>
    <div id="tabela-posicoes"></div>
  `;

  _tabelaSortCol = 'tamanho';
  _tabelaSortDir = 'desc';
  _destSortCol   = 'variacao';
  _destSortDir   = 'desc';
  renderStats(fundo);
  const posicoes = fundo.posicoes || [];
  renderChart(posicoes, fundo.data_ref, fundo.data_ref_anterior);
  renderEntradasSaidas(posicoes);
  renderDestaques(posicoes);
  renderTabelaCompleta(posicoes);

  // Carregado à parte, sem bloquear o resto do render (que já funciona com o mês atual).
  carregarEvolucaoAtivo(nomeCurto);
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

const RX_DEST_COLS = [
  { key: 'codigo',           label: 'Ativo',    num: false },
  { key: 'tamanho',          label: 'Atual',    num: true  },
  { key: 'tamanho_anterior', label: 'Anterior', num: true  },
  { key: 'variacao',         label: 'Variação', num: true  },
];

function _sortDestRows(rows, col, dir) {
  const factor = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (col === 'variacao') return factor * (Math.abs(b.variacao) - Math.abs(a.variacao));
    const va = a[col] ?? (dir === 'desc' ? -Infinity : Infinity);
    const vb = b[col] ?? (dir === 'desc' ? -Infinity : Infinity);
    if (typeof va === 'string') return factor * va.localeCompare(vb, 'pt-BR');
    return factor * (va - vb);
  });
}

function _renderDestBody(lista) {
  return _sortDestRows(lista, _destSortCol, _destSortDir).map(p => `
    <tr>
      <td class="mono">${p.codigo}</td>
      <td class="num">${czFmtPct(p.tamanho)}</td>
      <td class="num">${czFmtPct(p.tamanho_anterior)}</td>
      <td class="num ${p.variacao > 0 ? 'pos' : 'neg'}">${czFmtDiff(p.variacao)}</td>
    </tr>`).join('');
}

function renderDestaques(posicoes) {
  const dest = posicoes
    .filter(p => p.variacao != null && Math.abs(p.variacao) >= RX_LIMIAR && !p.novo && !p.saiu && p.tamanho > 0);

  const el = document.getElementById('destaques');

  if (dest.length === 0) {
    el.innerHTML = `<div class="section-title">Variações notáveis (|Δ| ≥ ${RX_LIMIAR * 100}p.p.)</div>
      <div class="ui-empty" style="padding:8px 0;font-size:.83em">Nenhuma variação acima do limiar.</div>`;
    return;
  }

  const theadHtml = RX_DEST_COLS.map(c => {
    const cls = [c.num ? 'num' : '', c.key === _destSortCol ? `sorted-${_destSortDir}` : '']
      .filter(Boolean).join(' ');
    return `<th data-col="${c.key}"${cls ? ` class="${cls}"` : ''}>${c.label}</th>`;
  }).join('');

  el.innerHTML = `
    <div class="section-title">Variações notáveis (|Δ| ≥ ${RX_LIMIAR * 100}p.p.) — ${dest.length} ativo(s)</div>
    <div class="cz-table-wrap">
      <table class="cz-table">
        <thead><tr id="rx-dest-thead">${theadHtml}</tr></thead>
        <tbody id="rx-dest-tbody">${_renderDestBody(dest)}</tbody>
      </table>
    </div>`;

  document.getElementById('rx-dest-thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    const col = th.dataset.col;
    _destSortDir = (_destSortCol === col && _destSortDir === 'desc') ? 'asc' : 'desc';
    _destSortCol = col;

    document.querySelectorAll('#rx-dest-thead th[data-col]').forEach(t => {
      t.classList.remove('sorted-asc', 'sorted-desc');
      if (t.dataset.col === _destSortCol) t.classList.add('sorted-' + _destSortDir);
    });
    document.getElementById('rx-dest-tbody').innerHTML = _renderDestBody(dest);
  });
}

// ── Tabela completa ───────────────────────────────────────────────────────────

const RX_TABELA_COLS = [
  { key: 'codigo',           label: 'Ativo',    num: false },
  { key: 'tamanho',          label: 'Atual',    num: true  },
  { key: 'tamanho_anterior', label: 'Anterior', num: true  },
  { key: 'variacao',         label: 'Variação', num: true  },
];

function _sortTabelaRows(rows, col, dir) {
  const factor = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = a[col] ?? (dir === 'desc' ? -Infinity : Infinity);
    const vb = b[col] ?? (dir === 'desc' ? -Infinity : Infinity);
    if (typeof va === 'string') return factor * va.localeCompare(vb, 'pt-BR');
    return factor * (va - vb);
  });
}

function _renderTabelaBody(lista) {
  return _sortTabelaRows(lista, _tabelaSortCol, _tabelaSortDir).map(p => {
    const badge    = p.novo  ? '<span class="badge-novo">NOVA</span> '
                   : p.saiu ? '<span class="badge-saiu">SAIU</span> '
                   : '';
    const varClass = p.variacao == null ? ''
                   : p.variacao > 0 ? 'pos'
                   : p.variacao < 0 ? 'neg'
                   : '';
    return `
      <tr data-codigo="${p.codigo}">
        <td class="mono">${badge}${p.codigo}</td>
        <td class="num">${czFmtPct(p.tamanho)}</td>
        <td class="num">${p.tamanho_anterior != null ? czFmtPct(p.tamanho_anterior) : '—'}</td>
        <td class="num ${varClass}">${czFmtDiff(p.variacao)}</td>
      </tr>`;
  }).join('');
}

function renderTabelaCompleta(posicoes) {
  const lista = [...posicoes].filter(p => p.tamanho > 0 || p.saiu);

  const theadHtml = RX_TABELA_COLS.map(c => {
    const cls = [c.num ? 'num' : '', c.key === _tabelaSortCol ? `sorted-${_tabelaSortDir}` : '']
      .filter(Boolean).join(' ');
    return `<th data-col="${c.key}"${cls ? ` class="${cls}"` : ''}>${c.label}</th>`;
  }).join('');

  document.getElementById('tabela-posicoes').innerHTML = `
    <div class="section-title">Todas as posições (${lista.length})</div>
    <div class="cz-table-wrap">
      <table class="cz-table">
        <thead><tr id="rx-tabela-thead">${theadHtml}</tr></thead>
        <tbody id="rx-tabela-tbody">${_renderTabelaBody(lista)}</tbody>
      </table>
    </div>`;

  document.getElementById('rx-tabela-thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    const col = th.dataset.col;
    _tabelaSortDir = (_tabelaSortCol === col && _tabelaSortDir === 'desc') ? 'asc' : 'desc';
    _tabelaSortCol = col;

    document.querySelectorAll('#rx-tabela-thead th[data-col]').forEach(t => {
      t.classList.remove('sorted-asc', 'sorted-desc');
      if (t.dataset.col === _tabelaSortCol) t.classList.add('sorted-' + _tabelaSortDir);
    });
    document.getElementById('rx-tabela-tbody').innerHTML = _renderTabelaBody(lista);
  });

  document.getElementById('rx-tabela-tbody').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-codigo]');
    if (!tr) return;
    selecionarAtivoEvolucao(tr.dataset.codigo);
  });
}

// ── Evolução do ativo ────────────────────────────────────────────────────────

// Carrega o histórico completo do fundo (todo o `historico`, não só o mês
// selecionado) para popular o seletor de ativo e desenhar a série temporal.
// Disparado à parte de renderFundo, sem bloquear o resto do render.
async function carregarEvolucaoAtivo(nomeCurto) {
  _renderEvolucaoShell(true);

  let fundoData;
  try {
    fundoData = await czLoadFundo(czNomeSafe(nomeCurto));
  } catch (err) {
    const el = document.getElementById('evolucao-ativo');
    if (el) el.innerHTML = `<div class="ui-error">Erro ao carregar histórico do ativo.<br><small>${err.message}</small></div>`;
    return;
  }

  // Corrida: usuário pode ter trocado de fundo antes do fetch terminar.
  if (nomeCurto !== _fundoNome) return;

  _fundoHistorico     = fundoData.historico || [];
  _fundoHistoricoNome = nomeCurto;

  _renderEvolucaoShell(false);

  if (_ativoSelecionado) {
    const input = document.getElementById('evol-ativo-input');
    if (input) input.value = _ativoSelecionado;
    renderEvolucaoChart(_ativoSelecionado);
  }
}

function _renderEvolucaoShell(loading) {
  const el = document.getElementById('evolucao-ativo');
  if (!el) return;

  if (loading) {
    el.innerHTML = `
      <div class="section-title">Evolução do ativo</div>
      <div class="ui-loading" style="padding:8px 0;font-size:.83em">Carregando histórico…</div>
    `;
    return;
  }

  // União de todos os códigos que já apareceram no fundo (inclui os que já saíram).
  const codigos = [...new Set(
    _fundoHistorico.flatMap(h => (h.posicoes || []).map(p => p.codigo))
  )].sort((a, b) => a.localeCompare(b, 'pt-BR'));

  el.innerHTML = `
    <div class="section-title">Evolução do ativo</div>
    <div class="evol-header">
      <input id="evol-ativo-input" list="evol-ativo-list" placeholder="Buscar ativo…" autocomplete="off">
      <datalist id="evol-ativo-list">${codigos.map(c => `<option value="${c}">`).join('')}</datalist>
    </div>
    <div id="evol-chart-wrap" class="chart-wrap">
      <div class="ui-empty">Selecione um ativo para ver a evolução.</div>
    </div>
  `;

  const input = document.getElementById('evol-ativo-input');
  if (_ativoSelecionado) input.value = _ativoSelecionado;

  // O navegador filtra as <option> do datalist pelo texto atual do input — com o
  // código já selecionado preenchido, só a própria opção passa no filtro. Limpamos
  // o texto pra o datalist voltar a oferecer a lista completa; se o usuário
  // desistir sem escolher nada novo, repomos o valor anterior no blur.
  //
  // Ordem real dos eventos do navegador: mousedown → focus → mouseup → click.
  // O popup do datalist é montado no mousedown/focus, ANTES do click — limpar só
  // no 'click' (tentativa anterior) deixava o popup já desenhado com o valor
  // antigo. Limpamos no 'mousedown' (mantendo 'focus' para navegação via
  // Tab/teclado, que não passa por mousedown). Combinado com o blur() forçado no
  // 'change' abaixo, todo clique subsequente do usuário é sempre um ciclo
  // mousedown→focus genuíno (nunca um clique num campo que já estava focado).
  let mudouDesdeFoco = false;
  const limparParaSugestoes = () => {
    mudouDesdeFoco = false;
    input.value = '';
  };
  input.addEventListener('mousedown', limparParaSugestoes);
  input.addEventListener('focus', limparParaSugestoes);
  input.addEventListener('blur', () => {
    if (!mudouDesdeFoco && input.value.trim() === '' && _ativoSelecionado) {
      input.value = _ativoSelecionado;
    }
  });
  input.addEventListener('change', e => {
    mudouDesdeFoco = true;
    const codigo = e.target.value.trim().toUpperCase();
    if (codigo && codigos.includes(codigo)) selecionarAtivoEvolucao(codigo);
    e.target.blur();
  });
}

// Chamado tanto pelo seletor quanto pelo clique numa linha da tabela completa.
function selecionarAtivoEvolucao(codigo) {
  _ativoSelecionado = codigo;

  const input = document.getElementById('evol-ativo-input');
  if (input) {
    input.value = codigo;
    // Garante que toda seleção termina com o campo sem foco: chamado pelo clique
    // na tabela (nunca focado, é um no-op) ou pelo 'change' do próprio input
    // (já dá blur lá, mas reforçamos aqui por ser o ponto único de seleção).
    input.blur();
  }

  // Histórico do fundo atual ainda carregando: aplicado quando o fetch terminar
  // (ver carregarEvolucaoAtivo).
  if (_fundoHistoricoNome !== _fundoNome) return;

  renderEvolucaoChart(codigo);

  const container = document.getElementById('evolucao-ativo');
  if (container) container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderEvolucaoChart(codigo) {
  const wrap = document.getElementById('evol-chart-wrap');
  if (!wrap) return;

  // A instância anterior precisa ser finalizada explicitamente antes de descartar
  // o DOM: innerHTML remove os elementos, mas o runtime do Vega (listeners,
  // signals) continua vivo se não for finalizado.
  if (_evolChartView) {
    _evolChartView.finalize();
    _evolChartView = null;
  }

  const historico = [...(_fundoHistorico || [])].sort((a, b) => a.mes_id.localeCompare(b.mes_id));

  // Filtra (não interpola) os meses em que o ativo está ausente/zerado — evita
  // sugerir visualmente uma posição residual que não existe.
  const longData = [];
  for (const h of historico) {
    const pos = (h.posicoes || []).find(p => p.codigo === codigo);
    if (!pos || !(pos.tamanho > 0)) continue;
    longData.push({
      mes_id:    h.mes_id,
      mes_label: czMesLabel(h.mes_id),
      data_ref:  h.data_ref,
      tamanho:   pos.tamanho
    });
  }

  // vegaEmbed acrescenta a classe "vega-embed" (display: inline-block, ver seu
  // próprio stylesheet) diretamente no elemento alvo — não num wrapper interno.
  // Como #evol-chart-wrap é reaproveitado entre trocas de ativo (só o innerHTML
  // é limpo, o nó nunca é recriado), essa classe fica órfã de uma renderização
  // pra outra: com o conteúdo vazio e display:inline-block, o container encolhe
  // para caber no conteúdo (largura ~0) antes do próximo embed, fazendo o
  // próximo gráfico calcular uma largura inválida (negativa) e colapsar todos
  // os pontos no eixo X. Resetar classe/estilo devolve o comportamento de bloco
  // normal (100% do container pai) antes de medir a largura de novo.
  wrap.className = 'chart-wrap';
  wrap.removeAttribute('style');

  if (longData.length === 0) {
    wrap.innerHTML = `<div class="ui-empty">Sem histórico de posição para ${codigo}.</div>`;
    return;
  }

  wrap.innerHTML = '';
  const chartWidth = (wrap.clientWidth || wrap.offsetWidth || 620) - 32;

  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: chartWidth,
    height: 240,
    data: { values: longData },
    mark: { type: 'line', point: true, color: '#3b82f6' },
    encoding: {
      x: {
        field: 'mes_label', type: 'ordinal',
        sort: longData.map(d => d.mes_label),
        axis: { title: null, labelAngle: -40, labelFontSize: 11 }
      },
      y: {
        field: 'tamanho', type: 'quantitative',
        scale: { domainMin: 0 },
        axis: { format: '.0%', title: null, gridColor: '#e2e4ea', tickCount: 5 }
      },
      tooltip: [
        { field: 'mes_label', title: 'Mês' },
        { field: 'data_ref',  title: 'Data ref.' },
        { field: 'tamanho',   title: 'Peso', format: '.2%' }
      ]
    },
    config: {
      view: { stroke: null },
      axis: { domainColor: '#e2e4ea' }
    }
  };

  if (window._czRxEvolResizeHandler) {
    window.removeEventListener('resize', window._czRxEvolResizeHandler);
    window._czRxEvolResizeHandler = null;
  }

  vegaEmbed('#evol-chart-wrap', spec, { actions: false, renderer: 'svg' })
    .then(({ view }) => {
      _evolChartView = view;
      window._czRxEvolResizeHandler = _debounce(() => {
        const w = (wrap.clientWidth || wrap.offsetWidth || 620) - 32;
        view.signal('width', w).run();
      }, 200);
      window.addEventListener('resize', window._czRxEvolResizeHandler);
    })
    .catch(err => {
      wrap.innerHTML = `<div class="ui-error">Erro ao renderizar gráfico.<br><small>${err}</small></div>`;
    });
}

// ── Start ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
