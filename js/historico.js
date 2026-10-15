/*
  Arquivo: js/historico.js
  Versão: 1.1.0
  Sessão: 6 — Orçamento e histórico
  Data: 15/10/2026
  1.1.0: Duplicar também copia o prazo da obra (prazoDias, prazoUteis).
  Tela do histórico (#historico): todos os orçamentos do pintor, do mais novo
  para o mais velho (atualizadoEm), com busca por cliente ou número e filtro
  por status. Tocar abre o orçamento (ir('orcamento', { id })). O botão ⋯ abre
  as ações: Abrir, Duplicar, Mudar status e Excluir (com confirmação).

  Contrato: montar(container, ctx) e desmontar() (cancela o onSnapshot).
  Lê users/{uid}/orcamentos inteira, ao vivo, e ordena no aparelho (funciona
  offline e não some orçamento sem atualizadoEm). Gravação sem esperar o
  servidor (contrato, seção 5).
  Duplicar: orçamento novo (número novo, rascunho, sem concluido/contadoNoUso),
  +1 em resumos/{uid}.totalOrcamentos. Excluir não mexe nos resumos.
  Ao abrir com internet, acerta os números provisórios (feitos offline).
*/

import { db, fs } from './firebase.js';
import { esc, moeda, num, dataBR, paraData, traduzErro } from './utils.js';
import { normalizarBusca, soDigitos } from './clientes.js';
import { STATUS, criarOrcamentoDoc, acertarPendentes } from './orcamento.js';

const FILTROS = [['todos', 'Todos'], ...Object.entries(STATUS).map(([k, v]) => [k, v.txt])];
const MAX_LISTA = 150;

let S = null;

export function montar(el, ctx) {
  S = { el, ctx, lista: [], ok: false, erro: null, busca: '', filtro: 'todos', unsub: null, folha: null, acertou: false };
  el.classList.add('orc-hist-tela');
  el.innerHTML =
    '<div class="orc-hist-cab"><h1>Orçamentos</h1><span class="muted js-total"></span></div>' +
    '<div class="orc-busca"><span class="orc-lupa" aria-hidden="true">🔎</span>' +
      '<input type="search" class="js-busca" placeholder="Buscar por cliente ou número" aria-label="Buscar orçamento por cliente ou número" autocomplete="off" enterkeyhint="search"></div>' +
    '<div class="qk orc-filtros js-filtros" role="group" aria-label="Filtrar por situação"></div>' +
    '<button type="button" class="big primary" data-act="novo">➕ Novo orçamento</button>' +
    '<div class="js-lista"><p class="muted">Carregando…</p></div>';

  el.addEventListener('click', aoClicar);
  el.addEventListener('input', aoDigitar);
  document.addEventListener('keydown', aoTecla);
  window.addEventListener('online', acertarProvisorios);
  desenharFiltros();
  assinar();
}

export function desmontar() {
  if (!S) return;
  try { S.unsub?.(); } catch (e) { /* ignora */ }
  fecharFolha();
  S.el.removeEventListener('click', aoClicar);
  S.el.removeEventListener('input', aoDigitar);
  document.removeEventListener('keydown', aoTecla);
  window.removeEventListener('online', acertarProvisorios);
  S = null;
}

/* ============================================================
   Dados
   ============================================================ */
const col = () => fs.collection(db, 'users', S.ctx.estado.uid, 'orcamentos');
const quando = o => paraData(o.atualizadoEm)?.getTime() || paraData(o.criadoEm)?.getTime() || 0;

function assinar() {
  if (!S.ctx.estado.uid) return;
  S.unsub = fs.onSnapshot(col(), snap => {
    if (!S) return;
    S.lista = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }))
      .sort((a, b) => quando(b) - quando(a));
    S.ok = true;
    S.erro = null;
    desenharFiltros();
    desenharLista();
    if (!snap.metadata.fromCache && !S.acertou) { S.acertou = true; acertarProvisorios(); }
  }, e => {
    console.error('[Print] histórico', e);
    if (!S) return;
    S.erro = e;
    S.ok = true;
    desenharLista();
  });
}

function acertarProvisorios() {
  if (!S || !navigator.onLine) return;
  const pend = S.lista.filter(o => o.numeroProvisorio === true).map(o => ({ id: o.id, numero: o.numero }));
  if (pend.length) acertarPendentes(S.ctx, pend);
}

/* ============================================================
   Desenho
   ============================================================ */
function desenharFiltros() {
  const box = S.el.querySelector('.js-filtros');
  const conta = k => k === 'todos' ? S.lista.length : S.lista.filter(o => (STATUS[o.status] ? o.status : 'rascunho') === k).length;
  box.innerHTML = FILTROS.map(([k, t]) =>
    '<button type="button" class="' + (S.filtro === k ? 'on' : '') + '" data-act="filtro" data-v="' + k + '" aria-pressed="' + (S.filtro === k) + '">' +
    esc(t) + (S.ok ? ' <small>' + conta(k) + '</small>' : '') + '</button>').join('');
}

