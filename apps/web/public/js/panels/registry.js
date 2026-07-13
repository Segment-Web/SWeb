
//





export function createRegistry() {
  const panels = [];

  return {
    register(panel) {
      if (!panel?.id || typeof panel.mount !== 'function') {
        throw new Error('panel должна иметь id и mount(body)');
      }
      if (panels.some((p) => p.id === panel.id)) {
        throw new Error(`панель "${panel.id}" уже зарегистрирована`);
      }
      panels.push(panel);
      return panel;
    },
    get(id) {
      return panels.find((p) => p.id === id);
    },
    list() {
      return panels.slice();
    },
  };
}
