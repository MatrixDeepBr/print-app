/*
  Arquivo: js/master.js
  Versão: 1.3.0
  Sessão: 8 — Refinamento do relatório de uso (1.2.0 era da 4B, 1.1.0 da 3B, 1.0.0 da Sessão 3)
  Data: 15/10/2026
  1.3.0: aba Uso refeita: resumo do mês (somado do uso/dias, o dia 1º começa
         do zero), gráfico de 14 dias, fichas (Todos, Quem chamar hoje, Sem uso
         há 7 dias, Sumidos há 30 dias, Maiores volumes, Liberados hoje sem uso)
         com contagem, ficha do pintor com gráfico de minutos e orçamentos,
         orçamentos enviados e última atividade (resumos.ultimoUsoEm).
         Datas do relatório no fuso de Brasília (diaBrasilia do uso.js).
  1.2.0: profissões na lista e na ficha (⋯ Ações), filtro por profissão;
         selo "⚠️ Possível conta repetida" e filtro (contaRepetidaAparelho);
         na ficha, "Liberar este WhatsApp" (apaga telefones/{numero}, exige
         digitar LIBERAR) e o jeito de entrar (Google ou e-mail).
  Painel do dono (só para quem está em admins/{uid}). Pensado para o celular, com uma mão.

  Abas:
    Usuários  pendentes no topo (Liberar / Recusar), busca, filtro por status
              e "Liberados hoje", selo auto/manual, ações: bloquear, reativar,
              mudar plano, estender o Pro, notas
    Pedidos   pedidos de contato (novo, atendido, parceiro), WhatsApp, notas
    Uso       mês corrente + últimos 14 dias, gráfico, fichas de filtro e ficha do pintor
    Empresa   dados da empresa (config/empresa), mostrados nos Termos
    Ajustes   chave Liberação automática (com os minutos), mensagemPendente,
              diasTesteProPadrao e "Ativar teste Pro para todos"

  O painel lê SÓ: users, resumos, uso (collectionGroup 'dias'), pedidosContato,
  masterNotas, config e telefones/{numero} (1.2.0, só ao abrir Liberar este WhatsApp). Nunca lê as subcoleções de users (clientes, orçamentos).

  Contrato: montar(container, ctx), desmontar()
  Extra:    CRITERIOS (constantes do relatório, fáceis de mudar)

  Campos gravados:
    users/{uid}:        status, liberadoEm, testeProPendente, liberadoPor ('manual'), plano, proAte
    masterNotas/{uid}:  notas, tags, ultimoContato, parceiro, codigo, atualizadoEm
    pedidosContato/{id}: status
    telefones/{numero}: apaga (Liberar este WhatsApp, 1.2.0)
    config/app:         mensagemPendente, diasTesteProPadrao,
                        liberacaoAutomatica, autoMinutosMin, autoMinutosMax (1.1.0)
    config/empresa:     nome, cnpj, endereco, responsavelDados, email, telefone, atualizadoEm
  Nunca grava users/{uid}.codigoParceiro (é a indicação digitada pelo pintor).
*/

import { db, fs } from './firebase.js';
import { formatarWhats, PROFISSOES, lerEspecialidades, nomesProfissoes } from './auth.js'; // 1.2.0: + profissões
import { segundosDaVez, lerMinutos } from './status.js'; // 1.1.0: mesmo sorteio do aparelho do pintor
import { diaBrasilia } from './uso.js'; // 1.3.0: o mesmo dia que o aparelho do pintor grava

/* ============================================================
   1. Critérios do relatório (mude aqui quando quiser)
   ============================================================ */
export const CRITERIOS = {
  diasRelatorio: 14,   // período do relatório de uso
  janelaChamar: 7,     // "Quem chamar hoje": olhar os últimos N dias...
  minDiasChamar: 3,    // ...e listar quem usou o app em pelo menos N desses dias
  // Pontos do ranking de engajamento (no período do relatório):
  pontosPorDia: 10,        // cada dia em que abriu o app
  pontosPorMinuto: 1,      // cada minuto de uso ativo
  pontosPorOrcamento: 5,   // cada orçamento concluído
  pontosPorEnvio: 8,       // 1.3.0: cada orçamento marcado como enviado
  // Fichas da aba Uso (1.3.0):
  diasSemUso: 7,           // "Sem uso há N dias": usava e parou há N dias ou mais...
  diasSumido: 30           // ...até "Sumidos há N dias" (daí em diante)
};

const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0, O, 1, I e L
const TAGS_RAPIDAS = ['interessado', 'usa muito', 'indicou alguém', 'sem resposta', 'compra na loja'];
const DIA_MS = 24 * 60 * 60 * 1000;

const ABAS = [
  ['usuarios', '👥', 'Usuários'],
  ['pedidos', '💬', 'Pedidos'],
  ['uso', '📊', 'Uso'],
  ['empresa', '🏢', 'Empresa'],
  ['ajustes', '⚙️', 'Ajustes']
];

const STATUS = {
  pendente: ['⏳', 'Pendente'],
  ativo: ['✅', 'Ativo'],
  recusado: ['🚫', 'Recusado'],
  bloqueado: ['🔒', 'Bloqueado']
};

const MOTIVOS = { duvida: '❓ Dúvida', sugestao: '💡 Sugestão', beneficios: '🤝 Benefícios' };
const STATUS_PEDIDO = [['novo', 'Novo'], ['atendido', 'Atendido'], ['parceiro', 'Parceiro']];

/* ============================================================
   2. Estado da tela
   ============================================================ */
let S = null;

function novoEstado(el, ctx) {
  return {
    el, ctx,
    aba: lerAba(),
    users: new Map(),     // uid -> dados
    notas: new Map(),     // uid -> masterNotas
    pedidos: [],          // [{ id, ...dados }]
    config: null,         // config/app (ao vivo, 1.1.0)
    prontos: { users: false, notas: false, pedidos: false },
    erroLista: null,
    filtro: 'todos',
    filtroProf: 'todas',  // 1.2.0
    busca: '',
    filtroPedidos: 'novo',
    uso: null,            // resultado do relatório
    filtroUso: 'todos',   // 1.3.0: ficha escolhida na aba Uso
    usoErro: null,
    usoCarregando: false,
    unsubs: [],
    folha: null,
    agendado: false
  };
}

function lerAba() {
  try {
    const a = localStorage.getItem('print.masterAba');
    return ABAS.some(x => x[0] === a) ? a : 'usuarios';
  } catch (e) { return 'usuarios'; }
}
function guardarAba(a) {
  try { localStorage.setItem('print.masterAba', a); } catch (e) { /* ignora */ }
}

/* ============================================================
   3. Ajudantes
   ============================================================ */
const U = () => S.ctx.utils;
const esc = s => S.ctx.utils.esc(s);

function toast(msg, tipo) { S?.ctx.toast(msg, tipo); }

/** Espera o servidor confirmar; sem internet, a gravação fica na fila do aparelho. */
function comPrazo(promessa, ms = 12000) {
  return Promise.race([
    promessa.then(() => 'ok'),
    new Promise(res => setTimeout(() => res('fila'), ms))
  ]);
}

/** Grava e avisa. Devolve true se deu certo (ou ficou na fila). */
async function gravar(promessa, msgOk) {
  try {
    const r = await comPrazo(promessa);
    toast(r === 'fila' ? 'Sem internet: fica guardado e envia quando a conexão voltar.' : msgOk, 'ok');
    return true;
  } catch (e) {
    console.error('[Print] painel master', e);
    toast(U().traduzErro(e), 'erro');
    return false;
  }
}

function ts(data) { return fs.Timestamp.fromDate(data); }

/** Data daqui a N dias, no fim do dia (23:59:59). */
function daquiADias(n, base = new Date()) {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + n);
  d.setHours(23, 59, 59, 0);
  return d;
}

function dataHora(d) {
  const x = U().paraData(d);
  if (!x) return '';
  return x.toLocaleDateString('pt-BR') + ' ' + x.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** "há 3 dias", "hoje", "ontem" (1.3.0: contado pelos dias de Brasília). */
function haQuanto(d) {
  const x = U().paraData(d);
  if (!x) return '';
  const n = diasEntre(diaBrasilia(x), diaBrasilia());
  if (n <= 0) return 'hoje';
  if (n === 1) return 'ontem';
  return 'há ' + n + ' dias';
}

function soDigitos(s) { return String(s ?? '').replace(/\D/g, ''); }

/** Link do WhatsApp com uma saudação neutra (primeiro contato é para ajudar). */
function linkZap(whats, nome) {
  let d = soDigitos(whats);
  if (d.length < 10) return '';
  if (d.length <= 11) d = '55' + d;
  const p = U().primeiroNome(nome, '');
  const txt = (p ? 'Olá, ' + p + '!' : 'Olá!') + ' Aqui é da equipe do Print.';
  return 'https://wa.me/' + d + '?text=' + encodeURIComponent(txt);
}

function botaoZap(whats, nome, classe = 'mt-btn zap') {
  const l = linkZap(whats, nome);
  if (!l) return '<span class="mt-btn desligado" aria-disabled="true">Sem WhatsApp</span>';
  return '<a class="' + classe + '" href="' + esc(l) + '" target="_blank" rel="noopener">🟢 WhatsApp</a>';
}

function nomeDe(uid, reserva = 'Sem nome') {
  return S.users.get(uid)?.nome || S.pedidos.find(p => p.uid === uid)?.nome || reserva;
}

function ehParceiro(uid) { return !!S.notas.get(uid)?.parceiro; }

function seloStatus(s) {
  const [ic, txt] = STATUS[s] || STATUS.pendente;
  return '<span class="selo st-' + esc(s || 'pendente') + '">' + ic + ' ' + txt + '</span>';
}

function textoPlano(u) {
  const ate = U().paraData(u.proAte);
  const venceu = ate && ate.getTime() <= Date.now();
  if (u.plano === 'pro') return ate ? 'Pro até ' + U().dataBR(ate) + (venceu ? ' (vencido)' : '') : 'Pro sem vencimento';
  if (u.plano === 'teste_pro') return ate ? 'Teste Pro até ' + U().dataBR(ate) + (venceu ? ' (vencido)' : '') : 'Teste Pro (sem data)';
  return 'Free' + (u.testeProPendente ? ' · teste Pro guardado' : '');
}

function seloPlano(u) {
  const pro = U().planoEfetivo(u) === 'pro';
  return '<span class="selo ' + (pro ? 'pl-pro' : 'pl-free') + '">' + esc(textoPlano(u)) + '</span>';
}

function seloParceiro(uid) {
  const n = S.notas.get(uid);
  return n?.parceiro ? '<span class="selo pl-parceiro">⭐ Parceiro' + (n.codigo ? ' · ' + esc(n.codigo) : '') + '</span>' : '';
}

/** Mostra o link do índice quando o Firebase pede (erro failed-precondition). */
function avisoIndice(e) {
  const url = String(e?.message || '').match(/https:\/\/console\.firebase\.google\.com\S+/);
  if (e?.code !== 'failed-precondition' || !url) return null;
  return '<div class="card mt-alerta">' +
    '<b>O Firebase precisa criar um índice (só uma vez)</b>' +
    '<p>1. Toque no botão abaixo. Abre o console do Firebase.</p>' +
    '<p>2. Clique em <b>Salvar</b> (ou Criar índice).</p>' +
    '<p>3. Espere uns 5 minutos e toque em <b>Atualizar</b> aqui.</p>' +
    '<a class="big primary" href="' + esc(url[0].replace(/[)\].,]+$/, '')) + '" target="_blank" rel="noopener">Abrir o link do índice</a>' +
    '</div>';
}

