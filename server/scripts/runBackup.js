require('dotenv').config();
const { runDailyBackup } = require('../lib/backup');

(async () => {
  try {
    const result = await runDailyBackup();
    console.log(`[backup] OK ${result.dbBackupPath}`);
    process.exit(0);
  } catch (error) {
    console.error('[backup] ERROR', error?.message || error);
    process.exit(1);
  }
})();
