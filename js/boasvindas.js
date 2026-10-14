/*
  Arquivo: js/boasvindas.js
  Versão: 1.0.0
  Sessão: 2 — Cadastro, login e pendente
  Data: 14/10/2026
  Boas-vindas: 3 cartões mostrados uma vez, na primeira abertura sem login.
  A marca fica no navegador (localStorage, chave print.boasVindas).

  Contrato: montar(container, ctx)
  Extras:   jaViuBoasVindas(), marcarBoasVindas()
*/

const CHAVE = 'print.boasVindas';

/* Textos aprovados (Plano, seção 4 — decisões de 14/10/2026). Não mudar sem o Maestro. */
const CARTOES = [
  { ic: '📄', txt: 'Monte orçamentos em minutos, com a sua logo.' },
  { ic: '⭐', txt: 'Você está entre os primeiros: o app é grátis, e quem entra agora ganha 2 meses de Pro quando ele abrir. Depois do período grátis, o Pro terá um valor, e avisamos com 30 dias de antecedência. O Free continua grátis.' },
  { ic: '💬', txt: 'Dúvidas, ideias ou benefícios para profissionais? Fale com a equipe do Print pelo app.' }
];

/** true se a pessoa já viu (ou pulou) as boas-vindas neste navegador. */
export function jaViuBoasVindas() {
  try { return localStorage.getItem(CHAVE) === '1'; } catch (e) { return false; }
}

export function marcarBoasVindas() {
  try { localStorage.setItem(CHAVE, '1'); } catch (e) { /* sem armazenamento: mostra de novo na próxima */ }
}

export function montar(el, ctx) {
  let atual = 0;

  function desenhar() {
    const c = CARTOES[atual];
    const ultimo = atual === CARTOES.length - 1;
    el.innerHTML =
      '<div class="bv">' +
        '<div class="bv-topo">' +
          '<span class="bv-nome">Print — Orçamentos e Gestão</span>' +
          (ultimo ? '' : '<button class="link-btn js-pular" type="button">Pular</button>') +
        '</div>' +
        '<div class="bv-cartao" aria-live="polite">' +
          '<span class="bv-ic" aria-hidden="true">' + c.ic + '</span>' +
          '<p class="bv-txt">' + ctx.utils.esc(c.txt) + '</p>' +
        '</div>' +
        '<div class="dots bv-dots" aria-label="Cartão ' + (atual + 1) + ' de ' + CARTOES.length + '">' +
          CARTOES.map((_, i) => '<i class="' + (i <= atual ? 'on' : '') + '"></i>').join('') +
        '</div>' +
        (ultimo
          ? '<button class="big primary js-criar" type="button">Criar minha conta</button>' +
            '<button class="big js-entrar" type="button">Já tenho conta</button>'
          : '<button class="big primary js-prox" type="button">Próximo</button>' +
            (atual > 0 ? '<button class="big js-volta" type="button">Voltar</button>' : '')) +
      '</div>';

    el.querySelector('.js-pular')?.addEventListener('click', () => sair('entrar'));
    el.querySelector('.js-prox')?.addEventListener('click', () => { atual++; desenhar(); });
    el.querySelector('.js-volta')?.addEventListener('click', () => { atual--; desenhar(); });
    el.querySelector('.js-criar')?.addEventListener('click', () => sair('cadastro'));
    el.querySelector('.js-entrar')?.addEventListener('click', () => sair('entrar'));
    el.querySelector('.big.primary')?.focus({ preventScroll: true });
  }

  function sair(tela) {
    marcarBoasVindas();
    ctx.ir(tela);
  }

  desenhar();
}