/* ============================================================
   4. Montar e desmontar
   ============================================================ */
export async function montar(el, ctx) {
  desmontar();
  S = novoEstado(el, ctx);
  el.classList.add('larga', 'master');
  el.innerHTML =
    '<h1>Painel master</h1>' +
    '<nav class="mt-abas" aria-label="Partes do painel">' +
      ABAS.map(([k, ic, n]) =>
        '<button type="button" class="mt-aba" data-aba="' + k + '">' +
        '<span class="ic" aria-hidden="true">' + ic + '</span><span>' + n + '</span>' +
        '<i class="mt-badge js-badge-' + k + '" hidden></i></button>').join('') +
    '</nav>' +
    '<div class="js-aba"></div>';

  garantirCssUso(); // 1.3.0
  el.addEventListener('click', aoClicar);
  el.addEventListener('input', aoDigitar);
  el.addEventListener('submit', aoEnviar);
  document.addEventListener('keydown', aoTecla);

  assinar();
  desenharAba();
}

export function desmontar() {
  if (!S) return;
  S.unsubs.forEach(f => { try { f(); } catch (e) { /* ignora */ } });
  fecharFolha();
  S.el.removeEventListener('click', aoClicar);
  S.el.removeEventListener('input', aoDigitar);
  S.el.removeEventListener('submit', aoEnviar);
  document.removeEventListener('keydown', aoTecla);
  S = null;
}

/** Dados ao vivo: users, masterNotas e pedidosContato. */
function assinar() {
  const erro = qual => e => {
    console.error('[Print] painel ' + qual, e);
    if (!S) return;
    S.erroLista = e;
    S.prontos[qual] = true;
    agendar();
  };
  S.unsubs.push(fs.onSnapshot(fs.collection(db, 'users'), snap => {
    if (!S) return;
    S.users = new Map(snap.docs.map(d => [d.id, d.data()]));
    S.prontos.users = true;
    S.erroLista = null;
    agendar();
  }, erro('users')));
  S.unsubs.push(fs.onSnapshot(fs.collection(db, 'masterNotas'), snap => {
    if (!S) return;
    S.notas = new Map(snap.docs.map(d => [d.id, d.data()]));
    S.prontos.notas = true;
    agendar();
  }, erro('notas')));
  S.unsubs.push(fs.onSnapshot(fs.query(fs.collection(db, 'pedidosContato'), fs.orderBy('criadoEm', 'desc')), snap => {
    if (!S) return;
    S.pedidos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    S.prontos.pedidos = true;
    agendar();
  }, erro('pedidos')));
  // 1.1.0: config/app ao vivo (chave da liberação automática e minutos)
  S.unsubs.push(fs.onSnapshot(fs.doc(db, 'config', 'app'), snap => {
    if (!S) return;
    S.config = snap.exists() ? snap.data() : {};
    agendar();
  }, e => console.warn('[Print] painel config/app', e)));
}

/** Junta várias mudanças seguidas num redesenho só. */
function agendar() {
  if (!S || S.agendado) return;
  S.agendado = true;
  requestAnimationFrame(() => {
    if (!S) return;
    S.agendado = false;
    atualizarBadges();
    atualizarAba();
    atualizarFolhaAberta();
  });
}

function atualizarBadges() {
  const pend = [...S.users.values()].filter(u => (u.status || 'pendente') === 'pendente').length;
  const novos = S.pedidos.filter(p => (p.status || 'novo') === 'novo').length;
  const por = (k, n) => {
    const b = S.el.querySelector('.js-badge-' + k);
    if (!b) return;
    b.hidden = !n;
    b.textContent = n > 99 ? '99+' : String(n);
  };
  por('usuarios', pend);
  por('pedidos', novos);
}

/* ============================================================
   5. Abas
   ============================================================ */
