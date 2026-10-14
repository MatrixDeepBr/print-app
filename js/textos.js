/*
  Arquivo: js/textos.js
  Versão: 1.0.0
  Sessão: 2 — Cadastro, login e pendente
  Data: 14/10/2026
  Termos de uso, Política de Privacidade e Sobre (RASCUNHO).
  Rota: #termos (Termos), #termos/privacidade, #termos/sobre.
  A Collornew é citada SÓ aqui (marca neutra no resto do app).

  Contrato: montar(container, ctx)
  Extras:   VERSAO_TERMOS (gravada no cadastro), rodapeLegal() (links para o rodapé do Perfil)

  Trechos entre [colchetes] precisam ser preenchidos pelo dono antes do piloto.
*/

/** Mude esta versão sempre que o texto dos Termos ou da Política mudar. */
export const VERSAO_TERMOS = '2026-10-14-rascunho';

const RESPONSAVEL = 'Collornew Tintas e Revestimentos';
const CONTATO_EMAIL = 'collornewrp@gmail.com';

const AVISO = '<p class="rascunho">RASCUNHO — revisar com contador ou advogado</p>';

const TEXTOS = {
  termos: {
    titulo: 'Termos de uso',
    html:
      AVISO +
      '<p class="muted">Versão ' + VERSAO_TERMOS + '</p>' +
      '<h2>1. Quem oferece o app</h2>' +
      '<p>O Print — Orçamentos e Gestão é oferecido pela ' + RESPONSAVEL + ', [CNPJ a preencher], com sede em São José do Rio Preto (SP), [endereço a preencher].</p>' +
      '<h2>2. Para que serve</h2>' +
      '<p>O Print ajuda profissionais da construção civil a montar orçamentos, cuidar dos clientes e organizar o próprio trabalho.</p>' +
      '<h2>3. O app é grátis</h2>' +
      '<p>Usar o Print é grátis. Há duas versões: Free e Pro.</p>' +
      '<p>O Free continua grátis, e nada que hoje faz parte dele será retirado.</p>' +
      '<p>Quem entra agora ganha 2 meses de Pro quando ele abrir. Depois do período grátis, o Pro terá um valor. Avisamos com pelo menos 30 dias de antecedência, antes de qualquer cobrança. Ninguém passa a pagar sem concordar.</p>' +
      '<h2>4. Sua conta</h2>' +
      '<p>Para usar o app, você cria uma conta com nome, WhatsApp, cidade, e-mail e senha. A liberação do acesso é feita pela equipe.</p>' +
      '<p>Guarde a sua senha e não a passe para ninguém. Você é responsável pelo que for feito na sua conta.</p>' +
      '<p>A equipe pode recusar um cadastro ou bloquear uma conta usada de forma abusiva, ilegal ou que prejudique o app ou outras pessoas.</p>' +
      '<h2>5. Seus dados são seus</h2>' +
      '<p>Os seus clientes, orçamentos e demais informações que você cadastra pertencem a você. Você pode pedir uma cópia deles ou a exclusão a qualquer momento.</p>' +
      '<p>A equipe não usa os dados dos seus clientes para nenhum fim, nem para vender, nem para oferecer produtos a eles.</p>' +
      '<h2>6. Uso do app</h2>' +
      '<p>Para melhorar o app, acompanhamos só o uso: quantas vezes você abre, por quanto tempo usa, quantos orçamentos faz e a soma dos valores orçados por dia. Os detalhes estão na Política de Privacidade.</p>' +
      '<h2>7. Responsabilidades</h2>' +
      '<p>Os valores, os serviços e as condições dos orçamentos são definidos por você. O app é uma ferramenta e não participa do acordo entre você e o seu cliente.</p>' +
      '<p>Fazemos o possível para o app funcionar sempre, mas ele pode ficar fora do ar por falha de internet, manutenção ou de serviços de terceiros.</p>' +
      '<h2>8. Mudanças nestes termos</h2>' +
      '<p>Se estes termos mudarem, avisamos no app. Mudanças que envolvam cobrança seguem o aviso de 30 dias do item 3.</p>' +
      '<h2>9. Contato</h2>' +
      '<p>Pelo botão Falar com a equipe, no app, ou pelo e-mail ' + CONTATO_EMAIL + '.</p>' +
      '<p>Fica eleito o foro de São José do Rio Preto (SP).</p>'
  },

  privacidade: {
    titulo: 'Política de Privacidade',
    html:
      AVISO +
      '<p class="muted">Versão ' + VERSAO_TERMOS + '</p>' +
      '<p>Esta política explica quais dados o Print guarda, para quê, e quais são os seus direitos, conforme a Lei Geral de Proteção de Dados (LGPD, Lei nº 13.709/2018).</p>' +
      '<h2>1. Quem cuida dos dados</h2>' +
      '<p>' + RESPONSAVEL + ', [CNPJ a preencher], São José do Rio Preto (SP).</p>' +
      '<p>Encarregado de dados (LGPD): [nome a preencher], pelo e-mail ' + CONTATO_EMAIL + '.</p>' +
      '<h2>2. Dados da sua conta</h2>' +
      '<p>Nome, WhatsApp, cidade, e-mail, código de parceiro (se você informar), data do cadastro e data do aceite destes termos.</p>' +
      '<p><b>Para quê:</b> criar e manter a sua conta, liberar o acesso e falar com você quando precisar.</p>' +
      '<p><b>Base legal:</b> execução do contrato de uso do app (LGPD, art. 7º, V).</p>' +
      '<h2>3. Dados de uso</h2>' +
      '<p>Por dia: quantas vezes o app foi aberto, por quanto tempo foi usado, quantos orçamentos foram feitos e a soma dos valores orçados.</p>' +
      '<p><b>Para quê:</b> melhorar o app e entender quais recursos ajudam mais.</p>' +
      '<p><b>Base legal:</b> legítimo interesse (LGPD, art. 7º, IX). Você pode se opor pelo contato abaixo.</p>' +
      '<p>Só coletamos esses dados de uso. Não coletamos localização, contatos do celular, fotos ou o que você faz em outros apps.</p>' +
      '<h2>4. Dados dos seus clientes</h2>' +
      '<p>Os clientes e orçamentos que você cadastra são seus. Você decide o que guardar, e é você quem trata esses dados com os seus clientes.</p>' +
      '<p>Nós só guardamos esses dados para o app funcionar. A equipe não consulta nem usa esses dados, e eles nunca são vendidos ou passados para outras empresas.</p>' +
      '<h2>5. Onde ficam os dados</h2>' +
      '<p>Os dados ficam guardados no Google Firebase, com acesso protegido por senha e por regras que separam a conta de cada pessoa. A senha é guardada pelo próprio sistema de login do Google, e nem a equipe tem acesso a ela.</p>' +
      '<p>No seu aparelho, o app lembra só o e-mail do último login e as suas preferências de tela.</p>' +
      '<h2>6. Por quanto tempo</h2>' +
      '<p>Enquanto a sua conta existir. Se você pedir a exclusão, apagamos os dados em até 30 dias, menos o que a lei mandar guardar.</p>' +
      '<h2>7. Seus direitos</h2>' +
      '<p>Você pode, a qualquer momento: saber quais dados temos, receber uma cópia (exportar), corrigir, pedir a exclusão, se opor ao acompanhamento de uso e tirar dúvidas sobre esta política.</p>' +
      '<h2>8. Como pedir</h2>' +
      '<p>Pelo botão Falar com a equipe, no app, ou pelo e-mail ' + CONTATO_EMAIL + '. Respondemos em até 15 dias.</p>'
  },

  sobre: {
    titulo: 'Sobre',
    html:
      '<p><b>Print — Orçamentos e Gestão</b></p>' +
      '<p class="muted">Versão piloto · outubro de 2026</p>' +
      '<p>Um app feito para pintores e profissionais da construção civil montarem orçamentos na frente do cliente e organizarem o próprio trabalho, no celular e no computador.</p>' +
      '<p>Responsável: ' + RESPONSAVEL + ', São José do Rio Preto (SP).</p>' +
      '<p>Dúvidas, ideias ou benefícios para profissionais? Use o botão Falar com a equipe.</p>'
  }
};

