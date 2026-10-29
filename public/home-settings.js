// Do not import editor transport before the MCP sidebar bridge is installed.
const preferences = {
  getItem(key) { try { return localStorage.getItem(key); } catch { return null; } },
  setItem(key, value) { try { localStorage.setItem(key, value); } catch {} }
};
export function installHomeSettings({ rail, call, signal, onLanguage }) {
  let language = preferences.getItem('codexCanvasLanguage') || (navigator.language?.startsWith('zh') ? 'zh' : 'en');
  let info = null, busy = false, failed = false;
  const zh = () => language === 'zh';
  const wrap = document.createElement('div'); wrap.className = 'center-home-settings';
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'center-button center-nav';
  toggle.innerHTML = "<svg fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" viewBox=\"0 0 24 24\" aria-hidden=\"true\">\n              <path d=\"M12 15.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5z\"></path>\n              <path d=\"M19.4 13.5a7.9 7.9 0 0 0 .05-1.5 7.9 7.9 0 0 0-.05-1.5l2.02-1.54-1.9-3.28-2.37.98a8.45 8.45 0 0 0-2.58-1.5L14.25 2h-4.5l-.32 3.16a8.45 8.45 0 0 0-2.58 1.5l-2.37-.98-1.9 3.28L4.6 10.5a7.9 7.9 0 0 0-.05 1.5 7.9 7.9 0 0 0 .05 1.5l-2.02 1.54 1.9 3.28 2.37-.98a8.45 8.45 0 0 0 2.58 1.5l.32 3.16h4.5l.32-3.16a8.45 8.45 0 0 0 2.58-1.5l2.37.98 1.9-3.28-2.02-1.54z\"></path>\n            </svg><span></span>";
  const panel = document.createElement('div'); panel.className = 'center-settings-panel'; panel.hidden = true;
  const select = document.createElement('select'); select.innerHTML = '<option value="zh">简体中文</option><option value="en">English</option>'; select.value = language;
  const version = document.createElement('button'); version.type = 'button'; version.className = 'center-button';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const release = document.createElement('a'); release.target = '_blank'; release.rel = 'noopener noreferrer';
  const install = document.createElement('button'); install.type = 'button'; install.className = 'center-button center-primary';
  panel.append(select, version, status, install, release); wrap.append(toggle, panel); rail.append(wrap);
  function render() {
    toggle.querySelector('span').textContent = zh() ? '设置' : 'Settings'; toggle.setAttribute('aria-expanded', String(!panel.hidden));
    toggle.classList.toggle('update-available', Boolean(info?.updateAvailable));
    select.setAttribute('aria-label', zh() ? '语言' : 'Language');
    const v = info?.installedVersion || info?.pluginVersion || info?.version || '…';
    version.textContent = `${zh() ? '版本' : 'Version'} ${v} · ${zh() ? '检查更新' : 'Check updates'}`; version.disabled = busy;
    status.textContent = busy ? (zh() ? '正在处理…' : 'Working…') : failed || info?.dailyCheck?.error ? (zh() ? '检查失败，请重试。' : 'Check failed. Please retry.') : info?.updateAvailable ? `${zh() ? '有新版本可用' : 'Update available'}${info.canUpdate ? '' : ' · ' + ((zh() ? '请前往发布页查看安装方式' : 'See the release page for installation'))}` : info?.latestVersion ? (zh() ? '已是最新版本' : 'Up to date') : info ? (zh() ? '暂时无法确认最新版本，请重试' : 'Latest version could not be verified. Retry.') : '';
    let releaseUrl; try { const url = new URL(info?.releaseUrl); if (url.protocol === 'https:') releaseUrl = url.href; } catch {}
    release.hidden = !info?.updateAvailable || !releaseUrl; release.href = releaseUrl || '#'; release.textContent = zh() ? '查看发布页' : 'View release';
    install.textContent = zh() ? '安装更新' : 'Install update'; install.hidden = !info?.canUpdate || !info?.updateAvailable; install.disabled = busy;
  }
  async function request(action) {
    if (busy) return; busy = true; failed = false; render();
    try { const result = await call({ action }); if (signal.aborted) return; info = result.structuredContent || result; if (action === 'app-update-run') status.textContent = zh() ? '更新完成，请重新打开 Codex。' : 'Updated. Reopen Codex.'; }
    catch { failed = true; }
    finally { busy = false; if (!signal.aborted) { render(); if (action === 'app-update-run' && !failed) status.textContent = zh() ? '更新完成，请重新打开 Codex。' : 'Updated. Reopen Codex.'; } }
  }
  toggle.onclick = () => { panel.hidden = !panel.hidden; render(); };
  version.onclick = () => request('app-update-check'); install.onclick = () => request('app-update-run');
  select.onchange = () => { language = select.value; preferences.setItem('codexCanvasLanguage', language); document.documentElement.lang = zh() ? 'zh-CN' : 'en'; window.dispatchEvent(new CustomEvent('huayu-language-change', { detail: language })); onLanguage(language); render(); };
  document.addEventListener('pointerdown', e => { if (!wrap.contains(e.target)) { panel.hidden = true; render(); } }, { signal });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { panel.hidden = true; render(); } }, { signal });
  render(); onLanguage(language); request('app-update-status');
}
