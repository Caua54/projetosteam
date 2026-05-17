/**
 * VaultDB — Steam Price Tracker
 * Consome a CheapShark API para exibir preços e ofertas de jogos da Steam.
 * Docs da API: https://apidocs.cheapshark.com/
 */

'use strict';

/* ============================================================
   CONSTANTES E CONFIGURAÇÃO
   ============================================================ */

/** ID da loja Steam na CheapShark */
const STEAM_STORE_ID = '1';

/** Endpoints da CheapShark */
const API_BASE   = 'https://www.cheapshark.com/api/1.0';
const DEALS_URL  = `${API_BASE}/deals`;
const GAMES_URL  = `${API_BASE}/games`;

/** Limite de resultados por página */
const PAGE_SIZE = 12;

/** URL base para redirecionar para a Steam via CheapShark */
const REDIRECT_URL = 'https://www.cheapshark.com/redirect?dealID=';

/* ============================================================
   SISTEMA DE MOEDA E CÂMBIO
   Tenta 3 APIs em sequência para garantir cotação real do dia.
   Todos os preços chegam em USD — multiplica pelo rate ao vivo.
   Ex: $20 USD × 5.72 = R$ 114,40
   ============================================================ */

const CURRENCIES = {
  USD: { flag: '🇺🇸', symbol: '$',  locale: 'en-US', steamCC: 'us' },
  BRL: { flag: '🇧🇷', symbol: 'R$', locale: 'pt-BR', steamCC: 'br' },
  EUR: { flag: '🇪🇺', symbol: '€',  locale: 'de-DE', steamCC: 'de' },
  GBP: { flag: '🇬🇧', symbol: '£',  locale: 'en-GB', steamCC: 'gb' },
};

const fx = {
  current: 'USD',
  rates:   { USD: 1 },
  loading: false,
  steamPrices: {}, // cache: "appid_cc" -> { final, final_formatted } | null
};

/**
 * Busca o preço regional real da Steam via /api/steam-price (Vercel Edge Function).
 * Essa rota chama a Steam server-side, sem bloqueio de CORS.
 * Retorna { final, final_formatted } ou null.
 */
async function fetchSteamPrice(steamAppID, currency) {
  if (!steamAppID || currency === 'USD') return null;

  const cc = CURRENCIES[currency]?.steamCC;
  if (!cc) return null;

  const cacheKey = `${steamAppID}_${cc}`;
  if (Object.prototype.hasOwnProperty.call(fx.steamPrices, cacheKey)) {
    return fx.steamPrices[cacheKey];
  }

  try {
    const res = await fetch(`/api/steam-price?appid=${steamAppID}&cc=${cc}`);
    if (!res.ok) { fx.steamPrices[cacheKey] = null; return null; }
    const data = await res.json();
    const price = data?.price ?? null;
    fx.steamPrices[cacheKey] = price;
    return price;
  } catch {
    fx.steamPrices[cacheKey] = null;
    return null;
  }
}

/**
 * Busca cotação de câmbio USD → moeda. Tenta 2 APIs, depois fallback fixo.
 * Usado apenas quando não há steamAppID ou a Steam não retorna preço.
 */
async function fetchRate(currency) {
  if (currency === 'USD') return 1;
  if (Object.prototype.hasOwnProperty.call(fx.rates, currency)) return fx.rates[currency];

  const FALLBACK = { BRL: 5.76, EUR: 0.91, GBP: 0.78 };

  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (res.ok) {
      const data = await res.json();
      if (data.result === 'success' && data.rates?.[currency]) {
        fx.rates[currency] = data.rates[currency];
        return fx.rates[currency];
      }
    }
  } catch { /* tenta próxima */ }

  try {
    const res = await fetch(`https://api.frankfurter.app/latest?from=USD&to=${currency}`);
    if (res.ok) {
      const data = await res.json();
      if (data.rates?.[currency]) {
        fx.rates[currency] = data.rates[currency];
        return fx.rates[currency];
      }
    }
  } catch { /* fallback */ }

  fx.rates[currency] = FALLBACK[currency] || 1;
  return fx.rates[currency];
}

/**
 * Atualiza o bloco de preço convertido de um card.
 * Prioridade: preço real Steam → câmbio estimado.
 */
