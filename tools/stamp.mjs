// Cache-bust every local module. Import maps remap URL-like specifiers against
// the document base, so mapping "./js/foo.js" -> "./js/foo.js?v=N" versions the
// whole graph without touching a single import statement.
import fs from 'fs';
const root = new URL('../', import.meta.url).pathname;
const v = process.argv[2] || String(Date.now());
const mods = fs.readdirSync(root + 'js').filter(f => f.endsWith('.js')).map(f => `./js/${f}`);
const vendor = fs.readdirSync(root + 'js/vendor').filter(f => f.endsWith('.js')).map(f => `./js/vendor/${f}`);
const imports = { three: `./js/vendor/three.module.min.js?v=${v}` };
for (const m of [...mods, ...vendor]) imports[m] = `${m}?v=${v}`;
const map = `<script type="importmap">\n${JSON.stringify({ imports }, null, 1)}\n</script>`;

let html = fs.readFileSync(root + 'index.html', 'utf8');
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>/, map);
html = html.replace(/<script type="module" src="\.\/js\/main\.js[^"]*"><\/script>/,
  `<script type="module" src="./js/main.js?v=${v}"></script>`);
fs.writeFileSync(root + 'index.html', html);
console.log(`stamped v=${v} across ${mods.length + vendor.length} modules`);
