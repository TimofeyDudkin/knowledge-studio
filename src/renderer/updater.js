/**
 * updater.js — уведомление о доступном/скачанном автообновлении.
 *
 * Статусы приходят из main.js (autoUpdater) через IPC.onUpdaterStatus:
 *   available    → обновление найдено, началась скачка (autoDownload = true)
 *   downloading  → прогресс скачки (info.percent)
 *   downloaded   → обновление готово, можно перезапустить и установить
 *   error        → ошибка проверки/скачки
 */

window.UpdaterModule = (() => {
  let $toast = null;

  function buildToast() {
    if ($toast) return $toast;
    $toast = document.createElement('div');
    $toast.id = 'toast-update';
    $toast.className = 'toast hidden';
    document.body.appendChild($toast);
    return $toast;
  }

  function render(html) {
    buildToast();
    $toast.innerHTML = html;
    $toast.classList.remove('hidden');
    $toast.classList.add('visible');
  }

  function hide() {
    if (!$toast) return;
    $toast.classList.remove('visible');
    setTimeout(() => $toast.classList.add('hidden'), 200);
  }

  function onStatus(status) {
    switch (status.state) {
      case 'downloading':
        render(`
          <div class="toast-row">
            <div class="toast-icon-wrap">⬇️</div>
            <div class="toast-body">
              <p class="toast-title">Загрузка обновления…</p>
              <p class="toast-sub">${Math.round(status.percent || 0)}%</p>
            </div>
          </div>`);
        break;

      case 'downloaded':
        render(`
          <div class="toast-row">
            <div class="toast-icon-wrap">✨</div>
            <div class="toast-body">
              <p class="toast-title">Доступна версия ${status.version}</p>
              <p class="toast-sub">Обновление скачано и готово к установке</p>
            </div>
            <button class="toast-btn-no" id="toast-update-later" title="Позже">✕</button>
          </div>
          <div class="toast-footer-row">
            <button class="toast-btn-yes" id="toast-update-restart">Перезапустить и установить</button>
          </div>`);
        document.getElementById('toast-update-later')?.addEventListener('click', hide);
        document.getElementById('toast-update-restart')?.addEventListener('click', () => IPC.quitAndInstall());
        break;

      case 'error':
        console.warn('[updater] error:', status.message);
        hide();
        break;

      default:
        hide();
    }
  }

  IPC.onUpdaterStatus(onStatus);

  return { onStatus };
})();
