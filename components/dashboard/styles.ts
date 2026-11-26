/**
 * Shared §6-token class strings for the dashboard's cards and link-buttons.
 * Link-buttons mirror `components/ui/Button` (which renders a `<button>`,
 * not a link), so navigation stays a real `<a>`.
 */

export const CARD = "rounded-lg border border-border bg-surface p-5 shadow-sm sm:p-6";

const LINK_BUTTON_BASE =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition-colors sm:min-h-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export const PRIMARY_LINK_BUTTON = `${LINK_BUTTON_BASE} bg-accent text-accent-fg shadow-sm hover:bg-accent-hover`;

export const SECONDARY_LINK_BUTTON = `${LINK_BUTTON_BASE} border border-border-strong bg-surface text-fg shadow-sm hover:bg-surface-hover`;

/** Small "View all" style header link. */
export const HEADER_LINK =
  "inline-flex min-h-11 shrink-0 items-center rounded-sm text-sm font-medium text-fg-muted hover:text-fg sm:min-h-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export const ALERT =
  "rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg";
