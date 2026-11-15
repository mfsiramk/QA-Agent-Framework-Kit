/**
 * Database access for the Query Runner - one small wrapper per engine.
 * The driver for the client's engine is installed by "npm install" (the installer adds
 * only that one to package.json):
 *   sqlserver -> mssql (Windows authentication: msnodesqlv8, Windows only)
 *   postgres  -> pg
 *   mysql     -> mysql2
 *   oracle    -> oracledb (thin mode, no Oracle client needed)
 *
 * runQuery(cfg, env, sql, { readOnly }) -> { columns: [], rows: [[]], rowCount }
 * Read-only queries run inside a transaction that is ALWAYS rolled back.
 */

const ENGINES = {
  sqlserver: { label: 'SQL Server / Azure SQL', driver: 'mssql', port: 1433 },
  postgres: { label: 'PostgreSQL', driver: 'pg', port: 5432 },
  mysql: { label: 'MySQL / MariaDB', driver: 'mysql2', port: 3306 },
  oracle: { label: 'Oracle', driver: 'oracledb', port: 1521 },
};

function need(mod, engine) {
  try { return require(mod); } catch {
    throw new Error(`The ${ENGINES[engine].label} driver "${mod}" is not installed. Run: npm install`);
  }
}

/** Credentials: DB_<ENV>_USER / DB_<ENV>_PASSWORD, falling back to DB_USER / DB_PASSWORD. */
function credentials(env) {
  const key = String(env.name).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return {
    user: process.env[`DB_${key}_USER`] || process.env.DB_USER || '',
    password: process.env[`DB_${key}_PASSWORD`] || process.env.DB_PASSWORD || '',
  };
}

const toTable = (records) => {
  const columns = records.length ? Object.keys(records[0]) : [];
  return { columns, rows: records.map((r) => columns.map((c) => r[c])), rowCount: records.length };
};

async function sqlserver(qr, env, sql, readOnly) {
  const { user, password } = credentials(env);
  const windows = qr.auth === 'windows';
  const mssql = windows ? need('mssql/msnodesqlv8', 'sqlserver') : need('mssql', 'sqlserver');
  const config = {
    server: env.host, port: Number(env.port) || 1433, database: env.database,
    options: { encrypt: env.encrypt !== false, trustServerCertificate: !!env.trustServerCertificate },
    connectionTimeout: 20000, requestTimeout: Number(qr.timeoutSeconds || 120) * 1000,
  };
  if (windows) config.options.trustedConnection = true;
  else if (qr.auth === 'entra-password') config.authentication = { type: 'azure-active-directory-password', options: { userName: user, password } };
  else Object.assign(config, { user, password });
  const pool = await new mssql.ConnectionPool(config).connect();
  try {
    if (!readOnly) return toTable((await pool.request().query(sql)).recordset || []);
    const tx = new mssql.Transaction(pool);
    await tx.begin();
    try { return toTable((await new mssql.Request(tx).query(sql)).recordset || []); }
    finally { await tx.rollback().catch(() => {}); }
  } finally { await pool.close(); }
}

async function postgres(qr, env, sql, readOnly) {
  const { Client } = need('pg', 'postgres');
  const { user, password } = credentials(env);
  const c = new Client({ host: env.host, port: Number(env.port) || 5432, database: env.database, user, password, ssl: env.ssl ? { rejectUnauthorized: !env.trustServerCertificate } : undefined, statement_timeout: Number(qr.timeoutSeconds || 120) * 1000 });
  await c.connect();
  try {
    if (readOnly) await c.query('BEGIN READ ONLY');
    const r = await c.query(sql);
    const last = Array.isArray(r) ? r[r.length - 1] : r;
    return toTable(last.rows || []);
  } finally {
    if (readOnly) await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}

async function mysql(qr, env, sql, readOnly) {
  const m = need('mysql2/promise', 'mysql');
  const { user, password } = credentials(env);
  const c = await m.createConnection({ host: env.host, port: Number(env.port) || 3306, database: env.database, user, password, ssl: env.ssl ? { rejectUnauthorized: !env.trustServerCertificate } : undefined });
  try {
    if (readOnly) await c.query('START TRANSACTION READ ONLY');
    const [rows] = await c.query(sql);
    return toTable(Array.isArray(rows) ? rows : []);
  } finally {
    if (readOnly) await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}

async function oracle(qr, env, sql, readOnly) {
  const o = need('oracledb', 'oracle');
  const { user, password } = credentials(env);
  const c = await o.getConnection({ user, password, connectString: `${env.host}:${Number(env.port) || 1521}/${env.database}` });
  try {
    if (readOnly) await c.execute('SET TRANSACTION READ ONLY');
    const r = await c.execute(sql.replace(/;\s*$/, ''), [], { outFormat: o.OUT_FORMAT_OBJECT });
    return toTable(r.rows || []);
  } finally {
    await c.rollback().catch(() => {});
    await c.close();
  }
}

const RUNNERS = { sqlserver, postgres, mysql, oracle };

async function runQuery(qr, env, sql, { readOnly = true } = {}) {
  const run = RUNNERS[qr.engine];
  if (!run) throw new Error(`Unknown database engine "${qr.engine}".`);
  return run(qr, env, sql, readOnly);
}

/**
 * True if the SQL may change data or schema (conservative: stored-procedure calls count).
 * Writes into SQL Server temp tables (#name) are ignored - they vanish with the session.
 */
function isWrite(sql) {
  const s = String(sql)
    .replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '') // comments
    .replace(/'(?:[^']|'')*'/g, "''") // string literals
    .replace(/\b(insert\s+into|into|update|delete\s+from|truncate\s+table|drop\s+table)\s+#\w+/gi, ''); // temp tables
  return /\b(insert\s+into|update\s+[\w.[\]"`]+\s+set|delete\s+from|delete\s+[\w.[\]"`]+\s+(from|where)|merge\s+into|truncate\s+table|drop\s+(table|view|procedure|function|index|schema)|alter\s+(table|view|procedure|function)|create\s+(table|view|procedure|function|index)|grant\s|revoke\s|exec(ute)?\s+[\w.[\]]+|call\s+\w+)/i.test(s);
}

module.exports = { ENGINES, runQuery, isWrite, credentials };
