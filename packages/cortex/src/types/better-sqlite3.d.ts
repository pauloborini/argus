declare module "better-sqlite3" {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Statement<BindParameters extends unknown[] = unknown[]> {
    run(...params: BindParameters): RunResult;
    get(...params: BindParameters): unknown;
    all(...params: BindParameters): unknown[];
  }

  export interface Database {
    pragma(source: string, options?: { simple?: boolean }): unknown;
    exec(source: string): this;
    prepare(source: string): Statement;
    transaction<F extends (...args: unknown[]) => unknown>(fn: F): F;
    close(): void;
  }

  interface DatabaseConstructor {
    new (filename: string, options?: { readonly?: boolean }): Database;
  }

  const BetterSqlite3: DatabaseConstructor;
  export default BetterSqlite3;
}
