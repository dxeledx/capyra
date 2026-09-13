export default {
  apiVersion: 1, id: 'alternate-ui', version: '1.0.0', title: 'Capyra Observer',
  description: 'An independent read-only task and resource dashboard using the existing local console transport.',
  permissions: [],
  setup(ctx) {
    let observedEvents = 0;
    ctx.provide('ui', { assetsRoot: new URL('./', import.meta.url) });
    ctx.onEvent(() => { observedEvents++; });
    ctx.provide('alternate-ui.status', {
      snapshot() {
        const runtime = ctx.service('host.runtime');
        return { observedEvents, metrics: runtime.metrics() };
      },
    });
  },
};
