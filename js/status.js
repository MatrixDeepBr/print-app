/*
  Arquivo: js/status.js
  Versão: 1.0.0
  Sessão: 2 — Cadastro, login e pendente
  Data: 14/10/2026
  Telas da situação da conta: Aguardando liberação, Recusado, Bloqueado,
  e "Não deu para abrir sua conta" (quando o documento do usuário não carrega).
  Sem login, não mostram nada (o app.js leva para Entrar).

  Contrato de telas: telaPendente, telaRecusado, telaBloqueado, telaProblema
  Enquanto uma dessas telas está aberta, o app fica de olho no documento do
  usuário: quando a equipe libera (status "ativo"), o app abre sozinho.
*/

import { db, fs } from './firebase.js';
import { sair, formatarWhats } from './auth.js';

const MSG_PADRAO = 'Recebemos seu cadastro. Em breve a equipe libera seu acesso.';

/* Resumo dos cartões 2 e 3 das boas-vindas. */
const RESUMO_PRO = 'O app é grátis, e quem entra agora ganha 2 meses de Pro quando ele abrir. Depois, o Pro terá um valor, avisado com 30 dias de antecedência. O Free continua grátis.';
const RESUMO_EQUIPE = 'Dúvidas, ideias ou benefícios para profissionais? Fale com a equipe do Print.';

let pararVigia = null;

/** Fica de olho no próprio documento: se o status mudar, abre a tela certa. */
function vigiarStatus(ctx, statusAtual) {
  pararVigia?.();
  pararVigia = null;
  if (!ctx.estado.uid) return;
  let mudou = false;
  pararVigia = fs.onSnapshot(fs.doc(db, 'users', ctx.estado.uid), s => {
    const novo = s.exists() ? s.data().status : null;
    if (mudou || !novo || novo === statusAtual) return;
    mudou = true;
    ctx.recarregarUsuario().then(() => {
      if (novo === 'ativo') ctx.toast('Seu acesso foi liberado!', 'ok');
      ctx.ir('inicio'); // o app.js decide a tela pela situação nova
    });
  }, () => { /* sem permissão ou sem internet: segue sem vigiar */ });
}

function desmontar() {
  pararVigia?.();
  pararVigia = null;
}

function semLogin(el, ctx) {
  if (ctx.estado.uid) return false;
  el.innerHTML = '';
  return true;
}

function ligarSair(el, ctx) {
  el.querySelectorAll('.js-sair').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    await sair(ctx);
    b.disabled = false;
  }));
}

/* ============================================================
   Aguardando liberação
   ============================================================ */
export const telaPendente = {
  async montar(el, ctx) {
    if (semLogin(el, ctx)) return;
    const { esc, primeiroNome } = ctx.utils;
    const u = ctx.estado.usuario || {};
    const falta = !u.nome || !u.whatsapp || !u.cidade;

    el.innerHTML =
      '<div class="status-topo"><span class="status-ic" aria-hidden="true">⏳</span>' +
      '<h1>Aguardando liberação</h1>' +
      '<p class="muted">Cadastro recebido, ' + esc(primeiroNome(u.nome, 'pintor')) + '!</p></div>' +
      '<div class="card destaque"><p class="js-msg">' + esc(MSG_PADRAO) + '</p>' +
      '<p class="muted pequeno">Quando a equipe liberar, o app abre sozinho.</p></div>' +
      (falta ? formCompletar(u, esc) : '') +
      '<div class="card resumo">' +
        '<p><span aria-hidden="true">⭐</span> ' + esc(RESUMO_PRO) + '</p>' +
        '<p><span aria-hidden="true">💬</span> ' + esc(RESUMO_EQUIPE) + '</p>' +
      '</div>' +
      '<button class="big primary js-contato" type="button">💬 Falar com a equipe</button>' +
      '<button class="big js-sair" type="button">Sair</button>';

    el.querySelector('.js-contato').addEventListener('click', () => ctx.ir('contato', { de: 'pendente' }));
    ligarSair(el, ctx);
    if (falta) ligarCompletar(el, ctx);
    vigiarStatus(ctx, 'pendente');

    // Mensagem configurada pelo dono em config/app.mensagemPendente
    try {
      const s = await fs.getDoc(fs.doc(db, 'config', 'app'));
      const m = s.exists() ? String(s.data().mensagemPendente || '').trim() : '';
      const alvo = el.querySelector('.js-msg');
      if (m && alvo) alvo.textContent = m;
    } catch (e) { /* fica a mensagem padrão */ }
  },
  desmontar
};

