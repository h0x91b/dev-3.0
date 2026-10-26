import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export type SqliteRow = Record<string, unknown>;
export type ReadonlySqliteQuery = (path: string, sql: string) => SqliteRow[];

/**
 * A read-only open of a WAL database fails without its `-shm` sidecar and cannot
 * create one. With no `-wal` there is nothing outside the main file, so an
 * immutable open reads it without creating or locking anything beside it.
 */
export function readonlySqliteTarget(path: string, hasWal = existsSync(`${path}-wal`)): string {
	if (hasWal) return path;
	const absolute = resolve(path).replaceAll("\\", "/");
	// SQLite reads `file:/C:/…` as a Windows drive path; `file:C:/…` would be relative.
	const uriPath = encodeURI(absolute.startsWith("/") ? absolute : `/${absolute}`).replaceAll("?", "%3F").replaceAll("#", "%23");
	return `file:${uriPath}?mode=ro&immutable=1`;
}

const requireBuiltin = createRequire(import.meta.url);
interface ReadonlyDatabase { close(): void }

/** bun:sqlite in the app; node:sqlite where tests run under Node. Never writes. */
export const queryReadonlySqlite: ReadonlySqliteQuery = (path, sql) => {
	const target = readonlySqliteTarget(path);
	if (process.versions.bun) {
		const { Database } = requireBuiltin("bun:sqlite") as { Database: new (path: string, options: object) => ReadonlyDatabase & {
			query(sql: string): { all(): SqliteRow[] };
		} };
		const db = new Database(target, { readonly: true });
		try { return db.query(sql).all(); }
		finally { db.close(); }
	}
	const { DatabaseSync } = requireBuiltin("node:sqlite") as { DatabaseSync: new (path: string, options: object) => ReadonlyDatabase & {
		prepare(sql: string): { all(): SqliteRow[] };
	} };
	const db = new DatabaseSync(target, { readOnly: true });
	try { return db.prepare(sql).all(); }
	finally { db.close(); }
};
