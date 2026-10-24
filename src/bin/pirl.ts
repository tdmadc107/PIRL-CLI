#!/usr/bin/env node
// React and Ink run their development builds unless NODE_ENV says otherwise; the development build checks
// every render and costs several times the CPU. Set it before they load, which is why the TUI is imported here.
process.env.NODE_ENV ??= 'production';
await import('./main.js');
