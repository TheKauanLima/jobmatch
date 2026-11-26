import { describe, expect, it } from "vitest";

import { parseLocationFacets } from "@/lib/jobs/location";

/** Every example in docs/ARCHITECTURE.md §7.8.2, plus live board formats. */
describe("parseLocationFacets (§7.8.2)", () => {
  it.each([
    // Rule 1: DC
    ["Washington, D.C.", ["DC"], false],
    ["Washington DC", ["DC"], false],
    ["District of Columbia", ["DC"], false],
    ["Arlington, VA or D.C.", ["DC", "VA"], false],
    // Rule 2: codes
    ["San Francisco, CA", ["CA"], false],
    ["Remote - ME", ["ME"], true],
    ["New York, NY; Pittsburgh, PA", ["NY", "PA"], false],
    ["Remote - CA", ["CA"], true],
    ["Austin, TX 78701", ["TX"], false],
    ["Chicago (IL)", ["IL"], false],
    // Rule 3: full names
    ["New York", ["NY"], false],
    ["Texas", ["TX"], false],
    ["Charleston, West Virginia", ["WV"], false],
    ["Seattle, Washington, United States", ["WA"], false],
    // Rule 4: aliases
    ["San Francisco Bay Area", ["CA"], false],
    ["Austin", ["TX"], false],
    ["NYC", ["NY"], false],
    ["Portland", [], false],
    ["Cambridge", [], false],
    ["Columbus", [], false],
    // Rules 5–6: remote
    ["Remote - ME; Remote - NH", ["ME", "NH"], true],
    ["Anywhere", [], true],
    ["Work from home", [], true],
    ["WFH", [], true],
    // Rule 7: nothing
    ["North America", [], false],
    ["", [], false],
    // Required cases
    ["Hybrid - San Francisco, CA", ["CA"], false],
    ["San Francisco, CA, US; Remote, US", ["CA"], true],
    ["Remote - USA", [], true],
    ["Seattle, WA or Remote", ["WA"], true],
    ["Toronto, ON", [], false],
    // Formats seen on the live board
    ["San Francisco, CA • New York, NY", ["CA", "NY"], false],
    ["Foster City, CA, Boston, MA", ["CA", "MA"], false],
    ["Remote - US: Select locations", [], true],
    ["Hybrid", [], false],
    ["In-Office", [], false],
    ["Austin; New York City; San Francisco", ["CA", "NY", "TX"], false],
    ["New York, Seattle, South San Francisco HQ", ["CA", "NY", "WA"], false],
    ["Remote, CA, US", ["CA"], true],
    // Country codes that look like states stay out
    ["Toronto, CA", [], false],
    ["Mumbai, IN", [], false],
    ["Bangalore, KA, IN", [], false],
    ["Tbilisi, Georgia", [], false],
    ["Atlanta, Georgia, United States", ["GA"], false],
    // Lowercase two-letter words are never codes
    ["remote in or near me", [], true],
    // QA 2026-11-20: towns named after a state or an aliased city (live rows marked *)
    ["Brooklyn Park, MN", ["MN"], false], // *
    ["Abilene, TX, Delaware, OH, Rolla, MO", ["MO", "OH", "TX"], false], // *
    ["Michigan City, IN", ["IN"], false], // *
    ["Kansas City, MO", ["MO"], false],
    ["Washington, PA", ["PA"], false],
    ["Indiana, PA", ["PA"], false],
    ["Nevada City, CA", ["CA"], false],
    ["Austin, MN", ["MN"], false],
    ["Denver, NC", ["NC"], false],
    ["Bellevue, NE", ["NE"], false],
    ["San Francisco, Seattle, New York", ["CA", "NY", "WA"], false], // *
    // ...while same-state pairs and lists of state names still count
    ["Iowa City, IA", ["IA"], false],
    ["Oklahoma City, OK", ["OK"], false],
    ["New York, New York, USA; Pittsburgh, Pennsylvania, USA", ["NY", "PA"], false],
    ["Bellevue, Washington; Mountain View, California", ["CA", "WA"], false],
    ["California, Oregon, Washington", ["CA", "OR", "WA"], false],
    ["Austin, TX 78701", ["TX"], false],
    ["Seattle, San Francisco", ["CA", "WA"], false],
    ["Washington, D.C., Seattle, WA", ["DC", "WA"], false],
  ] as const)("%j → %j remote=%s", (location, states, isRemote) => {
    expect(parseLocationFacets(location)).toEqual({ states: [...states], isRemote });
  });

  it("returns nothing for null", () => {
    expect(parseLocationFacets(null)).toEqual({ states: [], isRemote: false });
  });

  it("uses the remote hint", () => {
    expect(parseLocationFacets("New York, NY", { remote: true })).toEqual({
      states: ["NY"],
      isRemote: true,
    });
    expect(parseLocationFacets(null, { remote: true })).toEqual({ states: [], isRemote: true });
  });

  it("does not add WA for Washington, D.C.", () => {
    expect(parseLocationFacets("Washington, D.C.").states).not.toContain("WA");
  });
});