function filtrar() {
  let l = S.lista;
  if (S.filtro !== 'todos') l = l.filter(o => (STATUS[o.status] ? o.status : 'rascunho') === S.filtro);
  const termos = normalizarBusca(S.busca).replace(/n[º°o]\s*/g, '').split(' ').map(t => t.replace(/[^a-z0-9]/g, '')).filter(Boolean);
  if (!termos.length) return l;
  return l.filter(o => {
    const nome = normalizarBusca(o.clienteNome);
    const numero = String(o.numero ?? '');
    const fone = soDigitos(o.clienteWhats);
    return termos.every(t => nome.includes(t) || (/^\d+$/.test(t) && (numero === t || numero.startsWith(t) || (t.length >= 4 && fone.includes(t)))));
  });
}

function desenharLista() {
  if (!S) return;
  const box = S.el.querySelector('.js-lista');
  const tot = S.el.querySelector('.js-total');
  tot.textContent = S.lista.length ? S.lista.length + (S.lista.length === 1 ? ' orçamento' : ' orçamentos') : '';

  if (!S.ok) { box.innerHTML = '<p class="muted">Carregando…</p>'; return; }
  if (S.erro && !S.lista.length) {
    box.innerHTML = '<div class="card"><b>Não deu para abrir os orçamentos.</b><p class="muted">' + esc(traduzErro(S.erro)) + '</p></div>';
    return;
  }
  if (!S.lista.length) {
    box.innerHTML = '<div class="card"><b>Nenhum orçamento ainda.</b><p class="muted">Toque em <b>Novo orçamento</b>. Tudo que você montar fica guardado aqui.</p></div>';
    return;
  }
  const l = filtrar();
  if (!l.length) {
    box.innerHTML = '<p class="muted">Nenhum orçamento encontrado' + (S.busca.trim() ? ' com “' + esc(S.busca.trim()) + '”' : '') + '.</p>';
    return;
  }
  box.innerHTML = '<ul class="orc-h-lista">' + l.slice(0, MAX_LISTA).map(item).join('') + '</ul>' +
    (l.length > MAX_LISTA ? '<p class="muted pequeno">Mostrando ' + MAX_LISTA + ' de ' + l.length + '. Use a busca para achar os outros.</p>' : '');
}

function item(o) {
  const st = STATUS[o.status] ? o.status : 'rascunho';
  const numero = o.numero ? 'Nº ' + esc(o.numero) : 'Sem número';
  const data = dataBR(o.atualizadoEm || o.criadoEm);
  return '<li class="orc-h-item">' +
    '<button type="button" class="orc-h-abrir" data-act="abrir" data-id="' + esc(o.id) + '">' +
      '<span class="orc-h-txt"><b>' + (o.clienteNome ? esc(o.clienteNome) : '<span class="muted">Sem cliente</span>') + '</b>' +
      '<small>' + numero + (data ? ' · ' + esc(data) : '') + (o.concluido ? '' : ' · <em>em montagem</em>') + '</small></span>' +
      '<span class="orc-h-dir"><b>' + esc(moeda(o.total)) + '</b>' +
      '<span class="orc-st orc-st-' + st + '"><span aria-hidden="true">' + STATUS[st].ic + '</span> ' + STATUS[st].txt + '</span></span>' +
    '</button>' +
    '<button type="button" class="orc-h-mais" data-act="mais" data-id="' + esc(o.id) + '" aria-label="Opções do orçamento ' + numero + '">⋯</button>' +
  '</li>';
}

/* ============================================================
   Folha de ações (por cima de tudo; nunca usa alert/confirm)
   ============================================================ */
