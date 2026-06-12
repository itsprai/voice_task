// localStorage wrapper — same pattern as v1 but keyed to CONFIG.STORAGE_KEY

const Storage = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY) || '[]');
    } catch {
      return [];
    }
  },

  save(tasks) {
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(tasks));
    Sync.push(tasks);
  },

  add(task) {
    const tasks = this.load();
    tasks.unshift(task);
    this.save(tasks);
    return tasks;
  },

  update(id, updates) {
    const tasks = this.load();
    const idx = tasks.findIndex(t => t.id === id);
    if (idx !== -1) {
      tasks[idx] = { ...tasks[idx], ...updates, updatedAt: new Date().toISOString() };
      this.save(tasks);
    }
    return tasks;
  },

  remove(id) {
    const tasks = this.load().filter(t => t.id !== id);
    this.save(tasks);
    return tasks;
  },

  // Removes from localStorage only — does NOT push to Supabase (for undo flows)
  removeLocal(id) {
    const tasks = this.load().filter(t => t.id !== id);
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(tasks));
    return tasks;
  }
};
