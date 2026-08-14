/**
 * Shared search types.
 *
 * Kept in their own module so the cache and the usage meter can refer to a
 * result without importing the search engine itself — that would be a cycle,
 * since the engine imports both of them.
 */

export interface SearchResultItem {
  title: string;
  url: string;
  content: string;
  /**
   * Provider relevance when supplied. Exa's auto search may omit this field;
   * missing is not zero, and must not be filtered as a bad result.
   */
  score?: number;
  domain: string;
  /** Publication date, when the provider supplies one. */
  publishedDate?: string;
  /**
   * Which provider returned this.
   *
   * Not decoration. Scores are NOT comparable across providers — Tavily
   * reports a relevance value that sits around 0.5-0.95 for a decent hit,
   * Exa reports a cosine similarity that sits around 0.15-0.35 for the same
   * quality of hit. A single threshold tuned to one silently discards
   * everything from the other, which is exactly what happened: Exa answered
   * correctly and every result was dropped before the model saw it.
   */
  provider?: string;
}

/** Search depth. Providers that have no such split ignore this. */
export type SearchDepth = "basic" | "advanced";

/**
 * How aggressively to spend on search.
 *
 * `quality` reproduces the original behaviour exactly — every request at
 * advanced depth, four queries in the opening round — so there is always a
 * setting that is known-good to fall back to.
 */
export type SearchProfile = "quality" | "balanced" | "cheap";

export interface ProfileSettings {
  /** Depth for the opening round. */
  firstRoundDepth: SearchDepth;
  /** Depth once the sufficiency check has asked for more. */
  followUpDepth: SearchDepth;
  /** Queries fired in the opening round. */
  firstRoundQueries: number;
  /** Queries fired in each follow-up round. */
  followUpQueries: number;
  /**
   * Results requested per query.
   *
   * Providers bill per request, not per result, and include up to ten in the
   * base price — asking for five paid the ten-result price for half the
   * sources, so more queries were needed to reach the same coverage.
   */
  resultsPerQuery: number;
  /** Whether cached results may be reused. */
  useCache: boolean;
}

export const SEARCH_PROFILES: Record<SearchProfile, ProfileSettings> = {
  // Exactly the pre-existing behaviour, kept as an escape hatch.
  quality: {
    firstRoundDepth: "advanced",
    followUpDepth: "advanced",
    firstRoundQueries: 4,
    followUpQueries: 3,
    resultsPerQuery: 10,
    useCache: true,
  },
  // Opening round goes wide and shallow; only the gap the judge identifies is
  // worth paying deep-parse prices for.
  balanced: {
    firstRoundDepth: "basic",
    followUpDepth: "advanced",
    firstRoundQueries: 3,
    followUpQueries: 3,
    resultsPerQuery: 10,
    useCache: true,
  },
  cheap: {
    firstRoundDepth: "basic",
    followUpDepth: "basic",
    firstRoundQueries: 2,
    followUpQueries: 2,
    resultsPerQuery: 10,
    useCache: true,
  },
};

export const DEFAULT_SEARCH_PROFILE: SearchProfile = "balanced";

/** Resolve a profile name, falling back to the default for unknown values. */
export function profileSettings(name: string | undefined): ProfileSettings {
  if (name && name in SEARCH_PROFILES) {
    return SEARCH_PROFILES[name as SearchProfile];
  }
  return SEARCH_PROFILES[DEFAULT_SEARCH_PROFILE];
}
