/*
  Arquivo: js/inicio.js
  Versão: 1.0.0
  Sessão: 5 — Início e clientes
  Data: 15/10/2026
  Tela inicial do app (#inicio): "Olá, {primeiro nome}", botão Novo orçamento,
  atalhos Clientes e Orçamentos, cartão Complete seu perfil, últimos 3 orçamentos
  e os botões "em breve" (Agenda, Obras e Financeiro).

  Contrato: montar(container, ctx) e desmontar().
  Lê (só leitura): users/{uid}/orcamentos, orderBy('atualizadoEm','desc'), limit(3),
  ao vivo (onSnapshot), para funcionar offline e atualizar sozinho.
  Não grava nada no banco.
  Navegador: sessionStorage 'print.guiaPerfilAgoraNao' (o "Agora não" do cartão
  Complete seu perfil vale só até fechar o navegador).
*/

import { db, fs } from './firebase.js';

const CHAVE_AGORA_NAO = 'print.guiaPerfilAgoraNao';

const STATUS = {
  rascunho: { txt: 'Rascunho', ic: '✏️' },
  enviado:  { txt: 'Enviado',  ic: '📤' },
  aprovado: { txt: 'Aprovado', ic: '✅' },
  recusado: { txt: 'Recusado', ic: '✖️' }
};

let S = null; // { el, ctx, unsub, aoClicar }

/* ---------- sessionStorage protegido (aba anônima pode dar erro) ---------- */
function lerSessao(k) {
  try { return sessionStorage.getItem(k); } catch (e) { return null; }
}
function gravarSessao(k, v) {
  try { sessionStorage.setItem(k, v); } catch (e) { /* sem armazenamento: só some agora */ }
}

/* ============================================================
   Montar
   ============================================================ */
export function montar(el, ctx) {
  const { estado, utils } = ctx;
  const { esc } = utils;
  const nome = utils.primeiroNome(estado.usuario?.nome);
  const verGuia = estado.perfil?.guiaFeito !== true && !lerSessao(CHAVE_AGORA_NAO);

  el.classList.add('ini-tela');
  el.innerHTML =
    '<h1 class="ini-ola">Olá, ' + esc(nome) + '</h1>' +
    '<p class="muted">O que vamos fazer agora?</p>' +

    '<button type="button" class="big primary ini-novo" data-acao="novo">' +
      '<span aria-hidden="true">➕</span> Novo orçamento</button>' +

    '<div class="grid ini-atalhos">' +
      '<button type="button" class="big" data-acao="clientes"><span class="ini-ic" aria-hidden="true">👥</span>Clientes</button>' +
      '<button type="button" class="big" data-acao="historico"><span class="ini-ic" aria-hidden="true">📄</span>Orçamentos</button>' +
    '</div>' +

    (verGuia ?
      '<div class="card ini-guia js-guia">' +
        '<div class="ini-guia-txt"><span class="ini-guia-ic" aria-hidden="true">🎨</span>' +
        '<div><b>Complete seu perfil</b>' +
        '<p>Coloque sua logo e seus dados para o orçamento sair com a sua cara.</p></div></div>' +
        '<div class="ini-guia-bts">' +
          '<button type="button" class="big primary" data-acao="perfil">Completar agora</button>' +
          '<button type="button" class="link-btn" data-acao="agora-nao">Agora não</button>' +
        '</div>' +
      '</div>' : '') +

    '<h2>Últimos orçamentos</h2>' +
    '<div class="ini-ultimos js-ultimos"><p class="muted">Carregando…</p></div>' +

    '<div class="ini-breve" aria-label="Novidades que vêm aí">' +
      '<button type="button" class="ini-breve-bt" disabled><span aria-hidden="true">📅</span>Agenda<small>em breve</small></button>' +
      '<button type="button" class="ini-breve-bt" disabled><span aria-hidden="true">🏗️</span>Obras<small>em breve</small></button>' +
      '<button type="button" class="ini-breve-bt" disabled><span aria-hidden="true">💰</span>Financeiro<small>em breve</small></button>' +
    '</div>';

  const aoClicar = ev => {
    const alvo = ev.target.closest('[data-acao], [data-orc]');
    if (!alvo || !el.contains(alvo)) return;
    if (alvo.dataset.orc) { ctx.ir('orcamento', { id: alvo.dataset.orc }); return; }
    switch (alvo.dataset.acao) {
      case 'novo':      ctx.ir('orcamento'); break;
      case 'clientes':  ctx.ir('clientes'); break;
      case 'historico': ctx.ir('historico'); break;
      case 'perfil':    ctx.ir('perfil', { guia: true }); break;
      case 'agora-nao':
        gravarSessao(CHAVE_AGORA_NAO, '1');
        el.querySelector('.js-guia')?.remove();
        break;
    }
  };
  el.addEventListener('click', aoClicar);

  S = { el, ctx, unsub: null, aoClicar };
  assinarUltimos();
}

