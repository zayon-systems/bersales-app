// Bersales — todos.js
//
// To-do list with per-task checklists. Deliberately a different shape from
// bills/debts/health: a task isn't an expiry or a reminder, it's a thing to
// do, so it has no status pill — just done / not done. The checklist is a
// genuine sub-item list (its own done flags), but a task's own "done" is a
// separate, manually-set flag rather than being auto-derived from checklist
// completion — some tasks are done without every checklist box ticked, and
// forcing that link is more surprising than helpful.

const Todos = (() => {
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  async function addTodo(item) {
    const id = uuid();
    const now = Date.now();
    const record = {
      id,
      title: item.title || '',
      dueDate: item.dueDate || '',
      notes: item.notes || '',
      done: false,
      checklist: [],
      createdAt: now,
      updatedAt: now
    };
    const payload = await Crypto.encryptJSON(record);
    await DB.putRaw('todos', id, payload);
    return record;
  }

  async function updateTodo(id, updates) {
    const existing = await getTodo(id);
    if (!existing) throw new Error('To-do not found');
    const merged = { ...existing, ...updates, id, updatedAt: Date.now() };
    const payload = await Crypto.encryptJSON(merged);
    await DB.putRaw('todos', id, payload);
    return merged;
  }

  async function toggleDone(id) {
    const existing = await getTodo(id);
    if (!existing) throw new Error('To-do not found');
    return updateTodo(id, { done: !existing.done });
  }

  async function getTodo(id) {
    const raw = await DB.getRaw('todos', id);
    if (!raw) return null;
    return Crypto.decryptJSON(raw.payload);
  }

  async function getAllTodos() {
    const rawAll = await DB.getAllRaw('todos');
    const items = [];
    for (const raw of rawAll) {
      try {
        items.push(await Crypto.decryptJSON(raw.payload));
      } catch (e) {
        console.error('Failed to decrypt to-do record', raw.id, e);
      }
    }
    // Open tasks first (oldest first within each group), done tasks last.
    items.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return b.updatedAt - a.updatedAt;
    });
    return items;
  }

  async function deleteTodo(id) {
    return DB.deleteRaw('todos', id);
  }

  // --- Checklist sub-items -----------------------------------------------

  async function addChecklistItem(todoId, text) {
    const todo = await getTodo(todoId);
    if (!todo) throw new Error('To-do not found');
    const checklist = [...(todo.checklist || []), { id: uuid(), text, done: false }];
    return updateTodo(todoId, { checklist });
  }

  async function toggleChecklistItem(todoId, itemId) {
    const todo = await getTodo(todoId);
    if (!todo) throw new Error('To-do not found');
    const checklist = (todo.checklist || []).map((it) => it.id === itemId ? { ...it, done: !it.done } : it);
    return updateTodo(todoId, { checklist });
  }

  async function removeChecklistItem(todoId, itemId) {
    const todo = await getTodo(todoId);
    if (!todo) throw new Error('To-do not found');
    const checklist = (todo.checklist || []).filter((it) => it.id !== itemId);
    return updateTodo(todoId, { checklist });
  }

  function checklistProgress(todo) {
    const list = todo.checklist || [];
    const done = list.filter((it) => it.done).length;
    return { done, total: list.length };
  }

  return {
    addTodo, updateTodo, toggleDone, getTodo, getAllTodos, deleteTodo,
    addChecklistItem, toggleChecklistItem, removeChecklistItem, checklistProgress
  };
})();
