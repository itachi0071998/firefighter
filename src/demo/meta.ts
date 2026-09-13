/**
 * Metadata sidecar for the seeded demo repository.
 *
 * The demo repo is a REAL git repository, but a git repo alone cannot describe
 * pull requests or production deployments. Those live in a JSON sidecar written
 * next to the repo (and git-ignored inside it, so it never shows up in a diff).
 * The mock GitHub adapter reads this file to answer PR/deployment queries the
 * same way the real adapter answers them from the GitHub API.
 */
import fs from 'node:fs';
import path from 'node:path';

/** A merged pull request in the demo repository's history. */
export interface DemoPrMeta {
  number: number;
  title: string;
  body: string;
  author: string;
  createdAt: string;
  mergedAt: string;
  mergeCommitSha: string;
  baseRef: string;
  headRef: string;
  labels: string[];
}

/** A recorded production deployment of one merge commit. */
export interface DemoDeployMeta {
  id: string;
  sha: string;
  prNumber: number;
  environment: string;
  deployedAt: string;
  status: 'success' | 'failed';
}

/** Everything the mock GitHub adapter needs that git itself cannot store. */
export interface DemoRepoMeta {
  owner: string;
  name: string;
  defaultBranch: string;
  pullRequests: DemoPrMeta[];
  deployments: DemoDeployMeta[];
  nextPrNumber: number;
  seededAt: string;
}

/** Name of the sidecar file, relative to the demo repo root. */
export const META_FILENAME = '.firefighter-meta.json';

/**
 * Absolute path of the metadata sidecar for a demo repo.
 *
 * @param repoPath - Root of the demo repository.
 */
export function metaPath(repoPath: string): string {
  return path.join(repoPath, META_FILENAME);
}

/**
 * Read the metadata sidecar.
 *
 * @param repoPath - Root of the demo repository.
 * @returns Parsed metadata, or null when the file is absent or unreadable.
 */
export function readMeta(repoPath: string): DemoRepoMeta | null {
  let raw: string;
  try {
    raw = fs.readFileSync(metaPath(repoPath), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DemoRepoMeta;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.pullRequests) || !Array.isArray(parsed.deployments)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write the metadata sidecar (pretty-printed, trailing newline).
 *
 * @param repoPath - Root of the demo repository. Created if missing.
 * @param meta - Metadata to persist.
 */
export function writeMeta(repoPath: string, meta: DemoRepoMeta): void {
  fs.mkdirSync(repoPath, { recursive: true });
  fs.writeFileSync(metaPath(repoPath), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

/**
 * Look up one pull request by number.
 *
 * @param meta - Demo repo metadata.
 * @param number - Pull request number.
 */
export function findPr(meta: DemoRepoMeta, number: number): DemoPrMeta | null {
  return meta.pullRequests.find((pr) => pr.number === number) ?? null;
}

/**
 * Most recent deployment for an environment, by deployedAt.
 *
 * @param meta - Demo repo metadata.
 * @param environment - Environment name, defaults to "production".
 */
export function latestDeploy(meta: DemoRepoMeta, environment = 'production'): DemoDeployMeta | null {
  const candidates = meta.deployments
    .filter((d) => d.environment === environment)
    .sort((a, b) => (a.deployedAt < b.deployedAt ? -1 : a.deployedAt > b.deployedAt ? 1 : 0));
  return candidates.length > 0 ? candidates[candidates.length - 1]! : null;
}
