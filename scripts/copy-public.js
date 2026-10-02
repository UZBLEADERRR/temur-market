// Copies the mini app static files into dist after tsc build.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'src', 'webapp', 'public');
const dst = path.join(__dirname, '..', 'dist', 'webapp', 'public');
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
console.log('Copied mini app files to', dst);
