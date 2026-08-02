import NetInfo from '@react-native-community/netinfo';
import { getPendingInspections, markInspectionAsSynced } from '../database/db';

let isSyncing = false;

/**
 * Triggers the upload of all pending offline inspections in the local SQLite database.
 * @param {string} apiBaseUrl - The backend API base URL
 * @param {string} token - The active user authorization JWT token
 * @param {function} onSyncProgress - Optional callback to notify UI of sync status updates
 */
export const triggerSync = async (apiBaseUrl, token, onSyncProgress = () => {}) => {
  if (isSyncing) return;
  isSyncing = true;
  onSyncProgress('syncing');

  try {
    const pendingInspections = getPendingInspections();
    if (pendingInspections.length === 0) {
      console.log('🔄 No pending inspections to sync.');
      isSyncing = false;
      onSyncProgress('idle');
      return;
    }

    console.log(`📶 Sync Engine: Found ${pendingInspections.length} pending logs to sync...`);

    for (const log of pendingInspections) {
      try {
        const formData = new FormData();
        
        // Append text fields
        formData.append('operator_name', log.operator_name);
        formData.append('chamber_id', log.chamber_id.toString());
        formData.append('client_name', log.client_name);
        formData.append('entry_date', log.entry_date);
        formData.append('entry_time', log.entry_time);
        formData.append('box_temp', log.box_temp.toString());
        if (log.box_count !== undefined && log.box_count !== null) {
          formData.append('box_count', log.box_count.toString());
        }
        if (log.chamber_type) {
          formData.append('chamber_type', log.chamber_type);
        }
        if (log.overdue_time) {
          formData.append('overdue_time', log.overdue_time);
        }

        // Append photo file
        if (log.photo_uri) {
          const filename = log.photo_uri.split('/').pop() || `inspection-${log.id}.jpg`;
          formData.append('sensor_photo', {
            uri: log.photo_uri,
            name: filename,
            type: 'image/jpeg'
          });
        }

        // Send multi-part POST request to backend API
        const response = await fetch(`${apiBaseUrl}/api/chambers/inspections`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
          },
          body: formData
        });

        const resData = await response.json();

        // 201 Created or 200 OK means sync successful
        if (response.status === 200 || response.status === 201) {
          markInspectionAsSynced(log.id);
        } 
        // 409 Conflict means duplicate entry exists on backend; mark synced locally so queue is not blocked
        else if (response.status === 409) {
          console.warn(`⚠️ Sync Warning: Duplicate found on server. Clearing log ID: ${log.id}`);
          markInspectionAsSynced(log.id);
        } else {
          throw new Error(resData.message || 'Sync request failed with status ' + response.status);
        }
      } catch (err) {
        console.error(`❌ Sync failed for log ${log.id}:`, err.message || err);
        // Halt queue upload on connection/server errors to try again later
        break;
      }
    }
  } catch (error) {
    console.error('❌ Sync Engine encountered an error:', error);
  } finally {
    isSyncing = false;
    onSyncProgress('idle');
  }
};

/**
 * Subscribes to network status updates using NetInfo.
 * Automatically triggers sync when transitioning from Offline ➔ Online.
 */
export const subscribeToSync = (apiBaseUrl, token, onSyncProgress = () => {}) => {
  return NetInfo.addEventListener(state => {
    const isOnline = state.isConnected && state.isInternetReachable !== false;
    if (isOnline) {
      console.log('📶 NetInfo: Network online. Triggering synchronization.');
      triggerSync(apiBaseUrl, token, onSyncProgress);
    }
  });
};