function desenharAba() {
  S.el.querySelectorAll('[data-aba]').forEach(b => {
    const on = b.dataset.aba === S.aba;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const box = S.el.querySelector('.js-aba');
  if (S.aba === 'usuarios') {
    box.innerHTML =
      '<div class="js-pend"></div>' +
      '<h2>Todos os usuários</h2>' +
      '<label class="mt-oculto" for="mt-busca">Buscar por nome</label>' +
      '<input id="mt-busca" class="js-busca" type="search" placeholder="🔍 Buscar por nome, cidade ou WhatsApp" autocomplete="off" value="' + esc(S.busca) + '">' +
      '<div class="qk mt-filtros" role="group" aria-label="Filtrar por status">' +
        [['todos', 'Todos'], ['hoje', 'Liberados hoje'], ['ativo', 'Ativos'], ['pendente', 'Pendentes'], ['bloqueado', 'Bloqueados'], ['recusado', 'Recusados'], ['repetida', '⚠️ Possível conta repetida']]
          .map(([k, n]) => '<button type="button" data-filtro="' + k + '" class="' + (S.filtro === k ? 'on' : '') + '" aria-pressed="' + (S.filtro === k) + '">' + n + '</button>').join('') +
      '</div>' +
      // 1.2.0: filtro por profissão
      '<div class="qk mt-filtros" role="group" aria-label="Filtrar por profissão">' +
        [['todas', '🧑‍🔧', 'Todas as profissões'], ...PROFISSOES.map(p => [p[0], p[1], p[3]])]
          .map(([k, ic, n]) => '<button type="button" data-fprof="' + k + '" class="' + (S.filtroProf === k ? 'on' : '') + '" aria-pressed="' + (S.filtroProf === k) + '">' + ic + ' ' + esc(n) + '</button>').join('') +
      '</div>' +
      '<div class="js-lista"></div>';
  } else if (S.aba === 'pedidos') {
    box.innerHTML =
      '<div class="qk mt-filtros" role="group" aria-label="Filtrar pedidos">' +
        [['novo', 'Novos'], ['atendido', 'Atendidos'], ['parceiro', 'Parceiros'], ['todos', 'Todos']]
          .map(([k, n]) => '<button type="button" data-fped="' + k + '" class="' + (S.filtroPedidos === k ? 'on' : '') + '" aria-pressed="' + (S.filtroPedidos === k) + '">' + n + '</button>').join('') +
      '</div>' +
      '<div class="js-lista"></div>';
  } else if (S.aba === 'uso') {
    box.innerHTML = '<div class="js-lista"></div>';
    if (!S.uso && !S.usoCarregando && !S.usoErro) carregarUso();
  } else if (S.aba === 'empresa') {
    desenharEmpresa(box);
    return;
  } else if (S.aba === 'ajustes') {
    desenharAjustes(box);
    return;
  }
  atualizarAba();
}

function atualizarAba() {
  if (!S) return;
  if (S.aba === 'usuarios') atualizarUsuarios();
  else if (S.aba === 'pedidos') atualizarPedidos();
  else if (S.aba === 'uso') atualizarUso();
  else if (S.aba === 'ajustes') {
    const q = S.el.querySelector('.js-qtd-teste');
    if (q) q.textContent = String(contarTestePendente());
    atualizarChaveAuto();
  }
}

function carregandoOuErro() {
  if (S.erroLista) {
    return '<div class="card mt-alerta"><b>Não deu para carregar</b><p>' + esc(U().traduzErro(S.erroLista)) + '</p>' +
      '<p class="muted pequeno">Confira a internet e se as regras novas foram publicadas.</p></div>';
  }
  if (!S.prontos.users) return '<p class="muted">Carregando…</p>';
  return null;
}

/* ---------- 5.1 Usuários ---------- */
function atualizarUsuarios() {
  const pend = S.el.querySelector('.js-pend');
  const lista = S.el.querySelector('.js-lista');
  if (!pend || !lista) return;
  const aviso = carregandoOuErro();
  if (aviso) { pend.innerHTML = ''; lista.innerHTML = aviso; return; }

  const todos = [...S.users.entries()].map(([uid, u]) => ({ uid, ...u }));
  const porData = (a, b) => (U().paraData(b.criadoEm)?.getTime() || 0) - (U().paraData(a.criadoEm)?.getTime() || 0);

  // Pendentes no topo (os mais antigos primeiro: quem espera há mais tempo)
  const pendentes = todos.filter(u => (u.status || 'pendente') === 'pendente').sort((a, b) => -porData(a, b));
  const mostrarPend = S.filtro === 'todos' && S.filtroProf === 'todas' && !S.busca.trim(); // 1.2.0: + profissão
  pend.innerHTML = mostrarPend
    ? '<h2>Pendentes' + (pendentes.length ? ' (' + pendentes.length + ')' : '') + '</h2>' +
      (pendentes.length
        ? pendentes.map(cartaoUsuario).join('')
        : '<div class="card mt-vazio">Nenhum cadastro esperando liberação ✓</div>')
    : '';

  // Lista com busca e filtro
  const termo = normalizar(S.busca);
  const digitos = soDigitos(S.busca);
  const hoje = U().dataBR(new Date());
  let lista2 = todos.filter(u => {
    const st = u.status || 'pendente';
    if (S.filtro === 'todos') { if (mostrarPend && st === 'pendente') return false; }
    else if (S.filtro === 'hoje') { if (!u.liberadoEm || U().dataBR(u.liberadoEm) !== hoje) return false; } // 1.1.0
    else if (S.filtro === 'repetida') { if (u.contaRepetidaAparelho !== true) return false; }              // 1.2.0
    else if (st !== S.filtro) return false;
    if (S.filtroProf !== 'todas' && !lerEspecialidades(u).includes(S.filtroProf)) return false;           // 1.2.0
    if (!termo) return true;
    return normalizar(u.nome).includes(termo) || normalizar(u.cidade).includes(termo) ||
      normalizar(u.email).includes(termo) || (digitos.length >= 3 && soDigitos(u.whatsapp).includes(digitos));
  }).sort(S.filtro === 'hoje'
    ? (a, b) => (U().paraData(b.liberadoEm)?.getTime() || 0) - (U().paraData(a.liberadoEm)?.getTime() || 0)
    : porData);

  const dicaHoje = S.filtro === 'hoje'
    ? '<p class="campo-ajuda">Confira quem entrou hoje. Se não for profissional, toque em ⋯ Ações e em Bloquear acesso.</p>'
    : S.filtro === 'repetida'
      ? '<p class="campo-ajuda">Contas criadas num aparelho onde outra conta já tinha entrado. Pode ser a mesma pessoa com outro WhatsApp, ou alguém que usou o celular de outra pessoa para se cadastrar. Essas contas não entram sozinhas: você decide.</p>'
      : '';
  lista.innerHTML = dicaHoje + (lista2.length
    ? '<p class="muted pequeno">' + lista2.length + (lista2.length === 1 ? ' usuário' : ' usuários') + '</p>' + lista2.map(cartaoUsuario).join('')
    : '<div class="card mt-vazio">' + (S.filtro === 'hoje' ? 'Ninguém foi liberado hoje.' : 'Ninguém encontrado.') + '</div>');
}

/* 1.1.0: selo "auto" ou "manual" (pelo liberadoPor). Antigos, sem o campo, ficam sem selo. */
function seloLiberacao(u) {
  if (u.liberadoPor === 'auto') return '<span class="selo pl-free">⚡ auto</span>';
  if (u.liberadoPor === 'manual') return '<span class="selo pl-free">✋ manual</span>';
  return '';
}

/* 1.2.0: aviso de possível conta repetida (marca do aparelho). */
function seloRepetida(u) {
  return u.contaRepetidaAparelho === true ? '<span class="selo st-bloqueado">⚠️ Possível conta repetida</span>' : '';
}

/* 1.2.0: "🎨 Pintor · Marido de aluguel" */
function linhaProfissoes(u) {
  const lista = lerEspecialidades(u);
  const p = PROFISSOES.find(x => x[0] === lista[0]) || PROFISSOES[0];
  return p[1] + ' ' + esc(nomesProfissoes(lista, true));
}

/* 1.1.0: com a chave ligada, quando o pendente entra sozinho. */
function linhaAuto(u) {
  if (S.config?.liberacaoAutomatica !== true) return '';
  if (u.contaRepetidaAparelho === true) return '<br>⚠️ Não entra sozinho (possível conta repetida): libere ou recuse.'; // 1.2.0
  const criado = U().paraData(u.criadoEm);
  if (!criado) return '';
  const { min, max } = lerMinutos(S.config);
  const hora = new Date(criado.getTime() + segundosDaVez(u.uid, min, max) * 1000);
  const txt = hora.getTime() > Date.now()
    ? 'entra sozinho por volta das ' + hora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : 'entra sozinho quando abrir o app';
  return '<br>⚡ ' + esc(txt) + ' (dá para liberar ou recusar antes)';
}

function normalizar(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function cartaoUsuario(u) {
  const st = u.status || 'pendente';
  const voce = u.uid === S.ctx.estado.uid;
  const linhaZap = u.whatsapp ? '📱 ' + esc(formatarWhats(u.whatsapp)) : '📱 sem WhatsApp';
  const indicacao = u.codigoParceiro ? ' · Indicação: <b>' + esc(u.codigoParceiro) + '</b>' : '';
  let principais = '';
  if (st === 'pendente') {
    principais = '<div class="mt-duplo">' +
      '<button type="button" class="big primary mt-liberar" data-acao="liberar" data-uid="' + esc(u.uid) + '">✅ Liberar</button>' +
      '<button type="button" class="big mt-recusar" data-acao="recusar" data-uid="' + esc(u.uid) + '">Recusar</button></div>';
  } else if (st === 'recusado') {
    principais = '<button type="button" class="big primary mt-liberar" data-acao="liberar" data-uid="' + esc(u.uid) + '">✅ Liberar</button>';
  } else if (st === 'bloqueado') {
    principais = '<button type="button" class="big primary" data-acao="reativar" data-uid="' + esc(u.uid) + '">🔓 Reativar</button>';
  }
  return '<article class="card mu">' +
    '<div class="mu-cab"><b>' + esc(u.nome || 'Sem nome') + (voce ? ' <span class="muted">(você)</span>' : '') + '</b>' +
      seloStatus(st) + '</div>' +
    '<div class="mu-selos">' + seloPlano(u) + seloLiberacao(u) + seloParceiro(u.uid) + seloRepetida(u) + '</div>' +
    '<p class="mu-info">' + linhaProfissoes(u) + '<br>' + linhaZap + (u.cidade ? ' · ' + esc(u.cidade) : '') + '<br>' +
      'Cadastro: ' + esc(U().dataBR(u.criadoEm) || '—') + indicacao +
      (st !== 'pendente' && u.liberadoEm ? '<br>Liberado: ' + esc(dataHora(u.liberadoEm)) : '') +
      (st === 'pendente' ? linhaAuto(u) : '') + '</p>' +
    principais +
    '<div class="mu-acoes">' +
      botaoZap(u.whatsapp, u.nome) +
      '<button type="button" class="mt-btn" data-acao="notas" data-uid="' + esc(u.uid) + '">📝 Notas</button>' +
      '<button type="button" class="mt-btn" data-acao="acoes" data-uid="' + esc(u.uid) + '">⋯ Ações</button>' +
    '</div>' +
    '</article>';
}

/* ---------- 5.2 Pedidos de contato ---------- */
function atualizarPedidos() {
  const lista = S.el.querySelector('.js-lista');
  if (!lista) return;
  if (S.erroLista) { lista.innerHTML = carregandoOuErro(); return; }
  if (!S.prontos.pedidos) { lista.innerHTML = '<p class="muted">Carregando…</p>'; return; }

  const f = S.filtroPedidos;
  const itens = S.pedidos.filter(p => f === 'todos' || (p.status || 'novo') === f);
  // Marca possíveis repetidos (mesma pessoa e mesma mensagem)
  const vistos = new Map();
  S.pedidos.slice().reverse().forEach(p => {
    const k = p.uid + '|' + String(p.mensagem || '').trim();
    vistos.set(k, (vistos.get(k) || 0) + 1);
  });

  lista.innerHTML = itens.length
    ? itens.map(p => {
      const st = p.status || 'novo';
      const repetido = (vistos.get(p.uid + '|' + String(p.mensagem || '').trim()) || 0) > 1;
      const u = S.users.get(p.uid);
      return '<article class="card mp">' +
        '<div class="mu-cab"><b>' + esc(p.nome || u?.nome || 'Sem nome') + '</b>' +
          '<span class="selo">' + esc(MOTIVOS[p.motivo] || p.motivo || '') + '</span></div>' +
        '<p class="muted pequeno">' + esc(dataHora(p.criadoEm) || 'agora') +
          (u ? ' · cadastro ' + esc((STATUS[u.status] || STATUS.pendente)[1].toLowerCase()) : '') +
          (repetido ? ' · <span class="mt-repetido">mensagem repetida</span>' : '') + '</p>' +
        '<p class="mp-msg">' + esc(p.mensagem || '') + '</p>' +
        '<div class="seg tres mp-status" role="group" aria-label="Situação do pedido">' +
          STATUS_PEDIDO.map(([k, n]) => '<button type="button" data-acao="pedido-status" data-id="' + esc(p.id) + '" data-st="' + k + '" class="' + (st === k ? 'on' : '') + '" aria-pressed="' + (st === k) + '">' + n + '</button>').join('') +
        '</div>' +
        '<div class="mu-acoes">' +
          botaoZap(p.whatsapp || u?.whatsapp, p.nome || u?.nome) +
          '<button type="button" class="mt-btn" data-acao="notas" data-uid="' + esc(p.uid) + '" data-pedido="' + esc(p.id) + '">📝 Notas e parceria</button>' +
        '</div>' +
        '</article>';
    }).join('')
    : '<div class="card mt-vazio">' + (f === 'novo' ? 'Nenhum pedido novo ✓' : 'Nenhum pedido aqui.') + '</div>';
}

/* ---------- 5.3 Relatório de uso (1.3.0) ----------
   Uma consulta só (collectionGroup 'dias'), desde o mais antigo entre
   14 dias atrás e o dia 1º do mês. Datas sempre no fuso de Brasília.
   Números do mês = soma dos uso/dias do mês (o dia 1º começa do zero). */
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const ISO_DIA = /^\d{4}-\d{2}-\d{2}$/;
const CSS_USO = 'mt-uso-css';

function msDoIso(iso) { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); }
/** "2026-10-15" + n dias (sem depender do fuso do aparelho). */
function isoMais(iso, n) { return new Date(msDoIso(iso) + n * DIA_MS).toISOString().slice(0, 10); }
/** Quantos dias de a até b (datas "AAAA-MM-DD"). */
function diasEntre(a, b) { return Math.round((msDoIso(b) - msDoIso(a)) / DIA_MS); }
/** Qualquer data -> dia de Brasília ("" se inválida). */
function diaDe(d) { const x = U().paraData(d); return x ? diaBrasilia(x) : ''; }
/** 00:00 de Brasília (o Brasil não tem horário de verão desde 2019). */
function inicioDoDia(iso) { return new Date(iso + 'T00:00:00-03:00'); }

function diasDoPeriodo(n, hoje = diaBrasilia()) {
  const lista = [];
  for (let i = n - 1; i >= 0; i--) lista.push(isoMais(hoje, -i));
  return lista;
}

async function carregarUso() {
  if (!S) return;
  S.usoCarregando = true;
  S.usoErro = null;
  atualizarUso();
  const meu = S;
  try {
    const hoje = diaBrasilia();
    const dias = diasDoPeriodo(CRITERIOS.diasRelatorio, hoje);
    const mes = hoje.slice(0, 7);
    const primeiro = mes + '-01';
    const desde = primeiro < dias[0] ? primeiro : dias[0];
    const q = fs.query(fs.collectionGroup(db, 'dias'), fs.where('atualizadoEm', '>=', ts(inicioDoDia(desde))));
    const [snapUso, snapRes] = await Promise.all([
      fs.getDocs(q),
      fs.getDocs(fs.collection(db, 'resumos')).catch(() => null)
    ]);
    if (S !== meu) return;
    const resumos = new Map((snapRes?.docs || []).map(d => [d.id, d.data()]));
    S.uso = { hoje, dias, mes, desde, docs: snapUso.docs.map(d => ({ id: d.id, uid: d.ref.parent.parent?.id, ...d.data() })), resumos, quando: new Date() };
  } catch (e) {
    console.error('[Print] relatório de uso', e);
    if (S === meu) S.usoErro = e;
  }
  if (S === meu) {
    S.usoCarregando = false;
    atualizarUso();
    atualizarFolhaAberta();
  }
}

const usouNoDia = x => !!x && (x.a > 0 || x.s > 0);

/** Junta os dias por pintor. O dono fica fora de tudo (lista, gráfico e totais). */
function calcularUso() {
  const { hoje, dias, mes, desde, docs, resumos } = S.uso;
  const eu = S.ctx.estado.uid;
  const noPeriodo = new Set(dias);
  const janela = dias.slice(-CRITERIOS.janelaChamar);
  const num = U().num;
  const por = new Map();
  const linha = uid => {
    if (!por.has(uid)) {
      por.set(uid, {
        uid, porDia: {}, aberturas: 0, segundos: 0, orcamentos: 0, enviados: 0, valor: 0,
        mesOrc: 0, mesEnv: 0, mesValor: 0, mesDias: 0, ultimaDoc: null
      });
    }
    return por.get(uid);
  };

  for (const d of docs) {
    if (!d.uid || d.uid === eu || !ISO_DIA.test(d.id) || d.id < desde || d.id > hoje) continue;
    const p = linha(d.uid);
    const x = { a: num(d.aberturas), s: num(d.segundosAtivos), o: num(d.orcamentosCriados), e: num(d.orcamentosEnviados), v: num(d.valorOrcado) };
    p.porDia[d.id] = x;
    if (noPeriodo.has(d.id)) {
      p.aberturas += x.a; p.segundos += x.s; p.orcamentos += x.o; p.enviados += x.e; p.valor += x.v;
    }
    if (d.id.startsWith(mes)) {
      p.mesOrc += x.o; p.mesEnv += x.e; p.mesValor += x.v;
      if (usouNoDia(x)) p.mesDias += 1;
    }
    const quando = U().paraData(d.atualizadoEm);
    if (quando && (!p.ultimaDoc || quando > p.ultimaDoc)) p.ultimaDoc = quando;
  }
  // Ativos sem uso também entram (com zero), para aparecer quem sumiu.
  for (const [uid, u] of S.users) if (u.status === 'ativo' && uid !== eu) linha(uid);

  return [...por.values()].map(p => {
    const r = resumos.get(p.uid) || null;
    const u = S.users.get(p.uid) || {};
    p.u = u;
    p.resumo = r;
    p.parceiro = ehParceiro(p.uid);
    p.diasUsados = dias.filter(k => usouNoDia(p.porDia[k])).length;
    p.diasJanela = janela.filter(k => usouNoDia(p.porDia[k])).length;
    p.minutos = Math.round(p.segundos / 60);
    p.pontos = p.diasUsados * CRITERIOS.pontosPorDia + p.minutos * CRITERIOS.pontosPorMinuto +
      p.orcamentos * CRITERIOS.pontosPorOrcamento + p.enviados * CRITERIOS.pontosPorEnvio;
    // Última atividade: o mais recente entre ultimoUsoEm, o uso/dias lido e os resumos.
    const sinais = [r?.ultimoUsoEm, p.ultimaDoc, r?.ultimoOrcamentoEm, r?.ultimoEnvioEm].map(x => U().paraData(x)).filter(Boolean);
    p.jaUsou = sinais.length > 0;
    p.ultima = sinais.length ? new Date(Math.max(...sinais.map(x => x.getTime()))) : null;
    const ref = p.ultima || U().paraData(u.liberadoEm) || U().paraData(u.criadoEm);
    p.diasSem = ref ? Math.max(0, diasEntre(diaBrasilia(ref), hoje)) : null;
    p.liberadoHoje = diaDe(u.liberadoEm) === hoje;
    p.usouHoje = usouNoDia(p.porDia[hoje]) || diaDe(r?.ultimoUsoEm) === hoje;
    p.criadosMes = r && r.mesRef === mes ? num(r.orcamentosMes) : 0; // conta rascunhos: só "criados"
    return p;
  });
}

const ehAtivo = l => (l.u.status || 'pendente') === 'ativo';

/** Fichas da aba Uso: [chave, ícone, nome, quem entra, ordem]. */
function filtrosUso() {
  const C = CRITERIOS;
  const porPontos = (a, b) => b.pontos - a.pontos || (b.ultima?.getTime() || 0) - (a.ultima?.getTime() || 0);
  const porSumico = (a, b) => (a.diasSem ?? 9999) - (b.diasSem ?? 9999) || porPontos(a, b);
  return [
    ['todos', '', 'Todos', () => true, porPontos],
    ['chamar', '📞', 'Quem chamar hoje', l => l.diasJanela >= C.minDiasChamar && !l.parceiro,
      (a, b) => b.diasJanela - a.diasJanela || porPontos(a, b)],
    ['semuso', '⏸️', 'Sem uso há ' + C.diasSemUso + ' dias',
      l => ehAtivo(l) && l.jaUsou && l.diasSem != null && l.diasSem >= C.diasSemUso && l.diasSem < C.diasSumido, porSumico],
    ['sumidos', '😴', 'Sumidos há ' + C.diasSumido + ' dias',
      l => ehAtivo(l) && l.diasSem != null && l.diasSem >= C.diasSumido, porSumico],
    ['volumes', '🏆', 'Maiores volumes', l => l.valor > 0 || l.orcamentos > 0,
      (a, b) => b.valor - a.valor || b.orcamentos - a.orcamentos || porPontos(a, b)],
    ['liberados', '🆕', 'Liberados hoje sem uso', l => l.liberadoHoje && !l.usouHoje,
      (a, b) => (U().paraData(b.u.liberadoEm)?.getTime() || 0) - (U().paraData(a.u.liberadoEm)?.getTime() || 0)]
  ];
}

const DICAS_USO = {
  todos: () => 'Ordem de pontos (' + CRITERIOS.diasRelatorio + ' dias): ' + CRITERIOS.pontosPorDia + ' por dia de uso, ' + CRITERIOS.pontosPorMinuto +
    ' por minuto, ' + CRITERIOS.pontosPorOrcamento + ' por orçamento concluído e ' + CRITERIOS.pontosPorEnvio + ' por orçamento enviado.',
  chamar: () => 'Usou o app em ' + CRITERIOS.minDiasChamar + ' ou mais dos últimos ' + CRITERIOS.janelaChamar + ' dias e ainda não é parceiro.',
  semuso: () => 'Usava o app e está parado há ' + CRITERIOS.diasSemUso + ' a ' + (CRITERIOS.diasSumido - 1) + ' dias. Bom momento para um "tudo certo com o app?".',
  sumidos: () => 'Sem nenhuma atividade há ' + CRITERIOS.diasSumido + ' dias ou mais (ou liberado há tanto tempo e nunca usou).',
  volumes: () => 'Quem mais orçou nos últimos ' + CRITERIOS.diasRelatorio + ' dias (valor, depois quantidade).',
  liberados: () => 'Entrou hoje e ainda não abriu o app. Um "olá" ajuda a pessoa a começar.'
};

/** Gráfico de 14 barras, sem biblioteca. itens: [{ dia, valor, marca, titulo }]. */
function grafico(itens, rotulo) {
  const max = Math.max(1, ...itens.map(i => i.valor));
  const hoje = S.uso.hoje;
  return '<div class="mt-graf" role="img" aria-label="' + esc(rotulo) + '">' + itens.map(i => {
    const h = i.valor > 0 ? Math.max(6, Math.round(i.valor / max * 100)) : 0;
    const topo = i.marca
      ? '<span class="mt-graf-m">' + esc(String(i.marca)) + '</span>'
      : '<span class="mt-graf-v">' + (i.mostrarValor && i.valor > 0 ? esc(String(i.valor)) : '') + '</span>';
    return '<div class="mt-graf-col' + (i.dia === hoje ? ' hoje' : '') + '" title="' + esc(i.titulo) + '">' +
      '<div class="mt-graf-area">' + topo + '<span class="mt-graf-b' + (h ? '' : ' zero') + '" style="--h:' + h + '%"></span></div>' +
      '<span class="mt-graf-d">' + esc(String(+i.dia.slice(8))) + '</span></div>';
  }).join('') + '</div>';
}

function nomeMes(mes) { return MESES[+mes.slice(5) - 1] || mes; }

function cartaoMes(linhas) {
  const { dias, mes, hoje } = S.uso;
  const soma = k => linhas.reduce((t, l) => t + l[k], 0);
  const usaramMes = linhas.filter(l => l.mesDias > 0).length;
  const porDia = dias.map(k => {
    const n = linhas.filter(l => usouNoDia(l.porDia[k])).length;
    return { dia: k, valor: n, mostrarValor: true, titulo: U().dataBR(k) + ': ' + n + (n === 1 ? ' pintor usou' : ' pintores usaram') };
  });
  return '<section class="card mt-mes">' +
    '<b>Mês de ' + esc(nomeMes(mes)) + '</b> <span class="muted pequeno">(dia 1º a ' + esc(U().dataBR(hoje)) + ')</span>' +
    '<div class="mt-nums">' +
      '<div><b>' + soma('mesOrc') + '</b><span>concluídos</span></div>' +
      '<div><b>' + soma('mesEnv') + '</b><span>enviados</span></div>' +
      '<div><b>' + usaramMes + '</b><span>usaram no mês</span></div>' +
      '<div><b>' + esc(U().moeda(soma('mesValor'))) + '</b><span>valor orçado no mês</span></div>' +
    '</div>' +
    '<p class="rotulo">Pintores que usaram o app por dia (' + CRITERIOS.diasRelatorio + ' dias)</p>' +
    grafico(porDia, 'Pintores que usaram o app em cada um dos últimos ' + CRITERIOS.diasRelatorio + ' dias') +
    '</section>';
}

function atualizarUso() {
  const lista = S?.el.querySelector('.js-lista');
  if (!lista || S.aba !== 'uso') return;
  const barra = '<div class="mt-barra-uso"><p class="muted pequeno">' +
    (S.uso ? 'Últimos ' + CRITERIOS.diasRelatorio + ' dias: ' + esc(U().dataBR(S.uso.dias[0])) + ' a ' + esc(U().dataBR(S.uso.hoje)) +
      ' · lido às ' + esc(S.uso.quando.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })) : 'Relatório de uso') + '</p>' +
    '<button type="button" class="mt-btn" data-acao="atualizar-uso"' + (S.usoCarregando ? ' disabled' : '') + '>' + (S.usoCarregando ? 'Lendo…' : '🔄 Atualizar') + '</button></div>';

  if (S.usoCarregando && !S.uso) { lista.innerHTML = barra + '<p class="muted">Lendo o uso de todos…</p>'; return; }
  if (S.usoErro) {
    lista.innerHTML = barra + (avisoIndice(S.usoErro) ||
      '<div class="card mt-alerta"><b>Não deu para ler o uso</b><p>' + esc(U().traduzErro(S.usoErro)) + '</p></div>');
    return;
  }
  if (!S.uso || !S.prontos.users) { lista.innerHTML = barra + '<p class="muted">Carregando…</p>'; return; }

  const linhas = calcularUso();
  const filtros = filtrosUso();
  const contagem = new Map(filtros.map(([k, , , quem]) => [k, linhas.filter(quem).length]));
  if (!filtros.some(f => f[0] === S.filtroUso)) S.filtroUso = 'todos';
  const [chave, , , quem, ordem] = filtros.find(f => f[0] === S.filtroUso);
  const escolhidos = linhas.filter(quem).sort(ordem);

  const fichas = '<div class="qk mt-filtros mt-fuso" role="group" aria-label="Filtrar o relatório de uso">' +
    filtros.map(([k, ic, n]) => '<button type="button" data-fuso="' + k + '" class="' + (chave === k ? 'on' : '') + '" aria-pressed="' + (chave === k) + '">' +
      '<span>' + (ic ? ic + ' ' : '') + esc(n) + '</span><span class="mt-cont">' + contagem.get(k) + '</span></button>').join('') +
    '</div>';

  let corpo;
  if (chave === 'todos') {
    const comUso = escolhidos.filter(l => l.diasUsados > 0);
    const semUso = escolhidos.filter(l => l.diasUsados === 0);
    corpo = (comUso.length ? comUso.map((l, i) => cartaoUso(l, chave, i + 1)).join('') : '<div class="card mt-vazio">Ainda não há uso registrado no período.</div>') +
      (semUso.length
        ? '<h2>Sem uso nos últimos ' + CRITERIOS.diasRelatorio + ' dias (' + semUso.length + ')</h2><div class="card">' +
          semUso.map(l => '<div class="mt-linha"><button type="button" class="mt-nome-btn" data-acao="ficha-uso" data-uid="' + esc(l.uid) + '">' +
            esc(l.u.nome || 'Sem nome') + '</button>' + seloParceiro(l.uid) +
            botaoZap(l.u.whatsapp, l.u.nome, 'mt-btn zap pequeno-btn') + '</div>').join('') + '</div>'
        : '');
  } else {
    corpo = escolhidos.length
      ? escolhidos.map((l, i) => cartaoUso(l, chave, chave === 'volumes' ? i + 1 : 0)).join('')
      : '<div class="card mt-vazio">Ninguém aqui hoje ✓</div>';
  }

  lista.innerHTML = barra + cartaoMes(linhas) + fichas +
    '<p class="muted pequeno">' + esc(DICAS_USO[chave]()) + '</p>' +
    '<p class="muted pequeno">' + escolhidos.length + (escolhidos.length === 1 ? ' pessoa' : ' pessoas') + '</p>' + corpo;
}

