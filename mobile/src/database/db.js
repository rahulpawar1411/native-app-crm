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
    try {
      const tableInfo = db.getAllSync("PRAGMA table_info(local_assignments);");
      const hasSyncStatus = tableInfo.some(col => col.name === 'sync_status');
      const hasAction = tableInfo.some(col => col.name === 'action');
      if (tableInfo.length > 0 && (!hasSyncStatus || !hasAction)) {
        console.log('🧹 SQLite: Old local_assignments schema detected. Dropping for clean upgrade.');
        db.execSync('DROP TABLE IF EXISTS local_assignments;');
      }
    } catch (err) {}

    db.execSync(`
      CREATE TABLE IF NOT EXISTS local_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chamber_id INTEGER NOT NULL,
        chamber_name TEXT NOT NULL,
        client_name TEXT NOT NULL,
        remark TEXT,
        status TEXT DEFAULT 'active',
        sync_status TEXT DEFAULT 'synced',
        action TEXT DEFAULT 'none',
        UNIQUE(chamber_id, client_name) ON CONFLICT REPLACE
      );
    `);

    // 2. Drop inspections queue table if it contains deprecated columns or old UNIQUE constraint to force clean schema update
    try {
      const tableInfo = db.getAllSync("PRAGMA table_info(local_inspections);");
      const hasOldTemp = tableInfo.some(col => col.name === 'temperature');
      const hasOldName = tableInfo.some(col => col.name === 'operator_name');
      const hasOldTime = tableInfo.some(col => col.name === 'entry_time');
      const hasOldPhoto = tableInfo.some(col => col.name === 'photo_uri');
      const hasCreatedAt = tableInfo.length > 0 && tableInfo.some(col => col.name === 'created_at');
      
      const sqlSchema = db.getAllSync("SELECT sql FROM sqlite_master WHERE type='table' AND name='local_inspections';");
      const hasOldUnique = sqlSchema.length > 0 && !sqlSchema[0].sql.includes('UNIQUE(entry_date, chamber_id, client_name, inspection_time)');

      if (hasOldTemp || hasOldUnique || hasOldName || hasOldTime || hasOldPhoto || (tableInfo.length > 0 && !hasCreatedAt)) {
        console.log('🧹 SQLite: Old column names or missing created_at detected. Dropping table local_inspections for clean schema migration.');
        db.execSync('DROP TABLE IF EXISTS local_inspections;');
      }
    } catch (err) {
      // Ignored if table doesn't exist yet
    }

    // Create inspections queue table
    db.execSync(`
      CREATE TABLE IF NOT EXISTS local_inspections (
        id TEXT PRIMARY KEY,
        monitor_supervisor_name TEXT NOT NULL,
        chamber_id INTEGER NOT NULL,
        chamber_name TEXT NOT NULL,
        client_name TEXT NOT NULL,
        box_temp REAL NOT NULL,
        temp_sensor_image TEXT NOT NULL,
        entry_date TEXT NOT NULL,
        inspection_time TEXT NOT NULL,
        box_count INTEGER,
        chamber_type TEXT,
        overdue_time TEXT DEFAULT 'same day',
        photo_capture_time TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        shift TEXT DEFAULT 'Morning',
        reference_no TEXT,
        server_log_id INTEGER,
        created_at TEXT DEFAULT NULL,
        updated_at TEXT DEFAULT NULL,
        UNIQUE(entry_date, chamber_id, client_name, inspection_time) ON CONFLICT FAIL
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

    // Server id from daily_chamber_temp_logs (needed for Super Admin edit permission)
    try {
      db.execSync(`ALTER TABLE local_inspections ADD COLUMN server_log_id INTEGER;`);
      console.log('🌱 SQLite: Added server_log_id column to local_inspections.');
    } catch (err) {}

    try {
      db.execSync(`ALTER TABLE local_inspections ADD COLUMN updated_at TEXT DEFAULT NULL;`);
      console.log('🌱 SQLite: Added updated_at column to local_inspections.');
    } catch (err) {}

    // Suggestion pool + defaults used when seeding empty chambers
    db.execSync(`
      CREATE TABLE IF NOT EXISTS client_lot_master (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const DEFAULT_LOTS = [
      'Reliance Fresh',
      'BigBasket Cold',
      'Mother Dairy',
      'Amul Logistics',
      'ITC Foods Lot',
      'FreshToHome',
      'Licious Cold Chain',
      'Amazon Fresh Lot'
    ];
    for (const name of DEFAULT_LOTS) {
      try {
        db.runSync(
          'INSERT OR IGNORE INTO client_lot_master (client_name) VALUES (?);',
          [name]
        );
      } catch (_) {}
    }
    
    console.log('✅ SQLite Database Tables initialized successfully.');
  } catch (error) {
    console.error('❌ Failed to initialize SQLite database tables:', error);
  }
};

