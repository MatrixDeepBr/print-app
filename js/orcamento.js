/*
  Arquivo: js/orcamento.js
  Versão: 1.0.0
  Sessão: 6 — Orçamento e histórico
  Data: 15/10/2026
  Tela do orçamento (#orcamento), igual ao protótipo aprovado:
    Cliente → Áreas → Serviços → Conferência → Resumo (Concluir e Gerar PDF)

  Contrato: montar(container, ctx) e desmontar().
  Params: { id } abre um orçamento salvo · { clienteId } novo já com o cliente ·
          sem params = orçamento novo. Se a página for recarregada no meio de um
          orçamento, ele reabre sozinho (sessionStorage "print.orcAberto").

  Banco (contrato S4/S5/S6, seção 4):
    users/{uid}/orcamentos/{id}  campos do contrato + extras: numeroProvisorio,
                                 etapa e aba (para reabrir no ponto certo) e, em
                                 cada item, pm2, orig, origem e salvo (estrela).
    users/{uid}/servicos/{id}    Meu padrão: nome, preco, un, area, criadoEm
    users/{uid}/clientes/{id}    Cadastrar rápido (mesmos campos da S5)
    users/{uid}.contadorOrcamento  só por transação (acertarNumero)
    resumos/{uid}                totalOrcamentos, ultimoOrcamentoEm, totalClientes,
                                 orcamentosMes, valorOrcadoMes, mesRef

  Número do orçamento: nasce PROVISÓRIO (último número conhecido + 1) e a
  transação acerta o número definitivo assim que o servidor recebe o orçamento
  (na hora, se tiver internet; senão quando o sinal voltar ou na próxima
  abertura do Orçamento ou do Histórico).

  Exporta também (usado pelo historico.js): STATUS, criarOrcamentoDoc,
  acertarNumero, acertarPendentes.

  Funções auxiliares que podem ir para o utils.js na Sessão 10:
    txtN (número -> "2,5" para campo), corDoNome (faixa colorida), lerUmaVez
*/

import { db, fs } from './firebase.js';
import { registrarOrcamento } from './uso.js';
import { esc, moeda, num, dataBR, hojeISO, traduzErro } from './utils.js';
import { normalizarBusca, soDigitos, foneBR } from './clientes.js';

/* ============================================================
   Constantes
   ============================================================ */
const AR = {
  int: { n: 'Serviço interno', ic: '🏠', d: 'Paredes, tetos, portas e janelas por dentro', s: 'Interno' },
  ext: { n: 'Serviço externo', ic: '🏢', d: 'Fachada, muro, portão e área externa', s: 'Externo' }
};

/** Modelos prontos (os mesmos do protótipo). */
const MODELOS = [
  { id: 'p1', nome: 'Pintura interna, 2 demãos', preco: 25, un: 'm²', area: 'int' },
  { id: 'p3', nome: 'Textura de parede', preco: 35, un: 'm²', area: 'int' },
  { id: 'p4', nome: 'Massa corrida e lixa', preco: 18, un: 'm²', area: 'int' },
  { id: 'p2', nome: 'Pintura de fachada', preco: 30, un: 'm²', area: 'ext' },
  { id: 'p6', nome: 'Textura de fachada', preco: 38, un: 'm²', area: 'ext' },
  { id: 'p5', nome: 'Portão com esmalte', preco: 35, un: 'm²', area: 'ext' }
];

const UNIDADES = ['m²', 'metro', 'unidade'];
const ETAPAS = ['cliente', 'areas', 'servicos', 'conferencia', 'resumo'];
const MODELOS_PDF = [['classico', 'Clássico'], ['moderno', 'Moderno'], ['premium', 'Premium']];
const CHAVE_ABERTO = 'print.orcAberto';

export const STATUS = {
  rascunho: { txt: 'Rascunho', ic: '✏️' },
  enviado:  { txt: 'Enviado',  ic: '📤' },
  aprovado: { txt: 'Aprovado', ic: '✅' },
  recusado: { txt: 'Recusado', ic: '✖️' }
};

let S = null;
let ultimoNumero = 0;          // maior número já usado neste aparelho
const emAcerto = new Set();    // ids com transação de número rodando

/* ============================================================
   Auxiliares
   ============================================================ */
const r2 = n => Math.round(n * 100) / 100;
/** 2.5 -> "2,5" (para mostrar dentro do campo). 0 -> "". */
const txtN = n => { n = num(n); return n ? String(r2(n)).replace('.', ',') : ''; };
/** Cor fixa da faixa de cada serviço (igual ao protótipo). */
const corDoNome = n => { let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) % 360; return 'hsl(' + h + ' 62% 52%)'; };
const modeloOk = m => MODELOS_PDF.some(x => x[0] === m) ? m : 'classico';