async function updateCardPrice(card, currency) {
  const wrap = card.querySelector('[data-converted-wrap]');
  if (!wrap) return;

  if (currency === 'USD') { wrap.style.display = 'none'; return; }

  const usdSale = parseFloat(card.dataset.usdSale || '0');
  if (!usdSale) { wrap.style.display = 'none'; return; }

  const { flag, symbol, locale } = CURRENCIES[currency];
  const steamAppID = card.dataset.steamAppId;

  // Mostra loading
  card.querySelector('[data-converted-flag]').textContent  = flag;
  card.querySelector('[data-converted-val]').textContent   = '...';
  card.querySelector('[data-converted-label]').textContent = currency;
  wrap.style.display = 'flex';
  wrap.dataset.source = 'loading';

  // Tenta preço real da Steam via proxy
  if (steamAppID) {
    const steamPrice = await fetchSteamPrice(steamAppID, currency);
    if (steamPrice) {
      card.querySelector('[data-converted-flag]').textContent  = flag;
      card.querySelector('[data-converted-val]').textContent   = steamPrice.final_formatted;
      card.querySelector('[data-converted-label]').textContent = currency;
      wrap.dataset.source = 'steam';
      wrap.title = `Preço oficial da Steam (${currency})`;
      return;
    }
  }

  // Fallback: câmbio estimado
  const rate = await fetchRate(currency);
  const converted = usdSale * rate;
  card.querySelector('[data-converted-flag]').textContent  = flag;
  card.querySelector('[data-converted-val]').textContent   = `≈ ${symbol} ${converted.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  card.querySelector('[data-converted-label]').textContent = currency;
  wrap.dataset.source = 'fx';
  wrap.title = `Estimativa de câmbio (1 USD = ${rate.toFixed(2)} ${currency}). Preço regional da Steam indisponível.`;
}

/** Atualiza todos os cards visíveis. */
function updateAllCardPrices() {
  const currency = fx.current;
  document.querySelectorAll('.game-card').forEach(card => {
    const wrap = card.querySelector('[data-converted-wrap]');
    if (currency === 'USD') {
      if (wrap) wrap.style.display = 'none';
    } else {
      updateCardPrice(card, currency);
    }
  });
}

/** Atualiza o preço na página de detalhe do jogo. */
async function updateGameViewPrices() {
  if (!els.gameView || !state.currentGameDeal) return;

  const currency = fx.current;
  const deal = state.currentGameDeal;
  const sale = parseFloat(deal.salePrice || '0');
  const convEl = els.gameView.querySelector('[data-game-converted]');
  const saleEl = els.gameView.querySelector('[data-game-sale]');

  if (saleEl) saleEl.textContent = formatPrice(sale);
  if (!convEl) return;

  if (currency === 'USD' || sale === 0) { convEl.style.display = 'none'; return; }

  const { flag, symbol, locale } = CURRENCIES[currency];
  convEl.textContent = `${flag} ...`;
  convEl.style.display = '';

  if (deal.steamAppID) {
    const steamPrice = await fetchSteamPrice(deal.steamAppID, currency);
    if (steamPrice) {
      convEl.textContent = `${flag} ${steamPrice.final_formatted}`;
      convEl.title = `Preço oficial da Steam (${currency})`;
      return;
    }
  }

  const rate = await fetchRate(currency);
  const converted = sale * rate;
  convEl.textContent = `${flag} ≈ ${symbol} ${converted.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  convEl.title = `Estimativa de câmbio (1 USD = ${rate.toFixed(2)} ${currency})`;
}

/** Troca a moeda ativa e atualiza todos os preços. */
async function switchCurrency(currency) {
  if (fx.loading) return;
  fx.loading = true;

  document.querySelectorAll('.currency-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.currency === currency);
  });

  fx.current = currency;
  const rateEl = document.getElementById('currencyRate');

  if (currency === 'USD') {
    rateEl.textContent = '';
    updateAllCardPrices();
    updateGameViewPrices();
    fx.loading = false;
    return;
  }

  rateEl.textContent = 'buscando preços...';

  const rate = await fetchRate(currency);
  rateEl.textContent = `câmbio ref: 1 USD = ${rate.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${currency} · preço Steam quando disponível`;

  rateEl.classList.remove('flash');
  void rateEl.offsetWidth;
  rateEl.classList.add('flash');
  setTimeout(() => rateEl.classList.remove('flash'), 2000);

  updateAllCardPrices();
  updateGameViewPrices();
  fx.loading = false;
}


// Eventos dos botões de moeda
document.querySelectorAll('.currency-pill').forEach(btn => {
  btn.addEventListener('click', () => switchCurrency(btn.dataset.currency));
});

/* ============================================================
   ESTADO DA APLICAÇÃO
   ============================================================ */
const state = {
  query:       '',        // termo de pesquisa atual
  sort:        'deal',    // critério de ordenação ativo
  deals:       [],        // todos os deals carregados
  page:             0,         // página atual
  totalDeals:       null,      // total de ofertas (obtido do header)
  loading:          false,     // flag de carregamento
  lastQuery:        null,      // última query executada (para retry)
  hasMore:          true,      // se há mais páginas disponíveis
  currentGameDeal:  null,      // jogo exibido na página dinâmica
};

/* ============================================================
   ELEMENTOS DO DOM
   ============================================================ */
const $ = id => document.getElementById(id);

const els = {
  searchInput:    $('searchInput'),
  searchBtn:      $('searchBtn'),
  gamesGrid:      $('gamesGrid'),
  heroState:      $('heroState'),
  loadingState:   $('loadingState'),
  errorState:     $('errorState'),
  errorMsg:       $('errorMsg'),
  emptyState:     $('emptyState'),
  controlsBar:    $('controlsBar'),
  resultsCount:   $('resultsCount'),
  resultsQuery:   $('resultsQuery'),
  loadMoreWrapper:$('loadMoreWrapper'),
  loadMoreBtn:    $('loadMoreBtn'),
  retryBtn:       $('retryBtn'),
  totalDeals:     $('totalDeals'),
  cardTemplate:   $('cardTemplate'),
  navControls:    $('navControls'),
  prevBtn:        $('prevBtn'),
  homeBtn:        $('homeBtn'),
  nextBtn:        $('nextBtn'),
  pageInfo:       $('pageInfo'),
  logo:           document.querySelector('.logo'),
  gameView:       $('gameView'),
  metaDescription:$('metaDescription'),
  ogTitle:        $('ogTitle'),
  ogDescription:  $('ogDescription'),
  ogImage:        $('ogImage'),
  canonicalLink:  $('canonicalLink'),
};

