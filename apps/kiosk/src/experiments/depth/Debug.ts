// @ts-nocheck — no-op stub for the source's tweakpane Debug (dropped from the experiment).
// Keeps every `this.debug.addBinding(...)` call in the vendored modules harmless.
class Debug {
  init() {}
  setVisible() {}
  getFolder() {
    return { addBinding: () => ({ on() {}, dispose() {} }) };
  }
  addBinding() {
    return { on() {}, dispose() {} };
  }
  dispose() {}
}

export { Debug };