function textoUltima(l) {
  if (l.ultima) return haQuanto(l.ultima) + ' (' + dataHora(l.ultima) + ')';
  return 'nunca usou';
}

function seloDoFiltro(l, chave) {
  if (chave === 'chamar') return '<span class="selo pl-pro">' + l.diasJanela + ' de ' + CRITERIOS.janelaChamar + ' dias</span>';
  if (chave === 'volumes') return '<span class="selo pl-pro">' + esc(U().moeda(l.valor)) + '</span>';
  if (chave === 'semuso' || chave === 'sumidos') return '<span class="selo st-pendente">' + (l.jaUsou ? 'parado há ' + l.diasSem + ' dias' : 'nunca usou') + '</span>';
  if (chave === 'liberados') return seloLiberacao(l.u) || '<span class="selo pl-free">liberado hoje</span>';
  return '<span class="selo">' + l.pontos + ' pts</span>';
}

function cartaoUso(l, chave, pos) {
  const n = S.notas.get(l.uid);
  const resumo14 = l.minutos + ' min · ' + l.orcamentos + (l.orcamentos === 1 ? ' concluído' : ' concluídos') + ' · ' +
    l.enviados + (l.enviados === 1 ? ' enviado' : ' enviados') + ' · ' + U().moeda(l.valor);
  return '<article class="card mu">' +
    '<div class="mu-cab"><b>' + (pos ? '<span class="mt-pos">' + pos + 'º</span> ' : '') + esc(l.u.nome || 'Sem nome') + '</b>' + seloDoFiltro(l, chave) + '</div>' +
    '<div class="mu-selos">' + (l.u.status && l.u.status !== 'ativo' ? seloStatus(l.u.status) : '') + seloParceiro(l.uid) +
      (chave === 'liberados' ? '' : seloLiberacaoHoje(l)) +
      '<span class="selo pl-free">' + l.diasUsados + ' de ' + CRITERIOS.diasRelatorio + ' dias</span></div>' +
    '<p class="mu-info">' + linhaProfissoes(l.u) + (l.u.cidade ? ' · ' + esc(l.u.cidade) : '') + '<br>' +
      esc(resumo14) + ' <span class="muted">(' + CRITERIOS.diasRelatorio + ' dias)</span><br>' +
      'Última atividade: ' + esc(textoUltima(l)) +
      (chave === 'chamar' ? '<br>Último contato: ' + esc(n?.ultimoContato ? haQuanto(n.ultimoContato) : 'nunca') : '') + '</p>' +
    (chave === 'liberados' || chave === 'sumidos' ? '' : tira14(l)) +
    '<div class="mu-acoes">' + botaoZap(l.u.whatsapp, l.u.nome) +
      '<button type="button" class="mt-btn" data-acao="ficha-uso" data-uid="' + esc(l.uid) + '">📈 Ficha</button>' +
      '<button type="button" class="mt-btn" data-acao="notas" data-uid="' + esc(l.uid) + '">📝 Notas</button></div>' +
    '</article>';
}