function lerSessao(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
function gravarSessao(k, v) { try { if (v) sessionStorage.setItem(k, v); else sessionStorage.removeItem(k); } catch (e) { /* sem armazenamento */ } }

/** Primeira resposta de um documento (vem do aparelho na hora, mesmo offline). */
function lerUmaVez(ref) {
  return new Promise(ok => {
    let feito = false, un = null;
    const fim = v => {
      if (feito) return;
      feito = true;
      setTimeout(() => { try { un?.(); } catch (e) { /* ignora */ } }, 0);
      ok(v);
    };
    try { un = fs.onSnapshot(ref, s => fim(s), e => { console.warn('[Print] ler', e); fim(null); }); }
    catch (e) { fim(null); }
    setTimeout(() => fim(null), 8000);
  });
}

/* ---------- Contas (sobre o orçamento em edição) ---------- */
const sel = o => ['int', 'ext'].filter(a => o.areas[a].ativo);
const lt = it => it.cobr === 'fechado' ? num(it.preco) : num(it.qtd) * num(it.preco);
const at = (o, a) => o.areas[a].modo === 'fechado'
  ? num(o.areas[a].valorFechado)
  : o.itens.filter(i => i.area === a).reduce((s, i) => s + lt(i), 0);
const subt = o => sel(o).reduce((s, a) => s + at(o, a), 0);
const desc = o => Math.min(100, Math.max(0, num(o.descontoPct)));
const totl = o => subt(o) * (1 - desc(o) / 100);
/** Mostra a estrela "Salvar como meu padrão"? (regra do protótipo) */
const pode = it => !it.salvo && it.cobr === 'm2' && num(it.preco) > 0 && (it.origem === 'modelo' || num(it.preco) !== num(it.orig));

/* ============================================================
   Orçamento: vazio, do banco e para o banco
   ============================================================ */
function areaVazia() { return { ativo: false, modo: 'fechado', valorFechado: '', inclui: '' }; }

function vazio(perfil = {}) {
  return {
    id: null, numero: null, numeroProvisorio: false,
    clienteId: '', clienteNome: '', clienteWhats: '',
    areas: { int: areaVazia(), ext: areaVazia() },
    itens: [], descontoPct: '', observacao: '',
    validadeDias: String(num(perfil.validadeDias) || 15),
    modeloPdf: modeloOk(perfil.modeloPdf),
    status: 'rascunho', concluido: false, contadoNoUso: false,
    etapa: 'cliente', aba: 'int', criadoEm: null
  };
}

function deDoc(id, d) {
  const o = vazio();
  const areas = d.areas || {};
  for (const a of ['int', 'ext']) {
    const x = areas[a] || {};
    o.areas[a] = { ativo: !!x.ativo, modo: x.modo === 'itens' ? 'itens' : 'fechado', valorFechado: txtN(x.valorFechado), inclui: String(x.inclui || '') };
  }
  Object.assign(o, {
    id,
    numero: d.numero ?? null,
    numeroProvisorio: d.numeroProvisorio === true,
    clienteId: d.clienteId || '', clienteNome: d.clienteNome || '', clienteWhats: d.clienteWhats || '',
    itens: (Array.isArray(d.itens) ? d.itens : []).map(it => ({
      nome: String(it.nome || 'Serviço'), area: it.area === 'ext' ? 'ext' : 'int',
      cobr: it.cobr === 'fechado' ? 'fechado' : 'm2', qtd: txtN(it.qtd), un: it.un || 'm²',
      preco: txtN(it.preco), pm2: txtN(it.pm2 ?? it.preco), orig: num(it.orig ?? it.preco),
      origem: it.origem || 'modelo', salvo: !!it.salvo
    })),
    descontoPct: txtN(d.descontoPct),
    observacao: String(d.observacao || ''),
    validadeDias: String(num(d.validadeDias) || 15),
    modeloPdf: modeloOk(d.modeloPdf),
    status: STATUS[d.status] ? d.status : 'rascunho',
    concluido: !!d.concluido, contadoNoUso: !!d.contadoNoUso,
    criadoEm: d.criadoEm || null
  });
  o.etapa = ETAPAS.includes(d.etapa) ? d.etapa : (o.clienteNome ? 'conferencia' : 'cliente');
  if (o.etapa !== 'cliente' && !o.clienteNome) o.etapa = 'cliente';
  o.aba = d.aba === 'ext' ? 'ext' : 'int';
  return o;
}

/** Conteúdo do orçamento em números limpos (sem campos de controle). */
function paraDados(o) {
  const areas = {};
  for (const a of ['int', 'ext']) {
    const x = o.areas[a];
    areas[a] = { ativo: !!x.ativo, modo: x.modo === 'itens' ? 'itens' : 'fechado', valorFechado: r2(num(x.valorFechado)), inclui: String(x.inclui || '').trim() };
  }
  return {
    clienteId: o.clienteId || '', clienteNome: o.clienteNome || '', clienteWhats: o.clienteWhats || '',
    areas,
    itens: o.itens.map(it => ({
      nome: it.nome, area: it.area, cobr: it.cobr === 'fechado' ? 'fechado' : 'm2',
      qtd: num(it.qtd), un: it.un || 'm²', preco: r2(num(it.preco)),
      pm2: r2(num(it.pm2)), orig: num(it.orig), origem: it.origem || '', salvo: !!it.salvo
    })),
    descontoPct: desc(o),
    subtotal: r2(subt(o)),
    total: r2(totl(o)),
    observacao: String(o.observacao || '').trim(),
    validadeDias: Math.max(1, Math.round(num(o.validadeDias))) || 15,
    modeloPdf: modeloOk(o.modeloPdf),
    etapa: o.etapa, aba: o.aba
  };
}

/* ============================================================
   Número, criação e resumos (também usados pelo Histórico)
   ============================================================ */
function proximoProvisorio(estado) {
  ultimoNumero = Math.max(ultimoNumero, num(estado.usuario?.contadorOrcamento)) + 1;
  return ultimoNumero;
}

/** resumos/{uid}: +1 orçamento criado. */
function contarCriacao(uid) {
  try {
    fs.setDoc(fs.doc(db, 'resumos', uid),
      { totalOrcamentos: fs.increment(1), ultimoOrcamentoEm: fs.serverTimestamp() }, { merge: true })
      .catch(e => console.warn('[Print] resumo de orçamentos', e));
  } catch (e) { console.warn('[Print] resumo de orçamentos', e); }
}

/** resumos/{uid}: números do mês (zera se o mês virou). Chamado ao concluir. */
async function contarMes(uid, total) {
  const ref = fs.doc(db, 'resumos', uid);
  const mes = hojeISO().slice(0, 7);
  let atual = null; // null = não deu para saber
  try {
    const s = await Promise.race([fs.getDoc(ref), new Promise((_, nao) => setTimeout(() => nao(new Error('tempo')), 3000))]);
    atual = s.exists() ? String(s.data().mesRef || '') : '';
  } catch (e) { atual = null; }
  const dados = (atual === mes || atual === null)
    ? { orcamentosMes: fs.increment(1), valorOrcadoMes: fs.increment(total) }
    : { mesRef: mes, orcamentosMes: 1, valorOrcadoMes: total };
  try {
    fs.setDoc(ref, dados, { merge: true }).catch(e => console.warn('[Print] resumo do mês', e));
  } catch (e) { console.warn('[Print] resumo do mês', e); }
}

/**
 * Troca o número provisório pelo definitivo (transação). Só faz algo se o
 * orçamento já estiver no servidor e ainda for provisório: pode ser chamada
 * quantas vezes quiser. Devolve o número novo ou null.
 */
export function acertarNumero(ctx, id, aoAcertar) {
  const uid = ctx.estado.uid;
  if (!uid || !id || !navigator.onLine || emAcerto.has(id)) return Promise.resolve(null);
  emAcerto.add(id);
  const uRef = fs.doc(db, 'users', uid);
  const oRef = fs.doc(db, 'users', uid, 'orcamentos', id);
  return fs.runTransaction(db, async t => {
    const u = await t.get(uRef);
    const o = await t.get(oRef);
    if (!o.exists() || o.data().numeroProvisorio !== true) return null;
    const n = num(u.data()?.contadorOrcamento) + 1;
    t.update(uRef, { contadorOrcamento: n });
    t.update(oRef, { numero: n, numeroProvisorio: false });
    return n;
  }).then(n => {
    if (n) {
      if (ctx.estado.usuario) ctx.estado.usuario.contadorOrcamento = n;
      ultimoNumero = Math.max(ultimoNumero, n);
      try { aoAcertar?.(id, n); } catch (e) { /* ignora */ }
    }
    return n;
  }).catch(e => { console.warn('[Print] número do orçamento', e); return null; })
    .finally(() => emAcerto.delete(id));
}

/** Acerta, em ordem, vários orçamentos provisórios ({ id, numero }). */
export async function acertarPendentes(ctx, lista, aoAcertar) {
  const ordem = [...lista].sort((a, b) => num(a.numero) - num(b.numero));
  for (const o of ordem) {
    if (!navigator.onLine) break;
    await acertarNumero(ctx, o.id, aoAcertar);
  }
}

/**
 * Cria um orçamento novo (rascunho) com número provisório e já pede o
 * definitivo. Não espera o servidor. Devolve { id, numero }.
 */
export function criarOrcamentoDoc(ctx, dados, aoAcertar) {
  const uid = ctx.estado.uid;
  const ref = fs.doc(fs.collection(db, 'users', uid, 'orcamentos'));
  const numero = proximoProvisorio(ctx.estado);
  const agora = fs.serverTimestamp();
  try {
    fs.setDoc(ref, {
      ...dados, numero, numeroProvisorio: true, status: 'rascunho',
      concluido: false, contadoNoUso: false, criadoEm: agora, atualizadoEm: agora
    })
      .then(() => acertarNumero(ctx, ref.id, aoAcertar))
      .catch(e => { console.error('[Print] criar orçamento', e); ctx.toast(traduzErro(e), 'erro'); });
  } catch (e) { console.error('[Print] criar orçamento', e); ctx.toast(traduzErro(e), 'erro'); }
  contarCriacao(uid);
  return { id: ref.id, numero };
}

/* ============================================================
   Montar / desmontar
   ============================================================ */
export async function montar(el, ctx) {
  const token = {};
  S = {
    el, ctx, token, o: null,
    clientes: [], clientesOk: false, meus: [],
    busca: '', rapido: null, criando: false, conf: null, nota: false,
    unsubs: [], timer: null, sujo: false, desfazer: null, veioDoHistorico: false
  };
  el.classList.add('orc-tela');
  el.innerHTML = '<p class="muted">Carregando…</p>';

  el.addEventListener('click', aoClicar);
  el.addEventListener('input', aoDigitar);
  el.addEventListener('keydown', aoEnter);
  document.addEventListener('keydown', aoTecla);
  document.addEventListener('visibilitychange', aoEsconder);
  window.addEventListener('pagehide', aoSair);
  window.addEventListener('online', aoVoltarInternet);

  const uid = ctx.estado.uid;
  if (!uid) { el.innerHTML = '<h1>Orçamento</h1><p class="muted">Entre na sua conta para orçar.</p>'; return; }
  assinarClientes();
  assinarServicos();

  const p = ctx.params || {};
  let id = p.id || null;
  if (!id && !p.clienteId && !p.novo) id = lerSessao(CHAVE_ABERTO); // recarregou a página no meio
  S.veioDoHistorico = !!p.id;

  if (id) {
    const snap = await lerUmaVez(fs.doc(db, 'users', uid, 'orcamentos', id));
    if (S?.token !== token) return;
    if (snap?.exists()) S.o = deDoc(id, snap.data({ serverTimestamps: 'estimate' }));
    else if (p.id) ctx.toast('Não achei esse orçamento. Começando um novo.', 'erro');
  }
  if (!S.o) {
    S.o = vazio(ctx.estado.perfil || {});
    if (p.clienteId) {
      const c = await lerUmaVez(fs.doc(db, 'users', uid, 'clientes', p.clienteId));
      if (S?.token !== token) return;
      if (c?.exists()) {
        usarCliente({ id: c.id, ...c.data() });
        criar();
        S.o.etapa = 'areas';
      }
    }
  }
  if (S.o.id) gravarSessao(CHAVE_ABERTO, S.o.id);
  render();
  if (S.o.etapa === 'cliente' && !S.o.clienteNome) focarBusca();
  aoVoltarInternet();
}

export function desmontar() {
  if (!S) return;
  gravarJa();
  S.unsubs.forEach(u => { try { u(); } catch (e) { /* ignora */ } });
  fecharDesfazer();
  const el = S.el;
  el.removeEventListener('click', aoClicar);
  el.removeEventListener('input', aoDigitar);
  el.removeEventListener('keydown', aoEnter);
  document.removeEventListener('keydown', aoTecla);
  document.removeEventListener('visibilitychange', aoEsconder);
  window.removeEventListener('pagehide', aoSair);
  window.removeEventListener('online', aoVoltarInternet);
  gravarSessao(CHAVE_ABERTO, null);
  S = null;
}

/* ---------- Dados ao vivo: clientes e Meus padrões ---------- */
function assinarClientes() {
  const uid = S.ctx.estado.uid;
  S.unsubs.push(fs.onSnapshot(fs.collection(db, 'users', uid, 'clientes'), snap => {
    if (!S) return;
    S.clientes = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));
    S.clientesOk = true;
    if (S.o?.etapa === 'cliente') desenharListaClientes();
  }, e => {
    console.error('[Print] clientes', e);
    if (!S) return;
    S.clientesOk = true;
    S.erroClientes = e;
    if (S.o?.etapa === 'cliente') desenharListaClientes();
  }));
}

