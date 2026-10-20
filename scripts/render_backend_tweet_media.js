const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const width = 1920;
const height = 1080;
const outDir = path.resolve('generated-artifacts/memeperp-backend-tweet');
fs.mkdirSync(outDir, { recursive: true });

const logo = `
<g transform="translate(54 8) scale(.34)" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <path d="M83 294v-54m67 54v-99m67 99v-77m67 77V176" stroke="#263d37" stroke-width="25"/>
  <path d="m65 298 75-158 67 96 72-133 62 195" stroke="#3DF3C5" stroke-width="25"/>
  <path d="M279 103h15" stroke="#dff9ef" stroke-width="7"/>
</g>`;

function icon(stage, x, y) {
  const c = '#3DF3C5';
  const faint = '#638679';
  const p = [
    `<g fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="${x + 8}" y="${y + 14}" width="100" height="68" rx="14"/>
      <path d="M${x + 8} ${y + 34}h100M${x + 83} ${y + 54}h25v18H${x + 83}z"/>
      <circle cx="${x + 92}" cy="${y + 63}" r="2" fill="${c}"/>
      <path d="M${x + 22} ${y + 14}v-8h82v8" stroke="${faint}" stroke-width="3"/>
    </g>`,
    `<g fill="none" stroke="${c}" stroke-width="5" stroke-linejoin="round">
      <rect x="${x + 14}" y="${y + 8}" width="90" height="25" rx="6"/>
      <rect x="${x + 14}" y="${y + 43}" width="90" height="25" rx="6"/>
      <rect x="${x + 14}" y="${y + 78}" width="90" height="25" rx="6"/>
      <circle cx="${x + 29}" cy="${y + 20}" r="3" fill="${c}"/><circle cx="${x + 29}" cy="${y + 55}" r="3" fill="${c}"/><circle cx="${x + 29}" cy="${y + 90}" r="3" fill="${c}"/>
      <path d="M${x + 46} ${y + 20}h42M${x + 46} ${y + 55}h42M${x + 46} ${y + 90}h42" stroke="${faint}" stroke-width="3"/>
    </g>`,
    `<g fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M${x + 12} ${y + 93}V${y + 12}M${x + 12} ${y + 93}h106"/>
      <path d="m${x + 22} ${y + 75} 23-22 19 10 28-34 19 12" />
      <circle cx="${x + 45}" cy="${y + 53}" r="4" fill="${c}"/><circle cx="${x + 92}" cy="${y + 29}" r="4" fill="${c}"/>
    </g>`,
    `<g fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="${x + 9}" y="${y + 9}" width="108" height="91" rx="10"/>
      <path d="M${x + 9} ${y + 34}h108M${x + 28} ${y + 65}v18m23-34v34m23-24v24m23-42v42" />
      <path d="M${x + 20} ${y + 19}h55" stroke="${faint}" stroke-width="3"/>
    </g>`,
  ];
  return p[stage];
}

function card(stage, i) {
  const x = 100 + i * 430;
  const y = 360;
  const active = stage === i;
  const stroke = active ? '#3DF3C5' : '#2a4940';
  const opacity = active ? '1' : '.72';
  const top = ['ACCOUNT', 'VALIDATION', 'MARKET DATA', 'POSITION'][i];
  const title = ['WALLET + NETWORK', 'INTENT CHECK', 'LIVE QUOTE', 'POSITION VALUE'][i];
  const copy = [
    'Selected account and chain',
    'Validate the exact action',
    'Fetch the current token price',
    'Update mark and unrealized P&amp;L',
  ][i];
  const num = String(i + 1).padStart(2, '0');
  return `
  <g opacity="${opacity}">
    <rect x="${x}" y="${y}" width="400" height="304" rx="18" fill="#0c1916" fill-opacity=".94" stroke="${stroke}" stroke-width="${active ? 3 : 2}"/>
    ${active ? `<path d="M${x + 18} ${y}h364" stroke="#3DF3C5" stroke-width="5" stroke-linecap="round"/>` : ''}
    <text x="${x + 30}" y="${y + 44}" fill="${active ? '#3DF3C5' : '#90a99c'}" font-family="DejaVu Sans Mono,monospace" font-size="17" font-weight="700" letter-spacing="2">${num} / ${top}</text>
    <circle cx="${x + 350}" cy="${y + 40}" r="20" fill="${active ? '#3DF3C5' : '#1b302a'}"/>
    <text x="${x + 350}" y="${y + 47}" text-anchor="middle" fill="${active ? '#08110f' : '#a6b8ae'}" font-family="DejaVu Sans Mono,monospace" font-size="17" font-weight="700">${num}</text>
    ${icon(i, x + 140, y + 74)}
    <text x="${x + 30}" y="${y + 226}" fill="#ecf4ee" font-family="DejaVu Sans,sans-serif" font-size="24" font-weight="700" letter-spacing=".2">${title}</text>
    <text x="${x + 30}" y="${y + 268}" fill="#9aaba4" font-family="DejaVu Sans,sans-serif" font-size="18">${copy}</text>
  </g>`;
}

