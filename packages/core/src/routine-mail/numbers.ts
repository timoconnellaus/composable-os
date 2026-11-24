// Mobile numbers, as far as texting goes (ADR 0673): the countries the host knows the numbers of,
// and a number's international form when it is a mobile in one of the countries texts may go to.
// No imports: the settings schema reads the country codes.

/**
 * The countries a business may text, with their calling code, their trunk prefix (what a number
 * written without its country code starts with), and what a mobile's national number looks like.
 * In the North American plan a mobile cannot be told from a landline by its number, so any
 * number there is taken as one, and +1 is the United States' and Canada's both.
 */
const COUNTRIES = {
  AU: { code: "61", trunk: "0", mobile: /^4\d{8}$/ },
  NZ: { code: "64", trunk: "0", mobile: /^2\d{7,9}$/ },
  GB: { code: "44", trunk: "0", mobile: /^7\d{9}$/ },
  IE: { code: "353", trunk: "0", mobile: /^8[3-9]\d{7}$/ },
  US: { code: "1", trunk: "1", mobile: /^[2-9]\d{2}[2-9]\d{6}$/ },
  CA: { code: "1", trunk: "1", mobile: /^[2-9]\d{2}[2-9]\d{6}$/ },
} as const;

export type TextCountry = keyof typeof COUNTRIES;
export const TEXT_COUNTRY_CODES = Object.keys(COUNTRIES) as [TextCountry, ...TextCountry[]];

/**
 * `number` (as a person wrote it) in international form (`+61412345678`), when it is a mobile in
 * one of `countries`; else null. A number without its country code is read as the first
 * country's (the business's own).
 */
export function mobileInCountries(
  number: string,
  countries: readonly TextCountry[],
): string | null {
  const trimmed = number.trim();
  let digits = trimmed.replace(/\D/g, "");
  let international = trimmed.startsWith("+");
  if (!international && digits.startsWith("00")) {
    digits = digits.slice(2);
    international = true;
  }
  if (!digits) return null;
  if (international) {
    for (const id of countries) {
      const c = COUNTRIES[id];
      if (digits.startsWith(c.code) && c.mobile.test(digits.slice(c.code.length))) {
        return `+${digits}`;
      }
    }
    return null;
  }
  const own = countries[0];
  if (!own) return null;
  const c = COUNTRIES[own];
  const national =
    c.trunk && digits.startsWith(c.trunk) && !c.mobile.test(digits)
      ? digits.slice(c.trunk.length)
      : digits;
  return c.mobile.test(national) ? `+${c.code}${national}` : null;
}