function assinarServicos() {
  const uid = S.ctx.estado.uid;
  S.unsubs.push(fs.onSnapshot(fs.collection(db, 'users', uid, 'servicos'), snap => {
    if (!S) return;
    S.meus = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR', { sensitivity: 'base' }));
    // Redesenha a lista de serviços, mas nunca no meio de uma digitação.
    if (S.o?.etapa === 'servicos' && !S.criando && !S.conf && !S.nota) render();
  }, e => console.warn('[Print] meus padrões', e)));
}

/* ============================================================
   Gravação automática
   ============================================================ */
function mudou() {
  if (!S?.o?.id) return;
  S.sujo = true;
  clearTimeout(S.timer);
  S.timer = setTimeout(gravarJa, 800);
}

function gravarJa() {
  if (!S?.o?.id || !S.sujo) return;
  clearTimeout(S.timer);
  S.timer = null;
  S.sujo = false;
  const { ctx, o } = S;
  const ref = fs.doc(db, 'users', ctx.estado.uid, 'orcamentos', o.id);
  const dados = { ...paraDados(o), concluido: o.concluido, contadoNoUso: o.contadoNoUso, atualizadoEm: fs.serverTimestamp() };
  try {
    fs.setDoc(ref, dados, { merge: true }).catch(e => {
      console.error('[Print] salvar orçamento', e);
      ctx.toast(traduzErro(e), 'erro');
    });
  } catch (e) { console.error('[Print] salvar orçamento', e); ctx.toast(traduzErro(e), 'erro'); return; }
  avisarSalvo();
}

function avisarSalvo() {
  const el = S?.el.querySelector('.js-salvo');
  if (!el) return;
  const on = navigator.onLine;
  el.textContent = on ? 'Salvo ✓' : 'Salvo no aparelho';
  el.title = on ? 'Salvo' : 'Salvo no aparelho, envia quando tiver internet';
  el.classList.add('on');
  clearTimeout(avisarSalvo.t);
  avisarSalvo.t = setTimeout(() => el.classList.remove('on'), 2200);
}

function aoEsconder() { if (document.visibilityState === 'hidden') gravarJa(); }
function aoSair() { gravarJa(); }

/** Internet voltou (ou tela abriu): acerta números provisórios. */
function aoVoltarInternet() {
  if (!S || !navigator.onLine) return;
  const { ctx } = S;
  const col = fs.collection(db, 'users', ctx.estado.uid, 'orcamentos');
  fs.getDocs(fs.query(col, fs.where('numeroProvisorio', '==', true)))
    .then(snap => acertarPendentes(ctx, snap.docs.map(d => ({ id: d.id, numero: d.data().numero })), numeroAcertado))
    .catch(e => console.warn('[Print] números provisórios', e));
}

function numeroAcertado(id, n) {
  if (!S?.o || S.o.id !== id) return;
  S.o.numero = n;
  S.o.numeroProvisorio = false;
  const el = S.el.querySelector('.js-num');
  if (el) el.textContent = 'Nº ' + n;
  const p = S.el.querySelector('.js-pnum');
  if (p) p.textContent = 'Nº ' + n;
}

/** Cria o documento quando o cliente é escolhido (primeira vez). */
function criar() {
  const { ctx, o } = S;
  if (o.id) return;
  const { id, numero } = criarOrcamentoDoc(ctx, paraDados(o), numeroAcertado);
  o.id = id;
  o.numero = numero;
  o.numeroProvisorio = true;
  o.criadoEm = new Date();
  gravarSessao(CHAVE_ABERTO, id);
}

/* ============================================================
   Desenho
   ============================================================ */
function render() {
  if (!S?.o) return;
  const e = S.o.etapa;
  let h;
  if (e === 'cliente') h = telaCliente();
  else if (e === 'areas') h = telaAreas();
  else if (e === 'servicos') h = telaServicos();
  else if (e === 'conferencia') h = telaConferencia();
  else h = telaResumo();
  if (e !== 'cliente') h += botaoObs();
  if (S.nota) h += folhaObs();
  if (S.conf) h += folhaDeNovo();
  S.el.innerHTML = h;
  if (e === 'cliente') desenharListaClientes();
}