function artwork(activeStage = -1) {
  const cardMarkup = [0, 1, 2, 3].map(i => card(activeStage, i)).join('');
  const dots = [0, 1, 2, 3].map(i => {
    const x = 500 + i * 430;
    const active = i <= activeStage;
    return `<circle cx="${x}" cy="512" r="${active ? 5 : 3}" fill="${active ? '#3DF3C5' : '#527166'}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#07110f"/><stop offset=".58" stop-color="#101c19"/><stop offset="1" stop-color="#091411"/></linearGradient>
    <radialGradient id="glow"><stop stop-color="#1f5948" stop-opacity=".42"/><stop offset="1" stop-color="#07110f" stop-opacity="0"/></radialGradient>
    <pattern id="grid" width="80" height="80" patternUnits="userSpaceOnUse"><path d="M80 0H0V80" fill="none" stroke="#bdebd4" stroke-opacity=".045" stroke-width="1"/></pattern>
  </defs>
  <rect width="1920" height="1080" fill="url(#bg)"/>
  <ellipse cx="1540" cy="512" rx="680" ry="510" fill="url(#glow)"/>
  <rect width="1920" height="1080" fill="url(#grid)"/>
  <path d="M0 141H1920" stroke="#8db7a5" stroke-opacity=".19"/>
  <path d="M90 800H1830" stroke="#8db7a5" stroke-opacity=".25"/>
  <path d="M500 512H1820" stroke="#47675b" stroke-opacity=".7" stroke-width="3"/>
  <path d="M500 512H${500 + Math.max(0, activeStage) * 430}" stroke="#3DF3C5" stroke-opacity=".85" stroke-width="3"/>
  ${dots}
  ${logo}
  <text x="180" y="102" fill="#edf4ef" font-family="DejaVu Sans,sans-serif" font-size="45" font-weight="800" letter-spacing="-2">EMEPERP</text>
  <text x="100" y="267" fill="#a7b9af" font-family="DejaVu Sans,sans-serif" font-size="24">Wallet and network checks. Server-side intent validation. Live quotes for position values.</text>
  ${cardMarkup}
  <text x="100" y="855" fill="#8ca79a" font-family="DejaVu Sans Mono,monospace" font-size="16" font-weight="700" letter-spacing="2">CHAIN-AWARE  ·  SERVER-VALIDATED  ·  QUOTE-BASED</text>
  <text x="1815" y="855" text-anchor="end" fill="#6f8a7d" font-family="DejaVu Sans Mono,monospace" font-size="16" letter-spacing="2">MEMEPERP / ENGINE</text>
  </svg>`;
}

function render(svg, output) {
  const input = `${output}.svg`;
  fs.writeFileSync(input, svg);
  const result = spawnSync('magick', [input, '-background', 'none', output], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`ImageMagick failed to render ${output}`);
}

render(artwork(-1), path.join(outDir, 'memeperp-backend-flow.png'));
for (let i = 0; i < 4; i++) {
  render(artwork(i), path.join(outDir, `stage-${i + 1}.png`));
}
console.log(outDir);
