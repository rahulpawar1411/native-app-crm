import * as SQLite from 'expo-sqlite';

let db = null;
try {
  // Open sync SQLite database file
  db = SQLite.openDatabaseSync('reeferon_offline.db');
} catch (err) {
  console.error('❌ Error opening SQLite database:', err);
}

/**
 * Initializes local SQLite tables for client-chamber assignments cache
 * and pending inspections queue.
 */
export const initDatabase = () => {
  if (!db) return;
  try {
    // 1. Create assignments table (caching assignments from backend)
    db.execSync(`
      CREATE TABLE IF NOT EXISTS local_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chamber_id INTEGER NOT NULL,
        chamber_name TEXT NOT NULL,
        client_name TEXT NOT NULL,
        remark TEXT,
        status TEXT DEFAULT 'active',
        UNIQUE(chamber_id, client_name) ON CONFLICT REPLACE
      );
    `);

    try {
      db.execSync(`ALTER TABLE local_assignments ADD COLUMN remark TEXT;`);
      console.log('🌱 SQLite: Added remark column to local_assignments.');
    } catch (err) {}
    
    try {
      db.execSync(`ALTER TABLE local_assignments ADD COLUMN status TEXT DEFAULT 'active';`);
      console.log('🌱 SQLite: Added status column to local_assignments.');
    } catch (err) {}

    // 2. Drop inspections queue table if it contains the deprecated 'temperature' column or old UNIQUE constraint to force clean schema update
    try {
      const tableInfo = db.getAllSync("PRAGMA table_info(local_inspections);");
      const hasOldTemp = tableInfo.some(col => col.name === 'temperature');
      
      const sqlSchema = db.getAllSync("SELECT sql FROM sqlite_master WHERE type='table' AND name='local_inspections';");
      const hasOldUnique = sqlSchema.length > 0 && !sqlSchema[0].sql.includes('UNIQUE(entry_date, chamber_id, client_name, entry_time)');

      if (hasOldTemp || hasOldUnique) {
        console.log('🧹 SQLite: Old table format detected. Dropping table local_inspections for clean schema migration.');
        db.execSync('DROP TABLE IF EXISTS local_inspections;');
      }
    } catch (err) {
      // Ignored if table doesn't exist yet
    }

    // Create inspections queue table
    db.execSync(`
      CREATE TABLE IF NOT EXISTS local_inspections (
        id TEXT PRIMARY KEY,
        operator_name TEXT NOT NULL,
        chamber_id INTEGER NOT NULL,
        chamber_name TEXT NOT NULL,
        client_name TEXT NOT NULL,
        box_temp REAL NOT NULL,
        photo_uri TEXT NOT NULL,
        entry_date TEXT NOT NULL,
        entry_time TEXT NOT NULL,
        box_count INTEGER,
        chamber_type TEXT,
        overdue_time TEXT DEFAULT 'same day',
        photo_capture_time TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        shift TEXT DEFAULT 'Morning',
        reference_no TEXT,
        UNIQUE(entry_date, chamber_id, client_name, entry_time) ON CONFLICT FAIL
      );
    `);

    // Run simple schema migration to add box_temp if database exists with old temperature column
    try {
      db.execSync(`ALTER TABLE local_inspections ADD COLUMN box_temp REAL;`);
      console.log('🌱 SQLite: Added box_temp column to local_inspections.');
    } catch (err) {}

    // Programmatic migrations: Add box_count if table already exists without it
    try {
      db.execSync(`ALTER TABLE local_inspections ADD COLUMN box_count INTEGER;`);
      console.log('🌱 SQLite: Added box_count column to local_inspections.');
    } catch (err) {}

    // Programmatic migrations: Add shift if table already exists without it
    try {
      db.execSync(`ALTER TABLE local_inspections ADD COLUMN shift TEXT DEFAULT 'Morning';`);
      console.log('🌱 SQLite: Added shift column to local_inspections.');
    } catch (err) {}

    // Programmatic migrations: Add chamber_type if table already exists without it
    try {
      db.execSync(`ALTER TABLE local_inspections ADD COLUMN chamber_type TEXT;`);
      console.log('🌱 SQLite: Added chamber_type column to local_inspections.');
    } catch (err) {}

    // Programmatic migrations: Add overdue_time if table already exists without it
    try {
      db.execSync(`ALTER TABLE local_inspections ADD COLUMN overdue_time TEXT DEFAULT 'same day';`);
      console.log('🌱 SQLite: Added overdue_time column to local_inspections.');
    } catch (err) {}

    // Programmatic migrations: Add photo_capture_time if table already exists without it
    try {
      db.execSync(`ALTER TABLE local_inspections ADD COLUMN photo_capture_time TEXT;`);
      console.log('🌱 SQLite: Added photo_capture_time column to local_inspections.');
    } catch (err) {}

    // Programmatic migrations: Add reference_no if table already exists without it
    try {
      db.execSync(`ALTER TABLE local_inspections ADD COLUMN reference_no TEXT;`);
      console.log('🌱 SQLite: Added reference_no column to local_inspections.');
    } catch (err) {}
    
    console.log('✅ SQLite Database Tables initialized successfully.');
  } catch (error) {
    console.error('❌ Failed to initialize SQLite database tables:', error);
  }
};