function cab() {
  const o = S.o;
  const i = ETAPAS.indexOf(o.etapa);
  return '<div class="top orc-top">' +
    '<button type="button" class="back" data-act="voltar" aria-label="Voltar">←</button>' +
    (o.numero ? '<span class="orc-num js-num">Nº ' + esc(o.numero) + '</span>' : '') +
    '<span class="orc-salvo js-salvo" role="status" aria-live="polite"></span>' +
    '<div class="dots" aria-hidden="true">' + [1, 2, 3, 4].map(k => '<i class="' + (k <= i ? 'on' : '') + '"></i>').join('') + '</div>' +
  '</div>';
}

const barra = (txt, act) => '<div class="bar"><button type="button" class="big primary" data-act="' + act + '">' + txt + '</button></div>';

function seg(lista, atual, act, extra = '') {
  return '<div class="seg' + (lista.length === 3 ? ' tres' : '') + '">' + lista.map(x =>
    '<button type="button" class="' + (x[0] === atual ? 'on' : '') + '" data-act="' + act + '" data-v="' + esc(x[0]) + '"' + extra +
    ' aria-pressed="' + (x[0] === atual) + '">' + x[1] + '</button>').join('') + '</div>';
}

/* ---------- 1. Cliente ---------- */
function telaCliente() {
  const o = S.o;
  let h = cab() + '<h1>Para quem é o orçamento?</h1>';
  if (o.clienteNome) {
    h += '<div class="card orc-cli-atual"><span class="muted pequeno">Cliente escolhido</span><b>' + esc(o.clienteNome) + '</b>' +
      (o.clienteWhats ? '<small class="muted">' + esc(foneBR(o.clienteWhats)) + '</small>' : '') + '</div>';
  }
  h += '<div class="orc-busca"><span class="orc-lupa" aria-hidden="true">🔎</span>' +
    '<input type="search" data-f="busca" class="js-busca-cli" placeholder="Buscar cliente por nome ou WhatsApp" ' +
    'aria-label="Buscar cliente por nome ou WhatsApp" autocomplete="off" enterkeyhint="search" value="' + esc(S.busca) + '"></div>';
  h += S.rapido ? formRapido() : '<button type="button" class="big orc-rapido-btn" data-act="rapido">➕ Cadastrar rápido</button>';
  h += '<div class="js-cli-lista"></div>';
  if (o.clienteNome) h += barra('Continuar', 'avancar');
  return h;
}

function formRapido() {
  const r = S.rapido;
  return '<div class="new orc-rapido">' +
    '<label for="orc-r-nome">Nome do cliente</label>' +
    '<input id="orc-r-nome" class="js-r-nome" type="text" autocomplete="off" autocapitalize="words" enterkeyhint="next" maxlength="120" value="' + esc(r.nome) + '" placeholder="Ex.: Casa do João">' +
    '<label for="orc-r-zap">WhatsApp (opcional)</label>' +
    '<input id="orc-r-zap" class="js-r-zap" type="tel" inputmode="tel" autocomplete="off" enterkeyhint="done" value="' + esc(foneBR(r.whatsapp)) + '" placeholder="(17) 99999-9999">' +
    '<button type="button" class="big primary orc-mt" data-act="salvarrapido">Salvar e continuar</button>' +
    '<button type="button" class="big" data-act="rapido">Cancelar</button>' +
  '</div>';
}