/* ============================================================
   FUNÇÕES AUXILIARES
   ============================================================ */

/**
 * Formata um número como preço em dólar.
 * @param {string|number} val
 * @returns {string} — ex.: "$4.99"
 */
function formatPrice(val) {
  const num = parseFloat(val);
  if (isNaN(num)) return '—';
  if (num === 0) return 'GRÁTIS';
  return `$${num.toFixed(2)}`;
}

/**
 * Retorna a URL da imagem do jogo via Steam CDN.
 * Usa o steamAppID quando disponível.
 * @param {object} deal
 * @returns {string}
 */
function getImageUrl(deal) {
  if (deal.steamAppID) {
    return `https://cdn.cloudflare.steamstatic.com/steam/apps/${deal.steamAppID}/header.jpg`;
  }
  if (deal.thumb) return deal.thumb;
  return '';
}

/**
 * Retorna a URL de redirect da CheapShark para a oferta.
 * @param {string} dealID
 * @returns {string}
 */
function getDealUrl(dealID) {
  return `${REDIRECT_URL}${dealID}`;
}

/**
 * Classifica score do Metacritic em boa/média/ruim.
 * @param {number} score
 * @returns {string}
 */
function scoreClass(score) {
  if (score >= 75) return 'score-good';
  if (score >= 50) return 'score-ok';
  return 'score-bad';
}

/**
 * Constrói a query string da CheapShark.
 * @param {string} query   — título a buscar
 * @param {number} page    — página (0-indexed)
 * @param {string} sortBy  — critério de ordenação
 * @returns {string}
 */
function buildUrl(query, page, sortBy) {
  const sortMap = {
    deal:    { sortBy: 'DealRating',     desc: 1 },
    price:   { sortBy: 'Price',          desc: 0 },
    savings: { sortBy: 'Savings',        desc: 1 },
    rating:  { sortBy: 'Metacritic',     desc: 1 },
  };

  const sort = sortMap[sortBy] || sortMap.deal;
  const params = new URLSearchParams({
    storeID:    STEAM_STORE_ID,
    title:      query,
    pageNumber: page,
    pageSize:   PAGE_SIZE,
    sortBy:     sort.sortBy,
    desc:       sort.desc,
    onSale:     0,    // 0 = inclui todos (não só em promoção)
  });

  return `${DEALS_URL}?${params.toString()}`;
}

/**
 * Cria um slug SEO-friendly para o título do jogo.
 * Ex: "Cyberpunk 2077" → "cyberpunk-2077"
 */
function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function slugMatchesTitle(slug, title) {
  const normalized = slugify(title);
  if (normalized === slug) return true;
  if (normalized.includes(slug)) return true;
  const parts = slug.split('-').filter(Boolean);
  return parts.every(part => normalized.includes(part));
}

function updateMetaTags(deal) {
  if (!deal) return;
  const slug = slugify(deal.title);
  const url = `${window.location.origin}/game/${slug}`;

  document.title = `${deal.title} — SteamTrackDB`;
  if (els.metaDescription) els.metaDescription.content = `Página de ${deal.title} com preço atual e ofertas da Steam.`;
  if (els.ogTitle) els.ogTitle.content = `${deal.title} — SteamTrackDB`;
  if (els.ogDescription) els.ogDescription.content = `Compare preço e veja histórico de ${deal.title} na Steam.`;
  if (els.ogImage) els.ogImage.content = getImageUrl(deal);
  if (els.canonicalLink) els.canonicalLink.href = url;
}

function resetMetaTags() {
  document.title = 'SteamTrack — Rastreador de Preços Steam';
  if (els.metaDescription) els.metaDescription.content = 'Encontre os melhores preços da Steam em tempo real. Compare ofertas, histórico de preços e economize em jogos.';
  if (els.ogTitle) els.ogTitle.content = 'SteamTrack — Rastreador de Preços Steam';
  if (els.ogDescription) els.ogDescription.content = 'Encontre os melhores preços da Steam em tempo real.';
  if (els.ogImage) els.ogImage.content = '';
  if (els.canonicalLink) els.canonicalLink.href = window.location.origin;
}

/* ============================================================
   GERENCIAMENTO DE ESTADOS DA UI
   ============================================================ */

/** Oculta todos os estados e mostra apenas o solicitado. */
function showState(name) {
  ['heroState', 'loadingState', 'errorState', 'emptyState'].forEach(id => {
    els[id].style.display = id === name ? '' : 'none';
  });
}

/** Exibe a mensagem de erro com texto customizado. */
function showError(msg) {
  els.errorMsg.textContent = msg;
  showState('errorState');
  els.controlsBar.style.display = 'none';
  els.loadMoreWrapper.style.display = 'none';
}

/**
 * Retorna à tela inicial, limpa o campo de busca e carrega os destaques.
 */
function resetToHome() {
  state.query = '';
  state.page = 0;
  state.sort = 'rating';
  state.deals = [];
  state.currentGameDeal = null;
  state.hasMore = true;
  els.searchInput.value = '';
  els.gamesGrid.innerHTML = '';
  els.controlsBar.style.display = 'none';
  els.loadMoreWrapper.style.display = 'none';
  els.gameView.style.display = 'none';
  els.gamesGrid.style.display = '';
  resetMetaTags();
  showState('heroState');
  loadTopDeals();
}

