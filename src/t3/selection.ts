import type { Project } from "./contracts/orchestration.ts";
import type { Provider, ProviderModel } from "./contracts/providers.ts";
import type { VcsRef } from "./contracts/vcs.ts";

export const normalizePath = (value: string): string =>
  value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

const list = (items: string[]): string => (items.length > 0 ? items.join(", ") : "(none)");

export function resolveProject(projects: Project[], ref: string): Project {
  const wanted = ref.trim();
  if (!wanted) {
    throw new Error("project is required.");
  }
  const byId = projects.find((p) => p.id === wanted);
  if (byId) {
    return byId;
  }
  const byRoot = projects.filter((p) => normalizePath(p.workspaceRoot) === normalizePath(wanted));
  const matches = byRoot.length > 0 ? byRoot : projects.filter((p) => p.title === wanted);
  const [match] = matches;
  if (matches.length === 1 && match) {
    return match;
  }
  if (matches.length > 1) {
    const shown = matches.map((p) => `${p.id} (${p.title} @ ${p.workspaceRoot})`);
    throw new Error(
      `project "${wanted}" is ambiguous; pass the project id instead. Matches: ${list(shown)}`,
    );
  }
  throw new Error(
    `project "${wanted}" not found. Use t3_list_projects. Known: ${list(projects.map((p) => `${p.title} [${p.id}]`))}`,
  );
}

export function unusableReason(provider: Provider): string | null {
  if (provider.availability === "unavailable") {
    return provider.unavailableReason ?? "unavailable";
  }
  if (!provider.installed) {
    return provider.message ?? "not installed";
  }
  if (!provider.enabled || provider.status === "disabled") {
    return provider.message ?? "disabled in T3 settings";
  }
  if (provider.auth.status === "unauthenticated") {
    return "not signed in; sign in through T3 first";
  }
  return null;
}

export function resolveHarness(providers: Provider[], ref: string): Provider {
  const wanted = ref.trim();
  if (!wanted) {
    throw new Error("harness is required.");
  }
  const exact = providers.find((p) => p.instanceId === wanted);
  const matches = exact
    ? [exact]
    : providers.filter((p) =>
        [p.displayName, p.driver].some((name) => name?.toLowerCase() === wanted.toLowerCase()),
      );
  const [provider] = matches;
  if (matches.length !== 1 || !provider) {
    throw new Error(
      `harness "${wanted}" not found. Use t3_list_harnesses. Known ids: ${list(providers.map((p) => p.instanceId))}`,
    );
  }
  const reason = unusableReason(provider);
  if (reason) {
    throw new Error(`harness "${provider.instanceId}" is not usable right now: ${reason}.`);
  }
  return provider;
}

export function resolveModel(provider: Provider, ref: string): ProviderModel {
  const wanted = ref.trim();
  if (!wanted) {
    throw new Error("model is required.");
  }
  const bySlug = provider.models.find((m) => m.slug === wanted);
  if (bySlug) {
    return bySlug;
  }
  const byAlias = provider.models.filter(
    (m) => m.name === wanted || (m.aliases ?? []).includes(wanted),
  );
  const [match] = byAlias;
  if (byAlias.length === 1 && match) {
    return match;
  }
  throw new Error(
    `model "${wanted}" is not offered by harness "${provider.instanceId}". Use t3_list_harnesses. Offered: ${list(provider.models.map((m) => m.slug))}`,
  );
}

export interface WorktreeChoice {
  branch: string | null;
  worktreePath: string | null;
}

export function resolveWorktree(
  project: Project,
  refs: VcsRef[],
  worktreePath: string,
): WorktreeChoice {
  const wanted = normalizePath(worktreePath.trim());
  if (!wanted) {
    throw new Error("worktreePath is required.");
  }
  if (wanted === normalizePath(project.workspaceRoot)) {
    return { branch: refs.find((r) => r.current && !r.isRemote)?.name ?? null, worktreePath: null };
  }
  const match = refs.find((r) => r.worktreePath && normalizePath(r.worktreePath) === wanted);
  if (!match) {
    const known = refs.filter((r) => r.worktreePath).map((r) => `${r.worktreePath} (${r.name})`);
    throw new Error(
      `worktree "${worktreePath}" is not a worktree of project "${project.title}". Use t3_list_worktrees. Known: ${
        known.length > 0 ? known.join(", ") : "(none besides the project root)"
      }`,
    );
  }
  return { branch: match.name, worktreePath: match.worktreePath };
}
