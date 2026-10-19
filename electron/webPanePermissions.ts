// Permission policy for plain web panes (design 043 §Backlog, E-76).
//
// A web pane's `persist:<profile>` partition used to carry no permission
// handler, and with none set Electron grants every request — camera,
// microphone, geolocation, notifications, MIDI, HID/serial/USB, pointer lock,
// openExternal (handing a link to another app). Web panes load arbitrary sites
// and there is no prompt UI for them, so the policy is deny, with a short
// allowlist of permissions that expose no device, location or data:
//
//  - fullscreen: video players and meeting pages; the user leaves with Esc.
//  - clipboard-sanitized-write: "copy" buttons (code blocks, share links).
//    Write-only and sanitized by Chromium; reading the clipboard
//    (clipboard-read) stays denied.
//
// Add to the list only when a real site breaks, with the reason next to it.
//
// This answers what meetingPermission leaves undecided ("default"). Meeting
// panes share the same partition and the same handlers (installMeetingPermissions
// installs them on every web-pane partition with this function as the
// fallback), so camera/mic/screen for a meeting pane on an allowlisted origin
// still pass, and everything else falls here instead of to Electron's grant.

const WEB_PANE_ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write'])

/** True when a web pane (or a meeting pane, for permissions D8 does not decide) may have `permission`. */
export function webPanePermission(permission: string): boolean {
  return WEB_PANE_ALLOWED.has(permission)
}