/**
 * Caches the client assignments retrieved from the server.
 * @param {Array} assignments - Array of client assignments [{ chamber_id, chamber_name, client_name }]
 */
export const cacheAssignments = (assignments) => {
  if (!db) return;
  try {
    // Start transaction to clear and reload assignments
    db.execSync('DELETE FROM local_assignments;');
    
    for (const item of assignments) {
      db.runSync(
        'INSERT INTO local_assignments (chamber_id, chamber_name, client_name) VALUES (?, ?, ?);',
        [item.chamber_id, item.chamber_name, item.client_name]
      );
    }
    console.log('🌱 Successfully cached assignments locally in SQLite.');
  } catch (error) {
    console.error('❌ Failed to cache assignments:', error);
  }
};

/**
 * Retrieves cached client assignments from the local SQLite database.
 * @returns {Array} List of local assignments
 */
export const getLocalAssignments = () => {
  if (!db) return [];
  try {
    return db.getAllSync("SELECT chamber_id, chamber_name, client_name, remark FROM local_assignments WHERE status IS NULL OR status = 'active' ORDER BY chamber_name ASC, client_name ASC;");
  } catch (error) {
    console.error('❌ Failed to read local assignments:', error);
    return [];
  }
};

/**
 * Saves a new inspection log locally to the SQLite queue.
 * @param {Object} log - Log details to save
 */
export const saveInspectionLocally = (log) => {
  if (!db) return false;
  try {
    db.runSync(
      `INSERT INTO local_inspections 
      (id, operator_name, chamber_id, chamber_name, client_name, box_temp, photo_uri, entry_date, entry_time, box_count, chamber_type, overdue_time, photo_capture_time, sync_status, shift) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?);`,
      [
        log.id,
        log.operator_name,
        parseInt(log.chamber_id),
        log.chamber_name,
        log.client_name,
        parseFloat(log.box_temp),
        log.photo_uri,
        log.entry_date,
        log.entry_time,
        log.box_count !== undefined && log.box_count !== null ? parseInt(log.box_count) : null,
        log.chamber_type || 'Frozen',
        log.overdue_time || 'same day',
        log.photo_capture_time || null,
        log.shift || 'Morning'
      ]
    );
    console.log(`💾 Saved inspection locally in SQLite queue: ${log.client_name} - ${log.chamber_name} (${log.chamber_type || 'Frozen'}, Overdue: ${log.overdue_time || 'same day'})`);
    return true;
  } catch (error) {
    console.error('❌ Failed to save inspection locally:', error);
    return false;
  }
};

/**
 * Verifies if an inspection has already been recorded for the given client, chamber and date.
 * Enforces the business logic: "Prevent duplicate submissions for the same client on the same day".
 */
export const checkDuplicateInspection = (date, chamberId, clientName, entryTime) => {
  if (!db) return false;
  try {
    const row = db.getFirstSync(
      'SELECT COUNT(*) as count FROM local_inspections WHERE entry_date = ? AND chamber_id = ? AND client_name = ? AND entry_time = ?;',
      [date, parseInt(chamberId), clientName, entryTime]
    );
    return row && row.count > 0;
  } catch (error) {
    console.error('❌ Failed to check duplicate inspection:', error);
    return false;
  }
};

