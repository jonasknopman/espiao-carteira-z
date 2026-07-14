// util.js — utilitários compartilhados entre todas as páginas do Espião CZ.
// Carregado via <script src="js/util.js"> antes dos scripts específicos de cada página.
// Todas as funções/constantes são expostas no escopo global (prefixo cz).

'use strict';

// ── Constantes ────────────────────────────────────────────────────────────────

const CZ_DATA = 'data';

// ── Cache de fetch ────────────────────────────────────────────────────────────

const _czCache = {};

async function czFetch(path) {
  if (_czCache[path]) return _czCache[path];
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Não foi possível carregar ${path} (HTTP ${r.status})`);
  const data = await r.json();
  _czCache[path] = data;
  return data;
}

async function czLoadIndex() {
  return czFetch(`${CZ_DATA}/index.json`);
}

async function czLoadRaioX(mesId) {
  return czFetch(`${CZ_DATA}/${mesId}/raio_x.json`);
}

async function czLoadOverlap(mesId) {
  return czFetch(`${CZ_DATA}/${mesId}/overlap.json`);
}

async function czLoadRanking() {
  return czFetch(`${CZ_DATA}/ranking.json`);
}

async function czLoadTurnover() {
  return czFetch(`${CZ_DATA}/turnover.json`);
}

async function czLoadNaics() {
  return czFetch(`${CZ_DATA}/naics.json`);
}

async function czLoadSetores(mesId) {
  return czFetch(`${CZ_DATA}/${mesId}/setores.json`);
}

async function czLoadFundo(nomeSafe) {
  return czFetch(`${CZ_DATA}/fundos/${nomeSafe}.json`);
}

// ── Parâmetros de URL ─────────────────────────────────────────────────────────

function czGetParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function czPushParams(obj) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  history.pushState(null, '', url);
}

// ── Formatação ────────────────────────────────────────────────────────────────

function czFmtPct(v, dec = 1) {
  if (v == null || isNaN(v)) return '—';
  return (v * 100).toFixed(dec) + '%';
}

function czFmtDiff(v, dec = 1) {
  if (v == null || isNaN(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return sign + (v * 100).toFixed(dec) + 'p.p.';
}

function czFmtNum(v) {
  if (v == null || isNaN(v)) return '—';
  return v.toLocaleString('pt-BR');
}

// Converte mes_id (YYYY-MM) para label curto (ex.: "Fev/2026")
function czMesLabel(mesId) {
  const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const [ano, mes] = mesId.split('-');
  return `${meses[parseInt(mes) - 1]}/${ano}`;
}

// Converte nome_curto para nome de arquivo (mesmo algoritmo do R: sanitizar_nome_curto).
// Validado contra os 39 fundos reais em 2026-06: todos os nomes atuais são ASCII puro,
// então o trecho de remoção de acentos não foi exercitado com dado real.
// Se um fundo novo entrar com nome acentuado (ex.: "PÁTRIA SÊNIOR"), confirme
// manualmente que o arquivo gerado pelo R bate com czNomeSafe() antes de confiar
// no carregamento em raio_x.html / fundos/.
function czNomeSafe(nomeCurto) {
  return nomeCurto
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // remove diacríticos
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// ── Navegação ─────────────────────────────────────────────────────────────────

const CZ_NAV_LINKS = [
  { id: 'raio_x',   label: 'Raio-X',   href: 'raio_x.html' },
  { id: 'ranking',  label: 'Ranking',   href: 'ranking.html' },
  { id: 'overlap',  label: 'Overlap',   href: 'overlap.html' },
  { id: 'turnover', label: 'Turnover',  href: 'turnover.html' },
  { id: 'setores',  label: 'Setores',   href: 'setores.html' },
  { id: 'ajuda',    label: 'Ajuda',     href: 'ajuda.html' },
];

function czRenderNav(active) {
  const links = CZ_NAV_LINKS.map(l =>
    `<a href="${l.href}" class="topnav-link${l.id === active ? ' active' : ''}">${l.label}</a>`
  ).join('');
  return `
    <nav class="topnav">
      <a class="topnav-brand" href="index.html">Espião <span>CZ</span></a>
      <div class="topnav-links">${links}</div>
    </nav>`;
}

// ── Seletor de mês ────────────────────────────────────────────────────────────

function czRenderMonthSelect(meses, selectedId) {
  // Mais recente primeiro no dropdown
  const opts = [...meses].reverse().map(m =>
    `<option value="${m.id}"${m.id === selectedId ? ' selected' : ''}>${m.label}</option>`
  ).join('');
  return `<select id="mes-select" class="mes-select" aria-label="Selecionar mês">${opts}</select>`;
}

// Resolve mes_id: usa URL param se válido, senão o mais recente
function czResolveMes(meses) {
  const param = czGetParam('mes');
  if (param && meses.find(m => m.id === param)) return param;
  return meses[meses.length - 1].id;
}

// ── Estados de UI ─────────────────────────────────────────────────────────────

function czShowLoading(containerId, msg = 'Carregando…') {
  const el = document.getElementById(containerId);
  if (el) el.innerHTML = `<div class="ui-loading">${msg}</div>`;
}

function czShowError(containerId, err) {
  const el = document.getElementById(containerId);
  if (el) el.innerHTML = `<div class="ui-error">Erro ao carregar dados.<br><small>${err}</small></div>`;
}
