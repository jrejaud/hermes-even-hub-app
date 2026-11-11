// Generates zones.html — tailnet one-way zone policy (SC-7628 follow-up), diagram-design skin.
import { writeFileSync } from 'node:fs';
const C = { paper: '#f5f5f5', ink: '#2d3142', muted: '#4f5d75', soft: '#5a6580', accent: '#bf4520', link: '#2e5aa8' };
const mono = "'Geist Mono', monospace", sans = "'Geist', sans-serif";
const out = [];
const zone = (x, y, w, h, label) => {
  const lw = label.length * 5.2 + 16;
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="rgba(45,49,66,0.02)" stroke="rgba(45,49,66,0.20)" stroke-width="0.8"/>`,
    `<rect x="${x + 12}" y="${y + 4}" width="${lw}" height="12" rx="2" fill="${C.paper}"/>`,
    `<text x="${x + 12 + lw / 2}" y="${y + 13}" fill="${C.soft}" font-size="7" font-family="${mono}" text-anchor="middle" letter-spacing="0.14em">${label}</text>`);
};
const nodes = [];
const node = (x, y, w, h, tag, name, sub, accent = false) => {
  const s = accent ? C.accent : C.muted, f = accent ? 'rgba(191,69,32,0.08)' : 'rgba(45,49,66,0.05)';
  const tw = tag.length * 5 + 10, cx = x + w / 2, cy = y + h / 2;
  nodes.push(`<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${C.paper}"/>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${f}" stroke="${s}" stroke-width="1"/>`,
    `<rect x="${x + 8}" y="${y + 6}" width="${tw}" height="12" rx="2" fill="transparent" stroke="${accent ? 'rgba(191,69,32,0.5)' : 'rgba(79,93,117,0.5)'}" stroke-width="0.8"/>`,
    `<text x="${x + 8 + tw / 2}" y="${y + 15}" fill="${s}" font-size="7" font-family="${mono}" text-anchor="middle" letter-spacing="0.08em">${tag}</text>`,
    `<text x="${cx}" y="${cy + 4}" fill="${C.ink}" font-size="12" font-weight="600" font-family="${sans}" text-anchor="middle">${name}</text>`,
    `<text x="${cx}" y="${cy + 19}" fill="${C.muted}" font-size="9" font-family="${mono}" text-anchor="middle">${sub}</text></g>`);
};
const arrow = (d, accent = false) => out.push(`<path d="${d}" fill="none" stroke="${accent ? C.accent : C.muted}" stroke-width="1.2" marker-end="url(#${accent ? 'arrow-accent' : 'arrow'})"/>`);
const label = (cx, lineY, text, side = false) => {
  const w = text.length * 5 + 12;
  const x = side ? cx + 10 : cx - w / 2, y = side ? lineY - 6 : lineY - 20;
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="12" rx="2" fill="${C.paper}"/>`,
    `<text x="${x + w / 2}" y="${y + 9}" fill="${C.soft}" font-size="8" font-family="${mono}" text-anchor="middle" letter-spacing="0.06em">${text}</text>`);
};


zone(504, 96, 472, 280, 'ARISTO · TAILNET ONLY');
arrow('M 260,182 H 202'); label(231, 182, 'BLE');
arrow('M 440,182 H 518', true); label(479, 182, 'WSS + TOKEN');
arrow('M 700,166 H 732 Q 740,166 740,158 V 160 Q 740,152 748,152 H 778');
arrow('M 700,182 H 732 Q 740,182 740,190 V 232 Q 740,240 748,240 H 778');
arrow('M 700,198 H 716 Q 724,198 724,206 V 320 Q 724,328 732,328 H 778');
arrow('M 610,214 V 432 Q 610,440 602,440 H 442', true); label(526, 440, 'ASKS');
arrow('M 260,440 H 128 Q 120,440 120,432 V 216'); label(190, 440, 'MIRRORED');
node(40, 150, 160, 64, 'LENS', 'G2 glasses', '576x288 · ring + temple');
node(260, 150, 180, 64, 'PHONE', 'Aristo Lens app', 'Even Hub WebView');
node(520, 150, 180, 64, 'CHIBA', 'Glasses gateway', 'token · views · one feed', true);
node(780, 120, 180, 64, 'ARISTO', 'Overlord', 'sessions');
node(780, 208, 180, 64, 'ARISTO', 'Box', 'sessions');
node(780, 296, 180, 64, 'ARISTO', 'Chiba', 'sessions · views home');
node(260, 408, 180, 64, 'PHONE', 'Glasses Notifications', 'app closed: Even mirrors it');

const legendY = 520;
const legend = [
  `<line x1="40" y1="${legendY - 8}" x2="960" y2="${legendY - 8}" stroke="rgba(45,49,66,0.10)" stroke-width="0.8"/>`,
  `<text x="40" y="${legendY + 8}" fill="${C.muted}" font-size="8" font-family="${mono}" letter-spacing="0.18em">LEGEND</text>`,
  `<line x1="110" y1="${legendY + 5}" x2="150" y2="${legendY + 5}" stroke="${C.muted}" stroke-width="1.2" marker-end="url(#arrow)"/>`,
  `<text x="158" y="${legendY + 8}" fill="${C.muted}" font-size="8.5" font-family="${sans}">data flow; the glasses app never talks to a laptop directly</text>`,
  `<text x="520" y="${legendY + 8}" fill="${C.muted}" font-size="8.5" font-family="${sans}">orange = new pieces to build</text>`,
];

const svg = `<svg viewBox="0 0 1000 544" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="zones-title zones-desc">
<title id="zones-title">Aristo on the G2 glasses</title>
<desc id="zones-desc">The glasses talk over BLE to an Even Hub app on the phone, which holds one token-protected socket to a gateway on Chiba; the gateway merges sessions from the Aristo daemons on Overlord, Box and Chiba, and sends asks to a phone notification app the Even app mirrors to the lens.</desc>
<defs>
<marker id="arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="${C.muted}"/></marker>
<marker id="arrow-accent" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="${C.accent}"/></marker>
<marker id="arrow-link" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="${C.link}"/></marker>
</defs>
<rect width="100%" height="100%" fill="${C.paper}"/>
${out.join('\n')}
${nodes.join('\n')}
${legend.join('\n')}
</svg>`;

writeFileSync(process.argv[2] || 'arch.html', `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Aristo on G2 · Architecture</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Geist:wght@400;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Geist',sans-serif;background:${C.paper};color:${C.ink};display:flex;justify-content:center;padding:2rem}
.frame{max-width:1200px;width:100%}.eyebrow{font-family:'Geist Mono',monospace;font-size:.66rem;letter-spacing:.18em;text-transform:uppercase;color:${C.muted};margin-bottom:.5rem}
h1{font-family:'Instrument Serif',serif;font-weight:400;font-size:2rem;margin-bottom:1.5rem}svg{width:100%;min-width:1000px;display:block}</style></head>
<body><div class="frame"><p class="eyebrow">Architecture · proposed</p><h1>The glasses reach sessions only through Aristo</h1>
${svg}
</div></body></html>`);
console.log('wrote arch.html');