/**
 * Fetches all local inspections pending sync.
 */
export const getPendingInspections = (operatorName) => {
  if (!db) return [];
  try {
    if (operatorName) {
      return db.getAllSync("SELECT * FROM local_inspections WHERE sync_status = 'pending' AND operator_name = ?;", [operatorName]);
    }
    return db.getAllSync("SELECT * FROM local_inspections WHERE sync_status = 'pending';");
  } catch (error) {
    console.error('❌ Failed to fetch pending sync inspections:', error);
    return [];
  }
};

/**
 * Fetches all local inspections logged for today.
 */
export const getTodaysInspections = (date, operatorName) => {
  if (!db) return [];
  try {
    if (operatorName) {
      return db.getAllSync("SELECT * FROM local_inspections WHERE entry_date = ? AND operator_name = ?;", [date, operatorName]);
    }
    return db.getAllSync("SELECT * FROM local_inspections WHERE entry_date = ?;", [date]);
  } catch (error) {
    console.error('❌ Failed to fetch today\'s inspections:', error);
    return [];
  }
};

/**
 * Fetches all local inspections logged on the device.
 */
export const getAllLocalInspections = (operatorName) => {
  if (!db) return [];
  try {
    if (operatorName) {
      return db.getAllSync("SELECT * FROM local_inspections WHERE operator_name = ?;", [operatorName]);
    }
    return db.getAllSync("SELECT * FROM local_inspections;");
  } catch (error) {
    console.error('❌ Failed to fetch all inspections:', error);
    return [];
  }
};


/**
 * Marks a queued inspection as synced in the local database.
 * @param {string} id - Log ID
 */
export const markInspectionAsSynced = (id, referenceNo) => {
  if (!db) return;
  try {
    db.runSync(
      "UPDATE local_inspections SET sync_status = 'synced', reference_no = ? WHERE id = ?;",
      [referenceNo || null, id]
    );
    console.log(`🚀 Marked inspection ${id} as SYNCED with Ref: ${referenceNo} in local SQLite.`);
  } catch (error) {
    console.error('❌ Failed to mark inspection as synced:', error);
  }
};

/**
 * Deletes a local inspection by entry_date, chamber_id, client_name, and shift.
 */
export const deleteInspectionLocally = (date, chamberId, clientName, shift) => {
  if (!db) return false;
  try {
    db.runSync(
      "DELETE FROM local_inspections WHERE entry_date = ? AND chamber_id = ? AND client_name = ? AND shift = ?;",
      [date, parseInt(chamberId), clientName, shift]
    );
    console.log(`🗑️ Deleted local inspection: ${clientName} in Chamber ${chamberId} for date ${date} for shift ${shift}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to delete local inspection:', error);
    return false;
  }
};

/**
 * Adds a new client assignment locally with a remark/reason.
 */
export const addLocalAssignment = (chamberId, chamberName, clientName, remark) => {
  if (!db) return false;
  try {
    db.runSync(
      "INSERT INTO local_assignments (chamber_id, chamber_name, client_name, remark, status) VALUES (?, ?, ?, ?, 'active');",
      [parseInt(chamberId), chamberName, clientName, remark || '']
    );
    console.log(`➕ Added local client assignment: ${clientName} in ${chamberName} with remark: ${remark}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to add local assignment:', error);
    return false;
  }
};

/**
 * Deletes a client assignment locally by marking it inactive with a deletion remark.
 */
export const deleteLocalAssignment = (chamberId, clientName, remark) => {
  if (!db) return false;
  try {
    db.runSync(
      "UPDATE local_assignments SET status = 'inactive', remark = ? WHERE chamber_id = ? AND client_name = ?;",
      [remark || '', parseInt(chamberId), clientName]
    );
    console.log(`➖ Soft-deleted client assignment: ${clientName} from chamber ${chamberId} with remark: ${remark}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to soft-delete local assignment:', error);
    return false;
  }
};
