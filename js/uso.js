/*
  Arquivo: js/uso.js
  Versão: 1.0.0
  Sessão: 1 — Base do projeto
  Data: 14/10/2026
  Coleta de uso do app, desde o primeiro dia.

  Grava em uso/{uid}/dias/{AAAA-MM-DD}, sempre somando (increment):
    aberturas          nova abertura ao abrir o app, ou ao voltar depois de
                       mais de 30 minutos escondido
    segundosAtivos     só conta com o app visível E com toque/tecla/rolagem
                       nos últimos 60 segundos
    orcamentosCriados  somado por registrarOrcamento(valor)
    valorOrcado        somado por registrarOrcamento(valor)
    atualizadoEm       hora do servidor da última gravação (extra, ajuda o painel)

  Grava no máximo a cada 5 minutos e ao esconder/fechar o app.
  Só roda para usuário com status "ativo" (as regras também exigem isso).
  Se o dia virar com o app aberto, cada número vai para o dia certo.

  Contrato: iniciarUso(ctx), registrarOrcamento(valor), pararUso()
  Extras:   gravarUsoAgora() (usado pela tela de diagnóstico), infoUso()
*/

import { db, fs } from './firebase.js';
import { hojeISO, num } from './utils.js';

const INTERVALO_GRAVACAO = 5 * 60 * 1000; // 5 minutos
const JANELA_TOQUE = 60 * 1000;           // toque nos últimos 60 s
const NOVA_ABERTURA = 30 * 60 * 1000;     // escondido por mais de 30 min
const PASSO_RELOGIO = 5 * 1000;           // confere o tempo ativo a cada 5 s

let uid = null;
let rodando = false;
let pendente = {};          // { '2026-10-14': { aberturas, ms, orcamentosCriados, valorOrcado } }
let ultimoToque = 0;
let ultimoMarco = 0;        // até onde o tempo ativo já foi contado
let escondidoDesde = 0;
let relogio = null;
let gravador = null;
let ultimaGravacao = null;  // { quando: Date, ok: boolean, erro?: string }
let bloqueado = false;      // sem permissão: para de tentar

const EVENTOS_TOQUE = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];

function dia(d = hojeISO()) {
  if (!pendente[d]) pendente[d] = { aberturas: 0, ms: 0, orcamentosCriados: 0, valorOrcado: 0 };
  return pendente[d];
}

function visivel() {
  return document.visibilityState === 'visible';
}

/** Soma o tempo ativo desde o último marco (só se visível e com toque recente). */
function contarTempo() {
  const agora = Date.now();
  if (visivel()) {
    const fim = Math.min(agora, ultimoToque + JANELA_TOQUE);
    if (fim > ultimoMarco) dia().ms += fim - ultimoMarco;
  }
  ultimoMarco = agora;
}

function aoTocar() {
  const agora = Date.now();
  // Se ficou parado (sem toque) por mais de 60 s, o tempo parado não conta.
  if (agora - ultimoToque > JANELA_TOQUE) {
    contarTempo();
    ultimoMarco = agora;
  }
  ultimoToque = agora;
}

function aoMudarVisibilidade() {
  if (!rodando) return;
  if (visivel()) {
    const agora = Date.now();
    if (escondidoDesde && agora - escondidoDesde > NOVA_ABERTURA) dia().aberturas += 1;
    escondidoDesde = 0;
    ultimoMarco = agora;   // o tempo escondido não conta
    ultimoToque = agora;   // voltar ao app conta como toque
  } else {
    contarTempo();
    escondidoDesde = Date.now();
    gravar();              // grava ao esconder o app
  }
}

function aoSairDaPagina() {
  if (!rodando) return;
  contarTempo();
  gravar();
}

