(function () {
  const actions = document.querySelectorAll('.actions button');
  const urlInput = document.getElementById('action-url');
  const copyBtn = document.getElementById('copy-url');
  const defaultUrl = document.querySelector('.actions').dataset.defaultUrl;

  function buildUrl(button) {
    const action = button.dataset.action;
    const format = button.dataset.format;
    const query = button.dataset.query;
    const url = button.dataset.url || defaultUrl;

    const params = new URLSearchParams();
    params.set('action', action);
    if (format) params.set('format', format);
    if (query) params.set('query', query);
    if (url) params.set('url', url);

    return `localhost:3000/?${params.toString()}`;
  }

  actions.forEach((button) => {
    button.addEventListener('click', () => {
      const url = buildUrl(button);
      urlInput.value = url;
      urlInput.focus();
      urlInput.select();
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'MHNOS_NAVIGATE', url }, '*');
        }
      } catch (err) {
        // Fallback to manual copy in environments without bridge.
      }
    });
  });

  copyBtn.addEventListener('click', async () => {
    urlInput.focus();
    urlInput.select();
    try {
      await navigator.clipboard.writeText(urlInput.value);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 1200);
    } catch (err) {
      copyBtn.textContent = 'Select + Copy';
    }
  });
})();
