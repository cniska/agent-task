import { accessSync, statSync } from "node:fs";

export function permits(file: string, mode: number): boolean {
  if (statSync(file, { throwIfNoEntry: false })?.isFile() !== true) return false;
  try {
    accessSync(file, mode);
    return true;
  } catch {
    return false;
  }
}
