// UI flow graph: every screen as a node (the real lens render), every edge the gesture that
// takes you from one to the next. Run: node flow-gen.mjs  → flow.html (export with diagram/export-png.mjs)
import { readFileSync, writeFileSync } from 'node:fs';
const HERE = new URL('.', import.meta.url).pathname;
const C = { paper: '#f5f5f5', ink: '#2d3142', muted: '#4f5d75', soft: '#5a6580', accent: '#bf4520' };
const mono = "'Geist Mono', monospace", sans = "'Geist', sans-serif";
const W = 420, IMG_H = 210, TITLE_H = 30, CAP_H = 40, H = TITLE_H + IMG_H + CAP_H;
const out = [], top = [];
const b64 = f => readFileSync(HERE + 'flow/' + f).toString('base64');

function screen(x, y, n, title, file, caption, accent = false) {
  const s = accent ? C.accent : C.muted;
  top.push(`<g><rect x="${x}" y="${y}" width="${W}" height="${H}" rx="8" fill="${C.paper}" stroke="${s}" stroke-width="1.2"/>`,
    `<text x="${x + 12}" y="${y + 20}" fill="${s}" font-size="12" font-family="${mono}" letter-spacing="0.08em">${n}</text>`,
    `<text x="${x + 34}" y="${y + 20}" fill="${C.ink}" font-size="14" font-weight="600" font-family="${sans}">${title}</text>`,
    `<rect x="${x + 1}" y="${y + TITLE_H}" width="${W - 2}" height="${IMG_H}" fill="#000"/>`,
    `<image x="${x + 1}" y="${y + TITLE_H}" width="${W - 2}" height="${IMG_H}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${b64(file)}"/>`,
    `<text x="${x + 12}" y="${y + TITLE_H + IMG_H + 25}" fill="${C.muted}" font-size="11.5" font-family="${sans}">${caption}</text></g>`);
}
function box(x, y, w, h, title, sub) {
  top.push(`<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="rgba(45,49,66,0.05)" stroke="${C.muted}" stroke-width="1.2" stroke-dasharray="5 4"/>`,
    `<text x="${x + w / 2}" y="${y + h / 2 - 3}" fill="${C.ink}" font-size="14" font-weight="600" font-family="${sans}" text-anchor="middle">${title}</text>`,
    `<text x="${x + w / 2}" y="${y + h / 2 + 16}" fill="${C.muted}" font-size="11" font-family="${mono}" text-anchor="middle">${sub}</text></g>`);
}
// orthogonal route through points, rounded elbows
function arrow(pts, accent = false) {
  const r = 10; let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i], [px, py] = pts[i - 1], nx = pts[i + 1];
    if (!nx) { d += ` L ${x},${y}`; break; }
    const dx = Math.sign(x - px), dy = Math.sign(y - py), ex = Math.sign(nx[0] - x), ey = Math.sign(nx[1] - y);
    d += ` L ${x - dx * r},${y - dy * r} Q ${x},${y} ${x + ex * r},${y + ey * r}`;
  }
  out.push(`<path d="${d}" fill="none" stroke="${accent ? C.accent : C.muted}" stroke-width="1.6" marker-end="url(#${accent ? 'arrow-accent' : 'arrow'})"/>`);
}
function label(cx, cy, text, accent = false) {
  const w = text.length * 7.4 + 14;
  top.push(`<rect x="${cx - w / 2}" y="${cy - 10}" width="${w}" height="19" rx="3" fill="${C.paper}" stroke="${accent ? C.accent : 'rgba(79,93,117,0.45)'}" stroke-width="0.8"/>`,
    `<text x="${cx}" y="${cy + 4}" fill="${accent ? C.accent : C.ink}" font-size="12" font-family="${mono}" text-anchor="middle">${text}</text>`);
}

const X = [40, 590, 1140, 1690], Y = [60, 440, 820];
screen(X[0], Y[1], '1', 'Home: views', 'home.png', 'double tap: close the app');
screen(X[1], Y[0], '7', 'Banner: another session asks', 'banner.png', 'drawn over any screen · Later or 10 s: it goes away', true);
screen(X[1], Y[1], '2', 'A view: its sessions', 'list.png', 'hold: talk to the highlighted row · double tap: Home');
screen(X[2], Y[0], '3', 'Question', 'question.png', 'tap an option: answered, back to the list');
screen(X[2], Y[1], '4', 'Permission ask', 'permission.png', 'tap Allow or Deny: answered, back to the list');
screen(X[2], Y[2], '5', 'Working session', 'thread.png', 'double tap: back to the list');
screen(X[3], Y[1], '6', 'Dictate, then confirm', 'dictate.png', 'tap Send: sent, back where you came from');
box(X[0] + 60, Y[2] + 100, 300, 76, 'Lens notification', 'app closed · mirrored from phone');