function showGameView() {
  els.gameView.style.display = 'block';
  els.gamesGrid.style.display = 'none';
  els.controlsBar.style.display = 'none';
  els.loadMoreWrapper.style.display = 'none';
  ['heroState', 'loadingState', 'errorState', 'emptyState'].forEach(id => {
    els[id].style.display = 'none';
  });
  // Garantir que a página abra no topo ao mostrar a view do jogo.
  // Executar após render para evitar saltos de layout causados por imagens/carregamento.
  requestAnimationFrame(() => {
    try {
      if (els.gameView.scrollIntoView) {
        els.gameView.scrollIntoView({ block: 'start', behavior: 'auto' });
      }
      window.scrollTo(0, 0);
    } catch (e) {
      try { window.scrollTo(0, 0); } catch (err) {}
    }
  });
}

function showHomeView() {
  els.gameView.style.display = 'none';
  els.gamesGrid.style.display = '';
  els.controlsBar.style.display = '';
  resetMetaTags();
  // Voltar ao topo quando retornar à home
  requestAnimationFrame(() => {
    try {
      window.scrollTo(0, 0);
    } catch (e) {}
  });
}

async function fetchDealBySlug(slug) {
  const query = decodeURIComponent(slug.replace(/-/g, ' '));
  const response = await fetch(buildUrl(query, 0, 'rating'));
  if (!response.ok) return null;
  const deals = await response.json();
  if (!deals || deals.length === 0) return null;
  return deals.find(deal => slugMatchesTitle(slug, deal.title)) || deals[0];
}