export function desmontar() {
  if (!S) return;
  try { S.unsub?.(); } catch (e) { /* ignora */ }
  S.el.removeEventListener('click', S.aoClicar);
  S = null;
}

/* ============================================================
   Últimos orçamentos (até 3, ao vivo)
   ============================================================ */
function assinarUltimos() {
  const { estado } = S.ctx;
  if (!estado.uid) { desenharUltimos([]); return; }
  try {
    const q = fs.query(
      fs.collection(db, 'users', estado.uid, 'orcamentos'),
      fs.orderBy('atualizadoEm', 'desc'),
      fs.limit(3)
    );
    S.unsub = fs.onSnapshot(q,
      snap => desenharUltimos(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      e => {
        console.warn('[Print] início: últimos orçamentos', e);
        const box = S?.el.querySelector('.js-ultimos');
        if (box) box.innerHTML = '<p class="muted">Não deu para carregar os últimos orçamentos agora.</p>';
      });
  } catch (e) {
    console.warn('[Print] início: consulta de orçamentos', e);
    desenharUltimos([]);
  }
}

function desenharUltimos(lista) {
  const box = S?.el.querySelector('.js-ultimos');
  if (!box) return;
  const { esc, moeda, dataBR } = S.ctx.utils;

  if (!lista.length) {
    box.innerHTML =
      '<div class="card ini-vazio">' +
        '<b>Seu primeiro orçamento sai em 2 minutos.</b>' +
        '<p class="muted">Toque em <b>Novo orçamento</b>, monte na frente do cliente e mande o PDF pelo WhatsApp.</p>' +
      '</div>';
    return;
  }

  box.innerHTML = lista.map(o => {
    const st = STATUS[o.status] || STATUS.rascunho;
    const cliente = o.clienteNome ? esc(o.clienteNome) : '<span class="muted">Sem cliente</span>';
    const numero = (o.numero ?? '') !== '' ? 'Nº ' + esc(o.numero) : 'Sem número';
    const data = dataBR(o.atualizadoEm);
    return '<button type="button" class="ini-orc" data-orc="' + esc(o.id) + '">' +
        '<span class="ini-orc-txt">' +
          '<b>' + cliente + '</b>' +
          '<small>' + numero + (data ? ' · ' + esc(data) : '') + '</small>' +
        '</span>' +
        '<span class="ini-orc-dir">' +
          '<b>' + esc(moeda(o.total)) + '</b>' +
          '<span class="ini-st ini-st-' + esc(o.status in STATUS ? o.status : 'rascunho') + '">' +
            '<span aria-hidden="true">' + st.ic + '</span> ' + st.txt + '</span>' +
        '</span>' +
      '</button>';
  }).join('') +
  '<button type="button" class="link-btn ini-ver-todos" data-acao="historico">Ver todos os orçamentos →</button>';
}
