/**
 * Rasters → PNG bytes for image containers (SC-11683). The SDK takes encoded image bytes and converts them to the
 * lens's 4-bit grey itself, so this only draws white on black at the container's exact size.
 *
 * The pixel decisions live in `rasterPixels` (pure, unit-tested); `canvasRasterize` only paints them on a canvas,
 * except for a big text value, which uses the WebView's font (the lens font is not available to a canvas).
 */
import type { Raster } from './card';

/** Lit pixels for a bitmap or a sparkline, as [x, y] pairs inside w x h. Text returns null (needs a font). */
export function rasterPixels(r: Raster, w: number, h: number): [number, number][] | null {
  const out: [number, number][] = [];
  if (r.kind === 'bitmap') {
    const rw = (r.rows[0]?.length ?? 0) * r.scale;
    const rh = r.rows.length * r.scale;
    const ox = Math.round((w - rw) / 2);
    const oy = Math.round((h - rh) / 2);
    r.rows.forEach((row, j) =>
      [...row].forEach((ch, i) => {
        if (ch === '.' || ch === ' ') return;
        for (let a = 0; a < r.scale; a++)
          for (let b = 0; b < r.scale; b++) out.push([ox + i * r.scale + a, oy + j * r.scale + b]);
      }),
    );
    return out;
  }
  if (r.kind === 'spark') {
    const d = r.points;
    if (d.length < 2) return out;
    const lo = Math.min(...d);
    const hi = Math.max(...d);
    const pt = (i: number): [number, number] => [
      2 + Math.round((i * (w - 5)) / (d.length - 1)),
      2 + Math.round((1 - (d[i] - lo) / (hi - lo || 1)) * (h - 5)),
    ];
    for (let i = 1; i < d.length; i++) {
      const [ax, ay] = pt(i - 1);
      const [bx, by] = pt(i);
      const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1);
      for (let t = 0; t <= n; t++)
        out.push([Math.round(ax + ((bx - ax) * t) / n), Math.round(ay + ((by - ay) * t) / n)]);
    }
    const [lx, ly] = pt(d.length - 1);
    for (let dx = -2; dx <= 2; dx++)
      for (let dy = -2; dy <= 2; dy++) if (dx * dx + dy * dy <= 5) out.push([lx + dx, ly + dy]);
    return out;
  }
  return null;
}

export async function canvasRasterize(r: Raster, w: number, h: number): Promise<number[] | null> {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff';
  const px = rasterPixels(r, w, h);
  if (px) {
    for (const [x, y] of px) if (x >= 0 && y >= 0 && x < w && y < h) g.fillRect(x, y, 1, 1);
  } else if (r.kind === 'text') {
    // As tall as the box allows, narrowed until it fits the width.
    let size = Math.floor(h * 0.9);
    const font = (s: number) => `600 ${s}px "Helvetica Neue", Arial, sans-serif`;
    g.font = font(size);
    while (size > 12 && g.measureText(r.text).width > w - 4) g.font = font(--size);
    g.textBaseline = 'middle';
    g.fillText(r.text, 2, h / 2);
  }
  const blob: Blob | null = await new Promise((res) => cv.toBlob(res, 'image/png'));
  if (!blob) return null;
  return [...new Uint8Array(await blob.arrayBuffer())];
}
