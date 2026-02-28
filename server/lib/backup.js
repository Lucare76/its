const fs = require('fs/promises');
const path = require('path');
const fsSync = require('fs');

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function parseBackupTime(raw) {
  const input = String(raw || '02:30').trim();
  const match = input.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hours: 2, minutes: 30, label: '02:30' };

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return { hours: 2, minutes: 30, label: '02:30' };
  }

  return { hours, minutes, label: `${pad(hours)}:${pad(minutes)}` };
}

function parseRetentionCount(raw) {
  const parsed = Number.parseInt(String(raw || '7'), 10);
  if (Number.isNaN(parsed) || parsed < 1) return 7;
  return parsed;
}

function resolveSqliteDbPath() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url.startsWith('file:')) {
    throw new Error('Daily backup supports only SQLite DATABASE_URL values (file:...)');
  }

  const rawPath = url.slice('file:'.length);
  if (!rawPath) {
    throw new Error('Invalid SQLite DATABASE_URL: missing file path');
  }

  const normalized = rawPath.replace(/^\/+/, '/');
  if (path.isAbsolute(normalized)) {
    return normalized;
  }

  const cwdPath = path.resolve(process.cwd(), normalized);
  const prismaPath = path.resolve(process.cwd(), 'prisma', normalized);

  if (fsSync.existsSync(cwdPath)) return cwdPath;
  if (fsSync.existsSync(prismaPath)) return prismaPath;

  return prismaPath;
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfExists(sourcePath, targetPath) {
  if (!(await pathExists(sourcePath))) return false;
  await fs.copyFile(sourcePath, targetPath);
  return true;
}

async function removeFileIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

async function pruneOldBackups({ backupDir, sourceBaseName, retainCount }) {
  const entries = await fs.readdir(backupDir, { withFileTypes: true });
  const dbFiles = entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => name.startsWith(`${sourceBaseName}-`) && name.endsWith('.db'));

  if (dbFiles.length <= retainCount) return [];

  const withStats = await Promise.all(
    dbFiles.map(async fileName => {
      const fullPath = path.join(backupDir, fileName);
      const stats = await fs.stat(fullPath);
      return { fileName, fullPath, mtimeMs: stats.mtimeMs };
    }),
  );

  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toRemove = withStats.slice(retainCount);

  await Promise.all(
    toRemove.map(async item => {
      await removeFileIfExists(item.fullPath);
      await removeFileIfExists(`${item.fullPath}.json`);
      await removeFileIfExists(`${item.fullPath}-wal`);
      await removeFileIfExists(`${item.fullPath}-shm`);
    }),
  );

  return toRemove.map(item => item.fileName);
}

async function runDailyBackup() {
  const sourceDbPath = resolveSqliteDbPath();
  if (!(await pathExists(sourceDbPath))) {
    throw new Error(`SQLite DB file not found: ${sourceDbPath}`);
  }

  const backupDir = path.resolve(process.cwd(), process.env.BACKUP_DIR || 'backups');
  await ensureDirectory(backupDir);

  const timestamp = formatTimestamp(new Date());
  const sourceBaseName = path.basename(sourceDbPath, path.extname(sourceDbPath));
  const dbBackupName = `${sourceBaseName}-${timestamp}.db`;
  const dbBackupPath = path.join(backupDir, dbBackupName);

  await fs.copyFile(sourceDbPath, dbBackupPath);

  const walCopied = await copyIfExists(`${sourceDbPath}-wal`, `${dbBackupPath}-wal`);
  const shmCopied = await copyIfExists(`${sourceDbPath}-shm`, `${dbBackupPath}-shm`);

  const manifest = {
    createdAt: new Date().toISOString(),
    sourceDbPath,
    dbBackupPath,
    walCopied,
    shmCopied,
  };

  await fs.writeFile(`${dbBackupPath}.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const retainCount = parseRetentionCount(process.env.BACKUP_RETENTION_COUNT || '7');
  const removedBackups = await pruneOldBackups({ backupDir, sourceBaseName, retainCount });
  manifest.retention = {
    keepLast: retainCount,
    removed: removedBackups,
  };

  return manifest;
}

function scheduleDailyBackup({ logger = console } = {}) {
  const enabled = String(process.env.DAILY_BACKUP_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    logger.log('[backup] Daily backup disabled (DAILY_BACKUP_ENABLED=false)');
    return { cancel: () => {} };
  }

  const backupTime = parseBackupTime(process.env.DAILY_BACKUP_TIME || '02:30');
  let timeoutId = null;
  let intervalId = null;
  let cancelled = false;

  const run = async () => {
    try {
      const result = await runDailyBackup();
      logger.log(`[backup] Backup created: ${result.dbBackupPath}`);
    } catch (error) {
      logger.error('[backup] Backup failed:', error?.message || error);
    }
  };

  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(backupTime.hours, backupTime.minutes, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    const delay = next.getTime() - now.getTime();
    logger.log(`[backup] Daily backup scheduled at ${backupTime.label} (next run ${next.toLocaleString('it-IT')})`);

    timeoutId = setTimeout(async () => {
      if (cancelled) return;
      await run();
      intervalId = setInterval(run, 24 * 60 * 60 * 1000);
    }, delay);
  };

  scheduleNext();

  return {
    cancel: () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    },
  };
}

module.exports = {
  runDailyBackup,
  scheduleDailyBackup,
};
