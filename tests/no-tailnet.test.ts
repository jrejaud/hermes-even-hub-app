import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// This repo is a public fork (SC-9500 rules): no tailnet hostnames or 100.x tailnet IPs in shipped code.
// The gateway address comes from the phone form at runtime.
const TAILNET = /[a-z0-9-]+\.tail[0-9a-f]+\.ts\.net|\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('no tailnet addresses in shipped files', () => {
  for (const f of [...files('src').filter((p) => !p.startsWith('src/dev/')), 'app.json', 'index.html']) {
    it(f, () => {
      expect(readFileSync(f, 'utf8').match(TAILNET)?.[0] ?? '').toBe('');
    });
  }
});
