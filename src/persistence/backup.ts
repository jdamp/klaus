import { constants } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

async function assertDestinationAbsent(path: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
  } catch {
    return;
  }
  throw new Error(`Refusing to overwrite existing database file: ${path}`);
}

function assertHealthyDatabase(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (row.quick_check !== "ok") {
      throw new Error(`SQLite integrity check failed for ${path}: ${row.quick_check}`);
    }
    const migrationTable = database
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
      )
      .get();
    if (!migrationTable) throw new Error(`Not a Klaus Agent database: ${path}`);
  } finally {
    database.close();
  }
}

export async function backupDatabase(sourcePath: string, destinationPath: string): Promise<number> {
  if (resolve(sourcePath) === resolve(destinationPath)) {
    throw new Error("Backup source and destination must differ");
  }
  await assertDestinationAbsent(destinationPath);
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const pages = await backup(source, destinationPath);
    assertHealthyDatabase(destinationPath);
    return pages;
  } catch (error) {
    throw new Error(`Could not create SQLite backup at ${destinationPath}`, { cause: error });
  } finally {
    source.close();
  }
}

export async function restoreDatabase(backupPath: string, destinationPath: string): Promise<void> {
  if (resolve(backupPath) === resolve(destinationPath)) {
    throw new Error("Backup source and restore destination must differ");
  }
  assertHealthyDatabase(backupPath);
  await assertDestinationAbsent(destinationPath);
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  await copyFile(backupPath, destinationPath, constants.COPYFILE_EXCL);
  assertHealthyDatabase(destinationPath);
}