/* Selo auto/manual só para quem foi liberado hoje (fora do filtro próprio). */
function seloLiberacaoHoje(l) {
  return l.liberadoHoje ? (seloLiberacao(l.u) || '<span class="selo pl-free">liberado hoje</span>') : '';
}

function tira14(l) {
  return '<div class="mt-tira" aria-label="Uso por dia">' + S.uso.dias.map(k => {
    const x = l.porDia[k];
    const min = x ? Math.round(x.s / 60) : 0;
    const nivel = !usouNoDia(x) ? 0 : min < 5 ? 1 : min < 20 ? 2 : 3;
    return '<i class="n' + nivel + '" title="' + esc(U().dataBR(k) + ': ' + (x ? x.a : 0) + ' aberturas, ' + min + ' min') + '"></i>';
  }).join('') + '</div>';
}

/** Ficha do pintor: gráfico de minutos por dia com os orçamentos marcados. */
function abrirFichaUso(uid) {
  const desenhar = () => {
    if (!S.uso) return '<p>Relatório ainda não carregado.</p><button type="button" class="big" data-fechar>Fechar</button>';
    const l = calcularUso().find(x => x.uid === uid);
    if (!l) return '<p>Esta pessoa não está no relatório.</p><button type="button" class="big" data-fechar>Fechar</button>';
    const u = l.u, r = l.resumo || {};
    const itens = S.uso.dias.map(k => {
      const x = l.porDia[k] || { a: 0, s: 0, o: 0, e: 0, v: 0 };
      const min = Math.round(x.s / 60);
      return {
        dia: k, valor: min, marca: x.o || 0,
        titulo: U().dataBR(k) + ': ' + min + ' min, ' + x.a + ' aberturas, ' + x.o + ' concluídos, ' + x.e + ' enviados'
      };
    });
    const linhaTotais = [
      r.totalOrcamentos != null ? 'Orçamentos criados (total): ' + r.totalOrcamentos : '',
      r.totalEnviados != null ? 'Enviados (total): ' + r.totalEnviados : '',
      r.ultimoEnvioEm ? 'Último envio: ' + haQuanto(r.ultimoEnvioEm) : '',
      r.totalClientes != null ? 'Clientes: ' + r.totalClientes : ''
    ].filter(Boolean).join(' · ');
    return '<h2 class="folha-tit">' + esc(u.nome || 'Sem nome') + '</h2>' +
      '<div class="mu-selos">' + seloStatus(u.status || 'pendente') + seloPlano(u) + seloLiberacao(u) + seloParceiro(uid) + '</div>' +
      '<p class="mu-info">' + linhaProfissoes(u) + (u.cidade ? ' · ' + esc(u.cidade) : '') + '<br>' +
        (u.whatsapp ? '📱 ' + esc(formatarWhats(u.whatsapp)) : '📱 sem WhatsApp') +
        (u.liberadoEm ? '<br>Liberado: ' + esc(dataHora(u.liberadoEm)) : '') +
        '<br>Última atividade: <b>' + esc(textoUltima(l)) + '</b></p>' +
      '<p class="rotulo">Minutos por dia (' + CRITERIOS.diasRelatorio + ' dias)</p>' +
      grafico(itens, 'Minutos de uso por dia de ' + (u.nome || 'pintor')) +
      '<p class="muted pequeno"><span class="mt-graf-m mt-leg">2</span> = orçamentos concluídos no dia · barra = minutos de uso</p>' +
      '<p class="rotulo">Últimos ' + CRITERIOS.diasRelatorio + ' dias</p>' +
      '<div class="mt-nums">' +
        '<div><b>' + l.diasUsados + '</b><span>dias de uso</span></div>' +
        '<div><b>' + l.minutos + '</b><span>minutos</span></div>' +
        '<div><b>' + l.aberturas + '</b><span>aberturas</span></div>' +
        '<div><b>' + l.orcamentos + '</b><span>concluídos</span></div>' +
        '<div><b>' + l.enviados + '</b><span>enviados</span></div>' +
        '<div><b>' + l.pontos + '</b><span>pontos</span></div>' +
        '<div><b>' + esc(U().moeda(l.valor)) + '</b><span>valor orçado</span></div>' +
      '</div>' +
      '<p class="rotulo">Mês de ' + esc(nomeMes(S.uso.mes)) + '</p>' +
      '<div class="mt-nums">' +
        '<div><b>' + l.mesOrc + '</b><span>concluídos</span></div>' +
        '<div><b>' + l.mesEnv + '</b><span>enviados</span></div>' +
        '<div><b>' + l.criadosMes + '</b><span>criados (com rascunhos)</span></div>' +
        '<div><b>' + esc(U().moeda(l.mesValor)) + '</b><span>valor orçado no mês</span></div>' +
      '</div>' +
      (linhaTotais ? '<p class="muted pequeno">' + esc(linhaTotais) + '</p>' : '') +
      '<div class="mu-acoes">' + botaoZap(u.whatsapp, u.nome) +
        '<button type="button" class="mt-btn" data-f="notas">📝 Notas e parceria</button></div>' +
      '<button type="button" class="big" data-fechar style="margin-top:14px">Fechar</button>';
  };
  abrirFolha(desenhar(), ev => {
    const b = ev.target.closest('[data-f]');
    if (b?.dataset.f === 'notas') abrirNotas(uid);
  }, { tipo: 'ficha-uso', uid, desenhar });
}

/** Estilos do relatório (1.3.0). Ficam aqui porque o style.css não muda nesta sessão. */
function garantirCssUso() {
  if (document.querySelector('style[data-print="' + CSS_USO + '"]')) return;
  const st = document.createElement('style');
  st.dataset.print = CSS_USO;
  st.textContent = [
    '.mt-mes { margin: 10px 0 6px; }',
    '.mt-mes .mt-nums { margin-top: 10px; }',
    '.mt-graf { display: grid; grid-template-columns: repeat(14, minmax(0, 1fr)); gap: 3px; height: 112px; margin: 6px 0 4px; }',
    '.mt-graf-col { display: flex; flex-direction: column; align-items: stretch; min-width: 0; }',
    '.mt-graf-area { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; min-height: 0; }',
    '.mt-graf-b { width: 100%; max-width: 22px; height: calc(var(--h) * 0.78); background: var(--brand); border-radius: 4px 4px 0 0; }',
    '.mt-graf-b.zero { height: 2px; background: var(--line); border-radius: 1px; }',
    '.mt-graf-v { font-size: 10.5px; line-height: 14px; min-height: 14px; color: var(--muted); }',
    '.mt-graf-m { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 3px; margin-bottom: 2px;' +
      ' border-radius: 8px; background: var(--star); color: #172033; font-size: 10.5px; font-weight: 700; line-height: 1; }',
    '.mt-graf-m.mt-leg { margin: 0 2px 0 0; vertical-align: middle; }',
    '.mt-graf-d { font-size: 10.5px; line-height: 16px; text-align: center; color: var(--muted); border-top: 1px solid var(--line); }',
    '.mt-graf-col.hoje .mt-graf-d { color: var(--ink); font-weight: 700; }',
    '.mt-fuso { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }',
    '.mt-fuso button { min-height: var(--toque); padding: 4px 8px; font-size: 13px; line-height: 1.2; border-radius: 12px; text-align: left; display: flex; align-items: center; justify-content: space-between; gap: 4px; }',
    '@media (min-width: 900px) { .mt-fuso { grid-template-columns: repeat(3, 1fr); } }',
    '.mt-cont { flex: none; display: inline-block; min-width: 22px; text-align: center; padding: 1px 6px; border-radius: 11px; background: var(--card); color: var(--ink); font-size: 12px; }',
    '.mt-nome-btn { background: none; border: 0; padding: 0; min-height: var(--toque); color: var(--ink); font: inherit; font-weight: 600; text-align: left; flex: 1; cursor: pointer; }'
  ].join('\n');
  document.head.appendChild(st);
}

/* ---------- 5.4 Dados da empresa ---------- */
const CAMPOS_EMPRESA = [
  ['nome', 'Nome da empresa (razão social)', 'text', 'Ex.: Collornew Tintas e Revestimentos'],
  ['cnpj', 'CNPJ', 'text', '00.000.000/0000-00'],
  ['endereco', 'Endereço completo', 'text', 'Rua, número, bairro, cidade (UF), CEP'],
  ['responsavelDados', 'Responsável pelos dados (LGPD)', 'text', 'Nome do encarregado'],
  ['email', 'E-mail de contato', 'email', 'contato@…'],
  ['telefone', 'Telefone', 'tel', '(17) 0000-0000']
];

