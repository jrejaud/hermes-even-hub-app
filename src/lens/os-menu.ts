/**
 * The glasses' own action menu, for any Even Hub app (SDK 0.0.14+, Even app 2.2.9+).
 *
 * The wearer opens it with a tap, then a hold. The OS draws it: Display off and Brightness on top, then the
 * app's items in the order given, then "Close <app name>" at the bottom. The app only declares its items and
 * gets one `menuItemClickEvent { itemID }` when one is picked; the menu then closes itself.
 *
 * Traps this module exists for (hub.evenrealities.com/docs/build/contextual-menu):
 *  - the items ride on `createStartUpPageContainer` / `rebuildPageContainer` as `menuObject`, and a rebuild
 *    WITHOUT it clears them: send `osMenuObject(items)` on every page build;
 *  - an item cannot relabel itself: a changed list needs a rebuild, so put `osMenuKey(items)` in whatever key
 *    decides "same page, just upgrade text";
 *  - at most 10 items, a non-zero unique uint32 id each, a label of at most 32 UTF-8 bytes (keep it a verb
 *    under ~16 characters); one bad item makes the SDK refuse the WHOLE page, so bad items are dropped here;
 *  - opening the menu sends FOREGROUND_ENTER and closing it FOREGROUND_EXIT, the same events as the phone
 *    resuming and pausing the app: do not tear down or reconnect on them blindly;
 *  - no Exit item of your own: closing is the OS's bottom row.
 *
 * Generic: no app code in here, so other glasses apps copy this file as-is.
 */
import { MenuContainerProperty, MenuItemProperty, type EvenHubEvent } from '@evenrealities/even_hub_sdk';

export interface OsMenuItem {
  /** Non-zero, unique in the list. Stable per action, so a click means the same thing after a relabel. */
  id: number;
  /** A verb ("Quiet mode", "Mark read"), at most 32 UTF-8 bytes. */
  label: string;
}

export const OS_MENU_MAX = 10;
const MAX_LABEL_BYTES = 32;

const bytes = (s: string): number => new TextEncoder().encode(s).length;

/** The items the firmware will accept, in order: invalid ids, duplicates and overlong labels are dropped. */
export function validOsMenu(items: readonly OsMenuItem[]): OsMenuItem[] {
  const seen = new Set<number>();
  const out: OsMenuItem[] = [];
  for (const it of items) {
    const okId = Number.isInteger(it.id) && it.id > 0 && it.id <= 0xffffffff && !seen.has(it.id);
    const okLabel = it.label.length > 0 && bytes(it.label) <= MAX_LABEL_BYTES;
    if (!okId || !okLabel) {
      console.warn(`[os-menu] dropped item ${JSON.stringify(it)}`);
      continue;
    }
    seen.add(it.id);
    out.push(it);
    if (out.length === OS_MENU_MAX) break;
  }
  return out;
}

/** `menuObject` for a page build; undefined when there are no items (the OS rows still show). */
export function osMenuObject(items: readonly OsMenuItem[]): MenuContainerProperty | undefined {
  const ok = validOsMenu(items);
  if (!ok.length) return undefined;
  return new MenuContainerProperty({
    menuItems: ok.map((it) => new MenuItemProperty({ itemID: it.id, itemName: it.label })),
  });
}

/** A key that changes exactly when the menu the OS shows would change. */
export function osMenuKey(items: readonly OsMenuItem[]): string {
  return validOsMenu(items)
    .map((it) => `${it.id}=${it.label}`)
    .join(';');
}

/** The id of the item the wearer picked, or null when the event is not a menu pick. */
export function osMenuPick(e: EvenHubEvent): number | null {
  const id = e.menuItemClickEvent?.itemID;
  return typeof id === 'number' && id > 0 ? id : null;
}
