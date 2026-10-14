/*
  Arquivo: js/contato.js
  Versão: 1.0.0
  Sessão: 2 — Cadastro, login e pendente
  Data: 14/10/2026
  Formulário "Falar com a equipe". Funciona para usuário pendente e ativo.
  Grava em pedidosContato/{id}: uid, nome, whatsapp, motivo, mensagem,
  status 'novo' e criadoEm. Só o administrador muda o status (regras).

  Contrato: montar(container, ctx)
  ctx.params.de (opcional): tela para onde o botão Voltar leva ('pendente', 'perfil'...)
*/

import { db, fs } from './firebase.js';

const MAX = 2000;
const MOTIVOS = [
  ['duvida', '❓', 'Dúvida'],
  ['sugestao', '💡', 'Sugestão'],
  ['beneficios', '🤝', 'Benefícios']
];

let rascunho = { motivo: '', mensagem: '' }; // só na memória, para não perder o texto

/** Desiste de esperar depois de ms (sem internet, a gravação fica na fila do aparelho). */
function comPrazo(promessa, ms) {
  return Promise.race([
    promessa.then(() => 'ok'),
    new Promise(res => setTimeout(() => res('fila'), ms))
  ]);
}

export function montar(el, ctx) {
  const { esc, traduzErro } = ctx.utils;
  const u = ctx.estado.usuario || {};
  const voltarPara = ctx.params?.de || 'inicio';
  const zap = u.whatsapp ? formatar(u.whatsapp) : '';

  el.innerHTML =
    '<div class="top"><button class="back js-voltar" type="button" aria-label="Voltar">←</button></div>' +
    '<h1>Falar com a equipe</h1>' +
    '<p class="muted">Mande sua dúvida, ideia ou pergunte sobre benefícios para profissionais.' +
      (zap ? ' A equipe responde no seu WhatsApp ' + esc(zap) + '.' : ' A equipe responde pelo WhatsApp do seu cadastro.') + '</p>' +
    '<form class="js-form" novalidate>' +
      '<p class="rotulo" id="ct-motivo">Sobre o que é?</p>' +
      '<div class="seg tres" role="radiogroup" aria-labelledby="ct-motivo">' +
        MOTIVOS.map(([k, ic, n]) =>
          '<button type="button" role="radio" data-motivo="' + k + '" aria-checked="' + (rascunho.motivo === k) + '" class="' + (rascunho.motivo === k ? 'on' : '') + '">' +
          '<span aria-hidden="true">' + ic + '</span> ' + n + '</button>').join('') +
      '</div>' +
      '<label for="ct-msg">Mensagem</label>' +
      '<textarea id="ct-msg" name="mensagem" maxlength="' + MAX + '" placeholder="Escreva aqui…">' + esc(rascunho.mensagem) + '</textarea>' +
      '<p class="campo-ajuda contador js-cont"></p>' +
      '<button class="big primary js-enviar" type="submit" style="margin-top:10px">Enviar</button>' +
    '</form>' +
    '<div class="card ok-card js-ok" hidden>' +
      '<b class="js-ok-tit">Mensagem enviada! ✓</b>' +
      '<p class="js-ok-txt">A equipe vai falar com você pelo WhatsApp em breve.</p>' +
      '<button class="big primary js-voltar" type="button">Voltar</button>' +
      '<button class="big js-outra" type="button">Mandar outra mensagem</button>' +
    '</div>';

  const f = el.querySelector('.js-form');
  const btn = el.querySelector('.js-enviar');
  const cont = el.querySelector('.js-cont');
  const contar = () => { cont.textContent = f.mensagem.value.length + ' de ' + MAX + ' letras'; };
  contar();

  el.querySelectorAll('[data-motivo]').forEach(b => b.addEventListener('click', () => {
    rascunho.motivo = b.dataset.motivo;
    el.querySelectorAll('[data-motivo]').forEach(x => {
      const on = x === b;
      x.classList.toggle('on', on);
      x.setAttribute('aria-checked', on);
    });
  }));
  f.mensagem.addEventListener('input', () => { rascunho.mensagem = f.mensagem.value; contar(); });
  el.querySelectorAll('.js-voltar').forEach(b => b.addEventListener('click', () => ctx.ir(voltarPara)));
  el.querySelector('.js-outra').addEventListener('click', () => montar(el, ctx));

  let enviando = false;
  f.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (enviando) return; // evita envio duplo
    const motivo = rascunho.motivo;
    const mensagem = f.mensagem.value.trim().slice(0, MAX);
    if (!motivo) { ctx.toast('Escolha: Dúvida, Sugestão ou Benefícios.', 'erro'); el.querySelector('[data-motivo]').focus(); return; }
    if (mensagem.length < 3) { ctx.toast('Escreva a sua mensagem.', 'erro'); f.mensagem.focus(); return; }
    if (!ctx.estado.uid) { ctx.toast('Você precisa entrar na sua conta.', 'erro'); return; }

    enviando = true;
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const pedido = {
        uid: ctx.estado.uid,
        nome: u.nome || '',
        whatsapp: u.whatsapp || '',
        motivo,
        mensagem,
        status: 'novo',
        criadoEm: fs.serverTimestamp()
      };
      const r = await comPrazo(fs.addDoc(fs.collection(db, 'pedidosContato'), pedido), 12000);
      rascunho = { motivo: '', mensagem: '' };
      f.hidden = true;
      el.querySelector('.js-ok').hidden = false;
      if (r === 'fila') {
        el.querySelector('.js-ok-tit').textContent = 'Mensagem guardada';
        el.querySelector('.js-ok-txt').textContent = 'Você está sem internet agora. A mensagem fica guardada no aparelho e é enviada sozinha quando a internet voltar.';
      }
      ctx.toast(r === 'fila' ? 'Mensagem guardada' : 'Mensagem enviada!', 'ok');
    } catch (e) {
      ctx.toast(traduzErro(e), 'erro');
      enviando = false;
      btn.disabled = false;
      btn.textContent = 'Enviar';
    }
  });
}

function formatar(d) {
  d = String(d).replace(/\D/g, '');
  if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
  if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
  return d;
}
