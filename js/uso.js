/*
  Arquivo: js/uso.js
  Versão: 1.1.1
  Sessão: 10 — Revisão (1.1.0 era da Sessão 8, 1.0.0 da Sessão 1)
  Data: 15/10/2026
  1.1.1: pararUso() espera no máximo 3 s pelo servidor. Sem internet a gravação
         fica na fila do aparelho e o "Sair" não trava mais esperando o sinal.
  Coleta de uso do app, desde o primeiro dia.

  1.1.0:
    - registrarEnvio(): +1 em orcamentosEnviados no dia e, em resumos/{uid},
      totalEnviados (+1) e ultimoEnvioEm. Grava na hora.
    - resumos/{uid}.ultimoUsoEm (hora do servidor) uma vez por dia, na primeira
      abertura do dia (marca no navegador: print.ultimoUsoDia = "AAAA-MM-DD|uid").
    - O dia agora é o de Brasília (America/Sao_Paulo), não o do relógio do
      aparelho: diaBrasilia() (o painel usa a mesma função).
    - Recarregar a página (ou o login do Google, que recarrega) até 30 minutos
      depois da última atividade não conta abertura nova, igual a voltar de
      um app escondido (marca no navegador: print.usoUltimo = { uid, t, dia }).
      No dia novo a primeira abertura sempre conta.
    - Ao esconder o app, os últimos segundos visíveis passaram a contar (antes
      o navegador já dizia "escondido" e eles se perdiam). Escondido continua
      sem contar nada.

  Grava em uso/{uid}/dias/{AAAA-MM-DD}, sempre somando (increment):
    aberturas           nova abertura ao abrir o app, ou ao voltar depois de
                        mais de 30 minutos escondido/fechado
    segundosAtivos      só conta com o app visível E com toque/tecla/rolagem
                        nos últimos 60 segundos
    orcamentosCriados   somado por registrarOrcamento(valor) (na prática: concluídos)
    valorOrcado         somado por registrarOrcamento(valor)
    orcamentosEnviados  somado por registrarEnvio() (1.1.0)
    atualizadoEm        hora do servidor da última gravação (ajuda o painel)

  Grava no máximo a cada 5 minutos, ao esconder/fechar o app e ao marcar envio.
  Só roda para usuário com status "ativo" (as regras também exigem isso).
  Se o dia virar com o app aberto, cada número vai para o dia certo.

  Contrato: iniciarUso(ctx), registrarOrcamento(valor), registrarEnvio(), pararUso()
  Extras:   diaBrasilia(data), gravarUsoAgora(), infoUso()
*/

import { db, fs } from './firebase.js';
import { hojeISO, num } from './utils.js';

const INTERVALO_GRAVACAO = 5 * 60 * 1000; // 5 minutos
const JANELA_TOQUE = 60 * 1000;           // toque nos últimos 60 s
const NOVA_ABERTURA = 30 * 60 * 1000;     // escondido/fechado por mais de 30 min
const PASSO_RELOGIO = 5 * 1000;           // confere o tempo ativo a cada 5 s
const CHAVE_DIA = 'print.ultimoUsoDia';   // 1.1.0
const CHAVE_ULTIMO = 'print.usoUltimo';   // 1.1.0

let uid = null;
let rodando = false;
let pendente = {};          // { '2026-10-14': { aberturas, ms, orcamentosCriados, valorOrcado, orcamentosEnviados } }
let ultimoToque = 0;
let ultimoMarco = 0;        // até onde o tempo ativo já foi contado
let escondidoDesde = 0;
let relogio = null;
let gravador = null;
let ultimaGravacao = null;  // { quando: Date, ok: boolean, erro?: string }
let bloqueado = false;      // sem permissão: para de tentar
let gravandoDia = '';       // 1.1.0: ultimoUsoEm em andamento para este dia

const EVENTOS_TOQUE = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];

/* ---------- Dia de Brasília (1.1.0) ---------- */
let fmtBrasilia = null;
try {
  fmtBrasilia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
} catch (e) { fmtBrasilia = null; }