const ABAS = [['termos', 'Termos'], ['privacidade', 'Privacidade'], ['sobre', 'Sobre']];

/** Links para o rodapé (Perfil). */
export function rodapeLegal() {
  return '<p class="rodape-legal">' +
    '<a href="#termos">Termos de uso</a> · <a href="#termos/privacidade">Privacidade</a> · <a href="#termos/sobre">Sobre</a>' +
    '</p>';
}

/** Qual texto abrir: #termos/privacidade -> 'privacidade'. */
function qualDoEndereco() {
  const sub = location.hash.replace(/^#\/?/, '').split('/')[1] || '';
  return TEXTOS[sub] ? sub : 'termos';
}

export function montar(el, ctx) {
  const qual = (ctx.params && TEXTOS[ctx.params.qual]) ? ctx.params.qual : qualDoEndereco();
  const t = TEXTOS[qual];
  el.classList.add('texto-legal');
  el.innerHTML =
    '<div class="top"><button class="back js-voltar" type="button" aria-label="Voltar">←</button></div>' +
    '<div class="seg tres" role="tablist">' +
      ABAS.map(([k, n]) => '<button type="button" role="tab" aria-selected="' + (k === qual) + '" class="' + (k === qual ? 'on' : '') + '" data-qual="' + k + '">' + n + '</button>').join('') +
    '</div>' +
    '<h1>' + t.titulo + '</h1>' +
    t.html +
    '<button class="big js-voltar" type="button" style="margin-top:20px">Voltar</button>';

  el.querySelectorAll('[data-qual]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.qual;
    history.replaceState(null, '', k === 'termos' ? '#termos' : '#termos/' + k);
    montar(el, { ...ctx, params: { qual: k } });
    window.scrollTo(0, 0);
  }));
  el.querySelectorAll('.js-voltar').forEach(b => b.addEventListener('click', () => {
    // Volta para a tela de onde veio (ex.: cadastro, sem perder o que já foi digitado).
    if (history.length > 1) history.back();
    else ctx.ir('inicio');
  }));
}