async function fetchGameInfo(deal) {
  if (!deal || !deal.gameID) return null;
  try {
    const res = await fetch(`${API_BASE}/games?id=${deal.gameID}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function renderGameDetail(deal, gameInfo) {
  state.currentGameDeal = deal;

  const savings = parseFloat(deal.savings);
  const salePrice = parseFloat(deal.salePrice);
  const normalPrice = parseFloat(deal.normalPrice);
  const isFree = salePrice === 0;
  const hasDiscount = savings > 0;

  const description = gameInfo?.info?.about_the_game || gameInfo?.info?.short_description || '';
  const platforms = (gameInfo?.info?.platforms || []).join(', ') || 'Steam';
  const headerUrl = getImageUrl(deal);

  els.gameView.innerHTML = `
    <section class="game-page">
      <div class="game-page-head">
        <a class="nav-btn" href="/" data-route title="Voltar para a página inicial">&#8592; Voltar</a>
      </div>

      

      <div class="game-page-grid">
        <div class="game-page-cover">
          <img src="${headerUrl}" alt="${deal.title}" loading="lazy"
            onerror="this.closest('.game-page-cover').style.display='none'" />
        </div>
        <div class="game-page-info">
          <h1>${deal.title}</h1>

          <div class="game-page-tags">
            <span class="game-page-tag">Steam</span>
            ${platforms ? platforms.split(', ').map(function(p) { return '<span class="game-page-tag">' + p + '</span>'; }).join('') : ''}
            ${deal.metacriticScore > 0 ? '<span class="game-page-tag">MC ' + deal.metacriticScore + '</span>' : ''}
          </div>

          ${hasDiscount && !isFree ? '<div class="game-page-discount-badge">-' + Math.round(savings) + '% OFF</div>' : ''}
          ${isFree ? '<div class="game-page-discount-badge">GR&#193;TIS</div>' : ''}

          <div class="game-page-price">
            <span class="price-sale" data-game-sale>${formatPrice(salePrice)}</span>
            ${hasDiscount && !isFree ? '<span class="price-original">' + formatPrice(normalPrice) + '</span>' : ''}
            <span class="game-page-converted" data-game-converted style="display:none;"></span>
          </div>

          <div class="game-page-actions">
            <a class="btn-steam-large" href="${getDealUrl(deal.dealID)}" target="_blank" rel="noopener noreferrer">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.718L.22 15.06C1.429 20.188 6.222 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.606 0 11.979 0z"/></svg>
              Ver na Steam
            </a>
            <button class="btn-history" data-history-page>Ver Hist&#243;rico de Pre&#231;os</button>
          </div>

          ${description ? '<div class="game-page-description"><h2>Sobre o jogo</h2><p>' + description.replace(/<[^>]*>/g, '') + '</p></div>' : ''}
        </div>
      </div>
    </section>
  `;

  showGameView();
  updateGameViewPrices();
}

function renderGameNotFound(slug) {
  els.gameView.innerHTML = `
    <section class="game-page game-not-found">
      <div class="game-page-head">
        <a class="nav-btn" href="/" data-route title="Voltar para a página inicial">← Voltar</a>
      </div>
      <div class="game-not-found-card">
        <h1>Jogo não encontrado</h1>
        <p>Não foi possível encontrar a página para <strong>${slug}</strong>. Tente pesquisar outro título.</p>
      </div>
    </section>
  `;
  showGameView();
}

async function renderGameRoute(slug) {
  if (!slug) {
    resetToHome();
    return;
  }

  const deal = await fetchDealBySlug(slug);
  if (!deal) {
    renderGameNotFound(slug);
    return;
  }

  const gameInfo = await fetchGameInfo(deal);
  updateMetaTags(deal);
  renderGameDetail(deal, gameInfo);
}

/* ============================================================
   CRIAÇÃO DE CARDS
   ============================================================ */

/**
 * Cria e retorna um elemento de card a partir do template HTML.
 * @param {object} deal — objeto de oferta da CheapShark API
 * @returns {HTMLElement}
 */
function createCard(deal) {
  const tpl   = els.cardTemplate.content.cloneNode(true);
  const card  = tpl.querySelector('.game-card');

  const savings = parseFloat(deal.savings);
  const salePrice = parseFloat(deal.salePrice);
  const normalPrice = parseFloat(deal.normalPrice);
  const isFree = salePrice === 0;
  const hasDiscount = savings > 0;

  /* Badge de desconto */
  const badge = card.querySelector('[data-badge]');
  if (isFree) {
    badge.textContent = 'GRÁTIS';
    badge.dataset.free = '';
  } else if (hasDiscount) {
    badge.textContent = `-${Math.round(savings)}%`;
  } else {
    badge.remove();
  }

  /* Imagem */
  const img = card.querySelector('[data-img]');
  const imgUrl = getImageUrl(deal);
  if (imgUrl) {
    img.src = imgUrl;
    img.alt = deal.title || 'Capa do jogo';
    img.onerror = () => {
      // Fallback: tenta o thumb original
      if (img.src !== deal.thumb && deal.thumb) {
        img.src = deal.thumb;
      } else {
        img.closest('.card-img-wrap').style.background = '#0d1117';
        img.style.display = 'none';
      }
    };
  } else {
    img.style.display = 'none';
  }

  /* Score Metacritic */
  const score = parseInt(deal.metacriticScore, 10);
  const scoreEl = card.querySelector('[data-score]');
  if (score > 0) {
    scoreEl.style.display = '';
    scoreEl.classList.add(scoreClass(score));
    card.querySelector('[data-score-val]').textContent = score;
  }

  /* Título */
  const titleEl = card.querySelector('[data-title]');
  const slug = slugify(deal.title);
  titleEl.innerHTML = `<a class="card-link" href="/game/${slug}" data-route>${deal.title || 'Título desconhecido'}</a>`;
  card.dataset.slug = slug;

  /* Preços */
  const originalEl = card.querySelector('[data-original]');
  const saleEl     = card.querySelector('[data-sale]');

  if (hasDiscount && !isFree) {
    originalEl.textContent = formatPrice(normalPrice);
    saleEl.textContent = formatPrice(salePrice);
  } else if (isFree) {
    originalEl.textContent = normalPrice > 0 ? formatPrice(normalPrice) : '';
    saleEl.textContent = 'GRÁTIS';
    saleEl.classList.add('is-free');
  } else {
    originalEl.textContent = '';
    saleEl.textContent = formatPrice(salePrice);
  }

  /* Meta: store + economia */
  card.querySelector('[data-store]').textContent = 'Steam';
  const savingsEl = card.querySelector('[data-savings]');
  if (hasDiscount && normalPrice > 0) {
    const saved = normalPrice - salePrice;
    savingsEl.textContent = `economia de $${saved.toFixed(2)}`;
  } else {
    savingsEl.textContent = isFree ? 'sem custo' : 'preço normal';
  }

  /* Botão Steam */
  const btnSteam = card.querySelector('[data-link]');
  btnSteam.href = getDealUrl(deal.dealID);

  /* Guarda dados no dataset para conversão de moeda */
  card.dataset.usdSale = salePrice;
  if (deal.steamAppID) card.dataset.steamAppId = deal.steamAppID;

  /* Dispara busca de preço regional (async) */
  if (fx.current !== 'USD' && !isFree && salePrice > 0) {
    updateCardPrice(card, fx.current);
  }

  /* Botão copiar link */
  const btnCopy = card.querySelector('[data-copy]');
  btnCopy.addEventListener('click', () => {
    const url = getDealUrl(deal.dealID);
    navigator.clipboard.writeText(url).then(() => {
      btnCopy.classList.add('copied');
      setTimeout(() => btnCopy.classList.remove('copied'), 2000);
    }).catch(() => {
      // Fallback para navegadores sem clipboard API
      const inp = document.createElement('input');
      inp.value = url;
      document.body.appendChild(inp);
      inp.select();
      document.execCommand('copy');
      document.body.removeChild(inp);
      btnCopy.classList.add('copied');
      setTimeout(() => btnCopy.classList.remove('copied'), 2000);
    });
  });

  return card;
}

/**
 * Renderiza os deals na grid de jogos.
 * @param {Array} deals  — lista de ofertas
 * @param {boolean} append — true para adicionar, false para substituir
 */
function renderDeals(deals, append = false) {
  if (!append) els.gamesGrid.innerHTML = '';

  const fragment = document.createDocumentFragment();
  deals.forEach(deal => fragment.appendChild(createCard(deal)));
  els.gamesGrid.appendChild(fragment);
}

/**
 * Atualiza os controles de navegação (anterior/próxima página).
 */
function updateNavigationControls() {
  const currentPage = state.page;

  // Sempre mostra controles de navegação
  els.navControls.style.display = 'flex';
  els.pageInfo.textContent = `Página ${currentPage + 1}`;

  // Botão anterior
  els.prevBtn.disabled = currentPage === 0;
  els.prevBtn.style.opacity = currentPage === 0 ? '0.4' : '1';

  // Botão próxima
  els.nextBtn.disabled = !state.hasMore;
  els.nextBtn.style.opacity = state.hasMore ? '1' : '0.4';
}

/* ============================================================
   BUSCA DE DADOS
   ============================================================ */

/**
 * Busca ofertas na CheapShark API e atualiza a UI.
 * @param {object} opts
 * @param {string}  opts.query   — título a pesquisar
 * @param {boolean} opts.append  — true = carregar mais, false = nova busca
 * @param {number}  opts.page    — página
 * @param {string}  opts.sort    — critério de ordenação
 */
async function fetchDeals({ query, append = false, page = 0, sort = 'deal' } = {}) {
  if (state.loading) return;

  state.loading = true;
  state.lastQuery = { query, page, sort };

  /* Exibe loading na primeira página */
  if (!append) {
    showState('loadingState');
    els.controlsBar.style.display = 'none';
    els.loadMoreWrapper.style.display = 'none';
    els.gamesGrid.innerHTML = '';
  } else {
    els.loadMoreBtn.textContent = 'Carregando...';
    els.loadMoreBtn.disabled = true;
  }

  try {
    const url = buildUrl(query, page, sort);
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Erro HTTP ${response.status}`);
    }

    /* CheapShark retorna o total de deals no header X-Total-Count */
    const total = parseInt(response.headers.get('X-Total-Count') || '0', 10);
    state.totalDeals = total;

    const deals = await response.json();

    /* Atualiza o contador no header */
    if (total > 0) {
      els.totalDeals.textContent = total.toLocaleString('pt-BR');
    }

    if (!deals || deals.length === 0) {
      if (!append) showState('emptyState');
      else {
        els.loadMoreWrapper.style.display = 'none';
      }
      return;
    }

    /* Armazena os deals carregados */
    if (append) {
      state.deals = [...state.deals, ...deals];
    } else {
      state.deals = deals;
    }

    /* Verifica se há mais páginas */
    if (deals.length < PAGE_SIZE) {
      state.hasMore = false;
    } else {
      state.hasMore = true;
    }

    /* Renderiza os cards */
    renderDeals(deals, append);

    /* Exibe a barra de controles na primeira carga */
    if (!append) {
      showState(null); // oculta estados
      ['heroState', 'loadingState', 'errorState', 'emptyState'].forEach(id => {
        els[id].style.display = 'none';
      });
      els.controlsBar.style.display = '';
      if (state.query === '') {
        els.resultsCount.textContent = `${deals.length} destaques`;
        els.resultsQuery.textContent = 'jogos triple AAA e melhores ofertas';
      } else {
        if (total > 0) {
          els.resultsCount.textContent = `${total.toLocaleString('pt-BR')} resultados`;
        } else {
          if (deals.length === PAGE_SIZE) {
            els.resultsCount.textContent = `Mais de ${deals.length} resultados`;
          } else {
            els.resultsCount.textContent = `${deals.length} resultados`;
          }
        }
        els.resultsQuery.textContent = `para "${query}"`;
      }
    }

    /* Botão "carregar mais" */
    const loaded = page * PAGE_SIZE + deals.length;
    if (total > loaded && deals.length === PAGE_SIZE && !state.query) {
      els.loadMoreWrapper.style.display = 'flex';
      els.loadMoreBtn.innerHTML = '<span>CARREGAR MAIS</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
      els.loadMoreBtn.disabled = false;
    } else {
      els.loadMoreWrapper.style.display = 'none';
    }

    /* Atualiza controles de navegação */
    updateNavigationControls();

  } catch (err) {
    console.error('[VaultDB] Erro ao buscar dados:', err);
    if (!append) {
      showError(`Não foi possível conectar à API. Verifique sua conexão e tente novamente.\n(${err.message})`);
    } else {
      els.loadMoreBtn.textContent = 'Erro — Tentar novamente';
      els.loadMoreBtn.disabled = false;
    }
  } finally {
    state.loading = false;
  }
}