function filtrarClientes() {
  const termos = normalizarBusca(S.busca).split(' ').map(t => t.replace(/[^a-z0-9]/g, '')).filter(Boolean);
  const buscaDe = c => c.nomeBusca || normalizarBusca(c.nome);
  if (!termos.length) {
    // Sem busca: os mais recentes primeiro (quem acabou de cadastrar está no topo).
    const t = c => (c.atualizadoEm?.toMillis?.() ?? (c.atualizadoEm?.seconds ?? 0) * 1000) || 0;
    return [...S.clientes].sort((a, b) => t(b) - t(a));
  }
  const achados = S.clientes.filter(c => {
    const nome = buscaDe(c), fone = soDigitos(c.whatsapp);
    return termos.every(t => nome.includes(t) || (/^\d+$/.test(t) && fone.includes(t)));
  });
  const comeca = c => (' ' + buscaDe(c)).includes(' ' + termos[0]) ? 0 : 1;
  return achados.map((c, i) => [comeca(c), i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
}

function desenharListaClientes() {
  const box = S?.el.querySelector('.js-cli-lista');
  if (!box) return;
  if (!S.clientesOk) { box.innerHTML = '<p class="muted">Carregando clientes…</p>'; return; }
  if (!S.clientes.length) {
    box.innerHTML = S.erroClientes
      ? '<p class="muted">Não deu para abrir os clientes. Use o Cadastrar rápido.</p>'
      : '<p class="muted">Você ainda não tem clientes. Toque em <b>Cadastrar rápido</b>: só o nome já basta.</p>';
    return;
  }
  const lista = filtrarClientes();
  if (!lista.length) {
    box.innerHTML = '<p class="muted">Nenhum cliente com “' + esc(S.busca.trim()) + '”. Toque em <b>Cadastrar rápido</b>.</p>';
    return;
  }
  box.innerHTML = (S.busca.trim() ? '' : '<h2 class="orc-sub">Clientes recentes</h2>') +
    '<ul class="orc-cli-lista">' + lista.slice(0, 40).map(c =>
    '<li><button type="button" class="orc-cli-item' + (c.id === S.o.clienteId ? ' on' : '') + '" data-act="escolher" data-id="' + esc(c.id) + '">' +
      '<span class="orc-av" aria-hidden="true">' + esc((String(c.nome || '?').trim().charAt(0) || '?').toLocaleUpperCase('pt-BR')) + '</span>' +
      '<span class="orc-cli-txt"><b>' + esc(c.nome || 'Sem nome') + '</b>' + (c.whatsapp ? '<small>' + esc(foneBR(c.whatsapp)) + '</small>' : '') + '</span>' +
      '<span class="orc-seta" aria-hidden="true">›</span></button></li>').join('') + '</ul>' +
    (lista.length > 40 ? '<p class="muted pequeno">Mostrando 40 de ' + lista.length + '. Use a busca para achar os outros.</p>' : '');
}

function usarCliente(c) {
  const o = S.o;
  o.clienteId = c.id || '';
  o.clienteNome = String(c.nome || '').trim() || 'Cliente';
  o.clienteWhats = soDigitos(c.whatsapp);
}

function focarBusca() {
  // Só no computador: no celular o teclado subindo esconderia a lista.
  if (window.matchMedia('(min-width: 900px)').matches) S?.el.querySelector('.js-busca-cli')?.focus();
}

function salvarRapido() {
  const { ctx } = S;
  const nome = (S.el.querySelector('.js-r-nome')?.value || '').trim().replace(/\s+/g, ' ');
  const whatsapp = soDigitos(S.el.querySelector('.js-r-zap')?.value).slice(0, 13);
  if (!nome) { ctx.toast('Digite o nome do cliente.', 'erro'); S.el.querySelector('.js-r-nome')?.focus(); return; }
  const uid = ctx.estado.uid;
  const ref = fs.doc(fs.collection(db, 'users', uid, 'clientes'));
  const agora = fs.serverTimestamp();
  try {
    fs.setDoc(ref, { nome, nomeBusca: normalizarBusca(nome), whatsapp, endereco: '', obs: '', criadoEm: agora, atualizadoEm: agora })
      .catch(e => { console.error('[Print] cliente rápido', e); ctx.toast(traduzErro(e), 'erro'); });
    fs.setDoc(fs.doc(db, 'resumos', uid), { totalClientes: fs.increment(1) }, { merge: true })
      .catch(e => console.warn('[Print] resumo de clientes', e));
  } catch (e) { ctx.toast(traduzErro(e), 'erro'); return; }
  usarCliente({ id: ref.id, nome, whatsapp });
  S.rapido = null;
  S.busca = '';
  ctx.toast(navigator.onLine ? 'Cliente salvo ✓' : 'Cliente salvo no aparelho', 'ok');
  if (!S.o.id) criar(); else mudou();
  irEtapa('areas');
}

/* ---------- 2. Áreas ---------- */
function telaAreas() {
  const o = S.o;
  return cab() + '<h1>Qual serviço é esse?</h1><p class="muted">Marque um ou os dois. Cada um vira uma fase do orçamento.</p>' +
    ['int', 'ext'].map(a => '<button type="button" class="area' + (o.areas[a].ativo ? ' on' : '') + '" data-act="togarea" data-a="' + a + '" aria-pressed="' + o.areas[a].ativo + '">' +
      '<span class="orc-area-ic" aria-hidden="true">' + AR[a].ic + '</span><div><b>' + AR[a].n + '</b><span>' + AR[a].d + '</span></div>' +
      '<i class="ck" aria-hidden="true">' + (o.areas[a].ativo ? '✔' : '') + '</i></button>').join('') +
    barra('Continuar', 'avancar');
}

/* ---------- 3. Serviços ---------- */
function chip(m, act) {
  return '<div class="chip"><div class="sw" style="background:' + corDoNome(m.nome) + '"></div>' +
    '<div class="t"><b>' + esc(m.nome) + '</b><span>' + esc(moeda(m.preco)) + ' / ' + esc(m.un || 'm²') + '</span></div>' +
    '<button type="button" class="add" data-act="' + act + '" data-id="' + esc(m.id) + '" aria-label="Adicionar ' + esc(m.nome) + '">+ Add</button></div>';
}

function usados(a) {
  const doArea = S.o.itens.filter(i => i.area === a);
  if (!doArea.length) return '';
  const g = new Map();
  doArea.forEach(i => g.set(i.nome, (g.get(i.nome) || 0) + 1));
  return '<h2>✔ Já adicionados (' + doArea.length + ')</h2>' + [...g.entries()].map(([n, q]) =>
    '<div class="chip used"><div class="sw" style="background:' + corDoNome(n) + '"></div>' +
    '<div class="t"><b>' + esc(n) + '</b><span>' + q + '× na lista</span></div>' +
    '<button type="button" class="add sec" data-act="tirar" data-n="' + esc(n) + '" aria-label="Tirar ' + esc(n) + '">Tirar</button>' +
    '<button type="button" class="add" data-act="denovo" data-n="' + esc(n) + '" aria-label="Adicionar ' + esc(n) + ' de novo">+ De novo</button></div>').join('');
}

function telaServicos() {
  const o = S.o, a = o.aba, ar = o.areas[a];
  let h = cab() + '<h1>O que você vai fazer?</h1>' +
    (sel(o).length > 1 ? seg(sel(o).map(x => [x, AR[x].ic + ' ' + AR[x].s]), a, 'aba') : '<p class="muted">' + AR[a].n + '</p>') +
    '<h2>Como vai cobrar o ' + AR[a].s.toLowerCase() + '?</h2>' +
    seg([['fechado', 'Valor fechado'], ['itens', 'Escolher serviços']], ar.modo, 'modo');

  if (ar.modo === 'fechado') {
    h += '<label for="orc-fech">Valor total, tudo incluso</label>' +
      '<input id="orc-fech" data-f="fech" data-a="' + a + '" value="' + esc(ar.valorFechado) + '" inputmode="decimal" placeholder="Ex.: 8500" autocomplete="off">' +
      '<label for="orc-inclui">O que está incluso (opcional)</label>' +
      '<input id="orc-inclui" data-f="inclui" data-a="' + a + '" value="' + esc(ar.inclui) + '" placeholder="Ex.: preparação, massa e 2 demãos" autocomplete="off">';
  } else {
    const ja = n => o.itens.some(i => i.area === a && i.nome === n);
    const ms = S.meus.filter(m => m.area === a && !ja(m.nome));
    const mo = MODELOS.filter(m => m.area === a && !ja(m.nome));
    h += '<h2><span class="star">★</span> Meus padrões</h2>' +
      (ms.length ? ms.map(m => chip(m, 'addm')).join('')
        : '<p class="muted">' + (S.meus.some(m => m.area === a) ? 'Todos os seus padrões já foram adicionados.' : 'Você ainda não salvou nenhum aqui. Crie um abaixo ou salve um modelo com o seu preço.') + '</p>') +
      '<button type="button" class="big" data-act="criar">' + (S.criando ? '✕ Cancelar' : '➕ Criar meu serviço') + '</button>' +
      (S.criando ? '<div class="new">' +
        '<label for="orc-n-nome">Nome do serviço</label><input id="orc-n-nome" class="js-n-nome" placeholder="Ex.: Portão com esmalte" autocomplete="off" maxlength="120">' +
        '<div class="two orc-sem-pad"><div><label for="orc-n-preco">Preço</label><input id="orc-n-preco" class="js-n-preco" inputmode="decimal" placeholder="35" autocomplete="off"></div>' +
        '<div><label for="orc-n-un">Unidade</label><select id="orc-n-un" class="js-n-un">' + UNIDADES.map(u => '<option>' + u + '</option>').join('') + '</select></div></div>' +
        '<button type="button" class="big primary orc-mt" data-act="salvarnovo">Salvar e adicionar</button></div>' : '') +
      '<h2>Modelos prontos</h2>' +
      (mo.length ? mo.map(m => chip(m, 'addp')).join('') : '<p class="muted">Todos os modelos já foram adicionados.</p>') +
      usados(a);
  }
  return h + barra('Continuar' + (o.itens.length ? ' (' + o.itens.length + ')' : ''), 'avancar');
}

/* ---------- 4. Conferência ---------- */
function linhaItem(it, i) {
  const m2 = it.cobr === 'm2';
  return '<div class="line orc-line"><div class="sw" style="background:' + corDoNome(it.nome) + '"></div><div class="orc-line-c">' +
    '<div class="h"><b>' + esc(it.nome) + '</b><button type="button" class="x" data-act="rem" data-i="' + i + '" aria-label="Remover ' + esc(it.nome) + '">✕</button></div>' +
    '<div class="orc-pad">' + seg([['m2', 'Por ' + esc(it.un || 'm²')], ['fechado', 'Valor fechado']], it.cobr, 'cobr', ' data-i="' + i + '"') + '</div>' +
    (m2
      ? '<div class="two"><div><label for="orc-q' + i + '">Quantidade (' + esc(it.un) + ')</label><input id="orc-q' + i + '" data-f="qtd" data-i="' + i + '" value="' + esc(it.qtd) + '" inputmode="decimal" autocomplete="off"></div>' +
        '<div><label for="orc-p' + i + '">Preço por ' + esc(it.un) + '</label><input id="orc-p' + i + '" data-f="preco" data-i="' + i + '" value="' + esc(it.preco) + '" inputmode="decimal" autocomplete="off"></div></div>'
      : '<div class="two orc-um"><div><label for="orc-p' + i + '">Valor deste serviço</label><input id="orc-p' + i + '" data-f="preco" data-i="' + i + '" value="' + esc(it.preco) + '" inputmode="decimal" autocomplete="off"></div></div>') +
    '<div class="sub"><button type="button" class="save" data-save="' + i + '" data-act="salvarpadrao" data-i="' + i + '"' + (pode(it) ? '' : ' hidden') + '><span class="star">★</span> Salvar como meu padrão</button>' +
    '<b class="orc-lt" data-sub="' + i + '">' + esc(moeda(lt(it))) + '</b></div>' +
  '</div></div>';
}

function cartaoFechado(a) {
  const ar = S.o.areas[a];
  return '<div class="line"><div class="two orc-um orc-fech-card">' +
    '<div><label for="orc-cf-' + a + '">Valor fechado do ' + AR[a].s.toLowerCase() + '</label><input id="orc-cf-' + a + '" data-f="fech" data-a="' + a + '" value="' + esc(ar.valorFechado) + '" inputmode="decimal" autocomplete="off"></div>' +
    '<div><label for="orc-ci-' + a + '">O que está incluso</label><input id="orc-ci-' + a + '" data-f="inclui" data-a="' + a + '" value="' + esc(ar.inclui) + '" placeholder="Opcional" autocomplete="off"></div>' +
  '</div></div>';
}

function telaConferencia() {
  const o = S.o;
  return cab() + '<h1>Confira os valores</h1><p class="muted">Cliente: ' + esc(o.clienteNome || 'sem nome') + '</p>' +
    sel(o).map(a => {
      const itens = o.itens.map((it, i) => it.area === a ? linhaItem(it, i) : '').join('');
      return '<div class="fase"><h2>' + AR[a].ic + ' ' + AR[a].n + '</h2><b data-at="' + a + '">' + esc(moeda(at(o, a))) + '</b></div>' +
        (o.areas[a].modo === 'fechado' ? cartaoFechado(a)
          : itens || '<div class="card orc-fase-vazia"><p class="muted">Nenhum serviço nesta fase.</p><button type="button" class="big" data-act="irservicos" data-a="' + a + '">➕ Escolher serviços</button></div>');
    }).join('') +
    '<label for="orc-desc">Desconto (%)</label><input id="orc-desc" data-f="desc" value="' + esc(o.descontoPct) + '" inputmode="decimal" placeholder="0" autocomplete="off">' +
    '<div class="tot"><div class="r"><span>Subtotal</span><span class="js-subtot">' + esc(moeda(subt(o))) + '</span></div>' +
    '<div class="r"><b>Total</b><span class="g js-tot">' + esc(moeda(totl(o))) + '</span></div></div>' +
    (o.observacao.trim() ? '<div class="line orc-obs-card"><b>Observações</b><div class="muted orc-pre">' + esc(o.observacao) + '</div><button type="button" class="save" data-act="nota">Editar</button></div>' : '') +
    barra('Ver o resumo', 'avancar');
}

/* ---------- 5. Resumo ---------- */
function previa() {
  const o = S.o, est = S.ctx.estado, p = est.perfil || {}, u = est.usuario || {};
  const empresa = p.empresa || u.nome || '';
  const logo = p.logo && /^data:image\//.test(p.logo) ? '<img src="' + esc(p.logo) + '" alt="">' : 'SUA LOGO';
  const cor = /^#[0-9a-f]{6}$/i.test(p.corPrincipal || '') ? p.corPrincipal : '';
  const contato = [foneBR(p.telefone || u.whatsapp), p.cidade || u.cidade].filter(Boolean).map(esc).join(' · ');
  const varias = sel(o).length > 1;
  return '<div class="orc-paper orc-m-' + esc(o.modeloPdf) + ' js-previa"' + (cor ? ' style="--orc-cor:' + cor + '"' : '') + '>' +
    '<div class="orc-ph"><div class="orc-logo">' + logo + '</div>' +
      '<div class="orc-pt"><div class="orc-ptitle">Orçamento</div><div class="orc-pmeta">' +
        '<span class="js-pnum">' + (o.numero ? 'Nº ' + esc(o.numero) : '') + '</span>' + (o.numero ? ' · ' : '') + esc(dataBR(o.criadoEm) || dataBR(new Date())) +
        '<br>Para: <b>' + esc(o.clienteNome || 'cliente') + '</b>' +
        '<br>Válido por <span class="js-pval">' + esc(Math.max(1, Math.round(num(o.validadeDias))) || 15) + '</span> dias</div></div></div>' +
    (empresa || contato ? '<div class="orc-pemp">' + (empresa ? '<b>' + esc(empresa) + '</b>' : '') + (contato ? '<span>' + contato + '</span>' : '') + '</div>' : '') +
    sel(o).map(a => '<p class="orc-pa"><b>' + AR[a].n + '</b></p><table><tr><th>Serviço</th><th>Qtd</th><th>Valor</th></tr>' +
      (o.areas[a].modo === 'fechado'
        ? '<tr><td colspan="2">Valor fechado' + (o.areas[a].inclui.trim() ? ' — ' + esc(o.areas[a].inclui.trim()) : '') + '</td><td>' + esc(moeda(at(o, a))) + '</td></tr>'
        : o.itens.filter(i => i.area === a).map(it => '<tr><td>' + esc(it.nome) + '</td><td>' + (it.cobr === 'fechado' ? '—' : esc(it.qtd || '0') + ' ' + esc(it.un)) + '</td><td>' + esc(moeda(lt(it))) + '</td></tr>').join('')) +
      (varias ? '<tr><td colspan="2"><b>Subtotal</b></td><td><b>' + esc(moeda(at(o, a))) + '</b></td></tr>' : '') + '</table>').join('') +
    (desc(o) ? '<div class="orc-pmu">Subtotal ' + esc(moeda(subt(o))) + ' · Desconto ' + esc(txtN(desc(o))) + '%</div>' : '') +
    '<div class="orc-total">' + esc(moeda(totl(o))) + '</div>' +
    (o.observacao.trim() ? '<div class="orc-pobs"><b>Observações</b><div class="orc-pre">' + esc(o.observacao.trim()) + '</div></div>' : '') +
    (p.condicoes ? '<div class="orc-pobs"><b>Condições</b><div class="orc-pre">' + esc(p.condicoes) + '</div></div>' : '') +
    (p.pix ? '<div class="orc-pobs"><b>PIX:</b> ' + esc(p.pix) + '</div>' : '') +
    '<div class="orc-pf">' + esc(p.rodape || 'Obrigado pela confiança!') + '</div>' +
  '</div>';
}

function telaResumo() {
  const o = S.o;
  return cab() + '<h1>Orçamento pronto</h1>' +
    (o.concluido
      ? '<div class="card ok-card"><b>✔ Concluído e salvo</b><p class="muted">Ele está no Histórico. Se mudar alguma coisa, salva sozinho.</p></div>'
      : '<p class="muted">Confira a prévia e toque em <b>Concluir</b>.</p>') +
    '<div class="orc-opcoes"><div><span class="rotulo">Visual do PDF</span>' + seg(MODELOS_PDF, o.modeloPdf, 'mod') + '</div>' +
    '<div class="orc-validade"><label for="orc-val">Validade (dias)</label><input id="orc-val" data-f="validade" value="' + esc(o.validadeDias) + '" inputmode="numeric" autocomplete="off"></div></div>' +
    previa() +
    '<div class="orc-acoes">' +
      (o.concluido ? '' : '<button type="button" class="big primary" data-act="concluir">✔ Concluir orçamento</button>') +
      '<button type="button" class="big' + (o.concluido ? ' primary' : '') + '" data-act="pdf">📄 Gerar PDF</button>' +
      '<button type="button" class="big" data-act="voltar">← Voltar e editar</button>' +
      '<div class="grid"><button type="button" class="big" data-act="historico"><span aria-hidden="true">📄</span>Histórico</button>' +
      '<button type="button" class="big" data-act="novo"><span aria-hidden="true">➕</span>Novo orçamento</button></div>' +
    '</div>';
}

/* ---------- Balão de observação e folhas ---------- */
function botaoObs() {
  return '<button type="button" class="fab" data-act="nota" aria-label="Observação do orçamento">💬 Observação' + (S.o.observacao.trim() ? '<i></i>' : '') + '</button>';
}

function folhaObs() {
  return '<div class="ov orc-ov"><div class="sheet" role="dialog" aria-modal="true" aria-label="Observação do orçamento">' +
    '<p><b>Observação do orçamento</b></p><p class="muted">Aparece no PDF, depois dos serviços.</p>' +
    '<div class="qk"><button type="button" data-act="ins" data-t="Incluso: ">Incluso</button>' +
    '<button type="button" data-act="ins" data-t="Combinado por fora: ">Combinado por fora</button>' +
    '<button type="button" data-act="ins" data-t="Valor a definir: ">Valor a definir</button></div>' +
    '<textarea class="js-obs" data-f="obs" maxlength="2000" aria-label="Observação" placeholder="Ex.: Incluso toda a parte interna da casa. Cimento queimado combinado por fora, valor a definir.">' + esc(S.o.observacao) + '</textarea>' +
    '<button type="button" class="big primary orc-mt" data-act="fechanota">Pronto</button></div></div>';
}

function folhaDeNovo() {
  return '<div class="ov orc-ov"><div class="sheet" role="alertdialog" aria-modal="true" aria-label="Adicionar de novo">' +
    '<p><b>Adicionar “' + esc(S.conf) + '” de novo?</b></p><p class="muted">Ele já está na lista. Isso cria mais uma linha igual.</p>' +
    '<button type="button" class="big primary" data-act="okdenovo">Adicionar de novo</button>' +
    '<button type="button" class="big" data-act="nao">Cancelar</button></div></div>';
}

/* ---------- Desfazer (tirar item com um toque) ---------- */
function oferecerDesfazer(msg, volta) {
  fecharDesfazer();
  const box = document.createElement('div');
  box.className = 'orc-desfazer';
  box.setAttribute('role', 'status');
  box.innerHTML = '<span>' + esc(msg) + '</span><button type="button">Desfazer</button>';
  box.querySelector('button').addEventListener('click', () => {
    fecharDesfazer();
    if (!S) return;
    volta();
    render();
    mudou();
  });
  document.body.appendChild(box);
  S.desfazer = { box, t: setTimeout(fecharDesfazer, 6000) };
}

function fecharDesfazer() {
  if (!S?.desfazer) return;
  clearTimeout(S.desfazer.t);
  S.desfazer.box.remove();
  S.desfazer = null;
}

/* ============================================================
   Ações
   ============================================================ */
function irEtapa(e) {
  const o = S.o;
  o.etapa = e;
  if (e === 'servicos' && !o.areas[o.aba].ativo) o.aba = sel(o)[0] || 'int';
  S.criando = false;
  S.conf = null;
  render();
  window.scrollTo(0, 0);
  mudou();
  gravarJa();
}

function validarServicos() {
  const o = S.o;
  if (!sel(o).length) return 'Marque interno, externo ou os dois';
  for (const a of sel(o)) {
    const ar = o.areas[a];
    if (ar.modo === 'fechado' && !num(ar.valorFechado)) return 'Informe o valor fechado do ' + AR[a].s.toLowerCase();
    if (ar.modo === 'itens' && !o.itens.some(i => i.area === a)) return 'Adicione serviços no ' + AR[a].s.toLowerCase();
  }
  return '';
}

function avancar() {
  const o = S.o, { toast } = S.ctx;
  switch (o.etapa) {
    case 'cliente':
      if (!o.clienteNome) return toast('Escolha ou cadastre o cliente');
      if (!o.id) criar();
      return irEtapa('areas');
    case 'areas':
      if (!sel(o).length) return toast('Marque interno, externo ou os dois');
      o.aba = sel(o)[0];
      return irEtapa('servicos');
    case 'servicos': {
      const erro = validarServicos();
      if (erro) {
        const a = sel(o).find(x => erro.endsWith(AR[x].s.toLowerCase()));
        if (a && a !== o.aba) { o.aba = a; render(); }
        return toast(erro);
      }
      return irEtapa('conferencia');
    }
    case 'conferencia':
      return irEtapa('resumo');
  }
}

function voltar() {
  const o = S.o;
  const i = ETAPAS.indexOf(o.etapa);
  if (i <= 0) { gravarJa(); S.ctx.ir(S.veioDoHistorico ? 'historico' : 'inicio'); return; }
  irEtapa(ETAPAS[i - 1]);
}

function adicionar(m, origem) {
  const o = S.o;
  o.itens.push({
    nome: m.nome, area: o.aba, cobr: 'm2', qtd: '', un: m.un || 'm²',
    preco: txtN(m.preco), pm2: txtN(m.preco), orig: num(m.preco), origem, salvo: origem === 'meu'
  });
  S.ctx.toast('Adicionado: ' + m.nome);
  render();
  mudou();
}

/** Grava em Meu padrão. Se já existir um com o mesmo nome na área, só troca o preço. */
function salvarPadrao(nome, preco, un, area) {
  const { ctx } = S;
  const col = fs.collection(db, 'users', ctx.estado.uid, 'servicos');
  const igual = S.meus.find(m => m.area === area && normalizarBusca(m.nome) === normalizarBusca(nome));
  try {
    const p = igual
      ? fs.updateDoc(fs.doc(col, igual.id), { preco, un })
      : fs.setDoc(fs.doc(col), { nome, preco, un, area, criadoEm: fs.serverTimestamp() });
    p.catch(e => { console.error('[Print] meu padrão', e); ctx.toast(traduzErro(e), 'erro'); });
  } catch (e) { ctx.toast(traduzErro(e), 'erro'); return false; }
  return true;
}

function concluir() {
  const o = S.o, { ctx } = S;
  const erro = validarServicos();
  if (erro) { ctx.toast(erro, 'erro'); return false; }
  if (!o.id) criar();
  const total = r2(totl(o));
  o.concluido = true;
  if (!o.contadoNoUso) {
    o.contadoNoUso = true;
    registrarOrcamento(total);
    contarMes(ctx.estado.uid, total);
  }
  S.sujo = true;
  gravarJa();
  ctx.toast(navigator.onLine ? 'Orçamento concluído ✓' : 'Concluído e salvo no aparelho', 'ok');
  render();
  return true;
}

async function gerarPdf() {
  const { ctx } = S;
  if (!S.o.concluido && !concluir()) return;
  gravarJa();
  const o = S.o;
  const orcamento = {
    id: o.id, numero: o.numero, ...paraDados(o),
    status: o.status, concluido: o.concluido, criadoEm: o.criadoEm || new Date()
  };
  let mod;
  try { mod = await import('./pdf.js'); }
  catch (e) { console.warn('[Print] pdf.js ainda não existe', e); ctx.toast('O PDF chega na próxima atualização'); return; }
  try { await mod.gerarPdf({ orcamento, perfil: ctx.estado.perfil, usuario: ctx.estado.usuario }); }
  catch (e) { console.error('[Print] gerar PDF', e); ctx.toast('Não deu para gerar o PDF. ' + traduzErro(e), 'erro'); }
}

function aoClicar(ev) {
  if (!S?.o) return;
  // Toque no fundo escuro fecha a folha.
  if (ev.target.classList.contains('orc-ov')) { S.nota = false; S.conf = null; render(); return; }
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const o = S.o, d = b.dataset, { toast } = S.ctx;

  switch (d.act) {
    case 'voltar': return voltar();
    case 'avancar': return avancar();

    case 'escolher': {
      const c = S.clientes.find(x => x.id === d.id);
      if (!c) return;
      usarCliente(c);
      S.busca = '';
      if (!o.id) criar(); else mudou();
      return irEtapa('areas');
    }
    case 'rapido': {
      if (S.rapido) { S.rapido = null; render(); return; }
      const q = S.busca.trim(), dig = soDigitos(q);
      const soNumero = dig.length >= 3 && !/[a-zA-ZÀ-ÿ]/.test(q);
      S.rapido = soNumero ? { nome: '', whatsapp: dig } : { nome: q, whatsapp: '' };
      render();
      S.el.querySelector(soNumero || !q ? '.js-r-nome' : '.js-r-zap')?.focus();
      return;
    }
    case 'salvarrapido': return salvarRapido();

    case 'togarea':
      o.areas[d.a].ativo = !o.areas[d.a].ativo;
      render();
      return mudou();
    case 'aba':
      o.aba = d.v;
      S.criando = false;
      render();
      return mudou();
    case 'modo':
      o.areas[o.aba].modo = d.v;
      render();
      if (d.v === 'fechado') S.el.querySelector('#orc-fech')?.focus();
      return mudou();

    case 'addm': { const m = S.meus.find(x => x.id === d.id); if (m) adicionar(m, 'meu'); return; }
    case 'addp': { const m = MODELOS.find(x => x.id === d.id); if (m) adicionar(m, 'modelo'); return; }
    case 'criar':
      S.criando = !S.criando;
      render();
      if (S.criando) S.el.querySelector('.js-n-nome')?.focus();
      return;
    case 'salvarnovo': {
      const nome = (S.el.querySelector('.js-n-nome')?.value || '').trim().replace(/\s+/g, ' ');
      const preco = r2(num(S.el.querySelector('.js-n-preco')?.value));
      const un = S.el.querySelector('.js-n-un')?.value || 'm²';
      if (!nome || !preco) return toast('Informe o nome e o preço', 'erro');
      if (!salvarPadrao(nome, preco, un, o.aba)) return;
      S.criando = false;
      return adicionar({ nome, preco, un }, 'meu');
    }
    case 'denovo': S.conf = d.n; return render();
    case 'nao': S.conf = null; return render();
    case 'okdenovo': {
      const x = o.itens.find(i => i.area === o.aba && i.nome === S.conf);
      if (x) o.itens.push({ ...x, qtd: '', cobr: 'm2', preco: txtN(x.orig), pm2: txtN(x.orig) });
      S.conf = null;
      toast('Adicionado de novo');
      render();
      return mudou();
    }
    case 'tirar': {
      let k = -1;
      for (let j = o.itens.length - 1; j >= 0; j--) if (o.itens[j].area === o.aba && o.itens[j].nome === d.n) { k = j; break; }
      if (k < 0) return;
      const [item] = o.itens.splice(k, 1);
      render();
      mudou();
      return oferecerDesfazer('Tirado: ' + item.nome, () => o.itens.splice(Math.min(k, o.itens.length), 0, item));
    }
    case 'rem': {
      const k = +d.i;
      const [item] = o.itens.splice(k, 1);
      if (!item) return;
      render();
      mudou();
      return oferecerDesfazer('Removido: ' + item.nome, () => o.itens.splice(Math.min(k, o.itens.length), 0, item));
    }
    case 'cobr': {
      const it = o.itens[+d.i];
      if (!it || it.cobr === d.v) return;
      if (d.v === 'fechado') { it.pm2 = it.preco; const v = num(it.qtd) * num(it.preco); it.preco = v ? txtN(v) : ''; }
      else it.preco = it.pm2;
      it.cobr = d.v;
      render();
      return mudou();
    }
    case 'salvarpadrao': {
      const it = o.itens[+d.i];
      if (!it || !salvarPadrao(it.nome, r2(num(it.preco)), it.un, it.area)) return;
      it.salvo = true;
      it.orig = num(it.preco);
      b.hidden = true;
      toast('Salvo em Meus padrões ★', 'ok');
      return mudou();
    }
    case 'irservicos':
      o.aba = d.a;
      o.areas[d.a].modo = 'itens';
      return irEtapa('servicos');

    case 'nota':
      S.nota = true;
      render();
      S.el.querySelector('.js-obs')?.focus();
      return;
    case 'fechanota':
      S.nota = false;
      render();
      return gravarJa();
    case 'ins': {
      o.observacao = (o.observacao.trim() ? o.observacao.replace(/\s+$/, '') + '\n' : '') + d.t;
      render();
      const t = S.el.querySelector('.js-obs');
      if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
      return mudou();
    }
    case 'mod':
      o.modeloPdf = modeloOk(d.v);
      render();
      return mudou();
    case 'concluir': return concluir();
    case 'pdf': return gerarPdf();
    case 'historico': gravarJa(); return S.ctx.ir('historico');
    case 'novo': gravarJa(); return S.ctx.ir('orcamento', { novo: true });
  }
}

function aoDigitar(ev) {
  if (!S?.o) return;
  const t = ev.target, f = t.dataset.f;
  if (!f) return;
  const o = S.o, v = t.value;
  switch (f) {
    case 'busca': S.busca = v; desenharListaClientes(); return;
    case 'fech': o.areas[t.dataset.a].valorFechado = v; break;
    case 'inclui': o.areas[t.dataset.a].inclui = v; break;
    case 'desc': o.descontoPct = v; break;
    case 'obs': o.observacao = v; break;
    case 'validade': o.validadeDias = v; break;
    case 'qtd': case 'preco': { const it = o.itens[+t.dataset.i]; if (it) it[f] = v; break; }
    default: return;
  }
  atualizarNumeros();
  mudou();
}

/** Atualiza totais sem redesenhar (o teclado não fecha). */
function atualizarNumeros() {
  const o = S.o, el = S.el;
  o.itens.forEach((it, i) => {
    const s = el.querySelector('[data-sub="' + i + '"]');
    if (s) s.textContent = moeda(lt(it));
    const b = el.querySelector('[data-save="' + i + '"]');
    if (b) b.hidden = !pode(it);
  });
  el.querySelectorAll('[data-at]').forEach(e => { e.textContent = moeda(at(o, e.dataset.at)); });
  const a = el.querySelector('.js-subtot'), b = el.querySelector('.js-tot'), v = el.querySelector('.js-pval');
  if (a) a.textContent = moeda(subt(o));
  if (b) b.textContent = moeda(totl(o));
  if (v) v.textContent = Math.max(1, Math.round(num(o.validadeDias))) || 15;
}

/** Enter no nome do cadastro rápido pula para o WhatsApp; no WhatsApp, salva. */
function aoEnter(ev) {
  if (ev.key !== 'Enter' || !S) return;
  if (ev.target.classList.contains('js-r-nome')) { ev.preventDefault(); S.el.querySelector('.js-r-zap')?.focus(); }
  else if (ev.target.classList.contains('js-r-zap')) { ev.preventDefault(); salvarRapido(); }
  else if (ev.target.classList.contains('js-n-preco')) { ev.preventDefault(); S.el.querySelector('[data-act="salvarnovo"]')?.click(); }
}

function aoTecla(ev) {
  if (ev.key !== 'Escape' || !S) return;
  if (S.nota || S.conf) { S.nota = false; S.conf = null; render(); gravarJa(); }
}
