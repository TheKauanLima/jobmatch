/**
 * The 50 US states plus DC, keyed by USPS code (docs/ARCHITECTURE.md §7.8.2).
 * Used by the location parser (`lib/jobs/location.ts`), the job-board query
 * validation, and the `/jobs` Location select.
 *
 * NO IMPORTS: the client bundle imports this file for dropdown labels.
 * The code list must stay identical to the `job_descriptions_location_states_check`
 * constraint in supabase/migrations/0012_job_board_filters.sql.
 */

export const US_STATES = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
} as const;

export type UsStateCode = keyof typeof US_STATES;

/** All 51 codes, in `US_STATES` order. */
export const US_STATE_CODES = Object.keys(US_STATES) as UsStateCode[];

export function isUsStateCode(value: string): value is UsStateCode {
  return Object.prototype.hasOwnProperty.call(US_STATES, value);
}

/** Display name for a code ("CA" → "California"), or null for anything else. */
export function usStateName(code: string | null | undefined): string | null {
  return code && isUsStateCode(code) ? US_STATES[code] : null;
}