/** Data no fuso de Brasília: "2026-10-15". Sem suporte ao fuso, usa o relógio do aparelho. */
export function diaBrasilia(d = new Date()) {
  if (fmtBrasilia) {
    try {
      const p = {};
      fmtBrasilia.formatToParts(d).forEach(x => { p[x.type] = x.value; });
      if (p.year && p.month && p.day) return p.year + '-' + p.month + '-' + p.day;
    } catch (e) { /* cai no relógio do aparelho */ }
  }
  return hojeISO(d);
}

/* ---------- Marcas no navegador (1.1.0) ---------- */
function lerLocal(chave) {
  try { return localStorage.getItem(chave); } catch (e) { return null; }
}
function gravarLocal(chave, valor) {
  try { localStorage.setItem(chave, valor); } catch (e) { /* ignora */ }
}

/** Guarda a hora da última atividade (para recarregar não virar abertura nova). */
function marcarAtividade() {
  if (uid) gravarLocal(CHAVE_ULTIMO, JSON.stringify({ uid, t: Date.now(), dia: diaBrasilia() }));
}

/** Recarregou a página pouco depois de usar? Então não é abertura nova. */
function eContinuacao(meuUid) {
  try {
    const m = JSON.parse(lerLocal(CHAVE_ULTIMO) || 'null');
    return !!m && m.uid === meuUid && m.dia === diaBrasilia() // dia novo sempre conta abertura
      && Date.now() - Number(m.t) < NOVA_ABERTURA && Number(m.t) <= Date.now();
  } catch (e) { return false; }
}

/** resumos/{uid}.ultimoUsoEm uma vez por dia. */
function marcarUsoDoDia() {
  if (!uid || bloqueado) return;
  const hoje = diaBrasilia();
  const marca = hoje + '|' + uid;
  if (lerLocal(CHAVE_DIA) === marca || gravandoDia === marca) return;
  gravandoDia = marca;
  const meu = uid;
  try {
    fs.setDoc(fs.doc(db, 'resumos', meu), { ultimoUsoEm: fs.serverTimestamp() }, { merge: true })
      .then(() => { gravarLocal(CHAVE_DIA, marca); })
      .catch(e => { console.warn('[Print] último uso', e); })
      .finally(() => { if (gravandoDia === marca) gravandoDia = ''; });
  } catch (e) { gravandoDia = ''; console.warn('[Print] último uso', e); }
}

/* ---------- Contagem ---------- */
function dia(d = diaBrasilia()) {
  if (!pendente[d]) pendente[d] = { aberturas: 0, ms: 0, orcamentosCriados: 0, valorOrcado: 0, orcamentosEnviados: 0 };
  return pendente[d];
}

function visivel() {
  return document.visibilityState === 'visible';
}

/**
 * Soma o tempo ativo desde o último marco (só se visível e com toque recente).
 * acabouDeEsconder = true no instante em que o app é escondido: o navegador já
 * diz "hidden", mas o trecho até agora foi visível e conta (1.1.0).
 */
function contarTempo(acabouDeEsconder = false) {
  const agora = Date.now();
  if (acabouDeEsconder || visivel()) {
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
    marcarUsoDoDia();      // 1.1.0: pode ser outro dia
  } else if (!escondidoDesde) {
    contarTempo(true);     // 1.1.0: conta até o instante de esconder
    escondidoDesde = Date.now();
    marcarAtividade();
    gravar().catch(() => {}); // grava ao esconder o app
  }
}

function aoSairDaPagina() {
  if (!rodando) return;
  if (!escondidoDesde) contarTempo(true);
  marcarAtividade();
  gravar().catch(() => {});
}