/** Default seeded client lot names (also in client_lot_master). */
export const DEFAULT_CLIENT_LOT_MASTER = [
  'Reliance Fresh',
  'BigBasket Cold',
  'Mother Dairy',
  'Amul Logistics',
  'ITC Foods Lot',
  'FreshToHome',
  'Licious Cold Chain',
  'Amazon Fresh Lot'
];

/**
 * Returns suggestion names for the add-client picker (not forced onto chambers).
 */
export const getClientLotMaster = () => {
  if (!db) return [...DEFAULT_CLIENT_LOT_MASTER];
  try {
    const rows = db.getAllSync(
      "SELECT client_name FROM client_lot_master ORDER BY client_name COLLATE NOCASE ASC;"
    );
    const names = (rows || []).map((r) => r.client_name).filter(Boolean);
    // Prefer DB suggestions; fall back to defaults for quick-pick UI only
    const merged = [...names];
    DEFAULT_CLIENT_LOT_MASTER.forEach((n) => {
      if (!merged.some((x) => x.toLowerCase() === n.toLowerCase())) merged.push(n);
    });
    return merged;
  } catch (error) {
    console.error('❌ Failed to read client lot master:', error);
    return [...DEFAULT_CLIENT_LOT_MASTER];
  }
};

/**
 * Adds a client name to the shared client lot master (appears in all chamber dropdowns).
 * @returns {boolean} true if inserted or already present
 */
export const addClientLotMaster = (clientName) => {
  if (!db) return false;
  const name = String(clientName || '').trim();
  if (!name) return false;
  try {
    db.runSync(
      "INSERT OR IGNORE INTO client_lot_master (client_name) VALUES (?);",
      [name]
    );
    console.log(`🌱 Client lot master: ensured "${name}"`);
    return true;
  } catch (error) {
    console.error('❌ Failed to add client lot master:', error);
    return false;
  }
};

/**
 * Caches the client assignments retrieved from the server.
 * @param {Array} assignments - Array of client assignments [{ chamber_id, chamber_name, client_name }]
 */
