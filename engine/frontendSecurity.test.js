const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const page = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
function extract(source, name) {
  const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, `Missing function ${name}`);
  return match[0];
}
const malicious = `<img src=x onerror="globalThis.stolen=true">`;

test('all inline page scripts remain valid JavaScript', () => {
  for (const file of ['index.html', 'testnet.html', 'home.html', 'admin.html', 'admin-login.html']) {
    for (const match of page(file).matchAll(/<script\b([^>]*)>([^]*?)<\/script>/gi)) {
      if (/\bsrc=/.test(match[1]) || /application\/(?:ld\+)?json/.test(match[1])) continue;
      new vm.Script(match[2], { filename: file });
    }
  }
});

test('externally loaded scripts are version-pinned and integrity-protected', () => {
  for (const file of ['index.html', 'testnet.html', 'home.html', 'admin.html', 'admin-login.html']) {
    for (const match of page(file).matchAll(/<script\b[^>]*\bsrc=["']https?:[^>]*>/gi)) {
      assert.ok(/integrity="sha384-[A-Za-z0-9+/=]+"/.test(match[0]), `${file}: unverified external script`);
      assert.ok(/crossorigin="anonymous"/.test(match[0]));
      assert.ok(!match[0].includes('@latest'));
    }
  }
});

test('mainnet token metadata and signup rows cannot become executable HTML', () => {
  const source = page('index.html');
  const body = {}, count = {};
  const context = vm.createContext({
    document: { getElementById: id => id === 'betaAdminBody' ? body : count },
    isTokenVerifiedTradeable: () => false,
    fmt: String,
  });
  vm.runInContext(['escapeHtml', 'sdropItem', 'renderBetaAdminRows'].map(name => extract(source, name)).join('\n'), context);
  const token = { sym: malicious, name: malicious, e: malicious, color: `red" onclick="alert(1)`, px: 1 };
  context.token = token;
  const result = vm.runInContext('sdropItem(token, 0)', context);
  assert.ok(!result.includes('<img'));
  assert.ok(result.includes('&lt;img'));
  assert.ok(!result.includes('background:red'));
  context.entries = [{ email: `${malicious}@example.invalid`, createdAt: malicious }];
  vm.runInContext('renderBetaAdminRows(entries)', context);
  assert.ok(!body.innerHTML.includes('<img'));
  assert.ok(body.innerHTML.includes('&lt;img'));
});

test('ticker identifiers are captured by event listeners, not inserted into JavaScript attributes', () => {
  const source = page('index.html'), handlers = [];
  const element = { innerHTML: '', querySelectorAll: () => [
    { dataset: { tickerIndex: '0' }, addEventListener: (_event, fn) => handlers.push(fn) },
    { dataset: { tickerIndex: '1' }, addEventListener: (_event, fn) => handlers.push(fn) },
  ] };
  const token = { id: `');globalThis.stolen=true;//`, addr: malicious, sym: malicious, px: 1, ch: 0 };
  const calls = [];
  const context = vm.createContext({
    document: { getElementById: () => element }, trendingTickerItems: [token], COINS: [],
    fmt: String, quickTickerSelect: (...args) => calls.push(args),
  });
  vm.runInContext(extract(source, 'escapeHtml') + '\n' + extract(source, 'buildTicker') + '\nbuildTicker()', context);
  assert.ok(!element.innerHTML.includes('onclick='));
  assert.ok(!element.innerHTML.includes('<img'));
  handlers[0]();
  assert.deepEqual(calls[0], [token.id, token.addr]);
});

test('Solana action attributes safely round-trip quotes, backslashes and markup', () => {
  const source = page('testnet.html'), context = vm.createContext({});
  vm.runInContext(extract(source, 'escapeHtml') + '\n' + extract(source, 'inlineString'), context);
  const value = `");globalThis.stolen=true;//'\\\n${malicious}`;
  context.value = value;
  const encoded = vm.runInContext('inlineString(value)', context);
  assert.ok(!/[<>"']/.test(encoded));
  const decoded = encoded.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(JSON.parse(decoded), value);
});