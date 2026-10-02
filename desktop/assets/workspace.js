/* Navigation belongs to the application shell, never to a hidden tab's modal. */
(() => {
  let parent = 'ask';
  let returnFocus = null;
  let returnScroll = 0;
  const labels = { ask: 'Ask', computer: 'This computer', changes: 'History', settings: 'Settings' };
  function display(view) {
    document.querySelectorAll('[data-view]').forEach(element => {
      element.classList.toggle('active', element.dataset.view === view);
    });
    document.getElementById('topbar-view-label').textContent = labels[parent] || 'ASIP';
  }
  window.ASIPWorkspace = {
    select(tab) {
      parent = Object.hasOwn(labels, tab) ? tab : 'ask';
      window.dispatchEvent(new Event('asip:navigation'));
      display(parent);
      document.querySelectorAll('[data-tab]').forEach(button => {
        const active = button.dataset.tab === parent;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      document.querySelector('main').scrollTo({ top: 0 });
    },
    detail() {
      if (!document.getElementById('change-detail').classList.contains('active')) {
        returnFocus = document.activeElement;
        returnScroll = document.querySelector('main').scrollTop;
      }
      display('detail');
      document.getElementById('detail-back').textContent = `← ${labels[parent]}`;
      document.querySelector('main').scrollTo({ top: 0 });
      document.getElementById('change-detail-body').focus();
    },
    back() {
      window.dispatchEvent(new Event('asip:navigation'));
      display(parent);
      document.querySelector('main').scrollTo({ top: returnScroll });
      if (returnFocus?.isConnected) returnFocus.focus();
    },
    error(message) {
      const banner = document.getElementById('application-error');
      banner.textContent = message || 'This action could not be completed. Please try again.';
      document.getElementById('error-banner').hidden = false;
    },
  };
  document.getElementById('detail-back').addEventListener('click', () => window.ASIPWorkspace.back());
})();