/** Envia o que está pendente. Devolve uma promessa (resolve quando o servidor confirma). */
function gravar() {
  if (!uid || bloqueado) return Promise.resolve(false);
  if (!escondidoDesde) contarTempo();
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
    if (p.orcamentosEnviados) campos.orcamentosEnviados = fs.increment(p.orcamentosEnviados); // 1.1.0
    if (!Object.keys(campos).length) continue;
    campos.atualizadoEm = fs.serverTimestamp();

    const ref = fs.doc(db, 'uso', uid, 'dias', data);
    envios.push(
      fs.setDoc(ref, campos, { merge: true })
        .then(() => { ultimaGravacao = { quando: new Date(), ok: true }; })
        .catch(e => {
          ultimaGravacao = { quando: new Date(), ok: false, erro: e?.code || String(e) };
          if (e?.code === 'permission-denied') {
            bloqueado = true; // usuário não está ativo (ou regras antigas): não insiste
          } else {
            // Falhou de vez: devolve os números para tentar na próxima gravação.
            const v = dia(data);
            v.aberturas += p.aberturas;
            v.ms += seg * 1000;
            v.orcamentosCriados += p.orcamentosCriados;
            v.valorOrcado += p.valorOrcado;
            v.orcamentosEnviados += p.orcamentosEnviados;
          }
          throw e;
        })
    );
  }
  marcarAtividade();
  marcarUsoDoDia(); // 1.1.0: se o dia virou com o app aberto
  if (!envios.length) return Promise.resolve(true);
  return Promise.all(envios).then(() => true);
}

/**
 * Começa a coleta. ctx é o contexto do app (precisa de ctx.estado).
 * Só roda se o usuário estiver com status "ativo".
 * Chamar de novo para o mesmo usuário (ex.: depois de salvar o perfil) não faz nada.
 */
export function iniciarUso(ctx) {
  const est = ctx?.estado;
  if (!est?.uid || est?.usuario?.status !== 'ativo') return false;
  if (rodando && uid === est.uid) return true;
  if (rodando) pararUso();

  const continuacao = eContinuacao(est.uid); // 1.1.0: antes de marcar a atividade nova
  uid = est.uid;
  rodando = true;
  bloqueado = false;
  pendente = {};
  const agora = Date.now();
  ultimoToque = agora;   // abrir o app conta como toque
  ultimoMarco = agora;
  escondidoDesde = visivel() ? 0 : agora;
  if (!continuacao) dia().aberturas += 1;  // esta abertura
  marcarAtividade();
  marcarUsoDoDia();      // 1.1.0

  EVENTOS_TOQUE.forEach(ev => window.addEventListener(ev, aoTocar, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', aoMudarVisibilidade);
  window.addEventListener('pagehide', aoSairDaPagina);
  relogio = setInterval(() => { if (!escondidoDesde) contarTempo(); }, PASSO_RELOGIO);
  gravador = setInterval(() => { gravar().catch(() => {}); }, INTERVALO_GRAVACAO);
  return true;
}

/** Chamar uma vez por orçamento, quando ele é concluído (Sessão 6). */
export function registrarOrcamento(valor) {
  if (!rodando) return;
  const p = dia();
  p.orcamentosCriados += 1;
  p.valorOrcado += num(valor);
}

/**
 * 1.1.0 — Chamar uma vez por orçamento, quando o pintor marca como Enviado
 * (pdf.js, que confere o contadoEnvio do orçamento). Soma no dia e no resumo,
 * e grava na hora. Devolve true se contou.
 */
export function registrarEnvio() {
  if (!rodando || !uid) return false;
  dia().orcamentosEnviados += 1;
  try {
    fs.setDoc(fs.doc(db, 'resumos', uid),
      { totalEnviados: fs.increment(1), ultimoEnvioEm: fs.serverTimestamp() }, { merge: true })
      .catch(e => console.warn('[Print] resumo de envios', e));
  } catch (e) { console.warn('[Print] resumo de envios', e); }
  gravar().catch(() => {});
  return true;
}

/** Para a coleta (ao sair da conta). Grava o que faltava antes de parar. */
export function pararUso() {
  if (!rodando) return Promise.resolve(false);
  // 1.1.1: sem internet o setDoc só termina quando o sinal volta; não segura o Sair.
  const promessa = Promise.race([
    gravar().catch(() => false),
    new Promise(ok => setTimeout(() => ok(false), 3000))
  ]);
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

/** Grava já (sem esperar os 5 minutos). Para conferência. */
export function gravarUsoAgora() {
  if (!rodando) return Promise.reject(new Error('A coleta de uso não está rodando (usuário não está ativo).'));
  return gravar();
}

/** Situação da coleta, para conferência. */
export function infoUso() {
  return { rodando, uid, bloqueado, ultimaGravacao, pendente: JSON.parse(JSON.stringify(pendente)) };
}
