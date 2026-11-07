import { $, node, parisDate } from './client.js';
import { decorateIcons, icon, notify } from './ui.js';

export function setupShell(navigate) {
  decorateIcons();
  const themeButton = $('theme-toggle');
  let theme;
  try { theme = localStorage.getItem('campus-theme'); } catch { /* Browser privacy settings may disable storage. */ }
  if (!['light', 'dark'].includes(theme)) theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    themeButton.setAttribute('aria-pressed', String(theme === 'dark'));
    themeButton.setAttribute('aria-label', theme === 'dark' ? 'Use light theme' : 'Use dark theme');
    $('theme-label').textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
    $('theme-icon').replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon'));
  }
  applyTheme();
  themeButton.onclick = () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('campus-theme', theme); } catch { /* Theme still works without persistence. */ }
    applyTheme();
  };
  $('workspace-date').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'long' }).format(new Date());
  const scrollBehavior = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  for (const button of document.querySelectorAll('[data-scroll-target]')) button.onclick = () => {
    $(button.dataset.scrollTarget)?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  };
  document.querySelector('a[href="#planning-customize"]').onclick = event => {
    event.preventDefault();
    $('planning-customize').open = true;
    $('planning-customize').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  };
  async function copy(text, message) {
    try { await navigator.clipboard.writeText(text); notify(message); }
    catch { notify(`Copy manually: ${text}`); }
  }
  $('copy-pi').onclick = () => void copy('npx --no-install pi --no-extensions', 'Pi launch command copied. Run it in this project, then /login openai and choose Sign in with ChatGPT.');

  const actions = [
    { label: 'Dashboard', hint: 'Overview & attention', icon: 'grid', run: () => navigate('dashboard', true) },
    { label: 'Calendar', hint: 'Day & week views', icon: 'calendar', run: () => navigate('calendar', true) },
    { label: 'Assignments', hint: 'Your persistent work', icon: 'check', run: () => navigate('assignments', true) },
    { label: 'Exams', hint: 'Dates & preparation', icon: 'cap', run: () => navigate('exams', true) },
    { label: 'AI Assistant', hint: 'Academic chat with Pi', icon: 'sparkles', run: () => navigate('assistant', true) },
    { label: 'New assignment', hint: 'Manual entry', icon: 'plus', run: () => { navigate('assignments'); document.querySelector('[data-new-record="assignments"]').click(); } },
    { label: 'New exam', hint: 'Manual entry', icon: 'plus', run: () => { navigate('exams'); document.querySelector('[data-new-record="exams"]').click(); } },
    { label: 'Study planner', hint: 'Read-only recommendations', icon: 'clock', run: () => { navigate('dashboard'); $('study-planning').scrollIntoView({ block: 'start' }); } },
    { label: 'Today’s calendar', hint: 'Europe/Paris', icon: 'sun', run: () => { $('date').value = parisDate(); $('view').value = 'day'; navigate('calendar', true); } },
  ];
  const dialog = $('command-dialog');
  function renderCommands() {
    const query = $('command-search').value.toLowerCase().trim();
    const matched = actions.filter(action => `${action.label} ${action.hint}`.toLowerCase().includes(query));
    $('command-results').replaceChildren();
    for (const action of matched) {
      const button = node('button');
      button.type = 'button';
      button.append(icon(action.icon), node('span', action.label), node('small', action.hint));
      button.onclick = () => {
        dialog.addEventListener('close', () => action.run(), { once: true });
        dialog.close();
      };
      $('command-results').append(button);
    }
    if (!matched.length) $('command-results').append(node('p', 'No matching pages or actions.'));
  }
  function openCommands() {
    if (dialog.open) { dialog.close(); return; }
    $('command-search').value = '';
    renderCommands();
    dialog.showModal();
    $('command-search').focus();
  }
  $('command-open').onclick = openCommands;
  $('command-close').onclick = () => dialog.close();
  $('command-search').oninput = renderCommands;
  dialog.addEventListener('keydown', event => {
    const buttons = [...$('command-results').querySelectorAll('button')];
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && buttons.length) {
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current <= 0 ? buttons.length - 1 : current - 1);
      buttons[next].focus();
    }
    if (event.key === 'Enter' && buttons.length) {
      const target = buttons.includes(document.activeElement) ? document.activeElement : document.activeElement === $('command-search') ? buttons[0] : null;
      if (target) { event.preventDefault(); target.click(); }
    }
  });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]:not(#command-dialog)')) { event.preventDefault(); openCommands(); }
    const digit = /^Digit([1-5])$/.exec(event.code)?.[1] ?? (/^[1-5]$/.test(event.key) ? event.key : null);
    if (event.altKey && !event.metaKey && !event.ctrlKey && digit && !document.querySelector('dialog[open]')) {
      event.preventDefault(); navigate(['dashboard', 'calendar', 'assignments', 'exams', 'assistant'][Number(digit) - 1], true);
    }
  });
}
