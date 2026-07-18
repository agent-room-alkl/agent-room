#!/usr/bin/env node

const DEFAULT_OWNER = "ebin198351-akl";
const DEFAULT_REPO = "agent-room";
const DEFAULT_CONCURRENCY = 5;
const API_VERSION = "2022-11-28";

function usage() {
  console.log(`Delete all GitHub deployment records for a repository.

Usage:
  GITHUB_TOKEN=... node scripts/delete-github-deployments.mjs [options]

Options:
  --execute          Deactivate and permanently delete deployments.
                     Without this flag, the script only lists what it would delete.
  --owner <owner>    Repository owner (default: ${DEFAULT_OWNER}).
  --repo <repo>      Repository name (default: ${DEFAULT_REPO}).
  --concurrency <n>  Concurrent deletions, from 1 to 20 (default: ${DEFAULT_CONCURRENCY}).
  --help             Show this help.

The token is read from GITHUB_TOKEN or GH_TOKEN and must have deployment write
access. Classic PATs normally need the repo scope; fine-grained PATs need
Deployments: Read and write permission for the repository.`);
}

function readValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseArgs(args) {
  const options = {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    concurrency: DEFAULT_CONCURRENCY,
    execute: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--execute") {
      options.execute = true;
    } else if (arg === "--owner") {
      options.owner = readValue(args, index, arg);
      index += 1;
    } else if (arg === "--repo") {
      options.repo = readValue(args, index, arg);
      index += 1;
    } else if (arg === "--concurrency") {
      const value = Number(readValue(args, index, arg));
      if (!Number.isInteger(value) || value < 1 || value > 20) {
        throw new Error("--concurrency must be an integer between 1 and 20");
      }
      options.concurrency = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function errorMessage(body, status) {
  if (body && typeof body === "object" && "message" in body) {
    return `${status}: ${body.message}`;
  }
  return `${status}: ${String(body || "GitHub API request failed")}`;
}

function createGitHubClient(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "agent-room-delete-deployments-script",
  };

  return async function request(path, options = {}) {
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        ...headers,
        ...options.headers,
      },
    });

    const text = await response.text();
    let body = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        // Preserve a non-JSON response so it is included in the error.
      }
    }

    if (!response.ok) {
      throw new Error(errorMessage(body, response.status));
    }

    return body;
  };
}

async function listAllDeployments(request, owner, repo) {
  const deployments = [];

  for (let page = 1; ; page += 1) {
    const result = await request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
        `/deployments?per_page=100&page=${page}`,
    );

    if (!Array.isArray(result)) {
      throw new Error("GitHub returned an unexpected deployments response");
    }

    deployments.push(...result);
    console.log(`Fetched page ${page}: ${result.length} deployment(s)`);

    if (result.length < 100) break;
  }

  return deployments;
}

async function deleteDeployment(request, owner, repo, deployment) {
  const basePath =
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/deployments/${deployment.id}`;

  await request(`${basePath}/statuses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "inactive" }),
  });

  await request(basePath, { method: "DELETE" });
}

async function runWorkers(items, concurrency, worker) {
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runWorker),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  if (!token) {
    throw new Error("Set GITHUB_TOKEN or GH_TOKEN to a PAT with deployment write access");
  }

  const request = createGitHubClient(token);
  console.log(`Repository: ${options.owner}/${options.repo}`);
  const deployments = await listAllDeployments(request, options.owner, options.repo);
  console.log(`Found ${deployments.length} deployment(s).`);

  if (deployments.length === 0) return;

  if (!options.execute) {
    console.log("Dry run: no deployments were changed.");
    console.log("Deployment IDs:", deployments.map(({ id }) => id).join(", "));
    console.log("Run again with --execute to deactivate and permanently delete them.");
    return;
  }

  let deleted = 0;
  const failures = [];

  await runWorkers(deployments, options.concurrency, async (deployment) => {
    try {
      await deleteDeployment(request, options.owner, options.repo, deployment);
      deleted += 1;
      console.log(`[${deleted + failures.length}/${deployments.length}] Deleted ${deployment.id}`);
    } catch (error) {
      failures.push({ id: deployment.id, error });
      console.error(
        `[${deleted + failures.length}/${deployments.length}] Failed ${deployment.id}: ${error.message}`,
      );
    }
  });

  console.log(`Finished: ${deleted} deleted, ${failures.length} failed.`);

  if (failures.length > 0) {
    console.error("Failed deployment IDs:");
    for (const failure of failures) {
      console.error(`  ${failure.id}: ${failure.error.message}`);
    }
    process.exitCode = 1;
  }
}

await main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
