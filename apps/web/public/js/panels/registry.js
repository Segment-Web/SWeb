// Реестр панелей — зачаток системы модификаций.
//
// Панель — это самостоятельная единица интерфейса: { id, title, mount(body) }.
// Встроенные панели (список чатов, окно чата) регистрируются здесь так же, как
// потом будут регистрироваться пользовательские модификации из библиотеки модов.
// mount(body) наполняет переданный контейнер и возвращает функцию очистки.

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
