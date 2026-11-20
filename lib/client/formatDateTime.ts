/**
 * Formats an ISO timestamp in the viewer's local time zone, with the zone
 * name shown (e.g. "Nov 12, 2026, 7:00 PM EST") so a reset time computed in
 * UTC is never mistaken for local midnight.
 *
 * Client-only in practice: the result depends on the runtime's locale and
 * time zone, so calling it during server rendering would produce a
 * hydration mismatch. `locale`/`timeZone` are injectable for tests.
 *
 * Returns `null` for an unparseable value so callers can fall back to
 * generic copy instead of rendering "Invalid Date".
 */
export function formatLocalDateTime(
  iso: string | null | undefined,
  options: { locale?: string; timeZone?: string } = {},
): string | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);

  // `dateStyle`/`timeStyle` can't be combined with `timeZoneName` in one
  // formatter (Intl throws), so the zone label is read separately.
  const dateTime = new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: options.timeZone,
  }).format(date);

  const zone = new Intl.DateTimeFormat(options.locale, {
    timeZoneName: "short",
    timeZone: options.timeZone,
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;

  return zone ? `${dateTime} ${zone}` : dateTime;
}
