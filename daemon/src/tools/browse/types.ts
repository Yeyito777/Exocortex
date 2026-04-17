export const MAX_RELEVANT_LINKS = 8;
export const CONTEXT_WINDOW = 200;
export const MIN_LINK_SCORE = 18;

export interface RelevantLink {
  text: string;
  url: string;
}

export interface ScoredRelevantLink extends RelevantLink {
  score: number;
  index: number;
  canonicalLabelScore: number;
}

export interface CandidateLink extends RelevantLink {
  index: number;
}

export type DomainKind =
  | "github"
  | "hackernews"
  | "wikipedia"
  | "python-docs"
  | "rust-blog"
  | "huggingface"
  | "docs-rs"
  | "mdn"
  | "npmjs"
  | "rfc-editor"
  | "arxiv"
  | "julia-blog"
  | "readthedocs"
  | "pandas-docs"
  | "fastapi-docs"
  | "python-blog"
  | "whatwg-spec"
  | "pypi"
  | "generic";

export interface PageContext {
  page: URL;
  domainKind: DomainKind;
  repoPrefix: string | null;
  keywords: string[];
  isGitHubRepoSearchPage: boolean;
}