/* Se o cadastro ficou incompleto (documento recriado depois de uma falha). */
function formCompletar(u, esc) {
  return '<form class="card js-completar" novalidate>' +
    '<b>Complete seu cadastro</b>' +
    '<p class="muted pequeno">Assim a equipe consegue falar com você.</p>' +
    '<label for="p-nome">Seu nome</label>' +
    '<input id="p-nome" name="nome" autocomplete="name" maxlength="80" value="' + esc(u.nome || '') + '">' +
    '<label for="p-whats">WhatsApp (com DDD)</label>' +
    '<input id="p-whats" name="whatsapp" type="tel" inputmode="tel" placeholder="(17) 90000-0000" value="' + esc(formatarWhats(u.whatsapp || '')) + '">' +
    '<label for="p-cidade">Cidade</label>' +
    '<input id="p-cidade" name="cidade" maxlength="60" value="' + esc(u.cidade || '') + '">' +
    '<button class="big primary js-salvar" type="submit" style="margin-top:14px">Salvar</button>' +
    '</form>';
}

function ligarCompletar(el, ctx) {
  const f = el.querySelector('.js-completar');
  const btn = f.querySelector('.js-salvar');
  f.whatsapp.addEventListener('input', () => { f.whatsapp.value = formatarWhats(f.whatsapp.value); });
  f.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (btn.disabled) return;
    const nome = f.nome.value.trim().replace(/\s+/g, ' ');
    const whatsapp = f.whatsapp.value.replace(/\D/g, '');
    const cidade = f.cidade.value.trim().replace(/\s+/g, ' ');
    if (nome.length < 2) { ctx.toast('Digite o seu nome.', 'erro'); f.nome.focus(); return; }
    if (whatsapp.length < 10 || whatsapp.length > 11) { ctx.toast('Digite o WhatsApp com DDD.', 'erro'); f.whatsapp.focus(); return; }
    if (cidade.length < 2) { ctx.toast('Digite a sua cidade.', 'erro'); f.cidade.focus(); return; }
    btn.disabled = true;
    btn.textContent = 'Salvando…';
    try {
      await fs.updateDoc(fs.doc(db, 'users', ctx.estado.uid), { nome, whatsapp, cidade });
      await ctx.recarregarUsuario();
      ctx.toast('Dados salvos!', 'ok');
      telaPendente.montar(el, ctx);
    } catch (e) {
      ctx.toast(ctx.utils.traduzErro(e), 'erro');
      btn.disabled = false;
      btn.textContent = 'Salvar';
    }
  });
}

/* ============================================================
   Recusado e Bloqueado
   ============================================================ */
function telaSimples(status, ic, titulo, texto) {
  return {
    montar(el, ctx) {
      if (semLogin(el, ctx)) return;
      el.innerHTML =
        '<div class="status-topo"><span class="status-ic" aria-hidden="true">' + ic + '</span>' +
        '<h1>' + titulo + '</h1></div>' +
        '<div class="card"><p>' + texto + '</p></div>' +
        '<button class="big js-sair" type="button">Sair</button>';
      ligarSair(el, ctx);
      vigiarStatus(ctx, status);
    },
    desmontar
  };
}

export const telaRecusado = telaSimples('recusado', '🚫', 'Cadastro não aprovado',
  'No momento, o seu cadastro não foi aprovado pela equipe.');

export const telaBloqueado = telaSimples('bloqueado', '🔒', 'Acesso bloqueado',
  'O acesso desta conta está bloqueado.');

/* ============================================================
   Não deu para abrir a conta (documento não carregou ou não existe)
   ============================================================ */
export const telaProblema = {
  montar(el, ctx) {
    if (semLogin(el, ctx)) return;
    const det = ctx.estado.erroUsuario ? ctx.utils.traduzErro(ctx.estado.erroUsuario) : 'O cadastro não terminou de ser criado.';
    el.innerHTML =
      '<div class="status-topo"><span class="status-ic" aria-hidden="true">📶</span>' +
      '<h1>Não deu para abrir sua conta</h1></div>' +
      '<div class="card"><p>' + ctx.utils.esc(det) + '</p>' +
      '<p class="muted pequeno">Confira a internet e toque em Tentar de novo.</p></div>' +
      '<button class="big primary js-tentar" type="button">Tentar de novo</button>' +
      '<button class="big js-sair" type="button">Sair</button>';
    const b = el.querySelector('.js-tentar');
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'Tentando…';
      await ctx.recarregarUsuario();
      if (ctx.estado.usuario) ctx.ir('inicio');
      else telaProblema.montar(el, ctx);
    });
    ligarSair(el, ctx);
  }
};