async function desenharEmpresa(box) {
  box.innerHTML = '<p class="muted">Carregando…</p>';
  let e = {};
  try {
    const s = await fs.getDoc(fs.doc(db, 'config', 'empresa'));
    e = s.exists() ? s.data() : {};
  } catch (err) {
    if (S?.aba !== 'empresa') return;
    box.innerHTML = '<div class="card mt-alerta"><b>Não deu para ler</b><p>' + esc(U().traduzErro(err)) + '</p></div>';
    return;
  }
  if (!S || S.aba !== 'empresa') return;
  box.innerHTML =
    '<form class="card js-form-empresa" novalidate>' +
      '<b>Dados da empresa</b>' +
      '<p class="muted pequeno">Aparecem só nos Termos, na Privacidade e no Sobre (marca neutra no resto do app). Campo vazio aparece como "preencher no painel".</p>' +
      CAMPOS_EMPRESA.map(([k, rot, tipo, ph]) =>
        '<label for="emp-' + k + '">' + rot + '</label>' +
        '<input id="emp-' + k + '" name="' + k + '" type="' + tipo + '" maxlength="160" placeholder="' + esc(ph) + '" value="' + esc(e[k] || '') + '"' +
          (tipo === 'email' ? ' inputmode="email" autocapitalize="off"' : tipo === 'tel' ? ' inputmode="tel"' : '') + '>').join('') +
      '<button type="submit" class="big primary" style="margin-top:16px">Salvar dados da empresa</button>' +
    '</form>' +
    '<a class="big" href="#termos">📄 Ver como ficou nos Termos</a>';
}

async function salvarEmpresa(f) {
  const dados = {};
  CAMPOS_EMPRESA.forEach(([k]) => { dados[k] = String(f[k].value || '').trim().replace(/\s+/g, ' '); });
  if (dados.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dados.email)) { toast('E-mail inválido. Confira se digitou certo.', 'erro'); f.email.focus(); return; }
  dados.atualizadoEm = fs.serverTimestamp();
  const b = f.querySelector('[type=submit]');
  b.disabled = true;
  await gravar(fs.setDoc(fs.doc(db, 'config', 'empresa'), dados, { merge: true }), 'Dados da empresa salvos!');
  b.disabled = false;
}

/* ---------- 5.5 Ajustes ---------- */
function contarTestePendente() {
  return [...S.users.values()].filter(u => u.testeProPendente === true).length;
}

async function desenharAjustes(box) {
  box.innerHTML = '<p class="muted">Carregando…</p>';
  let c = {};
  try {
    const s = await fs.getDoc(fs.doc(db, 'config', 'app'));
    c = s.exists() ? s.data() : {};
  } catch (err) {
    if (S?.aba !== 'ajustes') return;
    box.innerHTML = '<div class="card mt-alerta"><b>Não deu para ler</b><p>' + esc(U().traduzErro(err)) + '</p></div>';
    return;
  }
  if (!S || S.aba !== 'ajustes') return;
  S.config = c;
  const { min, max } = lerMinutos(c);
  box.innerHTML =
    // 1.1.0: chave da liberação automática
    '<div class="card">' +
      '<b>⚡ Liberação automática</b>' +
      '<div class="seg js-chave-auto" role="group" aria-label="Liberação automática">' +
        '<button type="button" data-acao="auto-chave" data-v="0">Desligada</button>' +
        '<button type="button" data-acao="auto-chave" data-v="1">Ligada</button>' +
      '</div>' +
      '<p class="campo-ajuda js-auto-txt"></p>' +
      '<form class="js-form-auto" novalidate>' +
        '<label for="aj-min">Liberar depois de (mínimo, em minutos)</label>' +
        '<input id="aj-min" name="autoMinutosMin" type="number" inputmode="numeric" min="1" max="120" value="' + min + '">' +
        '<label for="aj-max">Até (máximo, em minutos)</label>' +
        '<input id="aj-max" name="autoMinutosMax" type="number" inputmode="numeric" min="1" max="120" value="' + max + '">' +
        '<p class="campo-ajuda">Cada pessoa recebe um tempo entre o mínimo e o máximo (sempre o mesmo para ela), contado do cadastro. Assim não parece automático.</p>' +
        '<button type="submit" class="big" style="margin-top:14px">Salvar minutos</button>' +
      '</form>' +
    '</div>' +
    '<form class="card js-form-ajustes" novalidate>' +
      '<b>Mensagem e teste Pro</b>' +
      '<label for="aj-msg">Mensagem para quem está aguardando liberação</label>' +
      '<textarea id="aj-msg" name="mensagemPendente" maxlength="300">' + esc(c.mensagemPendente || '') + '</textarea>' +
      '<label for="aj-dias">Dias de teste Pro (padrão)</label>' +
      '<input id="aj-dias" name="diasTesteProPadrao" type="number" inputmode="numeric" min="1" max="365" value="' + esc(String(c.diasTesteProPadrao ?? 60)) + '">' +
      '<p class="campo-ajuda">Usado no botão abaixo e quando você muda alguém para Teste Pro.</p>' +
      '<button type="submit" class="big primary" style="margin-top:14px">Salvar ajustes</button>' +
    '</form>' +
    '<div class="card mt-perigo">' +
      '<b>⚠️ Ativar teste Pro para todos</b>' +
      '<p><b>Só use quando o Pro existir no app.</b> Hoje o app só tem o Free, e a contagem dos dias começa na hora em que você tocar.</p>' +
      '<p>Quem está esperando o teste: <b class="js-qtd-teste">' + contarTestePendente() + '</b> pessoa(s). Elas passam para Teste Pro até hoje + os dias de teste acima.</p>' +
      '<button type="button" class="big mt-btn-perigo" data-acao="ativar-teste">Ativar teste Pro para todos</button>' +
    '</div>';
  atualizarChaveAuto();
}

