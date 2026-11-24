// Which numbers are mobiles in the countries texts may go to (stage 30 step 3, ADR 0673): the
// international form a text is sent to, from a number as a person wrote it.
import { describe, expect, it } from "vitest";
import { mobileInCountries } from "../src/routine-mail/numbers.ts";

describe("mobileInCountries", () => {
  it("reads a number without its country code as the business's own country's", () => {
    expect(mobileInCountries("0412 345 678", ["AU"])).toBe("+61412345678");
    expect(mobileInCountries("412345678", ["AU"])).toBe("+61412345678");
    expect(mobileInCountries("07700 900123", ["GB", "AU"])).toBe("+447700900123");
    expect(mobileInCountries("(415) 555-0100", ["US"])).toBe("+14155550100");
  });

  it("takes a number with its country code only in a country texts may go to", () => {
    expect(mobileInCountries("+61 412 345 678", ["AU"])).toBe("+61412345678");
    expect(mobileInCountries("0061412345678", ["AU"])).toBe("+61412345678");
    expect(mobileInCountries("+447700900123", ["AU"])).toBeNull();
    expect(mobileInCountries("+447700900123", ["AU", "GB"])).toBe("+447700900123");
  });

  it("is not a landline, nor anything when no country is set", () => {
    expect(mobileInCountries("02 9876 5432", ["AU"])).toBeNull();
    expect(mobileInCountries("+61298765432", ["AU"])).toBeNull();
    expect(mobileInCountries("0412 345 678", [])).toBeNull();
    expect(mobileInCountries("call me", ["AU"])).toBeNull();
  });
});