function abrirFolha(id, confirmarExclusao = false) {
  fecharFolha();
  const o = S.lista.find(x => x.id === id);
  if (!o) return;
  const st = STATUS[o.status] ? o.status : 'rascunho';
  const titulo = (o.clienteNome || 'Sem cliente') + (o.numero ? ' · Nº ' + o.numero : '');
  const ov = document.createElement('div');
  ov.className = 'ov orc-h-folha';
  ov.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="orc-h-tit">' +
    (confirmarExclusao
      ? '<h2 id="orc-h-tit" class="orc-h-tit">Excluir o orçamento de ' + esc(titulo) + '?</h2>' +
        '<p>Ele sai do histórico e não dá para desfazer.</p>' +
        '<button type="button" class="big orc-perigo" data-f="excluir-sim">🗑️ Excluir</button>' +
        '<button type="button" class="big" data-f="fechar">Cancelar</button>'
      : '<h2 id="orc-h-tit" class="orc-h-tit">' + esc(titulo) + '</h2>' +
        '<p class="muted">' + esc(moeda(o.total)) + '</p>' +
        '<button type="button" class="big primary" data-f="abrir">✏️ Abrir</button>' +
        '<button type="button" class="big" data-f="duplicar">📑 Duplicar</button>' +
        '<span class="rotulo">Mudar status</span>' +
        '<div class="qk orc-h-status">' + Object.entries(STATUS).map(([k, v]) =>
          '<button type="button" class="' + (k === st ? 'on' : '') + '" data-f="status" data-v="' + k + '" aria-pressed="' + (k === st) + '">' +
          '<span aria-hidden="true">' + v.ic + '</span> ' + v.txt + '</button>').join('') + '</div>' +
        '<button type="button" class="big orc-excluir" data-f="excluir">🗑️ Excluir</button>' +
        '<button type="button" class="big" data-f="fechar">Fechar</button>') +
  '</div>';
  ov.addEventListener('click', ev => {
    if (ev.target === ov) { fecharFolha(); return; }
    const b = ev.target.closest('[data-f]');
    if (!b || !S) return;
    switch (b.dataset.f) {
      case 'fechar': fecharFolha(); break;
      case 'abrir': fecharFolha(); S.ctx.ir('orcamento', { id }); break;
      case 'duplicar': fecharFolha(); duplicar(id); break;
      case 'status': fecharFolha(); mudarStatus(id, b.dataset.v); break;
      case 'excluir': abrirFolha(id, true); break;
      case 'excluir-sim': fecharFolha(); excluir(id); break;
    }
  });
  document.body.appendChild(ov);
  S.folha = ov;
  ov.querySelector(confirmarExclusao ? '[data-f="fechar"]' : '[data-f="abrir"]')?.focus();
}

function fecharFolha() {
  if (!S?.folha) return;
  S.folha.remove();
  S.folha = null;
}

/* ============================================================
   Ações
   ============================================================ */
function duplicar(id) {
  const { ctx } = S;
  const o = S.lista.find(x => x.id === id);
  if (!o) return;
  const copia = JSON.parse(JSON.stringify({
    clienteId: o.clienteId || '', clienteNome: o.clienteNome || '', clienteWhats: o.clienteWhats || '',
    areas: o.areas || {}, itens: Array.isArray(o.itens) ? o.itens : [],
    descontoPct: num(o.descontoPct), subtotal: num(o.subtotal), total: num(o.total),
    observacao: o.observacao || '', validadeDias: num(o.validadeDias) || 15, modeloPdf: o.modeloPdf || 'classico',
    prazoDias: num(o.prazoDias), prazoUteis: !!o.prazoUteis,
    etapa: o.clienteNome ? 'conferencia' : 'cliente', aba: o.aba === 'ext' ? 'ext' : 'int'
  }));
  try {
    const novo = criarOrcamentoDoc(ctx, copia);
    ctx.toast('Cópia criada: Nº ' + novo.numero + (navigator.onLine ? '' : ' (salva no aparelho)'), 'ok');
  } catch (e) { ctx.toast(traduzErro(e), 'erro'); }
}

function mudarStatus(id, status) {
  const { ctx } = S;
  if (!STATUS[status]) return;
  try {
    fs.updateDoc(fs.doc(col(), id), { status, atualizadoEm: fs.serverTimestamp() })
      .catch(e => { console.error('[Print] status', e); ctx.toast(traduzErro(e), 'erro'); });
  } catch (e) { ctx.toast(traduzErro(e), 'erro'); return; }
  ctx.toast('Status: ' + STATUS[status].txt, 'ok');
}

function excluir(id) {
  const { ctx } = S;
  try {
    fs.deleteDoc(fs.doc(col(), id)).catch(e => { console.error('[Print] excluir orçamento', e); ctx.toast(traduzErro(e), 'erro'); });
  } catch (e) { ctx.toast(traduzErro(e), 'erro'); return; }
  S.lista = S.lista.filter(o => o.id !== id);
  desenharFiltros();
  desenharLista();
  ctx.toast(navigator.onLine ? 'Orçamento excluído' : 'Excluído no aparelho, atualiza quando tiver internet', 'ok');
}

/* ============================================================
   Eventos
   ============================================================ */
function aoClicar(ev) {
  const b = ev.target.closest('[data-act]');
  if (!b || !S) return;
  switch (b.dataset.act) {
    case 'novo': S.ctx.ir('orcamento', { novo: true }); break;
    case 'abrir': S.ctx.ir('orcamento', { id: b.dataset.id }); break;
    case 'mais': abrirFolha(b.dataset.id); break;
    case 'filtro': S.filtro = b.dataset.v; desenharFiltros(); desenharLista(); break;
  }
}

function aoDigitar(ev) {
  if (!ev.target.classList.contains('js-busca')) return;
  S.busca = ev.target.value;
  desenharLista();
}

function aoTecla(ev) {
  if (ev.key === 'Escape' && S?.folha) fecharFolha();
}
