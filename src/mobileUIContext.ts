import { createContext, useContext } from 'react';

// True inside the phone UI (MobileApp, chosen once by pickMobileUI in
// main.tsx), false everywhere else. Components shared with the desktop app
// read it to apply phone-only adjustments — e.g. PaneInput's >=16px font,
// without which iOS Safari zooms the page on focus — while the desktop
// renders exactly as before.
export const MobileUIContext = createContext(false);

export function useIsMobileUI(): boolean {
  return useContext(MobileUIContext);
}