/* 1.1.0: mostra a chave como está em config/app. */
function atualizarChaveAuto() {
  const box = S?.el.querySelector('.js-chave-auto');
  if (!box) return;
  const ligada = S.config?.liberacaoAutomatica === true;
  box.querySelectorAll('button').forEach(b => {
    const on = (b.dataset.v === '1') === ligada;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const { min, max } = lerMinutos(S.config || {});
  const t = S.el.querySelector('.js-auto-txt');
  if (t) t.innerHTML = ligada
    ? '<b>Ligada:</b> cadastros novos entram sozinhos entre ' + min + ' e ' + max + ' minutos depois do cadastro (ou na próxima vez que a pessoa abrir o app). Você continua podendo liberar ou recusar antes. <b>Quem já está pendente também entra sozinho</b> quando abrir o app: recuse antes quem você não quer.'
    : '<b>Desligada:</b> todo cadastro espera você tocar em Liberar.';
}

async function mudarChaveAuto(ligar, botao) {
  if ((S.config?.liberacaoAutomatica === true) === ligar) return;
  botao.disabled = true;
  const ok = await gravar(fs.setDoc(fs.doc(db, 'config', 'app'), { liberacaoAutomatica: ligar }, { merge: true }),
    ligar ? 'Liberação automática ligada ⚡' : 'Liberação automática desligada');
  if (ok && S) { S.config = { ...S.config, liberacaoAutomatica: ligar }; atualizarChaveAuto(); }
  botao.disabled = false;
}

async function salvarMinutos(f) {
  const min = Math.round(U().num(f.elements.autoMinutosMin.value));
  const max = Math.round(U().num(f.elements.autoMinutosMax.value));
  if (min < 1 || min > 120) { toast('O mínimo precisa ficar entre 1 e 120 minutos.', 'erro'); f.elements.autoMinutosMin.focus(); return; }
  if (max < min || max > 120) { toast('O máximo precisa ser igual ou maior que o mínimo (até 120).', 'erro'); f.elements.autoMinutosMax.focus(); return; }
  const b = f.querySelector('[type=submit]');
  b.disabled = true;
  const ok = await gravar(fs.setDoc(fs.doc(db, 'config', 'app'), { autoMinutosMin: min, autoMinutosMax: max }, { merge: true }),
    'Minutos salvos: de ' + min + ' a ' + max);
  if (ok && S) { S.config = { ...S.config, autoMinutosMin: min, autoMinutosMax: max }; atualizarChaveAuto(); }
  b.disabled = false;
}

async function salvarAjustes(f) {
  const msg = f.mensagemPendente.value.trim();
  const dias = Math.round(U().num(f.diasTesteProPadrao.value));
  if (msg.length < 5) { toast('Escreva a mensagem para quem está aguardando.', 'erro'); f.mensagemPendente.focus(); return; }
  if (dias < 1 || dias > 365) { toast('Os dias de teste precisam ficar entre 1 e 365.', 'erro'); f.diasTesteProPadrao.focus(); return; }
  const b = f.querySelector('[type=submit]');
  b.disabled = true;
  const ok = await gravar(fs.setDoc(fs.doc(db, 'config', 'app'), { mensagemPendente: msg, diasTesteProPadrao: dias }, { merge: true }), 'Ajustes salvos!');
  if (ok && S) S.config = { ...S.config, mensagemPendente: msg, diasTesteProPadrao: dias };
  b.disabled = false;
}

async function diasTeste() {
  if (S.config?.diasTesteProPadrao) return Math.max(1, Math.round(U().num(S.config.diasTesteProPadrao)));
  try {
    const s = await fs.getDoc(fs.doc(db, 'config', 'app'));
    const d = s.exists() ? U().num(s.data().diasTesteProPadrao) : 0;
    return d >= 1 ? Math.round(d) : 60;
  } catch (e) { return 60; }
}

function confirmarTesteParaTodos() {
  const n = contarTestePendente();
  if (!n) { toast('Ninguém está esperando o teste Pro.', 'erro'); return; }
  const dias = Math.max(1, Math.round(U().num(S.el.querySelector('#aj-dias')?.value || S.config?.diasTesteProPadrao || 60)));
  abrirFolha(
    '<h2 class="folha-tit">⚠️ Ativar teste Pro para todos?</h2>' +
    '<p><b>' + n + ' pessoa(s)</b> passam para Teste Pro até <b>' + esc(U().dataBR(daquiADias(dias))) + '</b> (' + dias + ' dias).</p>' +
    '<p>Use <b>só quando o Pro existir</b>. Não dá para desfazer de uma vez só.</p>' +
    '<label for="conf-txt">Para confirmar, digite ATIVAR</label>' +
    '<input id="conf-txt" class="js-conf" autocomplete="off" autocapitalize="characters">' +
    '<button type="button" class="big mt-btn-perigo" data-f="confirmar-teste" style="margin-top:14px">Ativar agora</button>' +
    '<button type="button" class="big" data-fechar>Cancelar</button>',
    async (ev, ov) => {
      const b = ev.target.closest('[data-f="confirmar-teste"]');
      if (!b) return;
      if (ov.querySelector('.js-conf').value.trim().toUpperCase() !== 'ATIVAR') { toast('Digite ATIVAR para confirmar.', 'erro'); return; }
      b.disabled = true;
      b.textContent = 'Ativando…';
      await ativarTesteParaTodos(dias);
      fecharFolha();
    });
}

async function ativarTesteParaTodos(dias) {
  const alvos = [...S.users.entries()].filter(([, u]) => u.testeProPendente === true);
  const ate = ts(daquiADias(dias));
  try {
    for (let i = 0; i < alvos.length; i += 400) {
      const lote = fs.writeBatch(db);
      alvos.slice(i, i + 400).forEach(([uid, u]) => {
        const ref = fs.doc(db, 'users', uid);
        if (u.plano === 'pro') lote.update(ref, { testeProPendente: false }); // já é Pro: só zera a marca
        else lote.update(ref, { plano: 'teste_pro', proAte: ate, testeProPendente: false });
      });
      const r = await comPrazo(lote.commit(), 20000);
      if (r === 'fila') { toast('Sem internet: a ativação fica guardada e envia quando a conexão voltar.', 'ok'); return; }
    }
    toast('Teste Pro ativado para ' + alvos.length + ' pessoa(s)!', 'ok');
  } catch (e) {
    console.error('[Print] ativar teste Pro', e);
    toast(U().traduzErro(e), 'erro');
  }
}

/* ============================================================
   6. Ações nos usuários
   ============================================================ */
async function mudarUsuario(uid, campos, msgOk) {
  return gravar(fs.updateDoc(fs.doc(db, 'users', uid), campos), msgOk);
}

function camposLiberar() {
  return { status: 'ativo', liberadoEm: fs.serverTimestamp(), testeProPendente: true, liberadoPor: 'manual' }; // 1.1.0: + liberadoPor
}

async function liberar(uid, botao) {
  if (botao) { botao.disabled = true; botao.textContent = 'Liberando…'; }
  const ok = await mudarUsuario(uid, camposLiberar(), U().primeiroNome(nomeDe(uid), 'Usuário') + ' liberado ✓');
  if (!ok && botao) { botao.disabled = false; botao.textContent = '✅ Liberar'; }
}

async function reativar(uid) {
  const u = S.users.get(uid) || {};
  // Quem nunca foi liberado (bloqueado direto do pendente) é liberado de verdade.
  const campos = u.liberadoEm ? { status: 'ativo' } : camposLiberar();
  return mudarUsuario(uid, campos, U().primeiroNome(nomeDe(uid), 'Usuário') + ' reativado ✓');
}

function confirmar(titulo, texto, rotuloBotao, acao, perigo = false) {
  abrirFolha(
    '<h2 class="folha-tit">' + esc(titulo) + '</h2>' +
    (texto ? '<p>' + esc(texto) + '</p>' : '') +
    '<button type="button" class="big ' + (perigo ? 'mt-btn-perigo' : 'primary') + '" data-f="sim">' + esc(rotuloBotao) + '</button>' +
    '<button type="button" class="big" data-fechar>Cancelar</button>',
    async ev => {
      const b = ev.target.closest('[data-f="sim"]');
      if (!b) return;
      b.disabled = true;
      await acao();
      fecharFolha();
    });
}

async function mudarPlano(uid, plano) {
  const u = S.users.get(uid) || {};
  if (u.plano === plano) return;
  let campos;
  if (plano === 'free') {
    campos = { plano: 'free', proAte: null };
  } else if (plano === 'teste_pro') {
    const ate = U().paraData(u.proAte);
    const futuro = ate && ate.getTime() > Date.now() ? ate : daquiADias(await diasTeste());
    campos = { plano: 'teste_pro', proAte: ts(futuro), testeProPendente: false };
  } else {
    campos = { plano: 'pro', proAte: null, testeProPendente: false }; // Pro sem vencimento (parceiro)
  }
  return mudarUsuario(uid, campos, 'Plano mudado para ' + ({ free: 'Free', teste_pro: 'Teste Pro', pro: 'Pro' })[plano] + ' ✓');
}

async function estenderPro(uid, dias) {
  const u = S.users.get(uid) || {};
  if (u.plano !== 'pro' && u.plano !== 'teste_pro') { toast('Só dá para estender quem está no Pro ou no Teste Pro.', 'erro'); return; }
  if (dias === 'sem') return mudarUsuario(uid, { proAte: null }, 'Pro sem vencimento ✓');
  const atual = U().paraData(u.proAte);
  const base = atual && atual.getTime() > Date.now() ? atual : new Date();
  const novo = daquiADias(dias, base);
  return mudarUsuario(uid, { proAte: ts(novo) }, 'Pro até ' + U().dataBR(novo) + ' ✓');
}

/** Folha de ações de um usuário. */
function abrirAcoes(uid) {
  const desenhar = () => {
    const u = S.users.get(uid);
    if (!u) return '<p>Usuário não encontrado.</p><button type="button" class="big" data-fechar>Fechar</button>';
    const st = u.status || 'pendente';
    const voce = uid === S.ctx.estado.uid;
    let status = '';
    if (st === 'pendente') status = '<div class="mt-duplo"><button type="button" class="big primary" data-f="liberar">✅ Liberar</button><button type="button" class="big" data-f="recusar">Recusar</button></div>';
    else if (st === 'recusado') status = '<button type="button" class="big primary" data-f="liberar">✅ Liberar</button>';
    else if (st === 'bloqueado') status = '<button type="button" class="big primary" data-f="reativar">🔓 Reativar</button>';
    // Bloquear fica no fim da folha (longe do polegar), com contorno vermelho.
    const bloquear = st === 'ativo' && !voce ? '<button type="button" class="big mt-btn-contorno" data-f="bloquear">🔒 Bloquear acesso</button>' : '';
    const temPro = u.plano === 'pro' || u.plano === 'teste_pro';
    return '<h2 class="folha-tit">' + esc(u.nome || 'Sem nome') + '</h2>' +
      '<div class="mu-selos">' + seloStatus(st) + seloPlano(u) + seloLiberacao(u) + seloParceiro(uid) + seloRepetida(u) + '</div>' +
      // 1.2.0: profissões, WhatsApp e jeito de entrar
      '<p class="mu-info">' + linhaProfissoes(u) + '<br>' +
        (u.whatsapp ? '📱 ' + esc(formatarWhats(u.whatsapp)) : '📱 sem WhatsApp') +
        (u.entrada === 'google' ? ' · entrou com Google' : u.entrada === 'email' ? ' · entrou com e-mail' : '') +
        (u.email ? '<br>✉️ ' + esc(u.email) : '') + '</p>' +
      status +
      '<p class="rotulo">Plano</p>' +
      '<div class="seg tres" role="group" aria-label="Plano">' +
        [['free', 'Free'], ['teste_pro', 'Teste Pro'], ['pro', 'Pro']].map(([k, n]) =>
          '<button type="button" data-f="plano" data-plano="' + k + '" class="' + (u.plano === k ? 'on' : '') + '" aria-pressed="' + (u.plano === k) + '">' + n + '</button>').join('') +
      '</div>' +
      (temPro
        ? '<p class="rotulo">Estender o Pro · ' + esc(textoPlano(u)) + '</p>' +
          '<div class="qk">' +
            [30, 60, 90].map(n => '<button type="button" data-f="estender" data-dias="' + n + '">+' + n + ' dias</button>').join('') +
            (u.plano === 'pro' && u.proAte ? '<button type="button" data-f="estender" data-dias="sem">Sem vencimento</button>' : '') +
          '</div>'
        : '<p class="campo-ajuda">Para estender o Pro, mude antes o plano para Teste Pro ou Pro.</p>') +
      '<button type="button" class="big" data-f="notas" style="margin-top:14px">📝 Notas e parceria</button>' +
      (u.whatsapp ? '<button type="button" class="big" data-f="liberar-whats">📱 Liberar este WhatsApp</button>' : '') + // 1.2.0
      bloquear +
      '<button type="button" class="big" data-fechar>Fechar</button>';
  };

  abrirFolha(desenhar(), async (ev, ov) => {
    const b = ev.target.closest('[data-f]');
    if (!b || b.disabled) return;
    const f = b.dataset.f;
    if (f === 'notas') { abrirNotas(uid); return; }
    if (f === 'liberar-whats') { abrirLiberarWhats(uid); return; } // 1.2.0
    if (f === 'recusar') { pedirRecusa(uid); return; }
    if (f === 'bloquear') {
      confirmar('Bloquear ' + nomeDe(uid) + '?', 'A pessoa deixa de entrar no app até você reativar. Os dados dela ficam guardados.', 'Bloquear',
        () => mudarUsuario(uid, { status: 'bloqueado' }, 'Bloqueado ✓'), true);
      return;
    }
    b.disabled = true;
    if (f === 'liberar') await liberar(uid);
    else if (f === 'reativar') await reativar(uid);
    else if (f === 'plano') await mudarPlano(uid, b.dataset.plano);
    else if (f === 'estender') await estenderPro(uid, b.dataset.dias === 'sem' ? 'sem' : +b.dataset.dias);
    b.disabled = false;
  }, { tipo: 'acoes', uid, desenhar });
}

/* ============================================================
   6.1 Liberar este WhatsApp (1.2.0): apaga telefones/{numero}
   Para quando a pessoa perdeu a conta ou trocou de número.
   ============================================================ */
async function abrirLiberarWhats(uid) {
  const u = S.users.get(uid) || {};
  const numero = soDigitos(u.whatsapp);
  if (numero.length < 10) { toast('Esta conta não tem WhatsApp.', 'erro'); return; }
  const ov = abrirFolha(
    '<h2 class="folha-tit">📱 Liberar este WhatsApp</h2>' +
    '<p><b>' + esc(formatarWhats(numero)) + '</b> · ' + esc(u.nome || 'Sem nome') + '</p>' +
    '<p class="muted js-lw-info">Conferindo o número…</p>' +
    '<button type="button" class="big" data-fechar>Cancelar</button>');
  const meu = S.folha;
  let info = '';
  let existe = false;
  try {
    const s = await fs.getDoc(fs.doc(db, 'telefones', numero));
    existe = s.exists();
    const dono = existe ? s.data().uid : null;
    if (!existe) info = 'Este número não está registrado (conta antiga, de antes da Sessão 4B, ou já foi liberado). Não há nada para liberar.';
    else if (dono === uid) info = 'O número está registrado nesta conta. Liberando, ele pode ser usado num cadastro novo (a pessoa perdeu a conta ou trocou de número). Esta conta continua igual.';
    else info = '⚠️ O número está registrado em OUTRA conta: ' + (S.users.get(dono)?.nome || 'conta sem cadastro') + '. Liberando, ele pode ser usado num cadastro novo.';
  } catch (e) {
    info = 'Não deu para conferir: ' + U().traduzErro(e);
  }
  if (!S || S.folha !== meu) return;
  const sheet = ov.querySelector('.sheet');
  sheet.innerHTML =
    '<h2 class="folha-tit">📱 Liberar este WhatsApp</h2>' +
    '<p><b>' + esc(formatarWhats(numero)) + '</b> · ' + esc(u.nome || 'Sem nome') + '</p>' +
    '<p>' + esc(info) + '</p>' +
    (existe
      ? '<label for="lw-txt">Para confirmar, digite LIBERAR</label>' +
        '<input id="lw-txt" class="js-conf" autocomplete="off" autocapitalize="characters">' +
        '<button type="button" class="big mt-btn-perigo" data-f="lw-sim" style="margin-top:14px">Liberar o número</button>'
      : '') +
    '<button type="button" class="big" data-fechar>' + (existe ? 'Cancelar' : 'Fechar') + '</button>';
  ov.addEventListener('click', async ev => {
    const b = ev.target.closest('[data-f="lw-sim"]');
    if (!b || b.disabled) return;
    if (ov.querySelector('.js-conf').value.trim().toUpperCase() !== 'LIBERAR') { toast('Digite LIBERAR para confirmar.', 'erro'); return; }
    b.disabled = true;
    b.textContent = 'Liberando…';
    const ok = await gravar(fs.deleteDoc(fs.doc(db, 'telefones', numero)), 'WhatsApp ' + formatarWhats(numero) + ' liberado ✓');
    if (ok) fecharFolha(); else { b.disabled = false; b.textContent = 'Liberar o número'; }
  });
}

function pedirRecusa(uid) {
  confirmar('Recusar o cadastro de ' + nomeDe(uid) + '?', 'A pessoa vê "Cadastro não aprovado". Dá para liberar depois, se mudar de ideia.', 'Recusar',
    () => mudarUsuario(uid, { status: 'recusado' }, 'Cadastro recusado'), true);
}

/* ============================================================
   7. Notas, tags, último contato e parceiro (masterNotas/{uid})
   ============================================================ */
function gerarCodigo() {
  const usados = new Set([...S.notas.values()].map(n => n.codigo).filter(Boolean));
  for (let t = 0; t < 50; t++) {
    const bytes = new Uint32Array(6);
    crypto.getRandomValues(bytes);
    const c = [...bytes].map(x => ALFABETO_CODIGO[x % ALFABETO_CODIGO.length]).join('');
    if (!usados.has(c)) return c;
  }
  throw new Error('Não deu para gerar um código novo. Tente de novo.');
}

function abrirNotas(uid, pedidoId = null) {
  // Rascunho do que está sendo editado (para não perder ao redesenhar)
  const n0 = S.notas.get(uid) || {};
  const rasc = { notas: n0.notas || '', tags: Array.isArray(n0.tags) ? n0.tags.slice() : [] };

  const desenhar = () => {
    const n = S.notas.get(uid) || {};
    const u = S.users.get(uid) || {};
    const zap = u.whatsapp || S.pedidos.find(p => p.uid === uid)?.whatsapp;
    const tagsTodas = [...new Set([...TAGS_RAPIDAS, ...rasc.tags])];
    return '<h2 class="folha-tit">' + esc(nomeDe(uid)) + '</h2>' +
      '<p class="muted pequeno">' + (zap ? '📱 ' + esc(formatarWhats(zap)) : 'sem WhatsApp') + (u.cidade ? ' · ' + esc(u.cidade) : '') + '</p>' +
      '<div class="mu-acoes">' + botaoZap(zap, nomeDe(uid, '')) + '</div>' +

      '<p class="rotulo">Último contato: <b>' + esc(n.ultimoContato ? haQuanto(n.ultimoContato) + ' (' + U().dataBR(n.ultimoContato) + ')' : 'nunca') + '</b></p>' +
      '<button type="button" class="big" data-f="contato-hoje">📅 Falei com ele hoje</button>' +

      '<p class="rotulo">Tags</p>' +
      '<div class="qk mt-tags">' + tagsTodas.map(t =>
        '<button type="button" data-f="tag" data-tag="' + esc(t) + '" class="' + (rasc.tags.includes(t) ? 'on' : '') + '" aria-pressed="' + rasc.tags.includes(t) + '">' + esc(t) + '</button>').join('') +
      '</div>' +
      '<div class="mt-tag-nova"><label class="mt-oculto" for="nt-tag">Nova tag</label>' +
        '<input id="nt-tag" class="js-tag" maxlength="30" placeholder="Outra tag"><button type="button" class="mt-btn" data-f="tag-nova">+ Pôr</button></div>' +

      '<label for="nt-notas">Notas</label>' +
      '<textarea id="nt-notas" class="js-notas" maxlength="3000" placeholder="Ex.: pinta casas de alto padrão, compra na loja X…">' + esc(rasc.notas) + '</textarea>' +
      '<button type="button" class="big primary" data-f="salvar">Salvar notas e tags</button>' +

      '<div class="card mt-parceiro">' +
        (n.parceiro
          ? '<b>⭐ Parceiro</b><p>Código do parceiro: <span class="codigo mt-codigo">' + esc(n.codigo || '—') + '</span></p>' +
            (n.codigo ? '<button type="button" class="big" data-f="copiar" data-txt="' + esc(n.codigo) + '">📋 Copiar o código</button>' : '') +
            '<button type="button" class="big" data-f="tirar-parceiro">Tirar a parceria</button>'
          : '<b>Parceria</b><p class="muted pequeno">Gera um código de 6 letras e números (sem letras confusas) e marca a pessoa como parceira.' + (n.codigo ? ' O código ' + esc(n.codigo) + ' volta a valer.' : '') + '</p>' +
            '<button type="button" class="big primary" data-f="parceiro">⭐ Marcar como parceiro</button>') +
      '</div>' +
      '<button type="button" class="big" data-fechar>Fechar</button>';
  };

  const salvarNota = (campos, msg) =>
    gravar(fs.setDoc(fs.doc(db, 'masterNotas', uid), { ...campos, atualizadoEm: fs.serverTimestamp() }, { merge: true }), msg);

  abrirFolha(desenhar(), async (ev, ov) => {
    const b = ev.target.closest('[data-f]');
    if (!b || b.disabled) return;
    const f = b.dataset.f;
    rasc.notas = ov.querySelector('.js-notas')?.value ?? rasc.notas;

    if (f === 'tag') {
      const t = b.dataset.tag;
      rasc.tags = rasc.tags.includes(t) ? rasc.tags.filter(x => x !== t) : [...rasc.tags, t];
      b.classList.toggle('on');
      b.setAttribute('aria-pressed', rasc.tags.includes(t));
      return;
    }
    if (f === 'tag-nova') {
      const inp = ov.querySelector('.js-tag');
      const t = inp.value.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!t) { inp.focus(); return; }
      if (!rasc.tags.includes(t)) rasc.tags.push(t);
      redesenharFolha();
      return;
    }
    if (f === 'copiar') {
      navigator.clipboard?.writeText(b.dataset.txt)
        .then(() => toast('Código copiado', 'ok'))
        .catch(() => toast('Não deu para copiar. Selecione e copie à mão.', 'erro'));
      return;
    }

    b.disabled = true;
    if (f === 'salvar') {
      await salvarNota({ notas: rasc.notas.trim(), tags: rasc.tags }, 'Notas salvas ✓');
    } else if (f === 'contato-hoje') {
      await salvarNota({ ultimoContato: fs.serverTimestamp() }, 'Último contato: hoje ✓');
    } else if (f === 'parceiro') {
      try {
        const atual = S.notas.get(uid) || {};
        const codigo = atual.codigo || gerarCodigo();
        const ok = await salvarNota({ parceiro: true, codigo }, '⭐ Parceiro! Código ' + codigo);
        if (ok && pedidoId) {
          const p = S.pedidos.find(x => x.id === pedidoId);
          if (p && p.status !== 'parceiro') fs.updateDoc(fs.doc(db, 'pedidosContato', pedidoId), { status: 'parceiro' }).catch(() => {});
        }
      } catch (e) { toast(U().traduzErro(e), 'erro'); }
    } else if (f === 'tirar-parceiro') {
      await salvarNota({ parceiro: false }, 'Parceria retirada (o código fica guardado)');
    }
    b.disabled = false;
  }, { tipo: 'notas', uid, desenhar });
}

/* ============================================================
   8. Folha que sobe de baixo (sheet)
   ============================================================ */
function abrirFolha(html, aoClicarFolha, info = null) {
  fecharFolha();
  const ov = document.createElement('div');
  ov.className = 'ov mt-folha';
  ov.innerHTML = '<div class="sheet" role="dialog" aria-modal="true">' + html + '</div>';
  ov.addEventListener('click', ev => {
    if (ev.target === ov || ev.target.closest('[data-fechar]')) { fecharFolha(); return; }
    aoClicarFolha?.(ev, ov);
  });
  document.body.appendChild(ov);
  S.folha = { ov, info };
  ov.querySelector('.sheet').scrollTop = 0;
  return ov;
}

function fecharFolha() {
  if (!S?.folha) return;
  S.folha.ov.remove();
  S.folha = null;
}

/** Redesenha a folha aberta (ex.: depois de uma mudança chegar do servidor). */
function redesenharFolha() {
  const f = S?.folha;
  if (!f?.info?.desenhar) return;
  const sheet = f.ov.querySelector('.sheet');
  const rolagem = sheet.scrollTop;
  const notas = sheet.querySelector('.js-notas');
  const foco = document.activeElement && sheet.contains(document.activeElement) ? document.activeElement.className : '';
  sheet.innerHTML = f.info.desenhar();
  // Mantém o texto e o foco de quem está digitando
  if (notas) { const n = sheet.querySelector('.js-notas'); if (n) n.value = notas.value; }
  sheet.scrollTop = rolagem;
  if (foco.includes('js-notas')) sheet.querySelector('.js-notas')?.focus({ preventScroll: true });
}

function atualizarFolhaAberta() {
  if (S?.folha?.info) redesenharFolha();
}

/* ============================================================
   9. Eventos (um ouvinte só para a tela toda)
   ============================================================ */
function aoClicar(ev) {
  if (!S) return;
  const aba = ev.target.closest('[data-aba]');
  if (aba) {
    S.aba = aba.dataset.aba;
    guardarAba(S.aba);
    desenharAba();
    return;
  }
  const filtro = ev.target.closest('[data-filtro]');
  if (filtro) { S.filtro = filtro.dataset.filtro; desenharAba(); return; }
  const fprof = ev.target.closest('[data-fprof]');                              // 1.2.0
  if (fprof) { S.filtroProf = fprof.dataset.fprof; desenharAba(); return; }
  const fped = ev.target.closest('[data-fped]');
  if (fped) { S.filtroPedidos = fped.dataset.fped; desenharAba(); return; }
  const fuso = ev.target.closest('[data-fuso]');                                // 1.3.0
  if (fuso) { S.filtroUso = fuso.dataset.fuso; atualizarUso(); S.el.querySelector('.mt-fuso')?.scrollIntoView({ block: 'nearest' }); return; }

  const b = ev.target.closest('[data-acao]');
  if (!b || b.disabled) return;
  const uid = b.dataset.uid;
  switch (b.dataset.acao) {
    case 'liberar': liberar(uid, b); break;
    case 'recusar': pedirRecusa(uid); break;
    case 'reativar': b.disabled = true; reativar(uid).finally(() => { b.disabled = false; }); break;
    case 'acoes': abrirAcoes(uid); break;
    case 'notas': abrirNotas(uid, b.dataset.pedido || null); break;
    case 'pedido-status': {
      const p = S.pedidos.find(x => x.id === b.dataset.id);
      if (!p || p.status === b.dataset.st) break;
      gravar(fs.updateDoc(fs.doc(db, 'pedidosContato', p.id), { status: b.dataset.st }),
        'Pedido marcado como ' + STATUS_PEDIDO.find(x => x[0] === b.dataset.st)[1].toLowerCase());
      break;
    }
    case 'atualizar-uso': carregarUso(); break;
    case 'ficha-uso': abrirFichaUso(uid); break; // 1.3.0
    case 'ativar-teste': confirmarTesteParaTodos(); break;
    case 'auto-chave': mudarChaveAuto(b.dataset.v === '1', b); break; // 1.1.0
  }
}

let timerBusca = null;
function aoDigitar(ev) {
  if (!S || !ev.target.classList.contains('js-busca')) return;
  S.busca = ev.target.value;
  clearTimeout(timerBusca);
  timerBusca = setTimeout(() => { if (S) atualizarUsuarios(); }, 150);
}

function aoEnviar(ev) {
  if (!S) return;
  if (ev.target.classList.contains('js-form-empresa')) { ev.preventDefault(); salvarEmpresa(ev.target); }
  else if (ev.target.classList.contains('js-form-ajustes')) { ev.preventDefault(); salvarAjustes(ev.target); }
  else if (ev.target.classList.contains('js-form-auto')) { ev.preventDefault(); salvarMinutos(ev.target); } // 1.1.0
}

function aoTecla(ev) {
  if (ev.key === 'Escape' && S?.folha) fecharFolha();
}