/* ============================================================
   ORDENAÇÃO LOCAL
   ============================================================ */

/**
 * Reordena os deals já carregados localmente e re-renderiza.
 * Para uma nova ordenação completa, faz nova requisição.
 * @param {string} sort
 */
function applySort(sort) {
  state.sort = sort;
  state.page = 0; // Reset page when sorting changes

  /* Refaz a busca com a nova ordenação */
  fetchDeals({ query: state.query, append: false, page: 0, sort });
}

/* ============================================================
   INICIALIZAÇÃO DE EVENTOS
   ============================================================ */

/** Dispara a pesquisa com o valor atual do input. */
function triggerSearch() {
  const query = els.searchInput.value.trim();
  if (!query) return;

  state.query = query;
  state.page  = 0;
  state.deals = [];

  fetchDeals({ query, append: false, page: 0, sort: state.sort });
}

/* -- Input de pesquisa: Enter + debounce -- */
let debounceTimer = null;

els.searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    clearTimeout(debounceTimer);
    triggerSearch();
  }
});

/* Debounce de 500ms para digitação contínua */
els.searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const query = els.searchInput.value.trim();
    if (query.length >= 3) triggerSearch();
  }, 500);
});

/* -- Botão de pesquisa -- */
els.searchBtn.addEventListener('click', triggerSearch);

