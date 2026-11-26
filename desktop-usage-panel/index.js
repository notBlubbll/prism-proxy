// prism-usage — OpenCode V2 server part.
// The real work is the desktop GUI part (gui-experimental.cjs). This tiny
// server part exists so the desktop app discovers the plugin and can read its
// GUI bundle; it intentionally has no server-side behavior.
export default {
  id: "prism-usage",
  async setup() {},
};
