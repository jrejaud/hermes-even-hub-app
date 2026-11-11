/**
 * Even Hub events → lens gestures (SC-9500). Pure, so every shape the firmware has been seen to send is a
 * unit test.
 *
 * Traps this encodes (even-realities `even-hub-sdk.md` → Input):
 *  - CLICK_EVENT is 0 and protobuf drops zero fields, so a tap arrives with NO eventType;
 *  - taps and double taps arrive on `sysEvent`, scrolls on `textEvent`; read whichever is present;
 *  - an audio frame is an event too and must never count as a tap.
 */
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk';
import type { Gesture } from './state';

export type LensInput = Gesture | 'foreground' | 'background' | 'exit';

export function toInput(e: EvenHubEvent): LensInput | null {
  if (e.audioEvent) return null;
  const src = e.sysEvent ?? e.textEvent ?? e.listEvent;
  if (!src) return null;
  const et = src.eventType ?? OsEventTypeList.CLICK_EVENT;
  switch (et) {
    case OsEventTypeList.CLICK_EVENT:
      return 'tap';
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      return 'double';
    case OsEventTypeList.SCROLL_TOP_EVENT:
      return 'up';
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      return 'down';
    case OsEventTypeList.LONG_PRESS_EVENT:
      return 'hold';
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
      return 'release';
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      return 'foreground';
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      return 'background';
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      return 'exit';
    default:
      return null;
  }
}
