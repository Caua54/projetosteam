'use strict';

function navigateTo(url) {
  if (window.location.pathname === url) return;
  history.pushState(null, '', url);
  handleRoute();
}

async function handleRoute() {
  const path = window.location.pathname.replace(/\/$/, '');

  if (path === '' || path === '/' || path.endsWith('/index.html')) {
    resetToHome();
    return;
  }

  const match = path.match(/^\/game\/([^\/]+)$/);
  if (match) {
    await renderGameRoute(match[1]);
    return;
  }

  resetMetaTags();
  els.gameView.innerHTML = `
    <section class="game-page game-not-found">
      <div class="game-page-head">
        <a class="nav-btn" href="/" data-route title="Voltar para a página inicial">← Voltar</a>
      </div>
      <div class="game-not-found-card">
        <h1>Página não encontrada</h1>
        <p>Esta rota não existe. Volte para a página inicial para buscar outros jogos.</p>
      </div>
    </section>
  `;
  showGameView();
}

window.addEventListener('popstate', handleRoute);

document.addEventListener('click', event => {
  const link = event.target.closest('a[data-route]');
  if (!link) return;

  const href = link.getAttribute('href');
  if (!href.startsWith('/')) return;

  event.preventDefault();
  navigateTo(href);
});

window.addEventListener('DOMContentLoaded', handleRoute);