/** Envia o que está pendente. Devolve uma promessa (resolve quando o servidor confirma). */
function gravar() {
  if (!uid || bloqueado) return Promise.resolve(false);
  contarTempo();
  const lote = pendente;
  pendente = {};
  const envios = [];

  for (const [data, p] of Object.entries(lote)) {
    const seg = Math.floor(p.ms / 1000);
    const sobra = p.ms - seg * 1000;
    if (sobra > 0) dia(data).ms += sobra; // guarda os milissegundos para a próxima

    const campos = {};
    if (p.aberturas) campos.aberturas = fs.increment(p.aberturas);
    if (seg) campos.segundosAtivos = fs.increment(seg);
    if (p.orcamentosCriados) campos.orcamentosCriados = fs.increment(p.orcamentosCriados);
    if (p.valorOrcado) campos.valorOrcado = fs.increment(Math.round(p.valorOrcado * 100) / 100);
    if (!Object.keys(campos).length) continue;
    campos.atualizadoEm = fs.serverTimestamp();

    const ref = fs.doc(db, 'uso', uid, 'dias', data);
    envios.push(
      fs.setDoc(ref, campos, { merge: true })
        .then(() => { ultimaGravacao = { quando: new Date(), ok: true }; })
        .catch(e => {
          ultimaGravacao = { quando: new Date(), ok: false, erro: e?.code || String(e) };
          if (e?.code === 'permission-denied') {
            bloqueado = true; // usuário não está ativo: não insiste
          } else {
            // Falhou de vez: devolve os números para tentar na próxima gravação.
            const v = dia(data);
            v.aberturas += p.aberturas;
            v.ms += seg * 1000;
            v.orcamentosCriados += p.orcamentosCriados;
            v.valorOrcado += p.valorOrcado;
          }
          throw e;
        })
    );
  }
  if (!envios.length) return Promise.resolve(true);
  return Promise.all(envios).then(() => true);
}

/**
 * Começa a coleta. ctx é o contexto do app (precisa de ctx.estado).
 * Só roda se o usuário estiver com status "ativo".
 */
export function iniciarUso(ctx) {
  const est = ctx?.estado;
  if (!est?.uid || est?.usuario?.status !== 'ativo') return false;
  if (rodando && uid === est.uid) return true;
  if (rodando) pararUso();

  uid = est.uid;
  rodando = true;
  bloqueado = false;
  pendente = {};
  const agora = Date.now();
  ultimoToque = agora;   // abrir o app conta como toque
  ultimoMarco = agora;
  escondidoDesde = visivel() ? 0 : agora;
  dia().aberturas += 1;  // esta abertura

  EVENTOS_TOQUE.forEach(ev => window.addEventListener(ev, aoTocar, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', aoMudarVisibilidade);
  window.addEventListener('pagehide', aoSairDaPagina);
  relogio = setInterval(contarTempo, PASSO_RELOGIO);
  gravador = setInterval(() => { gravar().catch(() => {}); }, INTERVALO_GRAVACAO);
  return true;
}

/** Chamar quando um orçamento for criado (Sessão 6). */
export function registrarOrcamento(valor) {
  if (!rodando) return;
  const p = dia();
  p.orcamentosCriados += 1;
  p.valorOrcado += num(valor);
}

/** Para a coleta (ao sair da conta). Grava o que faltava antes de parar. */
export function pararUso() {
  if (!rodando) return Promise.resolve(false);
  const promessa = gravar().catch(() => false);
  rodando = false;
  EVENTOS_TOQUE.forEach(ev => window.removeEventListener(ev, aoTocar, { capture: true }));
  document.removeEventListener('visibilitychange', aoMudarVisibilidade);
  window.removeEventListener('pagehide', aoSairDaPagina);
  clearInterval(relogio);
  clearInterval(gravador);
  relogio = gravador = null;
  uid = null;
  pendente = {};
  return promessa;
}

/** Grava já (sem esperar os 5 minutos). Usado só pela tela de diagnóstico. */
export function gravarUsoAgora() {
  if (!rodando) return Promise.reject(new Error('A coleta de uso não está rodando (usuário não está ativo).'));
  return gravar();
}

/** Situação da coleta, para conferência. */
export function infoUso() {
  return { rodando, uid, bloqueado, ultimaGravacao, pendente: JSON.parse(JSON.stringify(pendente)) };
}
