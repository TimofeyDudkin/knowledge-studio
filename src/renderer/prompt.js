/**
 * prompt.js — система промптов и шаблонов.
 * Отвечает за: рендер чипов шаблонов в модале,
 * сохранение кастомных шаблонов, подстановку промпта при создании подвопроса.
 */

window.PromptModule = (() => {

  function renderTemplateChips() {
    const $container = document.getElementById('prompt-templates');
    if (!$container) return;

    const templates = AppState.get('promptTemplates');
    $container.innerHTML = templates.map(t => `
      <button class="template-chip" data-template-id="${t.id}">${t.label}</button>
    `).join('');

    $container.querySelectorAll('.template-chip').forEach(btn => {
      btn.addEventListener('click', () => applyTemplate(btn.dataset.templateId));
    });
  }

  function applyTemplate(id) {
    const tpl = AppState.get('promptTemplates').find(t => t.id === id);
    if (!tpl) return;
    const $textarea = document.getElementById('input-topic-prompt');
    if ($textarea) $textarea.value = tpl.text;
  }

  /**
   * Получить промпт текущей темы (для подстановки в вопросы).
   */
  function getCurrentPrompt() {
    const topic = AppState.getCurrentTopic();
    return topic?.prompt || '';
  }

  /**
   * Сохранить промпт как новый шаблон.
   */
  function saveAsTemplate(name, text) {
    const tpl = { id: 'custom_' + Date.now(), label: name, text };
    AppState.update('promptTemplates', list => [...list, tpl]);
    renderTemplateChips();
    return tpl;
  }

  // Рендерим чипы при открытии модала
  document.getElementById('btn-new-topic')?.addEventListener('click', () => {
    renderTemplateChips();
  });
  document.getElementById('empty-new-topic')?.addEventListener('click', () => {
    renderTemplateChips();
  });

  return { renderTemplateChips, applyTemplate, getCurrentPrompt, saveAsTemplate };
})();