/* -- Tags de pesquisa rápida -- */
document.querySelectorAll('.quick-tag').forEach(btn => {
  btn.addEventListener('click', () => {
    const query = btn.dataset.query;
    els.searchInput.value = query;
    state.query = query;
    state.page  = 0;
    state.deals = [];
    fetchDeals({ query, append: false, page: 0, sort: state.sort });
  });
});

/* -- Botões de ordenação -- */
document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('active')) return;

    document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    applySort(btn.dataset.sort);
  });
});

/* -- Botão "Carregar mais" -- */
els.loadMoreBtn.addEventListener('click', () => {
  state.page++;
  fetchDeals({
    query:  state.query,
    append: true,
    page:   state.page,
    sort:   state.sort,
  });
});

if (els.homeBtn) {
  els.homeBtn.addEventListener('click', resetToHome);
}

if (els.logo) {
  els.logo.addEventListener('click', resetToHome);
}

/* -- Botões de navegação -- */
els.prevBtn.addEventListener('click', () => {
  if (state.page > 0) {
    state.page--;
    fetchDeals({
      query:  state.query,
      append: false,
      page:   state.page,
      sort:   state.sort,
    });
  }
});

els.nextBtn.addEventListener('click', () => {
  state.page++;
  fetchDeals({
    query:  state.query,
    append: false,
    page:   state.page,
    sort:   state.sort,
  });
});

/* -- Botão de retry no estado de erro -- */
els.retryBtn.addEventListener('click', () => {
  if (state.lastQuery) {
    fetchDeals({ ...state.lastQuery, append: false });
  }
});

/* ============================================================
   CARGA INICIAL — Busca as melhores ofertas da Steam
   ============================================================ */

/**
 * Ao abrir o site sem query, busca as melhores ofertas atuais
 * da Steam para popular a grade com conteúdo útil.
 * Prioriza jogos triple AAA (alta avaliação Metacritic).
 */
async function loadTopDeals() {
  try {
    // Primeiro tenta carregar jogos com alta avaliação Metacritic (triple AAA)
    const url = `${DEALS_URL}?storeID=${STEAM_STORE_ID}&pageSize=12&sortBy=Metacritic&desc=1&onSale=0`;
    const response = await fetch(url);

    if (!response.ok) return; // Falha silenciosa na carga inicial

    const total = parseInt(response.headers.get('X-Total-Count') || '0', 10);
    if (total > 0) {
      els.totalDeals.textContent = total.toLocaleString('pt-BR');
    }

    const deals = await response.json();

    if (deals && deals.length > 0) {
      // Renderiza os deals na tela inicial
      renderDeals(deals, false);

      // Oculta o estado hero e mostra a grade
      showState(null);
      ['heroState', 'loadingState', 'errorState', 'emptyState'].forEach(id => {
        els[id].style.display = 'none';
      });

      // Mostra controles com mensagem de destaques
      els.controlsBar.style.display = '';
      els.resultsCount.textContent = `${deals.length} destaques`;
      els.resultsQuery.textContent = 'jogos triple AAA e melhores ofertas';

      // Configura estado para permitir ordenação e navegação
      state.deals = deals;
      state.query = ''; // Mantém vazio para indicar que é carga inicial
      state.page = 0;
      state.sort = 'rating'; // Define como ordenado por rating inicialmente
      state.hasMore = true;

      // Mostra controles de navegação se houver mais páginas
      updateNavigationControls();
    }
  } catch {
    // Ignora erros de rede na carga inicial do contador
  }
}

/* ============================================================
   BOTÃO ATUALIZAR PREÇOS (REFRESH)
   ============================================================ */

/** Referência ao botão de refresh (só existe depois que uma busca é feita) */
const refreshBtn = $('refreshBtn');

refreshBtn.addEventListener('click', () => {
  if (state.loading) return;

  // Animação de spin enquanto atualiza
  refreshBtn.classList.add('spinning');
  refreshBtn.disabled = true;

  if (state.query) {
    fetchDeals({ query: state.query, page: 0, sort: state.sort })
      .finally(() => {
        refreshBtn.classList.remove('spinning');
        refreshBtn.disabled = false;
      });
  } else {
    // Para carga inicial, recarrega os destaques
    loadTopDeals().finally(() => {
      refreshBtn.classList.remove('spinning');
      refreshBtn.disabled = false;
    });
  }
});

/* ============================================================
   AUTO-REFRESH A CADA 5 MINUTOS
   Atualiza automaticamente sem o usuário precisar fazer nada.
   ============================================================ */
setInterval(() => {
  // Só atualiza se houver uma busca ativa e não estiver carregando
  if (state.query && !state.loading) {
    console.log('[VaultDB] Auto-refresh: atualizando preços...');
    fetchDeals({ query: state.query, page: 0, sort: state.sort });
  }
}, 5 * 60 * 1000); // 5 minutos em milissegundos

/* ============================================================
   MODAL DE HISTÓRICO DE PREÇOS
   Usa o endpoint /games?id={gameID} da CheapShark para buscar
   todas as ofertas já registradas para aquele jogo.
   ============================================================ */

