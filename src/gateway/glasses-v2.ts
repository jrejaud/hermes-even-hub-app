/**
 * Glasses contract additions for Aristo Lens v2 (SC-9703 / gateway card SC-9704), as specified on SC-9704.
 *
 * TEMPORARY: once aristo-v2 publishes them in packages/shared/glasses.ts, run `npm run contract:sync` and
 * delete this file (the vendored contract then carries the same shapes). Do not add anything here that is
 * not on SC-9704: the gateway is being built against exactly these.
 */
import type { GlassesClientFrame, GlassesKey, GlassesServerFrame } from './glasses';

export type LensClientFrameV2 =
  /** Start streaming speech-to-text for this socket (Soniox on the views home). */
  | { t: 'listen'; reqId: string; lang?: string[] }
  /** A base64 chunk of 16 kHz mono s16le PCM for the listen with this reqId. */
  | { t: 'audio'; reqId: string; pcm: string }
  /** The wearer let go: flush and reply `ok` with the final `text`. */
  | { t: 'listen.end'; reqId: string }
  /** Discard the listen; reply `ok` with no text. */
  | { t: 'listen.cancel'; reqId: string }
  /** Interrupt a working session. */
  | { t: 'interrupt'; reqId: string; key: GlassesKey }
  /** Start a new session with `text` as its first prompt; reply `ok` with its `key`. */
  | { t: 'create'; reqId: string; text: string; viewId?: string };

export type LensServerFrameV2 =
  /** Live transcript during a listen: `final` = settled text so far, `interim` = the not-yet-final tail. */
  { t: 'partial'; reqId: string; final: string; interim: string };

export type ClientFrame = GlassesClientFrame | LensClientFrameV2;
export type ServerFrame =
  | Exclude<GlassesServerFrame, { t: 'ok' }>
  | { t: 'ok'; reqId: string; text?: string; key?: GlassesKey }
  | LensServerFrameV2;