const R = x => x + W, mid = y => y + TITLE_H + IMG_H / 2;
const g1 = (R(X[0]) + X[1]) / 2, g2 = (R(X[1]) + X[2]) / 2, g3 = (R(X[2]) + X[3]) / 2;
arrow([[R(X[0]), mid(Y[1])], [X[1] - 2, mid(Y[1])]]); label(g1, mid(Y[1]), 'tap a view');
arrow([[R(X[1]), mid(Y[1]) - 50], [g2, mid(Y[1]) - 50], [g2, mid(Y[0]) + 40], [X[2] - 2, mid(Y[0]) + 40]]); label(g2, 400, 'tap [?] row');
arrow([[R(X[1]), mid(Y[1])], [X[2] - 2, mid(Y[1])]]); label(g2, mid(Y[1]), 'tap [!] row');
arrow([[R(X[1]), mid(Y[1]) + 50], [g2, mid(Y[1]) + 50], [g2, mid(Y[2])], [X[2] - 2, mid(Y[2])]]); label(g2, 780, 'tap any other row');
arrow([[R(X[1]), mid(Y[0]) - 40], [X[2] - 2, mid(Y[0]) - 40]], true); label(g2, mid(Y[0]) - 40, 'tap Answer now', true);
arrow([[R(X[2]), mid(Y[0])], [g3, mid(Y[0])], [g3, mid(Y[1]) - 50], [X[3] - 2, mid(Y[1]) - 50]]); label(g3, 400, 'hold, or last row');
arrow([[R(X[2]), mid(Y[1])], [X[3] - 2, mid(Y[1])]]); label(g3, mid(Y[1]), 'say why');
arrow([[R(X[2]), mid(Y[2])], [g3, mid(Y[2])], [g3, mid(Y[1]) + 50], [X[3] - 2, mid(Y[1]) + 50]]); label(g3, 780, 'hold, or Talk to it');
const nx = X[0] + 360, ny = Y[2] + 138, lx = X[1] + W / 2;
arrow([[nx, ny], [lx, ny], [lx, Y[1] + H + 2]]); label((nx + lx) / 2, ny, 'open the app: lands on Inbox');

const VW = X[3] + W + 40, LY = Y[2] + H + 50, VH = LY + 40;
const svg = `<svg viewBox="0 0 ${VW} ${VH}" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="t d">
<title id="t">Aristo on the G2: screen flow</title>
<desc id="d">Seven lens screens as nodes; each arrow is the gesture that moves from one screen to the next.</desc>
<defs>
<marker id="arrow" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto"><polygon points="0 0, 9 3.5, 0 7" fill="${C.muted}"/></marker>
<marker id="arrow-accent" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto"><polygon points="0 0, 9 3.5, 0 7" fill="${C.accent}"/></marker>
</defs>
<rect width="100%" height="100%" fill="${C.paper}"/>
${out.join('\n')}
${top.join('\n')}
<line x1="40" y1="${LY - 18}" x2="${VW - 40}" y2="${LY - 18}" stroke="rgba(45,49,66,0.12)" stroke-width="1"/>
<text x="40" y="${LY + 6}" fill="${C.muted}" font-size="11" font-family="${mono}" letter-spacing="0.18em">ON EVERY SCREEN</text>
<text x="200" y="${LY + 6}" fill="${C.ink}" font-size="13" font-family="${sans}">swipe = move the cursor    ·    double tap = back one level    ·    an arrow is a gesture that changes the screen; what a gesture does without leaving is written under the screen</text>
</svg>`;
writeFileSync(HERE + 'flow.html', `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Aristo on G2 · screen flow</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0}body{background:${C.paper};padding:1rem}svg{width:100%;min-width:${VW}px;display:block}</style></head><body>
${svg}
</body></html>`);
console.log('wrote flow.html', VW, VH);