export const cacheAssignments = (assignments) => {
  if (!db) return;
  try {
    // Preserve pending assignments
    const pending = db.getAllSync("SELECT * FROM local_assignments WHERE sync_status = 'pending';");
    
    // Start transaction to clear and reload assignments
    db.execSync('DELETE FROM local_assignments;');
    
    for (const item of assignments) {
      db.runSync(
        "INSERT INTO local_assignments (chamber_id, chamber_name, client_name, sync_status, action) VALUES (?, ?, ?, 'synced', 'none');",
        [item.chamber_id, item.chamber_name, item.client_name]
      );
    }

    // Re-insert pending assignments
    for (const item of pending) {
      if (item.action === 'add') {
        db.runSync(
          "INSERT OR REPLACE INTO local_assignments (chamber_id, chamber_name, client_name, remark, status, sync_status, action) VALUES (?, ?, ?, ?, 'active', 'pending', 'add');",
          [item.chamber_id, item.chamber_name, item.client_name, item.remark]
        );
      } else if (item.action === 'delete') {
        db.runSync(
          "INSERT OR REPLACE INTO local_assignments (chamber_id, chamber_name, client_name, remark, status, sync_status, action) VALUES (?, ?, ?, ?, 'inactive', 'pending', 'delete');",
          [item.chamber_id, item.chamber_name, item.client_name, item.remark]
        );
      }
    }
    console.log('🌱 Successfully cached assignments locally in SQLite (preserved pending).');
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
      (id, monitor_supervisor_name, chamber_id, chamber_name, client_name, box_temp, temp_sensor_image, entry_date, inspection_time, box_count, chamber_type, overdue_time, photo_capture_time, sync_status, shift, created_at) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?);`,
      [
        log.id,
        log.monitor_supervisor_name,
        parseInt(log.chamber_id),
        log.chamber_name,
        log.client_name,
        parseFloat(log.box_temp),
        log.temp_sensor_image,
        log.entry_date,
        log.inspection_time,
        log.box_count !== undefined && log.box_count !== null ? parseInt(log.box_count) : null,
        log.chamber_type || 'Frozen',
        log.overdue_time || 'same day',
        log.photo_capture_time || null,
        log.shift || 'Morning',
        log.created_at || null
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
      'SELECT COUNT(*) as count FROM local_inspections WHERE entry_date = ? AND chamber_id = ? AND client_name = ? AND inspection_time = ?;',
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
      return db.getAllSync(
        "SELECT * FROM local_inspections WHERE sync_status = 'pending' AND monitor_supervisor_name = ? ORDER BY entry_date DESC, COALESCE(updated_at, created_at) DESC, id DESC;",
        [operatorName]
      );
    }
    return db.getAllSync(
      "SELECT * FROM local_inspections WHERE sync_status = 'pending' ORDER BY entry_date DESC, COALESCE(updated_at, created_at) DESC, id DESC;"
    );
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
      return db.getAllSync(
        "SELECT * FROM local_inspections WHERE entry_date = ? AND monitor_supervisor_name = ? ORDER BY COALESCE(updated_at, created_at) DESC, id DESC;",
        [date, operatorName]
      );
    }
    return db.getAllSync(
      "SELECT * FROM local_inspections WHERE entry_date = ? ORDER BY COALESCE(updated_at, created_at) DESC, id DESC;",
      [date]
    );
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
      return db.getAllSync(
        "SELECT * FROM local_inspections WHERE monitor_supervisor_name = ? ORDER BY entry_date DESC, COALESCE(updated_at, created_at) DESC, id DESC;",
        [operatorName]
      );
    }
    return db.getAllSync(
      "SELECT * FROM local_inspections ORDER BY entry_date DESC, COALESCE(updated_at, created_at) DESC, id DESC;"
    );
  } catch (error) {
    console.error('❌ Failed to fetch all inspections:', error);
    return [];
  }
};


/**
 * Marks a queued inspection as synced in the local database.
 * @param {string} id - Local Log ID
 * @param {string} referenceNo - Server reference number
 * @param {number|string|null} serverLogId - Server daily_chamber_temp_logs.id
 */
export const markInspectionAsSynced = (id, referenceNo, serverLogId = null) => {
  if (!db) return;
  try {
    db.runSync(
      "UPDATE local_inspections SET sync_status = 'synced', reference_no = ?, server_log_id = COALESCE(?, server_log_id) WHERE id = ?;",
      [referenceNo || null, serverLogId != null ? parseInt(serverLogId, 10) : null, id]
    );
    console.log(`🚀 Marked inspection ${id} as SYNCED with Ref: ${referenceNo}, server_log_id: ${serverLogId} in local SQLite.`);
  } catch (error) {
    console.error('❌ Failed to mark inspection as synced:', error);
  }
};

/**
 * Updates an existing local inspection after Super Admin approved edit.
 */
export const updateInspectionLocally = (localId, updates = {}) => {
  if (!db || !localId) return false;
  try {
    db.runSync(
      `UPDATE local_inspections SET
        box_temp = COALESCE(?, box_temp),
        box_count = COALESCE(?, box_count),
        temp_sensor_image = COALESCE(?, temp_sensor_image),
        photo_capture_time = COALESCE(?, photo_capture_time),
        chamber_type = COALESCE(?, chamber_type),
        inspection_time = COALESCE(?, inspection_time),
        updated_at = COALESCE(?, updated_at),
        sync_status = COALESCE(?, sync_status)
      WHERE id = ?;`,
      [
        updates.box_temp != null ? parseFloat(updates.box_temp) : null,
        updates.box_count != null ? parseInt(updates.box_count, 10) : null,
        updates.temp_sensor_image || null,
        updates.photo_capture_time || null,
        updates.chamber_type || null,
        updates.inspection_time || null,
        updates.updated_at || null,
        updates.sync_status || null,
        localId
      ]
    );
    return true;
  } catch (error) {
    console.error('❌ Failed to update local inspection:', error);
    return false;
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
      "INSERT OR REPLACE INTO local_assignments (chamber_id, chamber_name, client_name, remark, status, sync_status, action) VALUES (?, ?, ?, ?, 'active', 'pending', 'add');",
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
 * For each chamber with no active clients yet, seed the default client master list.
 * After that, DO customizes per chamber (add/edit/delete) and those changes stick.
 * @returns {number} how many client rows inserted
 */
export const seedDefaultClientsForEmptyChambers = (chambers) => {
  if (!db || !Array.isArray(chambers) || !chambers.length) return 0;
  let added = 0;
  for (const ch of chambers) {
    if (ch?.id == null) continue;
    const cid = parseInt(ch.id, 10);
    if (!Number.isFinite(cid)) continue;
    try {
      const rows = db.getAllSync(
        `SELECT client_name FROM local_assignments
         WHERE chamber_id = ? AND (status IS NULL OR status = 'active')
         LIMIT 1;`,
        [cid]
      );
      if (rows && rows.length > 0) continue;

      const chamberName = ch.name || `Chamber ${cid}`;
      for (const name of DEFAULT_CLIENT_LOT_MASTER) {
        try {
          db.runSync(
            `INSERT OR REPLACE INTO local_assignments
             (chamber_id, chamber_name, client_name, remark, status, sync_status, action)
             VALUES (?, ?, ?, ?, 'active', 'pending', 'add');`,
            [cid, chamberName, name, 'Default client master']
          );
          added += 1;
        } catch (_) {}
      }
    } catch (err) {
      console.warn('⚠️ seedDefaultClientsForEmptyChambers failed for chamber', cid, err?.message || err);
    }
  }
  if (added > 0) {
    console.log(`🌱 Seeded ${added} default client master row(s) on empty chambers.`);
  }
  return added;
};

/**
 * One-time cleanup: remove auto-seeded "Master client lot" rows so each chamber
 * only keeps clients the DO explicitly manages.
 */
export const purgeAutoSeededMasterLotsOnce = () => {
  if (!db) return 0;
  try {
    const result = db.runSync(
      "DELETE FROM local_assignments WHERE remark = ?;",
      ['Master client lot']
    );
    const n = result?.changes || 0;
    if (n > 0) console.log(`🧹 Purged ${n} auto-seeded chamber client lots.`);
    return n;
  } catch (error) {
    console.error('❌ Failed to purge auto-seeded lots:', error);
    return 0;
  }
};

/**
 * Renames a client assignment on one chamber only (edit client master for that chamber).
 */
export const renameLocalAssignment = (chamberId, chamberName, oldClientName, newClientName) => {
  if (!db) return false;
  const oldName = String(oldClientName || '').trim();
  const newName = String(newClientName || '').trim();
  if (!oldName || !newName) return false;
  if (oldName.toLowerCase() === newName.toLowerCase()) return true;
  try {
    const cid = parseInt(chamberId, 10);
    const dup = db.getFirstSync(
      "SELECT id FROM local_assignments WHERE chamber_id = ? AND LOWER(client_name) = LOWER(?) AND (status IS NULL OR status = 'active') LIMIT 1;",
      [cid, newName]
    );
    if (dup) return false;

    const row = db.getFirstSync(
      "SELECT * FROM local_assignments WHERE chamber_id = ? AND LOWER(client_name) = LOWER(?) LIMIT 1;",
      [cid, oldName]
    );
    if (!row) return false;

    if (row.sync_status === 'pending' && row.action === 'add') {
      db.runSync(
        "UPDATE local_assignments SET client_name = ?, chamber_name = COALESCE(?, chamber_name) WHERE chamber_id = ? AND LOWER(client_name) = LOWER(?);",
        [newName, chamberName || null, cid, oldName]
      );
    } else {
      // Soft-delete old + pending add new (sync-friendly rename)
      db.runSync(
        "UPDATE local_assignments SET status = 'inactive', remark = ?, sync_status = 'pending', action = 'delete' WHERE chamber_id = ? AND LOWER(client_name) = LOWER(?);",
        [`Renamed to ${newName}`, cid, oldName]
      );
      db.runSync(
        "INSERT OR REPLACE INTO local_assignments (chamber_id, chamber_name, client_name, remark, status, sync_status, action) VALUES (?, ?, ?, ?, 'active', 'pending', 'add');",
        [cid, chamberName || row.chamber_name, newName, `Renamed from ${oldName}`]
      );
    }
    console.log(`✏️ Renamed client on chamber ${cid}: "${oldName}" → "${newName}"`);
    return true;
  } catch (error) {
    console.error('❌ Failed to rename local assignment:', error);
    return false;
  }
};

/**
 * Deletes a client assignment locally by marking it inactive with a deletion remark.
 */
export const deleteLocalAssignment = (chamberId, clientName, remark) => {
  if (!db) return false;
  try {
    // Check if the assignment exists and was already synced
    const row = db.getFirstSync("SELECT * FROM local_assignments WHERE chamber_id = ? AND client_name = ? LIMIT 1;", [parseInt(chamberId), clientName]);
    
    if (row && row.sync_status === 'pending' && row.action === 'add') {
      // If it was just added locally and not yet synced, we can delete it directly!
      db.runSync(
        "DELETE FROM local_assignments WHERE chamber_id = ? AND client_name = ?;",
        [parseInt(chamberId), clientName]
      );
      console.log(`🗑️ Deleted local pending assignment: ${clientName} from chamber ${chamberId}`);
    } else {
      // Otherwise mark it inactive and pending deletion sync
      db.runSync(
        "UPDATE local_assignments SET status = 'inactive', remark = ?, sync_status = 'pending', action = 'delete' WHERE chamber_id = ? AND client_name = ?;",
        [remark || '', parseInt(chamberId), clientName]
      );
      console.log(`➖ Soft-deleted client assignment for sync: ${clientName} from chamber ${chamberId}`);
    }
    return true;
  } catch (error) {
    console.error('❌ Failed to soft-delete local assignment:', error);
    return false;
  }
};

/**
 * Fetches all local client assignments pending sync.
 */
export const getPendingAssignments = () => {
  if (!db) return [];
  try {
    return db.getAllSync("SELECT * FROM local_assignments WHERE sync_status = 'pending';");
  } catch (error) {
    console.error('❌ Failed to fetch pending assignments:', error);
    return [];
  }
};

/**
 * Marks a queued client assignment as synced or deletes it if it was a deletion request.
 */
export const markAssignmentSynced = (chamberId, clientName, action) => {
  if (!db) return;
  try {
    if (action === 'delete') {
      db.runSync(
        "DELETE FROM local_assignments WHERE chamber_id = ? AND client_name = ?;",
        [parseInt(chamberId), clientName]
      );
      console.log(`🚀 Cleaned up synced deletion assignment: ${clientName} in Chamber ${chamberId}`);
    } else {
      db.runSync(
        "UPDATE local_assignments SET sync_status = 'synced', action = 'none' WHERE chamber_id = ? AND client_name = ?;",
        [parseInt(chamberId), clientName]
      );
      console.log(`🚀 Marked assignment synced: ${clientName} in Chamber ${chamberId}`);
    }
  } catch (error) {
    console.error('❌ Failed to mark assignment synced:', error);
  }
};
