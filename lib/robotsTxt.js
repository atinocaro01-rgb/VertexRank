// robots.txt parsing and matching, following the behaviour Google documents
// (RFC 9309): rules are grouped by user-agent, the most specific matching group wins,
// patterns support `*` and a trailing `$`, and within a group the LONGEST matching
// pattern wins (Allow wins a tie). No dependencies, so it is unit-tested directly.

/** Parses robots.txt text into { groups: [{ agents, rules }], sitemaps }. */
export function parseRobotsTxt(text) {
  const groups = [];
  const sitemaps = [];
  let current = null; // group being built
  let lastWasAgent = false;

  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      // Consecutive user-agent lines share one group; a user-agent after rules starts a new one.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      if (value) current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      if (!current) continue; // rule before any user-agent: ignore
      if (value === "") continue; // "Disallow:" with no value allows everything; an empty Allow is a no-op
      current.rules.push({ allow: key === "allow", pattern: value });
      continue;
    }
    lastWasAgent = false; // crawl-delay and unknown directives don't end or start groups
  }
  return { groups, sitemaps };
}

function compile(pattern) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + source + (anchored ? "$" : ""));
}

/**
 * Builds a matcher for one crawler. `agent` is the crawler's product token (e.g. "googlebot",
 * "vertexrankbot"). The group with the longest agent token contained in `agent` wins; otherwise
 * the "*" group applies; otherwise everything is allowed.
 */
export function matcherFor(parsed, agent) {
  const name = String(agent || "").toLowerCase();
  const groups = parsed?.groups || [];

  let bestToken = "";
  for (const g of groups) {
    for (const token of g.agents) {
      if (token !== "*" && name.includes(token) && token.length > bestToken.length) bestToken = token;
    }
  }
  const useToken = bestToken || "*";
  const rules = groups
    .filter((g) => g.agents.includes(useToken))
    .flatMap((g) => g.rules)
    .map((r) => ({ ...r, regex: compile(r.pattern), length: r.pattern.length }));

  function isAllowed(pathAndQuery) {
    const path = pathAndQuery || "/";
    let best = null;
    for (const r of rules) {
      if (!r.regex.test(path)) continue;
      if (!best || r.length > best.length || (r.length === best.length && r.allow && !best.allow)) best = r;
    }
    return best ? best.allow : true;
  }

  /** True when every sample path is disallowed — i.e. the whole site is blocked for this crawler. */
  function blocksWholeSite() {
    return ["/", "/about", "/blog/post", "/products/item-1?x=1"].every((p) => !isAllowed(p));
  }

  return { isAllowed, blocksWholeSite, matchedGroup: bestToken || (rules.length || groups.some((g) => g.agents.includes("*")) ? "*" : null), ruleCount: rules.length };
}
