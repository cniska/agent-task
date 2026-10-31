import { realpathSync, statSync } from "node:fs";
import { refusals } from "./coded-error";
import { mainWorkingTree, type ProcessEnv } from "./git";
import { refuseWhileHalted } from "./halt";
import {
  allProjects,
  isProjectId,
  type Project,
  type ProjectId,
  putProject,
  removeProject,
  type Store,
  type TaskName,
} from "./store";
import { actFor, USAGE } from "./usage";

export type ProjectContext = {
  readonly store: Store;
  readonly haltPath: string;
  readonly processEnv: ProcessEnv;
};

const refuse = refusals<{
  readonly invalid_project: { readonly id: string };
  readonly dir_missing: { readonly dir: string };
  readonly project_in_use: { readonly id: string; readonly tasks: readonly TaskName[] };
}>({
  invalid_project: {
    message: ({ id }) =>
      `${JSON.stringify(id)} is not a project id: lowercase letters and digits in dash-separated words`,
    resolve: () => "pass a kebab-case id such as agent-task",
  },
  dir_missing: {
    message: ({ dir }) => `${dir} is not a directory`,
    resolve: () => "pass the directory where the project's briefs and plans live",
  },
  project_in_use: {
    message: ({ id, tasks }) => `${tasks.join(", ")} still belong to project ${id}`,
    resolve: ({ tasks }) =>
      `${tasks.map((task) => `${actFor(USAGE.map, task)} or ${actFor(USAGE.done, task)}`).join("; ")}, then remove the project again`,
  },
});

export function parseProjectId(id: string): ProjectId {
  if (!isProjectId(id)) throw refuse("invalid_project", { id });
  return id;
}

export type ProjectRequest = {
  readonly id: string;
  readonly name: string;
  readonly repo: string;
  readonly dir: string;
};

export function addProject(
  { store, haltPath, processEnv }: ProjectContext,
  request: ProjectRequest,
): Project {
  refuseWhileHalted(haltPath);
  const id = parseProjectId(request.id);
  const repo = mainWorkingTree(request.repo, processEnv);
  if (statSync(request.dir, { throwIfNoEntry: false })?.isDirectory() !== true)
    throw refuse("dir_missing", { dir: request.dir });
  return putProject(store, { id, name: request.name, repo, dir: realpathSync(request.dir) });
}

export function listProjects({ store }: ProjectContext): readonly Project[] {
  return allProjects(store);
}

export function dropProject({ store, haltPath }: ProjectContext, raw: string): Project {
  refuseWhileHalted(haltPath);
  const id = parseProjectId(raw);
  const removal = removeProject(store, id);
  if (removal.kind === "in_use") throw refuse("project_in_use", { id, tasks: removal.tasks });
  return removal.project;
}