/** Nomes das lojas mapeados pelo ID da CheapShark */
const STORE_NAMES = {
  '1':  'Steam', '2': 'GamersGate', '3': 'GreenManGaming',
  '6':  'Fanatical', '7': 'WinGameStore', '8': 'GameBillet',
  '11': 'Humble Store', '13': 'Gog', '15': 'Nuuvem',
  '21': 'WinGameStore', '23': 'GamesPlanet', '25': 'Gamesload',
  '27': 'IndieGala', '28': 'Blizzard', '29': 'AllYouPlay',
  '31': 'DLGamer', '33': 'Fanatical', '35': 'Games Republic',
};

const modalEls = {
  overlay:   $('modalOverlay'),
  title:     $('modalTitle'),
  img:       $('modalImg'),
  lowest:    $('modalLowest'),
  current:   $('modalCurrent'),
  loading:   $('modalLoading'),
  body:      $('modalBody'),
  error:     $('modalError'),
  tbody:     $('historyTableBody'),
  closeBtn:  $('modalClose'),
};

/** Abre o modal e busca o histórico de preços de um jogo. */
async function openHistoryModal(deal) {
  // Exibe o modal em modo loading
  modalEls.overlay.style.display = 'flex';
  modalEls.title.textContent = deal.title || 'Histórico de Preços';
  modalEls.img.src = getImageUrl(deal);
  modalEls.img.alt = deal.title || '';
  modalEls.lowest.textContent = '—';
  modalEls.current.textContent = formatPrice(deal.salePrice);
  modalEls.loading.style.display = 'flex';
  modalEls.body.style.display = 'none';
  modalEls.error.style.display = 'none';

  // Bloqueia scroll do body
  document.body.style.overflow = 'hidden';

  try {
    // Busca dados completos do jogo pelo gameID
    const res = await fetch(`${API_BASE}/games?id=${deal.gameID}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    // Preenche menor preço já visto
    if (data.info && data.info.lowestPrice !== undefined) {
      const lowest = parseFloat(data.info.lowestPrice);
      modalEls.lowest.textContent = lowest === 0 ? 'GRÁTIS' : `$${lowest.toFixed(2)}`;
    }

    // Renderiza a tabela com todas as ofertas históricas
    if (data.deals && data.deals.length > 0) {
      modalEls.tbody.innerHTML = '';

      data.deals.forEach(d => {
        const saleP   = parseFloat(d.price);
        const retailP = parseFloat(d.retailPrice);
        const savP    = parseFloat(d.savings);
        const storeName = STORE_NAMES[d.storeID] || `Loja ${d.storeID}`;

        // Classe da coluna de desconto
        let savingsClass = 'td-savings-low';
        if (savP >= 50) savingsClass = 'td-savings-good';
        else if (savP >= 20) savingsClass = 'td-savings-ok';

        // Classe do preço
        const priceClass = saleP === 0 ? 'td-price-free' : 'td-price-sale';
        const priceText  = saleP === 0 ? 'GRÁTIS' : `$${saleP.toFixed(2)}`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${storeName}</td>
          <td class="${priceClass}">${priceText}</td>
          <td style="color:var(--text-muted);text-decoration:line-through;">
            ${retailP > 0 ? '$' + retailP.toFixed(2) : '—'}
          </td>
          <td class="${savingsClass}">
            ${savP > 0 ? '-' + Math.round(savP) + '%' : '—'}
          </td>
          <td style="color:var(--text-secondary);">
            ${d.metacriticScore > 0 ? d.metacriticScore : '—'}
          </td>
          <td>
            <a class="btn-deal" href="${REDIRECT_URL}${d.dealID}" target="_blank" rel="noopener">
              Ver oferta ↗
            </a>
          </td>
        `;
        modalEls.tbody.appendChild(tr);
      });

      modalEls.loading.style.display = 'none';
      modalEls.body.style.display = 'block';
    } else {
      throw new Error('Sem histórico disponível');
    }

  } catch (err) {
    console.error('[VaultDB] Erro ao carregar histórico:', err);
    modalEls.loading.style.display = 'none';
    modalEls.error.style.display = 'block';
  }
}

/** Fecha o modal de histórico. */
function closeModal() {
  modalEls.overlay.style.display = 'none';
  document.body.style.overflow = '';
}

// Fechar pelo botão ✕
modalEls.closeBtn.addEventListener('click', closeModal);

// Fechar clicando no overlay (fora do modal)
modalEls.overlay.addEventListener('click', e => {
  if (e.target === modalEls.overlay) closeModal();
});

// Fechar com tecla Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && modalEls.overlay.style.display !== 'none') {
    closeModal();
  }
});

/* ============================================================
   DELEGAÇÃO DE EVENTO PARA O BOTÃO HISTÓRICO DOS CARDS
   Como os cards são criados dinamicamente, usamos event
   delegation no container pai em vez de listeners individuais.
   ============================================================ */
els.gamesGrid.addEventListener('click', e => {
  const histBtn = e.target.closest('[data-history]');
  if (!histBtn) return;

  const card = histBtn.closest('.game-card');
  const cards = [...els.gamesGrid.querySelectorAll('.game-card')];
  const index = cards.indexOf(card);

  if (index !== -1 && state.deals[index]) {
    openHistoryModal(state.deals[index]);
  }
});

els.gameView.addEventListener('click', e => {
  const histBtn = e.target.closest('[data-history-page]');
  if (!histBtn || !state.currentGameDeal) return;
  openHistoryModal(state.currentGameDeal);
});

/* Inicia contador de ofertas */
loadTopDeals();