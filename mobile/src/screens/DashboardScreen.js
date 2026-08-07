import React, { useState, useEffect, useMemo } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  Modal,
  TextInput,
  Alert,
  StatusBar,
  SafeAreaView,
  useWindowDimensions,
  Platform,
  Image,
  ActivityIndicator,
  RefreshControl,
  Animated
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

// SQLite database and Sync Engine imports
import { 
  initDatabase, 
  cacheAssignments, 
  getLocalAssignments, 
  saveInspectionLocally, 
  checkDuplicateInspection,
  getPendingInspections,
  getTodaysInspections,
  getAllLocalInspections,
  deleteInspectionLocally,
  updateInspectionLocally,
  addLocalAssignment,
  deleteLocalAssignment,
  renameLocalAssignment,
  purgeAutoSeededMasterLotsOnce,
  getClientLotMaster,
  addClientLotMaster,
  DEFAULT_CLIENT_LOT_MASTER
} from '../database/db';
import { subscribeToSync, triggerSync } from '../services/syncEngine';

// Configure Notifications Handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export default function DashboardScreen({ user, token, apiUrl, onLogout, onUserUpdate }) {
  const displayName = user.full_name || user.email || 'Data Operator';
  const [chamberLimitOverride, setChamberLimitOverride] = useState(null);
  const chamberLimit = Math.max(
    1,
    parseInt(chamberLimitOverride ?? user?.chamber_limit ?? 4, 10) || 4
  );

  const persistChamberLimit = async (nextLimit) => {
    const n = parseInt(nextLimit, 10);
    if (!Number.isFinite(n) || n < 1) return;
    setChamberLimitOverride(n);
    try {
      const nextUser = { ...(user || {}), chamber_limit: n };
      await AsyncStorage.setItem('user_profile', JSON.stringify(nextUser));
      if (typeof onUserUpdate === 'function') onUserUpdate(nextUser);
    } catch (_) {}
  };

  /** Shared suggestion names for Add Client picker (not auto-forced on chambers). */
  const [masterClientLots, setMasterClientLots] = useState(() => [...DEFAULT_CLIENT_LOT_MASTER]);
  const [editingClientName, setEditingClientName] = useState(null); // { chamberId, oldName }
  const [editClientDraft, setEditClientDraft] = useState('');

  const refreshMasterClientLots = () => {
    try {
      setMasterClientLots(getClientLotMaster());
    } catch (_) {
      setMasterClientLots([...DEFAULT_CLIENT_LOT_MASTER]);
    }
  };

  /** Remember typed name as a future suggestion; does NOT assign to other chambers. */
  const ensureClientInLotMaster = (rawName) => {
    const name = String(rawName || '').trim();
    if (!name) return '';
    addClientLotMaster(name);
    refreshMasterClientLots();
    return name;
  };

  /** Clients assigned to one chamber only (source of truth for dropdowns / tasks). */
  const getClientsForChamber = (chamberId, list = assignments) => {
    if (chamberId == null) return [];
    return (list || []).filter(
      (a) =>
        Number(a.chamber_id) === Number(chamberId) &&
        a.status !== 'inactive' &&
        String(a.client_name || '').trim() &&
        String(a.client_name).toLowerCase() !== 'general'
    );
  };

  const refreshPermissionNotifications = async () => {
    if (!apiUrl || !token) return [];
    try {
      const listRes = await fetch(`${apiUrl}/api/permission-requests?_=${Date.now()}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      });
      if (listRes.ok) {
        const listData = await listRes.json().catch(() => []);
        if (Array.isArray(listData)) {
          setPermissionNotifications(listData);
          return listData;
        }
      }
    } catch (_) {}
    return permissionNotifications;
  };

  /** Chamber completion target = Master Setup client count for that chamber. */
  const getChamberClientTarget = (chamberId) => {
    if (chamberId == null) return null;
    const n = getClientsForChamber(chamberId).length;
    return n >= 1 ? n : null;
  };

  /** Unique clients logged for chamber + shift on a date */
  const countLoggedClientsForChamber = (chamberId, shiftName, dateStr, logs = completedLogs) => {
    const names = new Set();
    (logs || []).forEach((l) => {
      if (Number(l.chamber_id) !== Number(chamberId)) return;
      if (l.entry_date !== dateStr) return;
      let logShift = l.shift;
      if (logShift !== 'Morning' && logShift !== 'Evening') {
        if (l.inspection_time === '16:00' || String(l.inspection_time || '').startsWith('16')) {
          logShift = 'Evening';
        } else {
          logShift = 'Morning';
        }
      }
      if (logShift !== shiftName) return;
      if (l.client_name) names.add(String(l.client_name).toLowerCase());
    });
    return names.size;
  };

  /** Keep only first N chambers (same rule as Register DO chamber_limit). */
  const applyChamberLimit = (list) => {
    const rows = Array.isArray(list) ? [...list] : [];
    rows.sort((a, b) => {
      const na = parseInt((String(a.name || '').match(/\d+/) || [a.id])[0], 10);
      const nb = parseInt((String(b.name || '').match(/\d+/) || [b.id])[0], 10);
      return na - nb;
    });
    return rows.slice(0, chamberLimit);
  };

  /**
   * Tasks = only clients assigned to each chamber (chamber-wise master).
   * Does NOT inject global suggestion names onto every chamber.
   */
  const buildTasksForAssignedChambers = (chambers, rawAssignments) => {
    const chamberRows = Array.isArray(chambers) ? chambers : [];
    const allowedIds = new Set(chamberRows.map((c) => Number(c.id)));
    const active = (Array.isArray(rawAssignments) ? rawAssignments : []).filter(
      (a) =>
        a &&
        a.status !== 'inactive' &&
        allowedIds.has(Number(a.chamber_id)) &&
        String(a.client_name || '').trim() &&
        String(a.client_name).toLowerCase() !== 'general'
    );

    const chamberNameById = new Map(
      chamberRows.map((c) => [Number(c.id), c.name])
    );

    const merged = active.map((a) => ({
      ...a,
      chamber_name: a.chamber_name || chamberNameById.get(Number(a.chamber_id)) || `Chamber ${a.chamber_id}`
    }));

    merged.sort((a, b) => {
      const na = parseInt((String(a.chamber_name || '').match(/\d+/) || [a.chamber_id])[0], 10);
      const nb = parseInt((String(b.chamber_name || '').match(/\d+/) || [b.chamber_id])[0], 10);
      if (na !== nb) return na - nb;
      return String(a.client_name || '').localeCompare(String(b.client_name || ''));
    });
    return merged;
  };

  const reportDOActivity = async (action, description, remark = '') => {
    try {
      if (!apiUrl || !token) return;
      const desc = String(description || '').trim();
      if (!action || !desc) return;
      const remarkFromDesc = (desc.match(/(?:Remark|Remarks?)\s*:\s*(.+)$/im) || [])[1];
      const resolvedRemark = String(remark || remarkFromDesc || '').trim() || null;
      await fetch(`${apiUrl}/api/operator-activities`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        },
        body: JSON.stringify({
          action,
          logType: [
            'ADD_CLIENT',
            'DELETE_CLIENT',
            'UPDATE_CLIENT',
            'ADD_CHAMBER',
            'DELETE_CHAMBER'
          ].includes(String(action))
            ? 'DO_CHANGE'
            : 'activity',
          description: desc,
          remark: resolvedRemark
        })
      });
    } catch (err) {
      console.warn('⚠️ Failed to report operator activity to backend:', err.message);
    }
  };

  // Navigation Tab State: 'Dashboard' | 'Tasks' | 'Reports' | 'More'
  const [currentNavTab, setCurrentNavTab] = useState('Dashboard');

  // Sub-filter tabs inside Dashboard / Tasks: 'All' | 'Pending' | 'Completed' | 'Failed'
  const [activeTab, setActiveTab] = useState('All'); 

  // DateTime Display States
  const [currentTime, setCurrentTime] = useState('');
  const [currentDateStr, setCurrentDateStr] = useState('');
  const [currentDayStr, setCurrentDayStr] = useState('');

  // View state managers
  const [selectedChamber, setSelectedChamber] = useState(null); // Tapped chamber context
  const [showLogModal, setShowLogModal] = useState(false);
  const [selectedClient, setSelectedClient] = useState(null); // Active client log context
  const [openedFromFab, setOpenedFromFab] = useState(false); // Opened from the central '+' button
  const [isProfileEditable, setIsProfileEditable] = useState(true); // Edit vs Read-only toggle
  const [reportSearchQuery, setReportSearchQuery] = useState('');
  const [reportChamberFilter, setReportChamberFilter] = useState('all'); // 'all' | chamber_id
  const [reportClientFilter, setReportClientFilter] = useState('all'); // 'all' | client_name
  const [reportShiftFilter, setReportShiftFilter] = useState('all'); // 'all' | 'Morning' | 'Evening'
  const [showReportChamberDropdown, setShowReportChamberDropdown] = useState(false);
  const [showReportClientDropdown, setShowReportClientDropdown] = useState(false);
  const [editingExistingLog, setEditingExistingLog] = useState(null); // local completed log being edited after SA approval
  const [updateTimeInput, setUpdateTimeInput] = useState(''); // HH:mm on edit form → saved as inspection_time + updated_at
  const [permissionModal, setPermissionModal] = useState({
    isOpen: false,
    status: 'None',
    log: null,
    taskItem: null,
    loading: false
  });
  const [permissionRequestBusy, setPermissionRequestBusy] = useState(false);
  const [permissionNotifications, setPermissionNotifications] = useState([]);
  
  // Completed Log Metadata for read-only view
  const [logOperatorName, setLogOperatorName] = useState('');
  const [logSyncStatus, setLogSyncStatus] = useState('');
  const [logEntryTime, setLogEntryTime] = useState('');
  const [logShift, setLogShift] = useState('');

  // Server URL is configured on Login screen only
  const [selectedShift, setSelectedShift] = useState('10:00');
  const [activeShift, setActiveShift] = useState(new Date().getHours() >= 16 ? 'Evening' : 'Morning');
  
  // Clicked tracking states for red notification
  const [morningClicked, setMorningClicked] = useState(activeShift === 'Morning');
  const [eveningClicked, setEveningClicked] = useState(activeShift === 'Evening');

  useEffect(() => {
    const loadClickedStates = async () => {
      try {
        const todayStr = new Date().toISOString().split('T')[0];
        const mKey = `@morning_clicked_${todayStr}`;
        const eKey = `@evening_clicked_${todayStr}`;
        
        const mVal = await AsyncStorage.getItem(mKey);
        const eVal = await AsyncStorage.getItem(eKey);
        
        if (mVal === 'true') {
          setMorningClicked(true);
        }
        if (eVal === 'true') {
          setEveningClicked(true);
        }
      } catch (err) {
        console.warn('Failed to load clicked states:', err);
      }
    };
    loadClickedStates();
  }, []);

  useEffect(() => {
    const initNotifications = async () => {
      try {
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;
        if (existingStatus !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }
        if (finalStatus !== 'granted') {
          console.warn('Notifications permission not granted.');
          return;
        }

        // Cancel previous schedules to prevent duplicates
        await Notifications.cancelAllScheduledNotificationsAsync();

        // Schedule Morning Task daily at 10:00 AM
        await Notifications.scheduleNotificationAsync({
          content: {
            title: "Morning Task Active! ☀️",
            body: "Today's Morning Task is active. Open the app to complete assignments.",
            sound: true,
          },
          trigger: {
            hour: 10,
            minute: 0,
            repeats: true,
          },
        });

        // Schedule Evening Task daily at 4:00 PM (16:00)
        await Notifications.scheduleNotificationAsync({
          content: {
            title: "Evening Task Active! 🌙",
            body: "Today's Evening Task is active. Open the app to complete assignments.",
            sound: true,
          },
          trigger: {
            hour: 16,
            minute: 0,
            repeats: true,
          },
        });

        console.log('🔔 Offline daily task notifications scheduled successfully!');
      } catch (err) {
        console.warn('Failed to configure notifications:', err);
      }
    };

    initNotifications();
  }, []);

  const handleSelectShift = async (shift) => {
    setActiveShift(shift);
    const todayStr = new Date().toISOString().split('T')[0];
    if (shift === 'Morning') {
      setMorningClicked(true);
      try {
        await AsyncStorage.setItem(`@morning_clicked_${todayStr}`, 'true');
      } catch (err) {
        console.warn(err);
      }
    } else if (shift === 'Evening') {
      setEveningClicked(true);
      try {
        await AsyncStorage.setItem(`@evening_clicked_${todayStr}`, 'true');
      } catch (err) {
        console.warn(err);
      }
    }
  };
  
  // Inputs & captures state
  const [tempInput, setTempInput] = useState('');
  const [boxCountInput, setBoxCountInput] = useState('');
  const [capturedImage, setCapturedImage] = useState(null);
  const [capturedImageTimestamp, setCapturedImageTimestamp] = useState(null);
  const [showSubmitConfirmModal, setShowSubmitConfirmModal] = useState(false);
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [showDrawer, setShowDrawer] = useState(false);
  const drawerAnim = React.useRef(new Animated.Value(-280)).current;

  useEffect(() => {
    if (showDrawer) {
      Animated.timing(drawerAnim, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }).start();
    }
  }, [showDrawer]);

  const closeDrawer = () => {
    Animated.timing(drawerAnim, {
      toValue: -280,
      duration: 200,
      useNativeDriver: true,
    }).start(() => {
      setShowDrawer(false);
    });
  };
  const [selectedReportDate, setSelectedReportDate] = useState(new Date().toISOString().split('T')[0]);
  const [reportDateFrom, setReportDateFrom] = useState(new Date().toISOString().split('T')[0]);
  const [reportDateTo, setReportDateTo] = useState(new Date().toISOString().split('T')[0]);
  const [calendarPickMode, setCalendarPickMode] = useState('from'); // 'from' | 'to'
  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [showInventoryModal, setShowInventoryModal] = useState(false);
  const [selectedInventoryItem, setSelectedInventoryItem] = useState(null);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showNotificationsModal, setShowNotificationsModal] = useState(false);
  const [inventoryClientSearch, setInventoryClientSearch] = useState('');
  const [inventoryChamberSearch, setInventoryChamberSearch] = useState('');
  const [showInventoryClientDropdown, setShowInventoryClientDropdown] = useState(false);
  const [showInventoryChamberDropdown, setShowInventoryChamberDropdown] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [showClientDropdown, setShowClientDropdown] = useState(false);
  const [showChamberDropdown, setShowChamberDropdown] = useState(false);
  const [showAddClientModal, setShowAddClientModal] = useState(false);
  const [showAddChamberModal, setShowAddChamberModal] = useState(false);
  const [addChamberNameInput, setAddChamberNameInput] = useState('');
  const [addChamberRemarkInput, setAddChamberRemarkInput] = useState('');
  const [addChamberBusy, setAddChamberBusy] = useState(false);
  const [inlineClientInput, setInlineClientInput] = useState('');
  const [inlineRemarkInput, setInlineRemarkInput] = useState('');
  const [selectedChamberType, setSelectedChamberType] = useState('Frozen');
  
  // Custom Client Deletion Reason Modal States
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState(false);
  const [clientToDelete, setClientToDelete] = useState(null);
  const [deleteRemarkInput, setDeleteRemarkInput] = useState('');
  
  // Client Master Manager Modal States
  const [showClientManagerModal, setShowClientManagerModal] = useState(false);
  const [managerSelectedChamber, setManagerSelectedChamber] = useState(null);
  const [masterManagerTab, setMasterManagerTab] = useState('chambers'); // 'chambers' | 'clients'
  const [showManagerChamberDropdown, setShowManagerChamberDropdown] = useState(false);
  const [showClientSuggestions, setShowClientSuggestions] = useState(false);
  const [newClientInput, setNewClientInput] = useState('');
  const [newChamberNameInput, setNewChamberNameInput] = useState('');
  const [masterAccessLoading, setMasterAccessLoading] = useState(false);

  const masterRecordId = user?.id || 1;  
  // Data lists loaded from DB
  const [chambersList, setChambersList] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [completedLogs, setCompletedLogs] = useState([]); // Today's completed log entries (synced + unsynced)
  const [unsyncedLogs, setUnsyncedLogs] = useState([]); // Offline queue logs (only unsynced)
  const [pendingCount, setPendingCount] = useState(0);
  const [selectedTaskDueDate, setSelectedTaskDueDate] = useState('');
  const [overdueTasks, setOverdueTasks] = useState([]);
  const [overdueCount, setOverdueCount] = useState(0);
  const [syncStatus, setSyncStatus] = useState('idle'); // 'idle' | 'syncing'
  const [refreshing, setRefreshing] = useState(false);

  /** True when every Master Setup client on every chamber is logged for this shift today. */
  const isShiftFullyCompleted = (shiftName) => {
    const todayStr = new Date().toISOString().split('T')[0];
    const chambersWithClients = (chambersList || []).filter(
      (ch) => getClientsForChamber(ch.id).length > 0
    );
    if (chambersWithClients.length === 0) return false;

    return chambersWithClients.every((ch) => {
      const clients = getClientsForChamber(ch.id);
      const done = countLoggedClientsForChamber(ch.id, shiftName, todayStr);
      return done >= clients.length;
    });
  };

  const isMorningCompleted = useMemo(
    () => isShiftFullyCompleted('Morning'),
    [assignments, completedLogs, chambersList]
  );

  const isEveningCompleted = useMemo(
    () => isShiftFullyCompleted('Evening'),
    [assignments, completedLogs, chambersList]
  );

  const completedChambersCount = useMemo(() => {
    const todayStr = new Date().toISOString().split('T')[0];
    return chambersList.filter((chamber) => {
      const target = getChamberClientTarget(chamber.id);
      if (target == null) return false;
      const done = countLoggedClientsForChamber(chamber.id, activeShift, todayStr);
      return done >= target;
    }).length;
  }, [chambersList, completedLogs, activeShift, assignments]);

  const getActiveTasksDetails = () => {
    const isEveningUnlocked = new Date().getHours() >= 16;
    const activeAssignments = assignments.filter(item => item.status !== 'inactive');
    const todayStr = new Date().toISOString().split('T')[0];
    
    // For Morning tasks
    const completedMorningLogs = completedLogs.filter(log => log.shift === 'Morning' && log.entry_date === todayStr);
    const pendingMorning = activeAssignments.filter(task => 
      !completedMorningLogs.some(log => log.chamber_id === task.chamber_id && log.client_name === task.client_name)
    );

    // For Evening tasks
    const completedEveningLogs = completedLogs.filter(log => log.shift === 'Evening' && log.entry_date === todayStr);
    const pendingEvening = activeAssignments.filter(task => 
      !completedEveningLogs.some(log => log.chamber_id === task.chamber_id && log.client_name === task.client_name)
    );

    return {
      pendingMorning,
      pendingEvening,
      isEveningUnlocked
    };
  };

  // Auto-switch activeShift to Evening if Morning tasks are completed and Evening is unlocked
  useEffect(() => {
    const isEveningUnlocked = new Date().getHours() >= 16;
    if (isMorningCompleted && activeShift === 'Morning' && isEveningUnlocked) {
      setActiveShift('Evening');
    }
  }, [isMorningCompleted, activeShift]);

  // Dimensions
  const { width } = useWindowDimensions();
  const isTablet = width > 600;

  // 1. Ticking Time logic
  useEffect(() => {
    const updateDateTime = () => {
      const now = new Date();
      const day = String(now.getDate()).padStart(2, '0');
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const month = months[now.getMonth()];
      const year = now.getFullYear();
      setCurrentDateStr(`${day} ${month} ${year}`);

      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      setCurrentDayStr(days[now.getDay()]);

      const hoursStr = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      setCurrentTime(`${hoursStr}:${minutes}`);
    };

    updateDateTime();
    const timerInterval = setInterval(updateDateTime, 15000); // Update every 15s
    return () => clearInterval(timerInterval);
  }, []);

  // 2. Load Navigation Tab from Storage
  useEffect(() => {
    const loadNavTab = async () => {
      try {
        const savedTab = await AsyncStorage.getItem('active_mobile_nav_tab');
        if (savedTab) {
          setCurrentNavTab(savedTab);
        }
      } catch (e) {
        console.warn('Failed to load active navigation tab:', e);
      }
    };
    loadNavTab();
  }, []);

  // Handler to switch tabs and save in AsyncStorage
  const handleNavTabChange = async (tab) => {
    setCurrentNavTab(tab);
    try {
      await AsyncStorage.setItem('active_mobile_nav_tab', tab);
    } catch (e) {
      console.warn('Failed to save active navigation tab:', e);
    }
  };

  // Sync state update when prop changes — removed (IP config is on Login only)

  // Pre-select shift based on active shift filter when modal opens in editable mode
  useEffect(() => {
    if (showLogModal && isProfileEditable) {
      setSelectedShift(activeShift === 'Morning' ? '10:00' : '16:00');
    }
  }, [showLogModal, isProfileEditable, activeShift]);

  // Recalculate pending tasks count whenever activeShift, completedLogs or assignments change
  useEffect(() => {
    const todayStr = new Date().toISOString().split('T')[0];
    const targetShiftTime = activeShift === 'Morning' ? '10:00' : '16:00';
    const activeAssignmentsToday = assignments.filter(item => item.status !== 'inactive');

    const pendingTasksList = activeAssignmentsToday.filter(item => {
      // Check if this assignment has a completed log for today on the selected shift
      const log = completedLogs.find(l => 
        l.chamber_id === item.chamber_id && 
        l.client_name === item.client_name &&
        l.entry_date === todayStr &&
        l.inspection_time === targetShiftTime
      );
      const isCompleted = !!log;
      return !isCompleted;
    });
    
    setPendingCount(pendingTasksList.length);
  }, [activeShift, completedLogs, assignments]);

  // 3. Initialize SQLite DB and Sync Services
  useEffect(() => {
    initDatabase();
    refreshMasterClientLots();

    let unsubscribeSync = null;
    (async () => {
    // Force-clear demo clients so dashboard empty CTA shows (Expo Go SQLite cache)
    try {
      const purgedKey = 'purged_default_client_master_v3';
      const already = await AsyncStorage.getItem(purgedKey);
      const n = purgeAutoSeededMasterLotsOnce();
      if (!already) await AsyncStorage.setItem(purgedKey, '1');
      if (n > 0) console.log(`🧹 Cleared ${n} example client row(s) — DO will add chamber-wise.`);
    } catch (_) {}
    try {
      await AsyncStorage.removeItem('chamber_client_targets');
    } catch (_) {}

      unsubscribeSync = subscribeToSync(apiUrl, token, (status) => {
        setSyncStatus(status);
        loadInspectionsAndSummary();
      });

      await fetchAndLoadAssignments();
    })();

    return () => {
      if (unsubscribeSync) unsubscribeSync();
    };
  }, [apiUrl]);

  // Poll Super Admin permission decisions for notification bell
  useEffect(() => {
    if (!apiUrl || !token) return undefined;

    let cancelled = false;
    const loadPermissionNotifications = async () => {
      try {
        const res = await fetch(`${apiUrl}/api/permission-requests?_=${Date.now()}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json'
          }
        });
        if (!res.ok) return;
        const data = await res.json().catch(() => []);
        if (!cancelled && Array.isArray(data)) {
          setPermissionNotifications(data);
        }
      } catch (err) {
        // Keep last known list if offline
      }
    };

    loadPermissionNotifications();
    const timer = setInterval(loadPermissionNotifications, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [apiUrl, token]);

  const parsePermissionTaskMeta = (notif) => {
    const fromRequest = String(notif.request_description || '');
    const fromDesc = String(notif.description || '');
    const text = `${fromRequest} | ${fromDesc}`;

    const clientFromPipe = (text.match(/Client:\s*([^|]+)/i) || [])[1]?.trim();
    const chamberFromPipe = (text.match(/Chamber:\s*([^|]+)/i) || [])[1]?.trim();
    const shiftFromPipe = (text.match(/Shift:\s*([^|]+)/i) || [])[1]?.trim();

    let shift = notif.shift || shiftFromPipe || '';
    if (!shift) {
      if (/evening/i.test(text)) shift = 'Evening';
      else if (/morning/i.test(text)) shift = 'Morning';
    }
    if (shift && !/^Morning$|^Evening$/i.test(shift)) {
      shift = /evening/i.test(shift) ? 'Evening' : 'Morning';
    }

    return {
      chamber_id: notif.chamber_id != null ? Number(notif.chamber_id) : null,
      chamber_name: notif.chamber_name || chamberFromPipe || 'Chamber',
      client_name: notif.client_name || clientFromPipe || 'Client',
      shift: shift === 'Evening' ? 'Evening' : (shift === 'Morning' ? 'Morning' : null),
      entry_date: notif.entry_date || null,
      reference_no: notif.log_reference_no || null,
      record_id: notif.record_id
    };
  };

  const getActivePermissionAlerts = () =>
    permissionNotifications.filter(
      (n) =>
        !n.do_action_completed_at &&
        (n.status === 'Approved' || n.status === 'Denied') &&
        (n.record_type === 'Chamber' ||
          n.record_type === 'MasterSetup' ||
          n.record_type === 'ChamberMaster' ||
          n.record_type === 'ClientMaster')
    );

  const markPermissionNotificationComplete = async (notifId) => {
    if (!notifId || !apiUrl || !token) return;
    try {
      await fetch(`${apiUrl}/api/permission-requests/${notifId}/complete`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      });
      setPermissionNotifications((prev) =>
        prev.map((n) =>
          n.id === notifId
            ? { ...n, do_action_completed_at: new Date().toISOString() }
            : n
        )
      );
    } catch (err) {
      console.warn('Failed to mark permission notification complete:', err?.message || err);
    }
  };

  /** Plus / More → open Chambers & Clients master (add/delete chambers within limit). */
  const openMasterManager = (options = {}) => {
    const preferredChamber = options.chamber || null;
    const tab = options.tab === 'clients' || options.tab === 'chambers' ? options.tab : 'chambers';
    setManagerSelectedChamber(preferredChamber);
    setMasterManagerTab(tab);
    setShowManagerChamberDropdown(false);
    setShowClientSuggestions(false);
    setNewChamberNameInput('');
    setNewClientInput('');
    setEditingClientName(null);
    setEditClientDraft('');
    setShowClientManagerModal(true);
  };

  /** Open Master Setup → Clients tab for a chamber (dashboard empty-client CTA). */
  const openMasterSetupAddClients = (chamber = null) => {
    const target =
      chamber ||
      chambersList.find((c) => getClientsForChamber(c.id).length === 0) ||
      chambersList[0] ||
      null;
    openMasterManager({ chamber: target, tab: 'clients' });
  };

  /** Master Setup opens directly — no Super Admin allow gate */
  const openMasterManagerWithPermission = async () => {
    openMasterManager();
  };

  /** Stable INT for ChamberMaster ADD permission (must match backend). */
  const chamberAddPermissionId = (name) => {
    const s = `add|${String(name || '').trim().toLowerCase()}`;
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % 2000000000 || 1;
  };

  const openAddChamberPopup = () => {
    // Always open name + remark form; limit is checked when sending request
    const used = new Set(
      chambersList.map((c) => {
        const m = String(c.name || '').match(/^Chamber\s+(\d+)$/i);
        return m ? parseInt(m[1], 10) : null;
      }).filter((n) => n != null)
    );
    let nextNum = 1;
    while (used.has(nextNum) && nextNum <= chamberLimit) nextNum += 1;
    setAddChamberNameInput(chambersList.length >= chamberLimit ? '' : `Chamber ${nextNum}`);
    setAddChamberRemarkInput('');
    setShowAddChamberModal(true);
  };

  const executeChamberCreate = async (name, remark = '', notifIdToComplete = null, options = {}) => {
    if (!apiUrl || !token) {
      if (!options.silent) Alert.alert('Offline', 'Connect to server to add a chamber.');
      return false;
    }
    const chamberName = String(name || '').trim();
    if (!chamberName) {
      if (!options.silent) Alert.alert('Validation Error', 'Chamber name is required.');
      return false;
    }
    try {
      const res = await fetch(`${apiUrl}/api/chambers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ name: chamberName, remark: String(remark || '').trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Permission already used after SA approve — still refresh list from server
        if (res.status === 403) {
          await fetchAndLoadAssignments();
          if (notifIdToComplete) await markPermissionNotificationComplete(notifIdToComplete);
          if (!options.silent) {
            Alert.alert(
              'Chamber Updated',
              `"${chamberName}" should now appear in your chamber list.`
            );
          }
          return true;
        }
        throw new Error(data.message || data.error || 'Failed to add chamber');
      }

      if (data.chamber_limit != null) {
        await persistChamberLimit(data.chamber_limit);
      }

      try {
        const raw = await AsyncStorage.getItem('pending_chamber_adds');
        if (raw) {
          const map = JSON.parse(raw) || {};
          delete map[String(chamberAddPermissionId(chamberName))];
          await AsyncStorage.setItem('pending_chamber_adds', JSON.stringify(map));
        }
      } catch (_) {}

      await fetchAndLoadAssignments();
      if (data.data && !options.silent) {
        setManagerSelectedChamber(data.data);
        setMasterManagerTab('clients');
        setShowClientManagerModal(true);
      }
      if (notifIdToComplete) {
        await markPermissionNotificationComplete(notifIdToComplete);
      }
      if (!options.silent) {
        Alert.alert(
          'Chamber Added',
          `"${data.data?.name || chamberName}" is assigned. Tasks will use this chamber name with its client master.`
        );
      }
      return true;
    } catch (err) {
      if (!options.silent) Alert.alert('Add Chamber', err.message || 'Failed');
      return false;
    }
  };

  // When Super Admin approves Chamber Add, auto-sync chambers on mobile (no need to open bell)
  const autoSyncedChamberAddsRef = React.useRef(new Set());
  useEffect(() => {
    if (!apiUrl || !token) return undefined;
    const approvedAdds = (permissionNotifications || []).filter((n) => {
      if (n.record_type !== 'ChamberMaster' || n.status !== 'Approved' || n.do_action_completed_at) {
        return false;
      }
      const text = `${n.request_description || ''} ${n.description || ''}`;
      return /ADD chamber/i.test(text);
    });
    if (!approvedAdds.length) return undefined;

    let cancelled = false;
    (async () => {
      for (const notif of approvedAdds) {
        if (cancelled || autoSyncedChamberAddsRef.current.has(notif.id)) continue;
        autoSyncedChamberAddsRef.current.add(notif.id);
        const text = `${notif.request_description || ''} ${notif.description || ''}`;
        const nameMatch = text.match(/ADD chamber "([^"]+)"/i);
        const remarkMatch = text.match(/Remark:\s*(.+)$/i);
        let pending = null;
        try {
          const raw = await AsyncStorage.getItem('pending_chamber_adds');
          const map = raw ? JSON.parse(raw) : {};
          pending = map[String(notif.record_id)] || null;
        } catch (_) {}
        const chamberName = nameMatch?.[1] || pending?.name;
        if (!chamberName) {
          await fetchAndLoadAssignments();
          await markPermissionNotificationComplete(notif.id);
          continue;
        }
        const ok = await executeChamberCreate(
          chamberName,
          remarkMatch?.[1]?.trim() || pending?.remark || '',
          notif.id,
          { silent: true }
        );
        if (ok && !cancelled) {
          Alert.alert(
            'Chamber Added',
            `"${chamberName}" assigned after Super Admin approval.`
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [permissionNotifications, apiUrl, token]);

  const submitAddChamberRequest = async () => {
    if (!apiUrl || !token) {
      Alert.alert('Offline', 'Connect to server to request chamber add.');
      return;
    }
    // Limit is ignored for the request — Super Admin decides on allow
    const name = String(addChamberNameInput || '').trim();
    const remark = String(addChamberRemarkInput || '').trim();
    if (!name) {
      Alert.alert('Validation Error', 'Please enter a chamber name.');
      return;
    }
    if (!remark) {
      Alert.alert('Validation Error', 'Please enter a remark / reason.');
      return;
    }
    if (chambersList.some((c) => String(c.name).toLowerCase() === name.toLowerCase())) {
      Alert.alert('Already exists', `"${name}" is already in your chamber list.`);
      return;
    }

    setAddChamberBusy(true);
    try {
      const recordId = chamberAddPermissionId(name);

      // If already approved, create immediately
      const checkRes = await fetch(
        `${apiUrl}/api/permission-requests/check?record_type=${encodeURIComponent('ChamberMaster')}&record_id=${encodeURIComponent(recordId)}&action=Edit`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
      );
      const checkData = await checkRes.json().catch(() => ({}));
      if (checkRes.ok && checkData.approved) {
        setShowAddChamberModal(false);
        const list = await refreshPermissionNotifications();
        const granted = (list || []).find(
          (n) =>
            n.record_type === 'ChamberMaster' &&
            Number(n.record_id) === Number(recordId) &&
            n.status === 'Approved' &&
            !n.do_action_completed_at
        );
        await executeChamberCreate(name, remark, granted?.id || null);
        return;
      }
      if (checkRes.ok && checkData.status === 'Pending') {
        Alert.alert(
          'Waiting for Super Admin',
          `Add request for "${name}" is already pending.`
        );
        return;
      }

      try {
        const raw = await AsyncStorage.getItem('pending_chamber_adds');
        const map = raw ? JSON.parse(raw) : {};
        map[String(recordId)] = { name, remark };
        await AsyncStorage.setItem('pending_chamber_adds', JSON.stringify(map));
      } catch (_) {}

      const res = await fetch(`${apiUrl}/api/permission-requests`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          record_type: 'ChamberMaster',
          record_id: recordId,
          action: 'Edit',
          remark,
          description:
            `${displayName} requested Super Admin allow to ADD chamber "${name}". Remark: ${remark}`
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.request?.status === 'Approved') {
          setShowAddChamberModal(false);
          await executeChamberCreate(name, remark, null);
          return;
        }
        throw new Error(data.error || data.message || 'Failed to request allow.');
      }

      setShowAddChamberModal(false);
      setAddChamberNameInput('');
      setAddChamberRemarkInput('');
      await refreshPermissionNotifications();
      Alert.alert(
        'Request sent to Super Admin',
        `Allow needed to add "${name}". After Super Admin approves, open notifications (bell) — chamber will assign automatically.`
      );
    } catch (err) {
      Alert.alert('Add Chamber', err.message || 'Could not send request.');
    } finally {
      setAddChamberBusy(false);
    }
  };

  /** @deprecated — use openAddChamberPopup */
  const handleCreateChamber = () => {
    openAddChamberPopup();
  };

  const executeChamberDelete = async (chamber, notifIdToComplete = null) => {
    if (!chamber?.id) return false;
    try {
      const res = await fetch(`${apiUrl}/api/chambers/${chamber.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to delete');
      if (managerSelectedChamber?.id === chamber.id) setManagerSelectedChamber(null);
      await fetchAndLoadAssignments();
      if (notifIdToComplete) {
        await markPermissionNotificationComplete(notifIdToComplete);
      }
      reportDOActivity(
        'DELETE_CHAMBER',
        `${displayName} deleted chamber "${chamber.name}" (id: ${chamber.id}) after Super Admin allow.`
      );
      Alert.alert('Deleted', `"${chamber.name}" removed.`);
      return true;
    } catch (err) {
      Alert.alert('Delete Chamber', err.message || 'Failed');
      return false;
    }
  };

  const requestChamberDeletePermission = async (chamber, remark = '') => {
    if (!apiUrl || !token || !chamber?.id) {
      Alert.alert('Offline', 'Connect to server to request delete permission.');
      return;
    }
    const resolvedRemark = String(remark || '').trim();
    try {
      const res = await fetch(`${apiUrl}/api/permission-requests`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          record_type: 'ChamberMaster',
          record_id: chamber.id,
          action: 'Delete',
          remark: resolvedRemark || undefined,
          description:
            `${displayName} requested Super Admin allow to delete chamber "${chamber.name}" (id: ${chamber.id}).` +
            (resolvedRemark ? ` Remark: ${resolvedRemark}` : '')
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.request?.status === 'Approved') {
          Alert.alert(
            'Already Approved',
            `Delete of "${chamber.name}" is already allowed. Tap Delete again to remove it.`
          );
          return;
        }
        throw new Error(data.error || data.message || 'Failed to request delete permission.');
      }
      Alert.alert(
        'Request sent to Super Admin',
        `Allow needed to delete "${chamber.name}". After Super Admin approves, open notifications (bell) or tap Delete again.`
      );
      // Refresh permission notifications
      try {
        const listRes = await fetch(`${apiUrl}/api/permission-requests?_=${Date.now()}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
        });
        if (listRes.ok) {
          const listData = await listRes.json().catch(() => []);
          if (Array.isArray(listData)) setPermissionNotifications(listData);
        }
      } catch (_) {}
    } catch (err) {
      Alert.alert('Delete Permission', err.message || 'Could not send request.');
    }
  };

  const handleDeleteChamberMaster = (chamber) => {
    if (!chamber?.id) return;
    if (!apiUrl || !token) {
      Alert.alert('Offline', 'Connect to server to delete a chamber.');
      return;
    }

    (async () => {
      try {
        const checkRes = await fetch(
          `${apiUrl}/api/permission-requests/check?record_type=${encodeURIComponent('ChamberMaster')}&record_id=${encodeURIComponent(chamber.id)}&action=Delete`,
          { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
        );
        const checkData = await checkRes.json().catch(() => ({}));
        if (!checkRes.ok) {
          throw new Error(checkData.error || checkData.message || 'Permission check failed');
        }

        if (checkData.approved) {
          Alert.alert(
            'Delete Chamber',
            `Super Admin allowed delete. Remove "${chamber.name}" and deactivate its clients?`,
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                  const granted = permissionNotifications.find(
                    (n) =>
                      n.record_type === 'ChamberMaster' &&
                      Number(n.record_id) === Number(chamber.id) &&
                      n.status === 'Approved' &&
                      !n.do_action_completed_at
                  );
                  await executeChamberDelete(chamber, granted?.id || null);
                }
              }
            ]
          );
          return;
        }

        if (checkData.status === 'Pending') {
          Alert.alert(
            'Waiting for Super Admin',
            `Delete request for "${chamber.name}" is pending. Super Admin will approve in Role & Permission.`
          );
          return;
        }

        Alert.alert(
          'Super Admin Permission Required',
          `Deleting "${chamber.name}" needs Super Admin allow. Enter remark and send request.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Continue',
              onPress: () => {
                setClientToDelete({
                  type: 'chamber_delete_request',
                  chamberId: chamber.id,
                  chamberName: chamber.name,
                  clientName: chamber.name
                });
                setDeleteRemarkInput('');
                setShowDeleteConfirmModal(true);
              }
            }
          ]
        );
      } catch (err) {
        Alert.alert('Delete Chamber', err.message || 'Could not check permission.');
      }
    })();
  };

  const openPermissionNotificationTask = async (notif) => {
    setShowNotificationsModal(false);

    // Master Setup — no allow gate; open manager and dismiss stale allow notifs
    if (notif.record_type === 'MasterSetup') {
      openMasterManager();
      await markPermissionNotificationComplete(notif.id);
      return;
    }

    // Chamber master add/delete allow
    if (notif.record_type === 'ChamberMaster') {
      const desc = String(notif.description || notif.request_description || '');
      const isAdd = /ADD chamber/i.test(desc);

      if (isAdd) {
        const nameMatch = desc.match(/ADD chamber "([^"]+)"/i);
        const remarkMatch = desc.match(/Remark:\s*(.+)$/i);
        let pending = null;
        try {
          const raw = await AsyncStorage.getItem('pending_chamber_adds');
          const map = raw ? JSON.parse(raw) : {};
          pending = map[String(notif.record_id)] || null;
        } catch (_) {}
        const chamberName = nameMatch?.[1] || pending?.name;
        const remark = remarkMatch?.[1]?.trim() || pending?.remark || '';

        if (notif.status === 'Approved') {
          if (!chamberName) {
            await fetchAndLoadAssignments();
            Alert.alert('Chamber Updated', 'Your chamber list was refreshed after Super Admin approval.');
            await markPermissionNotificationComplete(notif.id);
            return;
          }
          // SA already created chamber + bumped limit; POST is idempotent and refreshes mobile
          await executeChamberCreate(chamberName, remark, notif.id);
        } else {
          Alert.alert(
            'Add Denied',
            desc || `Super Admin denied add of "${chamberName || 'chamber'}".`
          );
          await markPermissionNotificationComplete(notif.id);
        }
        return;
      }

      const chamberId = Number(notif.record_id);
      const nameMatch = desc.match(/delete chamber "([^"]+)"/i);
      const found = chambersList.find((c) => Number(c.id) === chamberId);
      const chamber = {
        id: chamberId,
        name: nameMatch?.[1] || found?.name || `Chamber ${chamberId}`
      };

      if (notif.status === 'Approved') {
        Alert.alert(
          'Delete Approved',
          `Super Admin allowed delete of "${chamber.name}". Remove it now?`,
          [
            { text: 'Later', style: 'cancel' },
            {
              text: 'Delete Now',
              style: 'destructive',
              onPress: () => executeChamberDelete(chamber, notif.id)
            }
          ]
        );
      } else {
        Alert.alert(
          'Delete Denied',
          notif.description || `Super Admin denied delete of "${chamber.name}".`
        );
        await markPermissionNotificationComplete(notif.id);
      }
      return;
    }

    // Client master — notify only (already applied locally). No SA allow apply step.
    if (notif.record_type === 'ClientMaster') {
      Alert.alert(
        'Client Master',
        'Client master changes are saved immediately. Super Admin is notified only — no allow step.'
      );
      await markPermissionNotificationComplete(notif.id);
      try {
        await AsyncStorage.removeItem('pending_client_master_edits');
      } catch (_) {}
      return;
    }

    const meta = parsePermissionTaskMeta(notif);
    const shiftName = meta.shift || 'Morning';
    const shiftTime = shiftName === 'Evening' ? '16:00' : '10:00';

    await handleSelectShift(shiftName);
    setCurrentNavTab('Tasks');
    setActiveTab('Completed');
    try {
      await AsyncStorage.setItem('active_mobile_nav_tab', 'Tasks');
    } catch (e) {
      /* ignore */
    }

    const localByServerId = completedLogs.find(
      (l) => Number(l.server_log_id) === Number(notif.record_id)
    ) || completedLogs.find(
      (l) =>
        String(l.client_name) === String(meta.client_name) &&
        l.shift === shiftName &&
        (!meta.chamber_id || Number(l.chamber_id) === Number(meta.chamber_id))
    );

    const taskItem = {
      chamber_id: meta.chamber_id || localByServerId?.chamber_id,
      chamber_name: meta.chamber_name || localByServerId?.chamber_name || 'Chamber',
      client_name: meta.client_name || localByServerId?.client_name || 'Client',
      shift_time: shiftTime,
      shift_label: shiftName === 'Morning' ? 'Morning (10:00)' : 'Evening (16:00)',
      due_date: meta.entry_date || localByServerId?.entry_date || undefined
    };

    await markPermissionNotificationComplete(notif.id);

    if (notif.status === 'Approved') {
      if (localByServerId) {
        // Open edit form immediately — permission already approved
        openEditableLogForm(taskItem, localByServerId);
      } else {
        handleEditCompletedLog(taskItem);
      }
    } else {
      Alert.alert(
        'Edit Denied',
        `Super Admin denied edit for ${taskItem.chamber_name} · ${taskItem.client_name} · ${shiftName}.`
      );
    }
  };
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await triggerSync(apiUrl, token, setSyncStatus);
      await fetchAndLoadAssignments();
    } catch (err) {
      console.warn('Failed to refresh data', err);
    } finally {
      setRefreshing(false);
    }
  };

  const fetchAndLoadAssignments = async () => {
    let loadedChambers = null;
    let sessionRevoked = false;
    try {
      const response = await fetch(`${apiUrl}/api/chambers/assignments`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.status === 401 || response.status === 403) {
        sessionRevoked = true;
        Alert.alert(
          'Session Revoked',
          'Your account has been deleted or disabled. Logging you out.',
          [{ text: 'OK', onPress: onLogout }]
        );
        return;
      }

      const data = await response.json();
      
      if (data.success && Array.isArray(data.data)) {
        const demoNames = new Set(
          DEFAULT_CLIENT_LOT_MASTER.map((n) => String(n).trim().toLowerCase())
        );
        const cleaned = data.data.filter(
          (a) => !demoNames.has(String(a?.client_name || '').trim().toLowerCase())
        );
        cacheAssignments(cleaned);
        purgeAutoSeededMasterLotsOnce();
      }

      // Load Chamber 1..N; create any missing so dashboard always has tasks
      loadedChambers = await ensureAssignedChambersFromServer();
    } catch (err) {
      console.log('📶 Device is offline or server unreachable. Using cached assignments.');
    } finally {
      if (!sessionRevoked) {
        loadLocalAssignmentsData(loadedChambers);
      } else {
        setIsLoadingData(false);
      }
    }
  };

  /** Fetch chambers for this DO; create Chamber 1..limit if missing; never return empty if limit > 0. */
  const ensureAssignedChambersFromServer = async () => {
    const limit = chamberLimit;
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    };

    const parseChamberRows = (chData) => {
      const rows = Array.isArray(chData?.data) ? chData.data : (Array.isArray(chData) ? chData : []);
      return rows.map((c) => ({
        id: Number(c.id),
        name: c.name || c.chamber_name || `Chamber ${c.id}`
      }));
    };

    const fetchChambers = async () => {
      const chRes = await fetch(`${apiUrl}/api/chambers`, { headers: authHeaders });
      if (!chRes.ok) return [];
      const chData = await chRes.json().catch(() => ({}));
      const serverLimit = parseInt(chData?.chamber_limit, 10);
      const effectiveLimit =
        Number.isFinite(serverLimit) && serverLimit > 0 ? serverLimit : limit;
      if (Number.isFinite(serverLimit) && serverLimit > 0 && serverLimit !== chamberLimit) {
        persistChamberLimit(serverLimit);
      }
      const sorted = parseChamberRows(chData).sort((a, b) => {
        const na = parseInt((String(a.name || '').match(/\d+/) || [a.id])[0], 10);
        const nb = parseInt((String(b.name || '').match(/\d+/) || [b.id])[0], 10);
        return na - nb;
      });
      return { chambers: sorted.slice(0, effectiveLimit), effectiveLimit };
    };

    let chambers = [];
    let effectiveLimit = limit;
    try {
      const first = await fetchChambers();
      chambers = first.chambers || [];
      effectiveLimit = first.effectiveLimit || limit;
    } catch (_) {
      chambers = [];
    }

    // Bootstrap only when empty — do not recreate chambers the user deleted
    if (!chambers.length && effectiveLimit > 0) {
      for (let i = 1; i <= effectiveLimit; i++) {
        try {
          const res = await fetch(`${apiUrl}/api/chambers`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ name: `Chamber ${i}` })
          });
          const body = await res.json().catch(() => ({}));
          if (res.ok && body?.data?.id) {
            chambers.push({
              id: Number(body.data.id),
              name: body.data.name || `Chamber ${i}`
            });
          }
        } catch (_) {}
      }
      try {
        const again = await fetchChambers();
        if (again.chambers?.length) {
          chambers = again.chambers;
          effectiveLimit = again.effectiveLimit || effectiveLimit;
        }
      } catch (_) {}
    }

    // Last resort: local placeholders so dashboard is never empty for assigned limit
    if (!chambers.length && effectiveLimit > 0) {
      chambers = Array.from({ length: effectiveLimit }, (_, idx) => ({
        id: idx + 1,
        name: `Chamber ${idx + 1}`
      }));
    }

    return applyChamberLimit(chambers).slice(0, effectiveLimit);
  };

  const loadLocalAssignmentsData = (chambersOverride = null) => {
    let chambers = applyChamberLimit(
      Array.isArray(chambersOverride) && chambersOverride.length
        ? chambersOverride
        : (chambersList || [])
    );

    let cachedData = getLocalAssignments();

    if (chambers.length === 0) {
      const fromAssign = [];
      const tracker = new Set();
      cachedData.forEach((item) => {
        if (!tracker.has(Number(item.chamber_id))) {
          tracker.add(Number(item.chamber_id));
          fromAssign.push({ id: item.chamber_id, name: item.chamber_name });
        }
      });
      chambers = applyChamberLimit(fromAssign);
    }

    // Still empty → show Chamber 1..limit so tasks appear on dashboard
    if (chambers.length === 0 && chamberLimit > 0) {
      chambers = Array.from({ length: chamberLimit }, (_, idx) => ({
        id: idx + 1,
        name: `Chamber ${idx + 1}`
      }));
    }

    // Empty chambers stay empty — DO adds clients chamber-wise in Master Setup
    // (no auto-seed of example clients)

    const lots = getClientLotMaster();
    setMasterClientLots(lots);

    const finalTasks = buildTasksForAssignedChambers(chambers, cachedData);

    setChambersList(chambers);
    setAssignments(finalTasks);
    loadInspectionsAndSummary(finalTasks, chambers);
  };

  const loadInspectionsAndSummary = (currAssignments = assignments, currChambers = chambersList) => {
    const todayStr = new Date().toISOString().split('T')[0];
    
    const todaysInspections = getTodaysInspections(todayStr, displayName);
    setCompletedLogs(todaysInspections);

    const pendingInspections = getPendingInspections(displayName);
    setUnsyncedLogs(pendingInspections);

    // Active assignments today (excluding soft-deleted / inactive ones)
    const activeAssignmentsToday = currAssignments.filter(item => item.status !== 'inactive');
    
    // Calculate pending count for chambers with more than 1 client task, taking shift-time and current hour into account
    const currentHour = new Date().getHours();
    const activeShiftTasks = [];
    activeAssignmentsToday.forEach(item => {
      activeShiftTasks.push({ ...item, shift_time: '10:00' });
      if (currentHour >= 16) {
        activeShiftTasks.push({ ...item, shift_time: '16:00' });
      }
    });

    const pendingTasksList = activeShiftTasks.filter(item => {
      const log = todaysInspections.find(l => 
        l.chamber_id === item.chamber_id && 
        l.client_name === item.client_name &&
        l.shift === (item.shift_time === '10:00' ? 'Morning' : 'Evening')
      );
      const isCompleted = !!log;
      return !isCompleted;
    });
    setPendingCount(pendingTasksList.length);

    // Calculate Overdue tasks for the past 2 days
    const allInspections = getAllLocalInspections(displayName);
    
    const getPastDates = (numDays) => {
      const dates = [];
      for (let i = 1; i <= numDays; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().split('T')[0]);
      }
      return dates;
    };
    
    const past2Days = getPastDates(2);
    const overdueList = [];
    
    past2Days.forEach(date => {
      currAssignments.forEach(item => {
        if (item.status === 'inactive') return;
        
        const hasMorningLog = allInspections.some(l => 
          l.chamber_id === item.chamber_id && 
          l.client_name === item.client_name && 
          l.entry_date === date &&
          (l.shift === 'Morning' || l.inspection_time === '10:00')
        );
        
        if (!hasMorningLog) {
          overdueList.push({
            ...item,
            id: `overdue_${item.chamber_id}_${item.client_name.replace(/\s+/g, '')}_${date}_Morning`,
            due_date: date,
            is_overdue: true,
            shift: 'Morning',
            shift_time: '10:00',
            shift_label: 'Morning'
          });
        }

        const hasEveningLog = allInspections.some(l => 
          l.chamber_id === item.chamber_id && 
          l.client_name === item.client_name && 
          l.entry_date === date &&
          (l.shift === 'Evening' || l.inspection_time === '16:00')
        );
        
        if (!hasEveningLog) {
          overdueList.push({
            ...item,
            id: `overdue_${item.chamber_id}_${item.client_name.replace(/\s+/g, '')}_${date}_Evening`,
            due_date: date,
            is_overdue: true,
            shift: 'Evening',
            shift_time: '16:00',
            shift_label: 'Evening'
          });
        }
      });
    });
    
    setOverdueTasks(overdueList);
    setOverdueCount(overdueList.length);
    setIsLoadingData(false);
  };

  // Launch phone camera to snap box photo
  const handleLaunchCamera = async () => {
    try {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 0.7,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        setCapturedImage(result.assets[0].uri);
        setCapturedImageTimestamp(Date.now());
      }
    } catch (error) {
      Alert.alert('Camera Error', 'Could not access device camera.');
    }
  };

  // Open Log Form for a specific client
  const handleOpenClientLogForm = (clientName) => {
    const todayStr = new Date().toISOString().split('T')[0];
    
    const existingLog = completedLogs.find(l => 
      l.chamber_id === selectedChamber.id && 
      l.client_name === clientName && 
      l.entry_date === todayStr
    );

    setSelectedClient(clientName);
    if (existingLog) {
      setTempInput(existingLog.box_temp.toString());
      setBoxCountInput(existingLog.box_count ? existingLog.box_count.toString() : '');
      setCapturedImage(existingLog.temp_sensor_image);
      if (existingLog.photo_capture_time) {
        try {
          const parsedDate = new Date(existingLog.photo_capture_time.replace(' ', 'T'));
          setCapturedImageTimestamp(isNaN(parsedDate.getTime()) ? null : parsedDate.getTime());
        } catch (e) {
          setCapturedImageTimestamp(null);
        }
      } else {
        setCapturedImageTimestamp(null);
      }
    } else {
      setTempInput('');
      setBoxCountInput('');
      setCapturedImage(null);
      setCapturedImageTimestamp(null);
    }
    setIsProfileEditable(true);
    setShowLogModal(true);
  };

  // Variance (minutes) between photo capture time and submit/now time
  const getImageTimeDifferenceInMinutes = (submitTs = Date.now()) => {
    if (!capturedImageTimestamp) return null;
    const diffMs = Math.abs(submitTs - capturedImageTimestamp);
    return Math.floor(diffMs / (1000 * 60));
  };

  // Helper to format Date into standard YYYY-MM-DD HH:mm:ss string
  const formatDateTime = (timestamp) => {
    if (!timestamp) return '';
    const dateObj = new Date(timestamp);
    if (isNaN(dateObj.getTime())) return '';
    const yyyy = dateObj.getFullYear();
    const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
    const dd = String(dateObj.getDate()).padStart(2, '0');
    const hh = String(dateObj.getHours()).padStart(2, '0');
    const min = String(dateObj.getMinutes()).padStart(2, '0');
    const ss = String(dateObj.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  };

  const formatClockTime = (timestamp) => {
    if (!timestamp) return '-';
    const dateObj = new Date(timestamp);
    if (isNaN(dateObj.getTime())) return '-';
    const hh = String(dateObj.getHours()).padStart(2, '0');
    const min = String(dateObj.getMinutes()).padStart(2, '0');
    const ss = String(dateObj.getSeconds()).padStart(2, '0');
    return `${hh}:${min}:${ss}`;
  };

  const handleTempInputChange = (text) => {
    if (text === '') {
      setTempInput('');
      return;
    }
    if (text === '-') {
      setTempInput('-');
      return;
    }
    const regex = /^-?[0-9]{0,2}\.?[0-9]{0,2}$/;
    if (regex.test(text)) {
      setTempInput(text);
    }
  };

  // Validate log form and trigger confirmation popup
  const handleSaveInspection = () => {
    if (!selectedChamber) {
      Alert.alert('Validation Error', 'Please select a Chamber.');
      return;
    }
    if (!selectedClient) {
      Alert.alert('Validation Error', 'Please select a Client.');
      return;
    }
    if (!editingExistingLog && getClientsForChamber(selectedChamber.id).length === 0) {
      Alert.alert(
        'Add clients first',
        'Is chamber pe Master Setup me client add karo — phir task submit hoga.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Open Master Setup',
            onPress: () => {
              setShowLogModal(false);
              openMasterSetupAddClients(selectedChamber);
            }
          }
        ]
      );
      return;
    }
    if (!tempInput || isNaN(parseFloat(tempInput))) {
      Alert.alert('Validation Error', 'Please enter a valid numeric temperature value (e.g. -12.25).');
      return;
    }
    if (!boxCountInput) {
      Alert.alert('Validation Error', 'Please enter a valid box count.');
      return;
    }
    const parsedBoxCount = parseInt(boxCountInput, 10);
    if (isNaN(parsedBoxCount) || parsedBoxCount < 0) {
      Alert.alert('Validation Error', 'Box quantity cannot be negative. Enter 0 or a positive count.');
      return;
    }
    if (!capturedImage) {
      Alert.alert('Validation Error', 'Please capture a photo of the sensor/box.');
      return;
    }
    // Edit + new: photo capture time must exist so it can be compared with submit time
    if (!capturedImageTimestamp) {
      Alert.alert(
        'Retake Photo Required',
        editingExistingLog
          ? 'Edit submit pe image time ko submit time se compare kiya jata hai. Naya verification photo lo.'
          : 'Photo capture time missing. Please retake the verification photo.'
      );
      return;
    }

    setShowSubmitConfirmModal(true);
  };

  const handleSelectClientPill = (clientName) => {
    // Already submitted for this shift → do not re-open for new entry
    if (
      selectedChamber &&
      isClientCompletedToday(selectedChamber.id, clientName, selectedShift) &&
      !editingExistingLog
    ) {
      return;
    }
    setSelectedClient(clientName);
    const todayStr = new Date().toISOString().split('T')[0];
    const targetShift = normalizeShiftLabel(selectedShift);
    const log = completedLogs.find(l => 
      Number(l.chamber_id) === Number(selectedChamber.id) && 
      String(l.client_name) === String(clientName) && 
      l.entry_date === todayStr &&
      normalizeShiftLabel(l.shift || l.inspection_time) === targetShift
    );
    if (log) {
      setTempInput(log.box_temp.toString());
      setBoxCountInput(log.box_count ? log.box_count.toString() : '');
      setCapturedImage(log.temp_sensor_image);
      setSelectedChamberType(log.chamber_type || getChamberTypeAndDefault(selectedChamber.id).type);
      if (log.photo_capture_time) {
        try {
          const parsedDate = new Date(log.photo_capture_time.replace(' ', 'T'));
          setCapturedImageTimestamp(isNaN(parsedDate.getTime()) ? null : parsedDate.getTime());
        } catch (e) {
          setCapturedImageTimestamp(null);
        }
      } else {
        setCapturedImageTimestamp(null);
      }
    } else {
      setTempInput('');
      setBoxCountInput('');
      setCapturedImage(null);
      setCapturedImageTimestamp(null);
      setSelectedChamberType(getChamberTypeAndDefault(selectedChamber.id).type);
    }
  };

  // Save the logged inspection to SQLite and trigger sync after confirmation
  const handleConfirmSaveInspection = async () => {
    setShowSubmitConfirmModal(false);

    const todayStr = new Date().toISOString().split('T')[0];
    const targetDate = selectedTaskDueDate || todayStr;
    const submitNowMs = Date.now();
    // Always use real photo capture time (never fake as submit) — compared with submitNowMs
    const captureTimeStr = formatDateTime(capturedImageTimestamp);
    const photoVsSubmitMins = getImageTimeDifferenceInMinutes(submitNowMs);

    // Approved edit of an existing completed log
    if (editingExistingLog) {
      if (!captureTimeStr) {
        Alert.alert(
          'Retake Photo Required',
          'Edit pe image capture time submit time se compare hota hai. Naya photo lo phir update karo.'
        );
        return;
      }

      const serverLogId = getServerLogIdForPermission(editingExistingLog);
      const nowTs = formatDateTime(submitNowMs);
      // Keep original inspection time — Update Time / client name are not editable on edit
      const keepInspectionTime =
        editingExistingLog.inspection_time ||
        (editingExistingLog.shift === 'Evening' ? '16:00' : '10:00');

      const localOk = updateInspectionLocally(editingExistingLog.id, {
        box_temp: parseFloat(tempInput),
        box_count: parseInt(boxCountInput, 10),
        temp_sensor_image: capturedImage,
        photo_capture_time: captureTimeStr,
        chamber_type: selectedChamberType,
        inspection_time: keepInspectionTime,
        client_name: editingExistingLog.client_name || selectedClient,
        updated_at: nowTs,
        sync_status: 'synced'
      });

      if (!localOk) {
        Alert.alert('Update Failed', 'Could not update the local log.');
        return;
      }

      try {
        if (serverLogId && apiUrl && token) {
          const formData = new FormData();
          formData.append('box_temp', String(parseFloat(tempInput)));
          formData.append('box_count', String(parseInt(boxCountInput, 10)));
          formData.append('chamber_type', selectedChamberType || 'Frozen');
          formData.append('inspection_time', keepInspectionTime);
          formData.append('photo_capture_time', captureTimeStr);
          formData.append('monitor_supervisor_name', displayName);
          formData.append(
            'remarks',
            `Mobile edit after SA allow. Photo vs submit: ${photoVsSubmitMins ?? '?'} min`
          );
          if (capturedImage && !String(capturedImage).startsWith('http') && !String(capturedImage).startsWith('uploads/')) {
            const filename = String(capturedImage).split('/').pop() || `edit-${serverLogId}.jpg`;
            formData.append('temp_sensor_image', {
              uri: capturedImage,
              name: filename,
              type: 'image/jpeg'
            });
          }

          const res = await fetch(`${apiUrl}/api/chamber-temp/${serverLogId}`, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json'
            },
            body: formData
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(data.message || data.error || `Update failed (${res.status})`);
          }
        }

        setShowLogModal(false);
        const refLabel = editingExistingLog.reference_no || serverLogId || editingExistingLog.id;
        setEditingExistingLog(null);
        setUpdateTimeInput('');
        setSelectedClient(null);
        setCapturedImage(null);
        setCapturedImageTimestamp(null);
        loadInspectionsAndSummary();
        Alert.alert(
          'Log Updated',
          'Inspection updated. For another edit, request Super Admin permission again.'
        );
        reportDOActivity(
          'UPDATE',
          `Mobile: updated Chamber log ${refLabel}`
        );
      } catch (err) {
        Alert.alert('Cloud Update Failed', err.message || 'Local copy was updated; cloud sync failed.');
        loadInspectionsAndSummary();
      }
      return;
    }

    // Save the actual current submission time in HH:mm 24-hour format
    const nowTime = new Date();
    const hh = String(nowTime.getHours()).padStart(2, '0');
    const min = String(nowTime.getMinutes()).padStart(2, '0');
    const timeStr = `${hh}:${min}`;

    const targetShiftName = selectedShift === '10:00' ? 'Morning' : 'Evening';

    // If it's already logged for targetDate and shift, delete the old record first to allow overwrite
    deleteInspectionLocally(targetDate, selectedChamber.id, selectedClient, targetShiftName);

    // Calculate overdue_time
    let overdueTimeStr = 'same day';
    if (targetDate !== todayStr) {
      try {
        const dueDateObj = new Date(targetDate + 'T18:00:00'); // Standard 6:00 PM shift end
        const nowObj = new Date();
        const diffMs = nowObj - dueDateObj;
        if (diffMs > 0) {
          const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
          const days = Math.floor(diffHours / 24);
          const hours = diffHours % 24;
          overdueTimeStr = days > 0 ? `${days}d ${hours}h later` : `${hours}h later`;
        }
      } catch (err) {
        overdueTimeStr = 'completed later';
      }
    }

    const newLog = {
      id: `${selectedChamber.id}_${selectedClient.replace(/\s+/g, '')}_${Date.now()}`,
      monitor_supervisor_name: displayName,
      chamber_id: selectedChamber.id,
      chamber_name: selectedChamber.name,
      client_name: selectedClient,
      box_temp: parseFloat(tempInput),
      box_count: parseInt(boxCountInput, 10),
      temp_sensor_image: capturedImage,
      entry_date: targetDate,
      inspection_time: timeStr,
      chamber_type: selectedChamberType,
      overdue_time: overdueTimeStr,
      photo_capture_time: captureTimeStr,
      shift: targetShiftName,
      created_at: formatDateTime(new Date())
    };

    const success = saveInspectionLocally(newLog);
    if (success) {
      setShowLogModal(false);
      setCapturedImage(null);
      setCapturedImageTimestamp(null);

      const target = getChamberClientTarget(selectedChamber.id);
      const todaysAfterSave = getTodaysInspections(targetDate, displayName);
      const doneAfter = countLoggedClientsForChamber(
        selectedChamber.id,
        targetShiftName,
        targetDate,
        todaysAfterSave
      );
      const totalClients = target != null ? target : 0;
      const chamberFullyDone = target != null && doneAfter >= target;
      const remaining = target != null ? Math.max(0, target - doneAfter) : 0;

      if (currentNavTab === 'Dashboard' || openedFromFab) {
        setSelectedChamber(null);
        setOpenedFromFab(false);
        setSelectedClient(null);
      }

      if (chamberFullyDone) {
        setActiveTab('Completed');
        setSelectedClient(null);
      } else {
        setActiveTab('Pending');
      }

      loadInspectionsAndSummary();

      Alert.alert(
        'Inspection Saved',
        chamberFullyDone
          ? `All ${totalClients} client(s) logged for ${selectedChamber.name}. Chamber completed.`
          : `Saved "${selectedClient}". ${doneAfter}/${totalClients || '?'} done — ${remaining} more needed.`,
        [
          { text: 'OK' },
          ...(!chamberFullyDone && target != null && remaining > 0 && currentNavTab === 'Tasks'
            ? [
                {
                  text: 'Next Client',
                  onPress: () => handleOpenChamberLogFormDirect(selectedChamber)
                }
              ]
            : [])
        ]
      );

      triggerSync(apiUrl, token, (status) => {
        setSyncStatus(status);
        loadInspectionsAndSummary();
      });
    } else {
      Alert.alert('Database Error', 'Failed to save log to local SQLite queue.');
    }
  };

  const handleCloseModal = () => {
    setShowLogModal(false);
    setSelectedClient(null);
    setCapturedImageTimestamp(null);
    setEditingExistingLog(null);
    setUpdateTimeInput('');
    setShowChamberDropdown(false);
    setShowClientDropdown(false);
    if (currentNavTab === 'Dashboard' || openedFromFab) {
      setSelectedChamber(null);
      setOpenedFromFab(false);
    }
  };

  // Dynamic Client Master Management methods
  const handleAddNewClient = () => {
    if (!managerSelectedChamber) {
      Alert.alert('Validation Error', 'Please select a Chamber first.');
      return;
    }
    if (!newClientInput || !newClientInput.trim()) {
      Alert.alert('Validation Error', 'Please enter a Client Lot Name.');
      return;
    }
    const clientName = ensureClientInLotMaster(newClientInput);
    if (!clientName) {
      Alert.alert('Validation Error', 'Please enter a Client Lot Name.');
      return;
    }

    const duplicateExists = getClientsForChamber(managerSelectedChamber.id).some(
      (item) => item.client_name.toLowerCase() === clientName.toLowerCase()
    );
    if (duplicateExists) {
      Alert.alert('Already on chamber', `"${clientName}" is already on ${managerSelectedChamber.name}.`);
      return;
    }

    const success = addLocalAssignment(
      managerSelectedChamber.id,
      managerSelectedChamber.name,
      clientName,
      'Added for this chamber only'
    );
    if (success) {
      setNewClientInput('');
      loadLocalAssignmentsData(chambersList);
      reportDOActivity('ADD_CLIENT', `Added client "${clientName}" to ${managerSelectedChamber.name} only`, 'Added for this chamber only');
      if (apiUrl && token) triggerSync(apiUrl, token, setSyncStatus);
      Alert.alert('Success', `"${clientName}" added to ${managerSelectedChamber.name} only.`);
    } else {
      Alert.alert('Error', 'Failed to add client to this chamber.');
    }
  };

  const handleRenameChamberClient = async () => {
    if (!managerSelectedChamber || !editingClientName) return;
    const oldName = editingClientName.oldName;
    const newName = String(editClientDraft || '').trim();
    if (!newName) {
      Alert.alert('Validation Error', 'Enter a new client name.');
      return;
    }
    if (newName.toLowerCase() === String(oldName).toLowerCase()) {
      setEditingClientName(null);
      setEditClientDraft('');
      return;
    }

    const ok = renameLocalAssignment(
      managerSelectedChamber.id,
      managerSelectedChamber.name,
      oldName,
      newName
    );
    if (!ok) {
      Alert.alert('Rename failed', 'Name may already exist on this chamber.');
      return;
    }
    ensureClientInLotMaster(newName);
    setEditingClientName(null);
    setEditClientDraft('');
    loadLocalAssignmentsData(chambersList);
    // Notify Super Admin only — no allow request
    reportDOActivity(
      'UPDATE_CLIENT',
      `${displayName} edited client master "${oldName}" → "${newName}" on ${managerSelectedChamber.name} (chamber_id: ${managerSelectedChamber.id}).`,
      `Renamed "${oldName}" to "${newName}"`
    );
    if (apiUrl && token) triggerSync(apiUrl, token, setSyncStatus);
    Alert.alert('Updated', `"${oldName}" renamed to "${newName}". Super Admin has been notified.`);
  };

  const handleDeleteClient = (clientName, chamberOverride = null) => {
    const chamber = chamberOverride || managerSelectedChamber;
    if (!chamber || !clientName) return;
    setClientToDelete({
      chamberId: chamber.id,
      chamberName: chamber.name,
      clientName
    });
    setDeleteRemarkInput('');
    setShowDeleteConfirmModal(true);
  };

  /** Delete client master from task form (same flow as Master Setup). */
  const openDeleteClientFromTaskForm = (clientName) => {
    if (!selectedChamber || !clientName) return;
    setShowClientDropdown(false);
    handleDeleteClient(clientName, selectedChamber);
  };

  // Chamber type classification
  const getChamberTypeAndDefault = (chamberId) => {
    const idVal = parseInt(chamberId, 10);
    if ([1, 2, 3, 7, 9].includes(idVal)) {
      return { type: 'Frozen', defaultTemp: -20.0, icon: 'snow', color: '#1d4ed8', bg: '#dbeafe' };
    } else if ([4, 6].includes(idVal)) {
      return { type: 'Chilled', defaultTemp: 2.0, icon: 'thermometer', color: '#0d9488', bg: '#ccfbf1' };
    } else if (idVal === 5) {
      return { type: 'Dry', defaultTemp: 18.0, icon: 'leaf', color: '#16a34a', bg: '#dcfce7' };
    } else {
      return { type: 'Other', defaultTemp: 25.0, icon: 'options', color: '#64748b', bg: '#f1f5f9' };
    }
  };

  // Details for Chamber Grid cards
  const getChamberDetails = (chamber) => {
    const pattern = getChamberTypeAndDefault(chamber.id);
    const chamberLogs = completedLogs.filter(log => Number(log.chamber_id) === Number(chamber.id) && log.shift === activeShift);
    const hasLogs = chamberLogs.length > 0;
    
    const tempVal = hasLogs ? chamberLogs[chamberLogs.length - 1].box_temp : null;

    let displayTemp = '--.-°C';
    let status = 'Pending';
    let statusColor = '#f59e0b';
    let type = pattern.type;
    let icon = pattern.icon;
    let pillColor = pattern.color;
    let pillBg = pattern.bg;
    let hasAlert = false;

    const chamberAssignments = assignments.filter(item => Number(item.chamber_id) === Number(chamber.id));
    const completedCount = chamberLogs.length;
    const totalCount = chamberAssignments.length;

    if (hasLogs) {
      chamberLogs.forEach(log => {
        const currentType = log.chamber_type || type;
        if (currentType === 'Frozen' && log.box_temp > -18) hasAlert = true;
        if (currentType === 'Chilled' && (log.box_temp < -5 || log.box_temp > 5)) hasAlert = true;
        if (currentType === 'Dry' && (log.box_temp < 15 || log.box_temp > 25)) hasAlert = true;
        // 'Other' type has no alert constraints
      });
    }

    if (completedCount > 0 && completedCount === totalCount) {
      status = 'Done';
      statusColor = '#16a34a';
    } else {
      status = 'Normal';
      statusColor = '#f59e0b';
    }

    if (tempVal !== null) {
      displayTemp = `${tempVal.toFixed(1)}°C`;
    }

    return { displayTemp, status, statusColor, type, icon, pillColor, pillBg, hasAlert };
  };

  // Filters Chambers List based on stats tab clicks
  const getFilteredChambers = () => {
    const todayStr = new Date().toISOString().split('T')[0];
    if (activeTab === 'All') return chambersList;
    return chambersList.filter(chamber => {
      const target = getChamberClientTarget(chamber.id);
      const done = countLoggedClientsForChamber(chamber.id, activeShift, todayStr);
      const isCompleted = target != null && done >= target;

      if (activeTab === 'Pending') {
        return !isCompleted;
      }
      if (activeTab === 'Completed') {
        return isCompleted;
      }
      if (activeTab === 'Failed') {
        const pattern = getChamberTypeAndDefault(chamber.id);
        const chamberLogs = completedLogs.filter(
          (log) => Number(log.chamber_id) === Number(chamber.id) && log.shift === activeShift
        );
        return chamberLogs.some(log => {
          if (pattern.type === 'Frozen') return log.box_temp > -18;
          if (pattern.type === 'Chilled') return log.box_temp < -5 || log.box_temp > 5;
          return log.box_temp <= 0;
        });
      }
      return true;
    });
  };

  const getFilteredAssignments = (targetTab = activeTab) => {
    if (targetTab === 'Overdue') {
      return overdueTasks;
    }
    
    // Duplicate active assignments for the two shifts (10:00 AM and 04:00 PM)
    const shiftTasks = [];
    assignments.forEach(item => {
      if (item.status === 'inactive') return;
      
      shiftTasks.push({
        ...item,
        shift_time: '10:00',
        shift_label: 'Morning Task'
      });
      
      const currentHour = new Date().getHours();
      if (currentHour >= 16) {
        shiftTasks.push({
          ...item,
          shift_time: '16:00',
          shift_label: 'Evening Task'
        });
      }
    });

    return shiftTasks.filter(item => {
      const todayStr = new Date().toISOString().split('T')[0];
      const log = completedLogs.find(l =>
        Number(l.chamber_id) === Number(item.chamber_id) &&
        l.client_name === item.client_name &&
        l.entry_date === todayStr &&
        l.shift === (item.shift_time === '10:00' ? 'Morning' : 'Evening')
      );
      const isCompleted = !!log;
      const pattern = getChamberTypeAndDefault(item.chamber_id);
      
      let hasWarning = false;
      if (isCompleted) {
        const checkType = log.chamber_type || pattern.type;
        if (checkType === 'Frozen' && log.box_temp > -18) hasWarning = true;
        if (checkType === 'Chilled' && (log.box_temp < -5 || log.box_temp > 5)) hasWarning = true;
        if (checkType === 'Dry' && (log.box_temp < 15 || log.box_temp > 25)) hasWarning = true;
      }

      if (targetTab === 'Pending') {
        return !isCompleted;
      }
      if (targetTab === 'Completed') {
        return isCompleted;
      }
      return true;
    });
  };

  /**
   * Tasks screen list:
   * - All / Pending / Overdue → one row per chamber (+ shift)
   * - Completed → one row per client lot (logged)
   */
  const getTasksScreenList = (targetTab = activeTab) => {
    // Completed = client-wise
    if (targetTab === 'Completed') {
      return getFilteredAssignments('Completed').map((item) => ({
        ...item,
        _view: 'client',
        is_chamber_task: false
      }));
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const currentHour = new Date().getHours();
    const shifts = [{ time: '10:00', label: 'Morning Task', name: 'Morning' }];
    if (currentHour >= 16) {
      shifts.push({ time: '16:00', label: 'Evening Task', name: 'Evening' });
    }

    // Overdue = chamber-wise (group missed client rows)
    if (targetTab === 'Overdue') {
      const map = new Map();
      overdueTasks.forEach((t) => {
        const key = `${t.chamber_id}_${t.due_date}_${t.shift_time || t.shift || ''}`;
        if (!map.has(key)) {
          map.set(key, {
            _view: 'chamber',
            is_chamber_task: true,
            is_overdue: true,
            chamber_id: t.chamber_id,
            chamber_name: t.chamber_name,
            client_name: null,
            due_date: t.due_date,
            shift_time: t.shift_time || (t.shift === 'Evening' ? '16:00' : '10:00'),
            shift_label: t.shift_label || (t.shift === 'Evening' ? 'Evening Task' : 'Morning Task'),
            clients_total: 0,
            clients_done: 0,
            is_completed: false
          });
        }
        map.get(key).clients_total += 1;
      });
      return Array.from(map.values()).sort((a, b) => {
        const na = parseInt((String(a.chamber_name || '').match(/\d+/) || [a.chamber_id])[0], 10);
        const nb = parseInt((String(b.chamber_name || '').match(/\d+/) || [b.chamber_id])[0], 10);
        if (String(a.due_date) !== String(b.due_date)) {
          return String(b.due_date).localeCompare(String(a.due_date));
        }
        return na - nb;
      });
    }

    // All / Pending = chamber-wise for active shift slots
    const rows = [];
    chambersList.forEach((ch) => {
      shifts.forEach((shift) => {
        const target = getChamberClientTarget(ch.id);
        const doneCount = countLoggedClientsForChamber(ch.id, shift.name, todayStr);
        // User-typed total (1,2,3,4…) — chamber complete only when logged >= target
        const clientsTotal = target != null ? target : 0;
        const isDone = target != null && doneCount >= target;

        if (targetTab === 'Pending' && isDone) return;
        if (targetTab === 'All' || targetTab === 'Pending') {
          rows.push({
            _view: 'chamber',
            is_chamber_task: true,
            chamber_id: ch.id,
            chamber_name: ch.name,
            client_name: null,
            shift_time: shift.time,
            shift_label: shift.label,
            clients_total: clientsTotal,
            clients_done: doneCount,
            target_set: target != null,
            is_completed: isDone,
            is_overdue: false
          });
        }
      });
    });

    return rows.sort((a, b) => {
      const na = parseInt((String(a.chamber_name || '').match(/\d+/) || [a.chamber_id])[0], 10);
      const nb = parseInt((String(b.chamber_name || '').match(/\d+/) || [b.chamber_id])[0], 10);
      if (na !== nb) return na - nb;
      return String(a.shift_time).localeCompare(String(b.shift_time));
    });
  };

  // Check if a client log exists today for a specific chamber + shift
  const normalizeShiftLabel = (shiftOrTime) => {
    if (!shiftOrTime) return activeShift;
    if (shiftOrTime === 'Morning' || shiftOrTime === 'Evening') return shiftOrTime;
    if (shiftOrTime === '10:00' || String(shiftOrTime).startsWith('10')) return 'Morning';
    if (shiftOrTime === '16:00' || String(shiftOrTime).startsWith('16')) return 'Evening';
    return shiftOrTime;
  };

  const isClientCompletedToday = (chamberId, clientName, entryTime = null) => {
    const todayStr = new Date().toISOString().split('T')[0];
    const targetShift = normalizeShiftLabel(entryTime || activeShift);
    return completedLogs.some(log =>
      Number(log.chamber_id) === Number(chamberId) &&
      String(log.client_name) === String(clientName) &&
      log.entry_date === todayStr &&
      normalizeShiftLabel(log.shift || log.inspection_time) === targetShift
    );
  };

  // Open task profile detail in unified modal
  const handleOpenTaskDetail = (item) => {
    const todayStr = new Date().toISOString().split('T')[0];
    const log = completedLogs.find(l => 
      l.chamber_id === item.chamber_id && 
      l.client_name === item.client_name && 
      l.entry_date === todayStr
    );
    if (log) {
      setSelectedChamber({ id: item.chamber_id, name: item.chamber_name });
      setSelectedClient(item.client_name);
      setTempInput(log.box_temp.toString());
      setBoxCountInput(log.box_count ? log.box_count.toString() : '');
      setCapturedImage(log.temp_sensor_image);
      setSelectedChamberType(log.chamber_type || getChamberTypeAndDefault(item.chamber_id).type);
      
      setLogOperatorName(log.monitor_supervisor_name);
      setLogSyncStatus(log.sync_status);
      setLogEntryDate(log.entry_date);
      setLogEntryTime(log.inspection_time);
      setLogShift(log.shift || (log.inspection_time === '10:00' ? 'Morning' : 'Evening'));
      
      if (log.photo_capture_time) {
        try {
          const parsedDate = new Date(log.photo_capture_time.replace(' ', 'T'));
          setCapturedImageTimestamp(isNaN(parsedDate.getTime()) ? null : parsedDate.getTime());
        } catch (e) {
          setCapturedImageTimestamp(null);
        }
      } else {
        setCapturedImageTimestamp(null);
      }
      
      setIsProfileEditable(false);
      setOpenedFromFab(false);
      setShowLogModal(true);
    }
  };

  const handleOpenTaskLogForm = (item) => {
    const targetDate = item.due_date || new Date().toISOString().split('T')[0];
    setSelectedTaskDueDate(targetDate);
    setEditingExistingLog(null);
    
    const targetShift = item.shift_time || '10:00 AM';
    setSelectedShift(targetShift);
    
    const existingLog = completedLogs.find(l => 
      l.chamber_id === item.chamber_id && 
      l.client_name === item.client_name && 
      l.entry_date === targetDate &&
      l.inspection_time === targetShift
    ) || (item.is_overdue ? unsyncedLogs.find(l =>
      l.chamber_id === item.chamber_id && 
      l.client_name === item.client_name && 
      l.entry_date === targetDate &&
      l.inspection_time === targetShift
    ) : null);

    const chamber = chambersList.find(c => c.id === item.chamber_id) || { id: item.chamber_id, name: item.chamber_name };
    setSelectedChamber(chamber);
    setSelectedClient(item.client_name);
    
    if (existingLog) {
      setTempInput(existingLog.box_temp.toString());
      setBoxCountInput(existingLog.box_count ? existingLog.box_count.toString() : '');
      setCapturedImage(existingLog.temp_sensor_image);
      setSelectedChamberType(existingLog.chamber_type || getChamberTypeAndDefault(item.chamber_id).type);
      if (existingLog.photo_capture_time) {
        try {
          const parsedDate = new Date(existingLog.photo_capture_time.replace(' ', 'T'));
          setCapturedImageTimestamp(isNaN(parsedDate.getTime()) ? null : parsedDate.getTime());
        } catch (e) {
          setCapturedImageTimestamp(null);
        }
      } else {
        setCapturedImageTimestamp(null);
      }
    } else {
      setTempInput('');
      setBoxCountInput('');
      setCapturedImage(null);
      setCapturedImageTimestamp(null);
      setSelectedChamberType(getChamberTypeAndDefault(item.chamber_id).type);
    }
    
    setIsProfileEditable(true);
    setOpenedFromFab(false);
    setShowLogModal(true);
  };

  /** Resolve server log id for permission (synced native chamber temp log). */
  const getServerLogIdForPermission = (log) => {
    if (!log) return null;
    if (log.server_log_id) return Number(log.server_log_id);
    // Fallback: parse RF-CH-26-0042 → 42
    const ref = String(log.reference_no || '');
    const m = ref.match(/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : null;
  };

  const openEditableLogForm = (item, existingLog) => {
    const targetDate = item.due_date || existingLog?.entry_date || new Date().toISOString().split('T')[0];
    setSelectedTaskDueDate(targetDate);
    const targetShift = item.shift_time || (existingLog?.shift === 'Evening' ? '16:00' : '10:00');
    setSelectedShift(targetShift);

    const chamber = chambersList.find(c => c.id === item.chamber_id) || { id: item.chamber_id, name: item.chamber_name };
    setSelectedChamber(chamber);
    setSelectedClient(item.client_name);
    setEditingExistingLog(existingLog);

    setTempInput(existingLog.box_temp != null ? String(existingLog.box_temp) : '');
    setBoxCountInput(existingLog.box_count ? String(existingLog.box_count) : '');
    setCapturedImage(existingLog.temp_sensor_image);
    setSelectedChamberType(existingLog.chamber_type || getChamberTypeAndDefault(item.chamber_id).type);
    setUpdateTimeInput('');
    setShowClientDropdown(false);
    if (existingLog.photo_capture_time) {
      try {
        const parsedDate = new Date(String(existingLog.photo_capture_time).replace(' ', 'T'));
        setCapturedImageTimestamp(isNaN(parsedDate.getTime()) ? null : parsedDate.getTime());
      } catch (e) {
        setCapturedImageTimestamp(null);
      }
    } else {
      setCapturedImageTimestamp(null);
    }

    setIsProfileEditable(true);
    setOpenedFromFab(false);
    setShowLogModal(true);
  };

  /**
   * Completed task → Edit requires Super Admin permission.
   * Approved → open edit form; otherwise show permission request popup (SA Role & Permission gets notification).
   */
  const handleEditCompletedLog = async (item) => {
    const todayStr = new Date().toISOString().split('T')[0];
    const targetDate = item.due_date || todayStr;
    const targetShiftName = item.shift_time === '10:00' || item.shift_time === '10:00 AM' ? 'Morning' : 'Evening';

    const existingLog = completedLogs.find(l =>
      l.chamber_id === item.chamber_id &&
      l.client_name === item.client_name &&
      l.entry_date === targetDate &&
      l.shift === targetShiftName
    ) || completedLogs.find(l =>
      l.chamber_id === item.chamber_id &&
      l.client_name === item.client_name &&
      l.entry_date === targetDate
    );

    if (!existingLog) {
      Alert.alert('Not Found', 'Completed log was not found on this device.');
      return;
    }

    if (existingLog.sync_status !== 'synced') {
      Alert.alert(
        'Sync Required',
        'This log is still in the device queue. Wait until it syncs to the cloud, then request edit permission.'
      );
      triggerSync(apiUrl, token, (status) => {
        setSyncStatus(status);
        loadInspectionsAndSummary();
      });
      return;
    }

    const serverLogId = getServerLogIdForPermission(existingLog);
    if (!serverLogId) {
      Alert.alert(
        'Permission Unavailable',
        'Server log ID is missing. Pull to refresh / sync again, then retry Edit.'
      );
      return;
    }

    try {
      setPermissionModal(prev => ({ ...prev, loading: true }));
      const res = await fetch(
        `${apiUrl}/api/permission-requests/check?record_type=${encodeURIComponent('Chamber')}&record_id=${encodeURIComponent(serverLogId)}&action=Edit`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json'
          }
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || 'Failed to verify permission.');
      }

      if (data.approved) {
        setPermissionModal({ isOpen: false, status: 'None', log: null, taskItem: null, loading: false });
        openEditableLogForm(item, existingLog);
        return;
      }

      setPermissionModal({
        isOpen: true,
        status: data.status || 'None',
        log: { ...existingLog, server_log_id: serverLogId },
        taskItem: item,
        loading: false
      });
    } catch (err) {
      setPermissionModal(prev => ({ ...prev, loading: false }));
      Alert.alert('Permission Check Failed', err.message || 'Please try again.');
    }
  };

  const handleRequestEditPermission = async () => {
    const log = permissionModal.log;
    const serverLogId = getServerLogIdForPermission(log);
    if (!log || !serverLogId) return;

    setPermissionRequestBusy(true);
    try {
      const descText =
        `Requested permission to edit Chamber log (Ref: ${log.reference_no || ('ID: ' + serverLogId)})` +
        ` | Client: ${log.client_name || 'N/A'} | Chamber: ${log.chamber_name || 'N/A'}` +
        ` | Shift: ${log.shift || 'N/A'} | Temp: ${log.box_temp ?? 'N/A'}°C` +
        ` | Mobile native app`;

      const res = await fetch(`${apiUrl}/api/permission-requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        },
        body: JSON.stringify({
          record_type: 'Chamber',
          record_id: serverLogId,
          action: 'Edit',
          description: descText
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || 'Failed to request permission.');
      }

      setPermissionModal(prev => ({ ...prev, status: 'Pending' }));
      // Refresh bell so Pending→Approved shows soon after SA acts
      try {
        const listRes = await fetch(`${apiUrl}/api/permission-requests?_=${Date.now()}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
        });
        if (listRes.ok) {
          const listData = await listRes.json().catch(() => []);
          if (Array.isArray(listData)) setPermissionNotifications(listData);
        }
      } catch (e) {
        /* ignore */
      }
      Alert.alert(
        'Request Sent',
        'Edit permission request sent to Super Admin. When approved, a message will appear on the notification bell.'
      );
    } catch (err) {
      Alert.alert('Request Failed', err.message || 'Could not send permission request.');
    } finally {
      setPermissionRequestBusy(false);
    }
  };

  const handleOpenChamberLogFormDirect = (chamber) => {
    if (!chamber) return;

    const masterClients = getClientsForChamber(chamber.id);
    if (masterClients.length === 0) {
      Alert.alert(
        'Add clients first',
        `"${chamber.name}" pe abhi koi client nahi. Master Setup me add karo.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Master Setup', onPress: () => openMasterSetupAddClients(chamber) }
        ]
      );
      return;
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const target = getChamberClientTarget(chamber.id);
    const done = countLoggedClientsForChamber(chamber.id, activeShift, todayStr);
    if (target != null && done >= target) {
      Alert.alert('Chamber Completed', `All ${target} client(s) already logged for this chamber.`);
      return;
    }
    
    const unloggedClient =
      masterClients.find(item => !isClientCompletedToday(chamber.id, item.client_name)) ||
      masterClients[0];
    
    setSelectedChamber(chamber);
    setSelectedClient(unloggedClient.client_name);
    setTempInput('');
    setBoxCountInput('');
    setCapturedImage(null);
    setCapturedImageTimestamp(null);
    setSelectedChamberType(getChamberTypeAndDefault(chamber.id).type);
    setIsProfileEditable(true);
    setOpenedFromFab(false);
    setEditingExistingLog(null);
    setShowClientDropdown(false);
    setShowLogModal(true);
  };

  // Opens Log Form when selected chamber is active
  const handleOpenChamberLogForm = () => {
    if (!selectedChamber) return;
    
    const chamberClients = assignments.filter(item => item.chamber_id === selectedChamber.id);
    const unloggedClient = chamberClients.find(item => !isClientCompletedToday(selectedChamber.id, item.client_name));
    
    if (!unloggedClient) {
      Alert.alert('Chamber Completed', 'All clients in this chamber have already been logged today.');
      return;
    }
    
    setSelectedClient(unloggedClient.client_name);
    setTempInput('');
    setBoxCountInput('');
    setCapturedImage(null);
    setCapturedImageTimestamp(null);
    setSelectedChamberType(getChamberTypeAndDefault(selectedChamber.id).type);
    setIsProfileEditable(true);
    setOpenedFromFab(false);
    setShowClientDropdown(false);
    setShowLogModal(true);
  };

  // ==========================================
  // VIEW RENDERERS
  // ==========================================

  // A. DASHBOARD VIEW
  const renderDashboardView = () => {
    const alertCount = completedLogs.filter(log => {
      const pattern = getChamberTypeAndDefault(log.chamber_id);
      if (pattern.type === 'Frozen') return log.box_temp > -18;
      if (pattern.type === 'Chilled' && (log.box_temp < -5 || log.box_temp > 5)) return true;
      if (pattern.type === 'Plus' && log.box_temp <= 0) return true;
      return false;
    }).length;

    return (
      <ScrollView 
        contentContainerStyle={styles.scrollContainer} 
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={["#003580"]} />
        }
      >
        {/* Welcome Greeting Banner */}
        <View style={styles.welcomeCard}>
          <View style={styles.welcomeInfo}>
            <Text style={styles.welcomeText}>Welcome, {displayName}</Text>
            <Text style={styles.roleText}>Operator</Text>
            
            <View style={styles.warehouseRow}>
              <Ionicons name="business-outline" size={16} color="#93c5fd" />
              <Text style={styles.warehouseText}>Warehouse: {user.warehouse_name || 'Generic'}</Text>
            </View>
          </View>
          
          {/* Calendar Widget Card */}
          <View style={styles.dateContainer}>
            <Text style={styles.dateText}>{currentDateStr || '01 Aug 2026'}</Text>
            <View style={styles.dateSub}>
              <Ionicons name="calendar-outline" size={12} color="#64748b" style={{ marginRight: 4 }} />
              <Text style={styles.dayText}>{currentDayStr || 'Saturday'}</Text>
            </View>
            <Text style={styles.timeText}>{currentTime || '01:39 PM'}</Text>
          </View>
        </View>

        {/* Offline Queue Indicator */}
        {unsyncedLogs.length > 0 && (
          <View style={styles.offlineAlertCard}>
            <Ionicons name="cloud-offline-outline" size={24} color="#ea580c" />
            <View style={styles.offlineAlertTextContainer}>
              <Text style={styles.offlineAlertTitle}>Offline Queue ({unsyncedLogs.length} logs)</Text>
              <Text style={styles.offlineAlertSubtitle}>Inspection logs queued locally on SQLite.</Text>
            </View>
            <TouchableOpacity 
              style={styles.syncBtn}
              onPress={() => triggerSync(apiUrl, token, (status) => {
                setSyncStatus(status);
                loadInspectionsAndSummary();
              })}
            >
              <Text style={styles.syncBtnText}>Upload Queue</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Today's Tasks Shift Selector */}
        <View style={{ paddingHorizontal: 15, marginBottom: 15 }}>
          <Text style={{ fontSize: 11, fontWeight: '800', color: '#64748b', textTransform: 'uppercase', marginBottom: 8, letterSpacing: 0.5 }}>
            Today's Tasks
          </Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            {/* Morning Shift Card */}
            {(() => {
              const showMorningRed = activeShift !== 'Morning' && !morningClicked && !isMorningCompleted;
              return (
                <TouchableOpacity
                  style={{
                    flex: 1,
                    backgroundColor: isMorningCompleted
                      ? '#f0fdf4'
                      : '#fffbeb',
                    borderColor: isMorningCompleted
                      ? '#86efac'
                      : '#eab308',
                    borderWidth: activeShift === 'Morning' || isMorningCompleted ? 1.5 : 1,
                    borderRadius: 8,
                    padding: 8,
                    alignItems: 'center',
                    flexDirection: 'row',
                    marginRight: 4,
                    elevation: 1,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.05,
                    shadowRadius: 2,
                  }}
                  activeOpacity={0.8}
                  onPress={() => handleSelectShift('Morning')}
                >
                  <View style={{
                    width: 26,
                    height: 26,
                    borderRadius: 13,
                    backgroundColor: isMorningCompleted
                      ? '#16a34a'
                      : '#eab308',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 6
                  }}>
                    <Ionicons
                      name={isMorningCompleted ? 'checkmark' : 'sunny'}
                      size={13}
                      color={isMorningCompleted ? '#ffffff' : '#ffffff'}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ 
                      fontSize: 11.5, 
                      fontWeight: showMorningRed ? '900' : '800', 
                      color: isMorningCompleted
                        ? '#15803d'
                        : (showMorningRed ? '#ef4444' : '#ca8a04')
                    }}>
                      Morning Task
                    </Text>
                    <Text style={{
                      fontSize: 8.5,
                      color: isMorningCompleted ? '#16a34a' : '#ca8a04',
                      fontWeight: '700',
                      marginTop: 0.5,
                      opacity: isMorningCompleted ? 1 : 0.85
                    }}>
                      {isMorningCompleted ? 'Completed' : 'Morning Slot'}
                    </Text>
                  </View>
                  {isMorningCompleted ? (
                    <Ionicons name="checkmark-circle" size={22} color="#16a34a" />
                  ) : null}
                </TouchableOpacity>
              );
            })()}

            {/* Evening Shift Card */}
            {(() => {
              const isEveningUnlocked = new Date().getHours() >= 16;
              const showEveningRed = activeShift !== 'Evening' && isEveningUnlocked && !eveningClicked && !isEveningCompleted;
              return (
                <TouchableOpacity
                  style={{
                    flex: 1,
                    backgroundColor: isEveningCompleted
                      ? '#f0fdf4'
                      : (activeShift === 'Evening' ? '#eff6ff' : (isEveningUnlocked ? '#ffffff' : '#f8fafc')),
                    borderColor: isEveningCompleted
                      ? '#86efac'
                      : (activeShift === 'Evening' ? '#2563eb' : '#e2e8f0'),
                    borderWidth: activeShift === 'Evening' || isEveningCompleted ? 1.5 : 1,
                    borderRadius: 8,
                    padding: 8,
                    alignItems: 'center',
                    flexDirection: 'row',
                    marginLeft: 4,
                    opacity: isEveningUnlocked || isEveningCompleted ? 1 : 0.7,
                    elevation: 1,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.05,
                    shadowRadius: 2,
                  }}
                  disabled={!isEveningUnlocked && !isEveningCompleted}
                  activeOpacity={0.8}
                  onPress={() => handleSelectShift('Evening')}
                >
                  <View style={{
                    width: 26,
                    height: 26,
                    borderRadius: 13,
                    backgroundColor: isEveningCompleted
                      ? '#16a34a'
                      : (activeShift === 'Evening' ? '#2563eb' : '#f1f5f9'),
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 6
                  }}>
                    <Ionicons 
                      name={
                        isEveningCompleted
                          ? 'checkmark'
                          : (isEveningUnlocked ? 'moon' : 'lock-closed')
                      }
                      size={13} 
                      color={isEveningCompleted || activeShift === 'Evening' ? '#ffffff' : '#475569'} 
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ 
                      fontSize: 11.5, 
                      fontWeight: showEveningRed ? '900' : '800', 
                      color: isEveningCompleted
                        ? '#15803d'
                        : (showEveningRed ? '#ef4444' : (activeShift === 'Evening' ? '#1e3a8a' : '#334155'))
                    }}>
                      Evening Task
                    </Text>
                    <Text style={{
                      fontSize: 8.5,
                      color: isEveningCompleted ? '#16a34a' : '#64748b',
                      fontWeight: '700',
                      marginTop: 0.5
                    }}>
                      {isEveningCompleted
                        ? 'Completed'
                        : (isEveningUnlocked ? 'Evening Slot' : 'Locks until evening')}
                    </Text>
                  </View>
                  {isEveningCompleted ? (
                    <Ionicons name="checkmark-circle" size={22} color="#16a34a" />
                  ) : null}
                </TouchableOpacity>
              );
            })()}
          </View>
        </View>

        {/* Horizontal scroll metrics ribbon */}
        <View style={styles.metricsContainer}>
          <View style={styles.metricsHeaderRow}>
            <Text style={styles.metricsTitle}>Inspection Status & Tasks</Text>
            <TouchableOpacity onPress={() => handleNavTabChange('Tasks')}>
              <Text style={styles.viewAllText}>View All</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.metricsRow}>
            {/* 0. All Tasks Card — chamber count */}
            <TouchableOpacity 
              style={[
                styles.metricCard, 
                { backgroundColor: '#eff6ff', borderColor: '#dbeafe' },
                activeTab === 'All' && styles.metricCardActive
              ]}
              activeOpacity={0.8}
              onPress={() => setActiveTab('All')}
            >
              <View style={[styles.metricIconCircle, { backgroundColor: '#dbeafe' }]}>
                <Ionicons name="list" size={18} color="#2563eb" />
              </View>
              <Text style={[styles.metricValue, { color: '#2563eb' }]}>
                {chambersList.length}
              </Text>
              <Text style={styles.metricLabel}>All Tasks</Text>
              <Text style={styles.metricSubtitle}>Chambers</Text>
            </TouchableOpacity>

            {/* 2. Pending Tasks Card — pending chambers */}
            <TouchableOpacity 
              style={[
                styles.metricCard, 
                { backgroundColor: '#fffbeb', borderColor: '#fef3c7' },
                activeTab === 'Pending' && styles.metricCardActive
              ]}
              activeOpacity={0.8}
              onPress={() => setActiveTab(activeTab === 'Pending' ? 'All' : 'Pending')}
            >
              <View style={[styles.metricIconCircle, { backgroundColor: '#fef3c7' }]}>
                <Ionicons name="document-text" size={18} color="#d97706" />
              </View>
              <Text style={[styles.metricValue, { color: '#d97706' }]}>
                {Math.max(0, chambersList.length - completedChambersCount)}
              </Text>
              <Text style={styles.metricLabel}>Pending</Text>
              <Text style={styles.metricSubtitle}>Chambers</Text>
            </TouchableOpacity>

            {/* 3. Completed Card — completed chambers */}
            <TouchableOpacity 
              style={[
                styles.metricCard, 
                { backgroundColor: '#f0fdf4', borderColor: '#dcfce7' },
                activeTab === 'Completed' && styles.metricCardActive
              ]}
              activeOpacity={0.8}
              onPress={() => setActiveTab(activeTab === 'Completed' ? 'All' : 'Completed')}
            >
              <View style={[styles.metricIconCircle, { backgroundColor: '#dcfce7' }]}>
                <Ionicons name="checkmark-circle" size={18} color="#16a34a" />
              </View>
              <Text style={[styles.metricValue, { color: '#16a34a' }]}>
                {completedChambersCount}
              </Text>
              <Text style={styles.metricLabel}>Completed</Text>
              <Text style={styles.metricSubtitle}>Chambers</Text>
            </TouchableOpacity>

            {/* 4. Overdue — unique overdue chambers */}
            <TouchableOpacity 
              style={[
                styles.metricCard, 
                { backgroundColor: '#f8fafc', borderColor: '#e2e8f0' },
                activeTab === 'Overdue' && styles.metricCardActive
              ]}
              activeOpacity={0.8}
              onPress={() => setActiveTab(activeTab === 'Overdue' ? 'All' : 'Overdue')}
            >
              <View style={[styles.metricIconCircle, { backgroundColor: '#e2e8f0' }]}>
                <Ionicons name="time" size={18} color="#64748b" />
              </View>
              <Text style={[styles.metricValue, { color: '#64748b' }]}>
                {new Set(overdueTasks.map((t) => Number(t.chamber_id))).size}
              </Text>
              <Text style={styles.metricLabel}>Overdue</Text>
              <Text style={styles.metricSubtitle}>Chambers</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* 2-column chambers grid view */}
        <View style={styles.metricsHeaderRow}>
          <Text style={styles.metricsTitle}>Chamber Overview ({chambersList.length} Chambers)</Text>
          <TouchableOpacity onPress={() => handleNavTabChange('Tasks')}>
            <Text style={styles.viewAllText}>View All</Text>
          </TouchableOpacity>
        </View>

        {(() => {
          const emptyClientChambers = chambersList.filter(
            (c) => getClientsForChamber(c.id).length === 0
          );
          if (chambersList.length === 0 || emptyClientChambers.length === 0) return null;
          const allEmpty = emptyClientChambers.length === chambersList.length;
          return (
            <TouchableOpacity
              style={styles.setupClientsBanner}
              onPress={() => openMasterSetupAddClients(emptyClientChambers[0])}
              activeOpacity={0.88}
            >
              <View style={styles.setupClientsBannerIcon}>
                <Ionicons name="people-outline" size={20} color="#0369a1" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.setupClientsBannerTitle}>
                  {allEmpty ? 'Add clients to start tasks' : 'Some chambers need clients'}
                </Text>
                <Text style={styles.setupClientsBannerSub}>
                  {allEmpty
                    ? 'Chamber-wise client master empty hai. Master Setup → Clients me add karo.'
                    : `${emptyClientChambers.length} chamber(s) me 0 clients — tap to add.`}
                </Text>
              </View>
              <Text style={styles.setupClientsBannerCta}>Add ➔</Text>
            </TouchableOpacity>
          );
        })()}

        <View style={styles.chambersGrid}>
          {getFilteredChambers().length === 0 ? (
            <View style={styles.emptyGridPlaceholder}>
              <Ionicons name="apps-outline" size={32} color="#94a3b8" />
              <Text style={styles.emptyGridText}>No chambers found matching "{activeTab}" filter.</Text>
            </View>
          ) : (
            getFilteredChambers().map((chamber) => {
              const details = getChamberDetails(chamber);
              const todayStr = new Date().toISOString().split('T')[0];
              const target = getChamberClientTarget(chamber.id);
              const doneCount = countLoggedClientsForChamber(chamber.id, activeShift, todayStr);
              const isDone = target != null && doneCount >= target;
              const clientCount = getClientsForChamber(chamber.id).length;
              const needsClients = clientCount === 0;

              return (
                <TouchableOpacity
                  key={chamber.id}
                  style={[
                    styles.chamberCard, 
                    details.hasAlert && styles.chamberCardAlertBorder,
                    needsClients && styles.chamberCardNeedsClients
                  ]}
                  onPress={() => {
                    if (needsClients) {
                      openMasterSetupAddClients(chamber);
                      return;
                    }
                    handleOpenChamberLogFormDirect(chamber);
                  }}
                >
                  {/* Left: Chamber details */}
                  <View style={{ flex: 1, alignItems: 'flex-start' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                      <Ionicons name={details.icon} size={14} color={details.pillColor} style={{ marginRight: 6 }} />
                      <Text style={{ fontSize: 13, fontWeight: 'bold', color: '#1e293b' }}>{chamber.name}</Text>
                    </View>
                    <View style={[styles.typePill, { backgroundColor: details.pillBg, marginVertical: 0 }]}>
                      <Text style={[styles.typePillText, { color: details.pillColor }]}>{details.type}</Text>
                    </View>
                    <Text style={{
                      fontSize: 10,
                      fontWeight: '700',
                      color: needsClients ? '#0369a1' : '#64748b',
                      marginTop: 6
                    }}>
                      {needsClients ? '0 clients · Tap to add' : `${clientCount} client${clientCount === 1 ? '' : 's'}`}
                    </Text>
                  </View>

                  {/* Right: Status */}
                  <View style={{ alignItems: 'flex-end', justifyContent: 'center' }}>
                    {needsClients ? (
                      <View style={styles.addClientChip}>
                        <Text style={styles.addClientChipText}>Add</Text>
                      </View>
                    ) : (
                      <View style={[styles.statusIndicatorRow, { marginTop: 0 }]}>
                        <View style={[styles.statusDot, { backgroundColor: isDone ? '#16a34a' : details.statusColor }]} />
                        <Text style={[styles.statusText, { color: isDone ? '#16a34a' : details.statusColor, fontSize: 11 }]}>
                          {isDone ? 'Done' : 'Pending'}
                        </Text>
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </View>

        <View style={{ height: 90 }} />
      </ScrollView>
    );
  };

  // B. TASKS TAB VIEW
  const renderTasksView = () => {
    const taskRows = getTasksScreenList(activeTab);

    return (
      <View style={styles.tabContainer}>
        {/* Top Filters */}
        <View style={styles.filterTabsRow}>
          {['All', 'Pending', 'Completed', 'Overdue'].map((tab) => {
            const count = getTasksScreenList(tab).length;
            return (
              <TouchableOpacity
                key={tab}
                style={[styles.filterTabButton, activeTab === tab && styles.filterTabButtonActive]}
                onPress={() => setActiveTab(tab)}
              >
                <Text style={[styles.filterTabButtonText, activeTab === tab && styles.filterTabButtonTextActive]}>
                  {tab} ({count})
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Tab Caption Info Box */}
        <View style={styles.tasksInfoBanner}>
          <Text style={styles.tasksInfoTitle}>{activeTab} tasks</Text>
          <Text style={styles.tasksInfoText}>
            {activeTab === 'All' && 'Chamber tasks with total client lots. Stays Pending until every client is logged.'}
            {activeTab === 'Pending' && 'Select each client lot and submit. Chamber stays here until all clients are done.'}
            {activeTab === 'Completed' && 'Client-wise completed logs (only after each client submit).'}
            {activeTab === 'Overdue' && 'Missed chamber audits from the past 2 days.'}
          </Text>
        </View>

        <ScrollView 
          contentContainerStyle={{ paddingHorizontal: 15, paddingTop: 10, paddingBottom: 100 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={["#003580"]} />
          }
        >
          {taskRows.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="clipboard-outline" size={44} color="#94a3b8" />
              <Text style={styles.emptyText}>No tasks found in "{activeTab}" filter.</Text>
            </View>
          ) : (
            taskRows.map((item, idx) => {
              const isChamberRow = !!item.is_chamber_task;
              const targetDate = item.due_date || new Date().toISOString().split('T')[0];
              const targetShiftName = item.shift_time === '10:00' ? 'Morning' : 'Evening';

              const log = isChamberRow || item.is_overdue
                ? null
                : completedLogs.find(l =>
                    Number(l.chamber_id) === Number(item.chamber_id) &&
                    l.client_name === item.client_name &&
                    l.entry_date === targetDate &&
                    (l.shift === targetShiftName ||
                      (!l.shift && (!item.shift_time || l.inspection_time === item.shift_time)))
                  );

              const isCompleted = activeTab === 'Completed'
                ? true
                : (isChamberRow ? !!item.is_completed : !!log);
              const pattern = getChamberTypeAndDefault(item.chamber_id);
              
              let hasWarning = false;
              if (log) {
                const checkType = log.chamber_type || pattern.type;
                if (checkType === 'Frozen' && log.box_temp > -18) hasWarning = true;
                if (checkType === 'Chilled' && (log.box_temp < -5 || log.box_temp > 5)) hasWarning = true;
                if (checkType === 'Dry' && (log.box_temp < 15 || log.box_temp > 25)) hasWarning = true;
              }

              const statusLabel = isCompleted
                ? 'Done'
                : (item.is_overdue ? 'Overdue' : 'Pending');

              const shiftLabel =
                item.shift_label || (item.shift_time === '10:00' ? 'Morning' : 'Evening');
              const isEveningShift =
                item.shift_time === '16:00' || /evening/i.test(String(shiftLabel));
              const shiftColor = isEveningShift ? '#2563eb' : '#ca8a04'; // Evening blue · Morning yellow (dashboard match)

              const titleText = isChamberRow
                ? (item.chamber_name || `Chamber ${item.chamber_id}`)
                : (item.client_name || 'Client');

              const prefixMeta = isChamberRow
                ? (item.is_overdue && item.due_date ? `Due ${item.due_date}` : null)
                : (item.chamber_name || null);

              return (
                <View
                  key={
                    isChamberRow
                      ? `ch_${item.chamber_id}_${item.shift_time || 'na'}_${item.due_date || 'today'}_${idx}`
                      : `${item.chamber_id}_${item.client_name}_${item.shift_time || 'na'}_${idx}`
                  }
                  style={[
                    styles.taskItemCard,
                    isCompleted && styles.taskItemCardCompleted,
                    item.is_overdue && !isCompleted && styles.taskItemCardOverdue
                  ]}
                >
                  <View
                    style={[
                      styles.taskCardAccent,
                      isCompleted
                        ? styles.taskCardAccentDone
                        : item.is_overdue
                          ? styles.taskCardAccentOverdue
                          : styles.taskCardAccentPending
                    ]}
                  />

                  <View style={[styles.taskCardBody, isChamberRow && { alignItems: 'flex-start' }]}>
                    <TouchableOpacity
                      style={styles.taskCardMain}
                      activeOpacity={0.7}
                      onPress={() => {
                        if (isChamberRow) {
                          const chamber =
                            chambersList.find((c) => Number(c.id) === Number(item.chamber_id)) || {
                              id: item.chamber_id,
                              name: item.chamber_name
                            };
                          if (item.shift_time === '16:00') handleSelectShift('Evening');
                          else handleSelectShift('Morning');
                          handleOpenChamberLogFormDirect(chamber);
                        } else if (isCompleted) {
                          handleOpenTaskDetail(item);
                        } else {
                          handleOpenTaskLogForm(item);
                        }
                      }}
                    >
                      <Text style={styles.taskClientName} numberOfLines={1}>
                        {titleText}
                      </Text>

                      <Text style={styles.taskMetaLine} numberOfLines={1}>
                        {prefixMeta ? `${prefixMeta}  ·  ` : ''}
                        <Text style={{ color: shiftColor, fontWeight: '800' }}>{shiftLabel}</Text>
                      </Text>

                      {isChamberRow && item.target_set ? (
                        <Text style={{ fontSize: 11, fontWeight: '600', color: '#64748b', marginTop: 4 }}>
                          Logged {Number(item.clients_done) || 0}/{Number(item.clients_total) || 0} clients
                        </Text>
                      ) : null}

                      {item.is_overdue && !isChamberRow ? (
                        <Text style={styles.taskOverdueDateText}>
                          Due {item.due_date}
                        </Text>
                      ) : null}

                      {isCompleted && log && !isChamberRow ? (
                        <View style={styles.taskReadingRow}>
                          <Text style={[styles.readingLoggedText, hasWarning && { color: '#64748b' }]}>
                            {log.box_temp}°C
                          </Text>
                          <Text style={styles.taskLoggedTime}>
                            {log.inspection_time || item.shift_label || ''}
                          </Text>
                        </View>
                      ) : null}
                    </TouchableOpacity>

                    <View style={styles.taskCardActions}>
                      <Text
                        style={[
                          styles.taskStatusLabel,
                          isCompleted
                            ? styles.taskStatusDone
                            : item.is_overdue
                              ? styles.taskStatusOverdue
                              : styles.taskStatusPending
                        ]}
                      >
                        {statusLabel}
                      </Text>
                      {!isCompleted ? (
                        <TouchableOpacity
                          style={styles.logActionBtn}
                          onPress={() => {
                            if (isChamberRow) {
                              const chamber =
                                chambersList.find((c) => Number(c.id) === Number(item.chamber_id)) || {
                                  id: item.chamber_id,
                                  name: item.chamber_name
                                };
                              if (item.shift_time === '16:00') handleSelectShift('Evening');
                              else handleSelectShift('Morning');
                              handleOpenChamberLogFormDirect(chamber);
                            } else {
                              handleOpenTaskLogForm(item);
                            }
                          }}
                          activeOpacity={0.85}
                        >
                          <Ionicons name="thermometer-outline" size={14} color="#ffffff" style={{ marginRight: 4 }} />
                          <Text style={styles.logActionBtnText}>Record Log</Text>
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity
                          style={styles.logActionBtn}
                          onPress={() => {
                            if (isChamberRow) {
                              const targetDate = item.due_date || new Date().toISOString().split('T')[0];
                              const shiftName = item.shift_time === '16:00' ? 'Evening' : 'Morning';
                              const chamberLog = completedLogs.find(
                                (l) =>
                                  Number(l.chamber_id) === Number(item.chamber_id) &&
                                  l.entry_date === targetDate &&
                                  (l.shift === shiftName ||
                                    (!l.shift &&
                                      ((shiftName === 'Evening' && l.inspection_time === '16:00') ||
                                        (shiftName === 'Morning' && (l.inspection_time === '10:00' || !l.inspection_time)))))
                              );
                              if (!chamberLog) {
                                Alert.alert('Edit', 'Is chamber ke liye abhi koi completed client log nahi mila.');
                                return;
                              }
                              if (item.shift_time === '16:00') handleSelectShift('Evening');
                              else handleSelectShift('Morning');
                              handleEditCompletedLog({
                                ...item,
                                chamber_id: chamberLog.chamber_id,
                                chamber_name: chamberLog.chamber_name || item.chamber_name,
                                client_name: chamberLog.client_name,
                                shift_time: item.shift_time || (shiftName === 'Evening' ? '16:00' : '10:00'),
                                shift_label: item.shift_label || `${shiftName} Task`
                              });
                            } else {
                              handleEditCompletedLog(item);
                            }
                          }}
                          activeOpacity={0.85}
                        >
                          <Ionicons name="create-outline" size={14} color="#ffffff" style={{ marginRight: 4 }} />
                          <Text style={styles.logActionBtnText}>Edit</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>
      </View>
    );
  };

  // Same filters as Reports screen (DO scope + chamber + client + slot + search)
  const getFilteredReportLogs = () => {
    const accessAssignments = assignments.filter((a) => a && a.status !== 'inactive');
    const accessChamberIds = new Set(accessAssignments.map((a) => Number(a.chamber_id)));
    const shiftRank = (log) => {
      const s = String(log?.shift || '').trim().toLowerCase();
      if (s === 'evening') return 1;
      if (s === 'morning') return 0;
      const t = String(log?.inspection_time || '');
      if (/^16:00|^18:00/.test(t)) return 1;
      return 0;
    };
    const timeKey = (log) =>
      String(log?.updated_at || log?.created_at || log?.photo_capture_time || log?.inspection_time || '');

    return getAllLocalInspections(displayName)
      .filter((log) => {
        if (!log) return false;
        if (accessChamberIds.size > 0 && !accessChamberIds.has(Number(log.chamber_id))) return false;
        if (
          reportChamberFilter !== 'all' &&
          Number(log.chamber_id) !== Number(reportChamberFilter)
        ) {
          return false;
        }
        if (
          reportClientFilter !== 'all' &&
          String(log.client_name) !== String(reportClientFilter)
        ) {
          return false;
        }
        if (reportShiftFilter !== 'all') {
          const resolved = normalizeShiftLabel(log.shift || log.inspection_time);
          if (resolved !== reportShiftFilter) return false;
        }
        // Calendar date range (From → To)
        const entryDay = String(log.entry_date || '').slice(0, 10);
        if (entryDay) {
          const from = reportDateFrom <= reportDateTo ? reportDateFrom : reportDateTo;
          const to = reportDateFrom <= reportDateTo ? reportDateTo : reportDateFrom;
          if (entryDay < from || entryDay > to) return false;
        }
        if (reportSearchQuery.trim()) {
          const q = reportSearchQuery.toLowerCase().trim();
          const hay = `${log.client_name || ''} ${log.chamber_name || ''} ${log.reference_no || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Latest on top: date DESC → Evening before Morning → timestamp DESC → id DESC
        const da = String(a.entry_date || '');
        const db = String(b.entry_date || '');
        if (db !== da) return db.localeCompare(da);
        const sr = shiftRank(b) - shiftRank(a);
        if (sr !== 0) return sr;
        const ta = timeKey(a);
        const tb = timeKey(b);
        if (tb !== ta) return tb.localeCompare(ta);
        return (Number(b.id) || 0) - (Number(a.id) || 0);
      });
  };

  // Modal to display Client Box Inventory Reports in a dedicated overlay view
  const renderInventoryModal = () => {
    if (!showInventoryModal) return null;

    const allInspections = getAllLocalInspections(displayName);
    
    // Group logs
    const clientInventory = {};
    allInspections.forEach(log => {
      if (!log.client_name || !log.chamber_name) return;
      const key = `${log.client_name}_${log.chamber_name}`.toLowerCase();
      if (!clientInventory[key]) {
        clientInventory[key] = {
          clientName: log.client_name,
          chamberName: log.chamber_name,
          chamberType: log.chamber_type || 'Frozen',
          history: []
        };
      }
      clientInventory[key].history.push({
        date: log.entry_date,
        boxCount: log.box_count || 0,
        temp: log.box_temp,
        time: log.inspection_time
      });
    });

    const inventoryList = Object.values(clientInventory).map(item => {
      item.history.sort((a, b) => b.date.localeCompare(a.date));
      item.currentCount = item.history.length > 0 ? item.history[0].boxCount : 0;
      return item;
    });

    const filteredInventoryList = inventoryList.filter(item => {
      if (inventoryClientSearch.trim() !== '') {
        if (!item.clientName.toLowerCase().includes(inventoryClientSearch.toLowerCase())) {
          return false;
        }
      }
      if (inventoryChamberSearch.trim() !== '') {
        if (!item.chamberName.toLowerCase().includes(inventoryChamberSearch.toLowerCase())) {
          return false;
        }
      }
      return true;
    });

    return (
      <Modal visible={showInventoryModal} animationType="slide" transparent={false} onRequestClose={() => setShowInventoryModal(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#f1f5f9' }}>
          {/* Header */}
          <View style={{
            height: 56,
            backgroundColor: '#003580',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            elevation: 4,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.1,
            shadowRadius: 3
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Ionicons name="cube" size={22} color="#ffffff" style={{ marginRight: 8 }} />
              <Text style={{ fontSize: 16, fontWeight: 'bold', color: '#ffffff' }}>Client Box Inventory</Text>
            </View>
            <TouchableOpacity onPress={() => setShowInventoryModal(false)} style={{ padding: 4 }}>
              <Ionicons name="close-circle" size={24} color="#ffffff" />
            </TouchableOpacity>
          </View>

          {/* Search Filters Row */}
          <View style={{ 
            flexDirection: 'row', 
            paddingHorizontal: 16, 
            paddingVertical: 10, 
            backgroundColor: '#ffffff', 
            borderBottomWidth: 1, 
            borderColor: '#e2e8f0',
            zIndex: 10
          }}>
            {/* Client Dropdown */}
            <View style={{ flex: 1, marginRight: 8, position: 'relative' }}>
              <TouchableOpacity 
                style={{
                  height: 38,
                  backgroundColor: '#f8fafc',
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: '#cbd5e1',
                  paddingHorizontal: 10,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }}
                onPress={() => {
                  setShowInventoryClientDropdown(!showInventoryClientDropdown);
                  setShowInventoryChamberDropdown(false);
                }}
              >
                <Text style={{ fontSize: 11, color: '#1e293b', fontWeight: '600' }} numberOfLines={1}>
                  {inventoryClientSearch || 'All Clients'}
                </Text>
                <Ionicons name={showInventoryClientDropdown ? 'chevron-up' : 'chevron-down'} size={14} color="#64748b" />
              </TouchableOpacity>

              {showInventoryClientDropdown && (
                <View style={{
                  position: 'absolute',
                  top: 42,
                  left: 0,
                  right: 0,
                  backgroundColor: '#ffffff',
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: '#cbd5e1',
                  maxHeight: 150,
                  zIndex: 20,
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.15,
                  shadowRadius: 4,
                  elevation: 5
                }}>
                  <ScrollView nestedScrollEnabled={true} keyboardShouldPersistTaps="handled">
                    <TouchableOpacity 
                      style={{ padding: 10, borderBottomWidth: 0.5, borderColor: '#f1f5f9' }}
                      onPress={() => {
                        setInventoryClientSearch('');
                        setShowInventoryClientDropdown(false);
                      }}
                    >
                      <Text style={{ fontSize: 11, color: '#0f172a', fontWeight: '700' }}>All Clients</Text>
                    </TouchableOpacity>
                    {Array.from(new Set(assignments.map(a => a.client_name).filter(Boolean))).sort().map(clientName => (
                      <TouchableOpacity 
                        key={clientName}
                        style={{ padding: 10, borderBottomWidth: 0.5, borderColor: '#f1f5f9' }}
                        onPress={() => {
                          setInventoryClientSearch(clientName);
                          setShowInventoryClientDropdown(false);
                        }}
                      >
                        <Text style={{ fontSize: 11, color: '#334155' }}>{clientName}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}
            </View>

            {/* Chamber Dropdown */}
            <View style={{ flex: 1, position: 'relative' }}>
              <TouchableOpacity 
                style={{
                  height: 38,
                  backgroundColor: '#f8fafc',
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: '#cbd5e1',
                  paddingHorizontal: 10,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }}
                onPress={() => {
                  setShowInventoryChamberDropdown(!showInventoryChamberDropdown);
                  setShowInventoryClientDropdown(false);
                }}
              >
                <Text style={{ fontSize: 11, color: '#1e293b', fontWeight: '600' }} numberOfLines={1}>
                  {inventoryChamberSearch || 'All Chambers'}
                </Text>
                <Ionicons name={showInventoryChamberDropdown ? 'chevron-up' : 'chevron-down'} size={14} color="#64748b" />
              </TouchableOpacity>

              {showInventoryChamberDropdown && (
                <View style={{
                  position: 'absolute',
                  top: 42,
                  left: 0,
                  right: 0,
                  backgroundColor: '#ffffff',
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: '#cbd5e1',
                  maxHeight: 150,
                  zIndex: 20,
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.15,
                  shadowRadius: 4,
                  elevation: 5
                }}>
                  <ScrollView nestedScrollEnabled={true} keyboardShouldPersistTaps="handled">
                    <TouchableOpacity 
                      style={{ padding: 10, borderBottomWidth: 0.5, borderColor: '#f1f5f9' }}
                      onPress={() => {
                        setInventoryChamberSearch('');
                        setShowInventoryChamberDropdown(false);
                      }}
                    >
                      <Text style={{ fontSize: 11, color: '#0f172a', fontWeight: '700' }}>All Chambers</Text>
                    </TouchableOpacity>
                    {Array.from(new Set(assignments.map(a => a.chamber_name).filter(Boolean))).sort().map(chamberName => (
                      <TouchableOpacity 
                        key={chamberName}
                        style={{ padding: 10, borderBottomWidth: 0.5, borderColor: '#f1f5f9' }}
                        onPress={() => {
                          setInventoryChamberSearch(chamberName);
                          setShowInventoryChamberDropdown(false);
                        }}
                      >
                        <Text style={{ fontSize: 11, color: '#334155' }}>{chamberName}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}
            </View>
          </View>

          {/* List content */}
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
            {filteredInventoryList.length === 0 ? (
              <View style={[styles.reportsEmptyRow, { backgroundColor: '#ffffff', padding: 24, borderRadius: 12 }]}>
                <Ionicons name="cube-outline" size={32} color="#94a3b8" />
                <Text style={[styles.reportsEmptyText, { marginTop: 10 }]}>No client inventory data matching filter.</Text>
              </View>
            ) : (
              filteredInventoryList.map((item, idx) => {
                const latest = item.history[0];
                const showTrend = item.history.length > 1;
                const diff = showTrend ? (latest.boxCount - item.history[1].boxCount) : 0;

                return (
                  <View key={`${item.clientName}_${item.chamberName}_${idx}`} style={[styles.inventoryItemCard, { backgroundColor: '#ffffff', elevation: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2 }]}>
                    <View style={styles.inventoryItemHeader}>
                      <View style={{ flex: 1, paddingRight: 8 }}>
                        <Text style={styles.inventoryClientName}>{item.clientName}</Text>
                        <Text style={styles.inventoryChamberLabel}>
                          <Text style={{ fontWeight: 'bold', color: '#475569' }}>{item.chamberName}</Text> • {item.chamberType}
                        </Text>
                      </View>
                      <View style={styles.inventoryCountBadge}>
                        <Text style={styles.inventoryCountText}>{item.currentCount} Boxes</Text>
                      </View>
                    </View>

                    {/* Trend Indicator */}
                    {showTrend && (
                      <View style={[styles.inventoryTrendRow, { backgroundColor: '#f8fafc' }]}>
                        <Ionicons 
                          name={diff < 0 ? "trending-down-outline" : "trending-up-outline"} 
                          size={16} 
                          color={diff < 0 ? "#ef4444" : "#16a34a"} 
                        />
                        <Text style={[styles.inventoryTrendText, { color: diff < 0 ? "#ef4444" : "#16a34a", flex: 1, flexWrap: 'wrap' }]}>
                          {diff < 0 ? `Reduced by ${Math.abs(diff)}` : `Increased by ${diff}`} boxes since last reading ({item.history[1].boxCount} ➔ {latest.boxCount})
                        </Text>
                      </View>
                    )}

                    {/* Recent updates list */}
                    <View style={styles.inventoryHistoryList}>
                      <Text style={styles.historyListTitle}>Recent Logs History:</Text>
                      {item.history.slice(0, 3).map((hist, hIdx) => (
                        <View key={hIdx} style={styles.historyRow}>
                          <Text style={styles.historyDate}>{hist.date} ({hist.time})</Text>
                          <Text style={styles.historyBoxes}>{hist.boxCount} Boxes ({hist.temp}°C)</Text>
                        </View>
                      ))}
                      
                      <TouchableOpacity 
                        style={{ 
                          marginTop: 8, 
                          flexDirection: 'row', 
                          alignItems: 'center', 
                          justifyContent: 'center', 
                          backgroundColor: '#eff6ff', 
                          borderColor: '#bfdbfe', 
                          borderWidth: 1, 
                          borderRadius: 8, 
                          paddingVertical: 6,
                          width: '100%'
                        }}
                        onPress={() => {
                          setSelectedInventoryItem(item);
                          setShowHistoryModal(true);
                        }}
                      >
                        <Ionicons name="eye-outline" size={14} color="#1d4ed8" style={{ marginRight: 6 }} />
                        <Text style={{ fontSize: 11, fontWeight: '700', color: "#1d4ed8" }}>View Full History</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    );
  };

  const renderNotificationsModal = () => {
    const { pendingMorning, pendingEvening, isEveningUnlocked } = getActiveTasksDetails();
    const hasMorningPending = pendingMorning.length > 0;
    const hasEveningPending = isEveningUnlocked && pendingEvening.length > 0;
    const permissionAlerts = getActivePermissionAlerts();

    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    const formattedDate = `${dd}/${mm}/${yyyy}`;

    return (
      <Modal
        visible={showNotificationsModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowNotificationsModal(false)}
      >
        <View style={[styles.modalOverlay, { justifyContent: 'flex-start' }]}>
          <View style={[styles.modalContainer, { 
            maxHeight: '85%', 
            width: '100%', 
            padding: 0, 
            borderTopLeftRadius: 0, 
            borderTopRightRadius: 0, 
            borderBottomLeftRadius: 20, 
            borderBottomRightRadius: 20 
          }]}>
            <View style={{ 
              flexDirection: 'row', 
              justifyContent: 'space-between', 
              alignItems: 'center', 
              paddingHorizontal: 20, 
              paddingVertical: 18,
              backgroundColor: '#003580',
              borderBottomWidth: 1, 
              borderColor: 'rgba(255, 255, 255, 0.1)' 
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="notifications" size={20} color="#ffffff" />
                <Text style={{ fontSize: 16, fontWeight: '800', color: '#ffffff' }}>Notification Center</Text>
              </View>
              <TouchableOpacity onPress={() => setShowNotificationsModal(false)}>
                <Ionicons name="close" size={24} color="#ffffff" />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={{ padding: 12, backgroundColor: '#ffffff', paddingBottom: 20 }}>
              {/* Super Admin edit approval / denial cards */}
              {permissionAlerts.map((notif) => {
                const meta = parsePermissionTaskMeta(notif);
                const isApproved = notif.status === 'Approved';
                const shiftLabel = meta.shift || 'Shift';
                return (
                  <TouchableOpacity
                    key={`perm-${notif.id}`}
                    style={{
                      backgroundColor: '#ffffff',
                      borderRadius: 10,
                      padding: 10,
                      marginBottom: 8,
                      borderLeftWidth: 3,
                      borderColor: isApproved ? '#16a34a' : '#ef4444',
                      elevation: 1,
                      shadowColor: '#000',
                      shadowOffset: { width: 0, height: 1 },
                      shadowOpacity: 0.05,
                      shadowRadius: 2,
                      width: '100%',
                    }}
                    activeOpacity={0.9}
                    onPress={() => openPermissionNotificationTask(notif)}
                  >
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <Text style={{ fontSize: 9.5, fontWeight: '800', color: '#64748b' }}>
                      {notif.record_type === 'MasterSetup'
                        ? 'Master Setup'
                        : notif.record_type === 'ChamberMaster'
                          ? (/ADD chamber/i.test(String(notif.description || ''))
                            ? 'Chamber Add'
                            : 'Chamber Delete')
                          : notif.record_type === 'ClientMaster'
                            ? (/EDIT client|UPDATE_CLIENT|edited client/i.test(String(notif.description || notif.action || ''))
                              ? 'Client Edit (Notify)'
                              : 'Client Delete (Notify)')
                            : 'Edit Permission'}{' '}
                      · {formattedDate}
                    </Text>
                      <View style={{
                        backgroundColor:
                          notif.record_type === 'ClientMaster' || notif.record_type === 'MasterSetup'
                            ? '#eff6ff'
                            : (isApproved ? '#f0fdf4' : '#fef2f2'),
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: 4
                      }}>
                        <Text style={{
                          fontSize: 9,
                          fontWeight: '800',
                          color:
                            notif.record_type === 'ClientMaster'
                              ? '#1d4ed8'
                              : notif.record_type === 'MasterSetup'
                                ? '#0369a1'
                                : (isApproved ? '#16a34a' : '#ef4444')
                        }}>
                          {notif.record_type === 'ClientMaster'
                            ? 'NOTIFY'
                            : notif.record_type === 'MasterSetup'
                              ? 'OPEN'
                              : (isApproved ? 'APPROVED' : 'DENIED')}
                        </Text>
                      </View>
                    </View>

                    <Text style={{ fontSize: 12, fontWeight: '700', color: '#1e293b', lineHeight: 16, marginBottom: 2 }}>
                      {notif.record_type === 'MasterSetup'
                        ? 'Chambers & Clients management'
                        : notif.record_type === 'ChamberMaster'
                          ? (
                            String(notif.description || '').match(/ADD chamber "([^"]+)"/i)?.[1] ||
                            String(notif.description || '').match(/delete chamber "([^"]+)"/i)?.[1] ||
                            `Chamber #${notif.record_id}`
                          )
                          : notif.record_type === 'ClientMaster'
                            ? (
                              String(notif.description || '').match(/EDIT client "([^"]+)"/i)?.[1] ||
                              String(notif.description || '').match(/DELETE client "([^"]+)"/i)?.[1] ||
                              'Client master'
                            )
                          : `${meta.chamber_name} · ${meta.client_name}`}
                    </Text>
                    <Text style={{ fontSize: 11, fontWeight: '600', color: '#475569', marginBottom: 6 }}>
                      {notif.record_type === 'MasterSetup'
                        ? 'Master Setup (no allow needed)'
                        : notif.record_type === 'ChamberMaster'
                          ? `${/ADD chamber/i.test(String(notif.description || '')) ? 'Chamber add' : 'Chamber delete'} ${isApproved ? 'approved' : 'denied'}`
                          : notif.record_type === 'ClientMaster'
                            ? 'Already saved · Super Admin notified only'
                          : `${shiftLabel} task · Edit ${isApproved ? 'approved' : 'denied'}${meta.reference_no ? ` · ${meta.reference_no}` : ''}`}
                    </Text>

                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 9.5, color: isApproved ? '#16a34a' : '#ef4444', fontWeight: '800' }}>
                        {notif.record_type === 'ChamberMaster' && isApproved
                          ? (/ADD chamber/i.test(String(notif.description || ''))
                            ? 'Tap to assign chamber ➔'
                            : 'Tap to delete chamber ➔')
                          : notif.record_type === 'ClientMaster'
                            ? 'Tap to dismiss ➔'
                          : notif.record_type === 'MasterSetup'
                            ? 'Tap to open Master Setup ➔'
                          : isApproved
                            ? 'Open task to edit ➔'
                            : 'View & dismiss ➔'}
                      </Text>
                      <View style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: isApproved ? '#16a34a' : '#ef4444'
                      }} />
                    </View>
                  </TouchableOpacity>
                );
              })}

              {/* Morning Task Notification Card */}
              <TouchableOpacity 
                style={{
                  backgroundColor: '#ffffff',
                  borderRadius: 10,
                  padding: 10,
                  marginBottom: 8,
                  borderLeftWidth: 3,
                  borderColor: '#eab308',
                  elevation: 1,
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 1 },
                  shadowOpacity: 0.05,
                  shadowRadius: 2,
                  width: '100%',
                }}
                activeOpacity={0.9}
                onPress={() => {
                  handleSelectShift('Morning');
                  setShowNotificationsModal(false);
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <Text style={{ fontSize: 9.5, fontWeight: '800', color: '#64748b' }}>
                    Today's Task - {formattedDate}
                  </Text>
                  <View style={{ backgroundColor: '#fffbeb', padding: 3, borderRadius: 4 }}>
                    <Ionicons name="sunny" size={12} color="#eab308" />
                  </View>
                </View>
                
                <Text style={{ fontSize: 11.5, fontWeight: '700', color: '#1e293b', lineHeight: 15, marginBottom: 4 }}>
                  Morning Task: {pendingMorning.length > 0 
                    ? `${pendingMorning.length} pending assignments.` 
                    : 'All assignments completed.'
                  }
                </Text>

                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 9.5, color: '#ca8a04', fontWeight: '800' }}>
                    {pendingMorning.length > 0 ? 'Click & Check ➔' : 'View Details ➔'}
                  </Text>
                  {pendingMorning.length > 0 && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#eab308' }} />}
                </View>
              </TouchableOpacity>

              {/* Evening Task Notification Card (Only show if Evening is active/unlocked) */}
              {isEveningUnlocked && (
                <TouchableOpacity 
                  style={{
                    backgroundColor: '#ffffff',
                    borderRadius: 10,
                    padding: 10,
                    borderLeftWidth: 3,
                    borderColor: '#3b82f6',
                    elevation: 1,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.05,
                    shadowRadius: 2,
                    width: '100%',
                  }}
                  activeOpacity={0.9}
                  onPress={() => {
                    handleSelectShift('Evening');
                    setShowNotificationsModal(false);
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <Text style={{ fontSize: 9.5, fontWeight: '800', color: '#64748b' }}>
                      Today's Task - {formattedDate}
                    </Text>
                    <View style={{ backgroundColor: '#eff6ff', padding: 3, borderRadius: 4 }}>
                      <Ionicons name="moon" size={12} color="#3b82f6" />
                    </View>
                  </View>
                  
                  <Text style={{ fontSize: 11.5, fontWeight: '700', color: '#1e293b', lineHeight: 15, marginBottom: 4 }}>
                    Evening Task: {pendingEvening.length > 0 
                      ? `${pendingEvening.length} pending assignments.` 
                      : 'All assignments completed.'
                    }
                  </Text>

                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 9.5, color: '#3b82f6', fontWeight: '800' }}>
                      {pendingEvening.length > 0 ? 'Click & Check ➔' : 'View Details ➔'}
                    </Text>
                    {pendingEvening.length > 0 && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#3b82f6' }} />}
                  </View>
                </TouchableOpacity>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    );
  };

  const renderHistoryModal = () => {
    if (!showHistoryModal || !selectedInventoryItem) return null;
    
    return (
      <Modal 
        visible={showHistoryModal} 
        animationType="slide" 
        transparent={false} 
        onRequestClose={() => setShowHistoryModal(false)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: '#f8fafc' }}>
          {/* Header */}
          <View style={{
            height: 56,
            backgroundColor: '#003580',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            elevation: 4,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.1,
            shadowRadius: 3
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 }}>
              <TouchableOpacity onPress={() => setShowHistoryModal(false)} style={{ marginRight: 12 }}>
                <Ionicons name="arrow-back" size={24} color="#ffffff" />
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: 'bold', color: '#ffffff' }} numberOfLines={1}>
                  {selectedInventoryItem.clientName}
                </Text>
                <Text style={{ fontSize: 10, color: '#93c5fd', marginTop: 1 }} numberOfLines={1}>
                  History • <Text style={{ fontWeight: 'bold', color: '#ffffff' }}>{selectedInventoryItem.chamberName}</Text>
                </Text>
              </View>
            </View>
            <TouchableOpacity onPress={() => setShowHistoryModal(false)} style={{ padding: 4 }}>
              <Ionicons name="close-circle" size={24} color="#ffffff" />
            </TouchableOpacity>
          </View>

          {/* Content */}
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
            <View style={{ backgroundColor: '#ffffff', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#e2e8f0', marginBottom: 16 }}>
              <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#64748b', textTransform: 'uppercase', marginBottom: 12 }}>
                Client & Chamber Info
              </Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={{ fontSize: 12, color: '#475569' }}>Client Name</Text>
                <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#0f172a' }}>{selectedInventoryItem.clientName}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={{ fontSize: 12, color: '#475569' }}>Chamber</Text>
                <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#0f172a' }}>{selectedInventoryItem.chamberName}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={{ fontSize: 12, color: '#475569' }}>Chamber Type</Text>
                <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#0f172a' }}>{selectedInventoryItem.chamberType}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 12, color: '#475569' }}>Current Stock</Text>
                <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#16a34a' }}>{selectedInventoryItem.currentCount} Boxes</Text>
              </View>
            </View>

            <View style={{ backgroundColor: '#ffffff', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#e2e8f0' }}>
              <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#64748b', textTransform: 'uppercase', marginBottom: 12 }}>
                Inventory Log History
              </Text>

              {selectedInventoryItem.history.length === 0 ? (
                <Text style={{ fontSize: 12, color: '#64748b', textAlign: 'center', marginVertical: 20 }}>
                  No history records found.
                </Text>
              ) : (
                selectedInventoryItem.history.map((hist, index) => (
                  <View key={index}>
                    <View style={{ paddingVertical: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: '#1e293b' }}>{hist.date}</Text>
                        <Text style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>
                          Slot: {hist.shift === 'Morning' ? 'Morning Task' : hist.shift === 'Evening' ? 'Evening Task' : (hist.time === '10:00' ? 'Morning Task' : hist.time === '16:00' ? 'Evening Task' : hist.time)}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={{ fontSize: 13, fontWeight: '800', color: '#0f172a' }}>{hist.boxCount} Boxes</Text>
                        {hist.temp !== undefined && hist.temp !== null && (
                          <Text style={{ fontSize: 11, color: '#475569', marginTop: 3 }}>Temp: {hist.temp}°C</Text>
                        )}
                      </View>
                    </View>
                    {index < selectedInventoryItem.history.length - 1 && (
                      <View style={{ height: 1, backgroundColor: '#f1f5f9', marginVertical: 2 }} />
                    )}
                  </View>
                ))
              )}
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    );
  };

  // C. REPORTS TAB VIEW
  const renderReportsView = () => {
    // Chamber list for this DO (Master Setup / assigned chambers)
    const accessChambers = (chambersList || []).length
      ? chambersList
      : assignments
          .filter((a) => a && a.status !== 'inactive')
          .reduce((acc, a) => {
            if (!acc.some((c) => Number(c.id) === Number(a.chamber_id))) {
              acc.push({ id: a.chamber_id, name: a.chamber_name });
            }
            return acc;
          }, []);

    // Client filter = that chamber's client master (or all masters if All Chambers)
    const accessClients =
      reportChamberFilter === 'all'
        ? Array.from(
            new Set(
              accessChambers.flatMap((ch) =>
                getClientsForChamber(ch.id).map((a) => String(a.client_name || '').trim())
              )
            )
          )
            .filter(Boolean)
            .sort((a, b) => String(a).localeCompare(String(b)))
        : getClientsForChamber(reportChamberFilter)
            .map((a) => String(a.client_name || '').trim())
            .filter(Boolean)
            .sort((a, b) => String(a).localeCompare(String(b)));

    const selectedChamberLabel =
      reportChamberFilter === 'all'
        ? 'All Chambers'
        : (accessChambers.find((c) => Number(c.id) === Number(reportChamberFilter))?.name ||
          `Chamber ${reportChamberFilter}`);

    const selectedClientLabel =
      reportClientFilter === 'all' ? 'All Clients' : reportClientFilter;

    // Logs: DO scope + date range + chamber + client + search (same as Export)
    const filteredLogs = getFilteredReportLogs();

    const renderFilterDropdown = ({
      label,
      valueLabel,
      open,
      setOpen,
      options,
      onSelect,
      closeOther,
      emptyText
    }) => (
      <View style={{ flex: 1, position: 'relative', zIndex: open ? 30 : 1 }}>
        <Text style={styles.reportFilterLabel}>{label}</Text>
        <TouchableOpacity
          style={styles.reportFilterTrigger}
          activeOpacity={0.85}
          onPress={() => {
            closeOther();
            setOpen(!open);
          }}
        >
          <Text style={styles.reportFilterTriggerText} numberOfLines={1}>
            {valueLabel}
          </Text>
          <Ionicons
            name={open ? 'chevron-up' : 'chevron-down'}
            size={16}
            color="#64748b"
          />
        </TouchableOpacity>
        {open && (
          <View style={styles.reportFilterDropdownInline}>
            <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={{ maxHeight: 180 }}>
              {options.length === 0 ? (
                <Text style={{ padding: 12, fontSize: 12, color: '#94a3b8' }}>
                  {emptyText || 'No options'}
                </Text>
              ) : (
                options.map((opt) => (
                  <TouchableOpacity
                    key={String(opt.value)}
                    style={styles.reportFilterOption}
                    onPress={() => {
                      onSelect(opt.value);
                      setOpen(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.reportFilterOptionText,
                        opt.value === (label.startsWith('Chamber') ? reportChamberFilter : reportClientFilter) && {
                          color: '#003580',
                          fontWeight: '700'
                        }
                      ]}
                      numberOfLines={1}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          </View>
        )}
      </View>
    );

    return (
      <ScrollView
        contentContainerStyle={styles.reportsContainer}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={() => {
          setShowReportChamberDropdown(false);
          setShowReportClientDropdown(false);
        }}
      >
        {/* DO profile scope */}
        <View style={styles.reportScopeCard}>
          <Text style={styles.reportScopeTitle}>DO Reports</Text>
          <Text style={styles.reportScopeSub} numberOfLines={2}>
            {displayName} · {accessChambers.length} chamber
            {accessChambers.length === 1 ? '' : 's'} in access
          </Text>
        </View>

        {/* Calendar / date range filter */}
        <Text style={[styles.reportSectionLabel, { marginTop: 4 }]}>Date</Text>
        {renderDateSlider()}
        <View style={styles.reportDateRangeRow}>
          <TouchableOpacity
            style={styles.reportDateRangeBtn}
            activeOpacity={0.85}
            onPress={() => {
              setCalendarMonth(new Date(reportDateFrom));
              setCalendarPickMode('from');
              setShowCalendarModal(true);
            }}
          >
            <Ionicons name="calendar-outline" size={16} color="#003580" />
            <Text style={styles.reportDateRangeBtnText}>
              {reportDateFrom === reportDateTo
                ? reportDateFrom
                : `${reportDateFrom} → ${reportDateTo}`}
            </Text>
            <Ionicons name="chevron-down" size={14} color="#64748b" />
          </TouchableOpacity>
          {!(
            reportDateFrom === new Date().toISOString().split('T')[0] &&
            reportDateTo === reportDateFrom
          ) && (
            <TouchableOpacity
              style={styles.reportDateTodayBtn}
              onPress={() => {
                const today = new Date().toISOString().split('T')[0];
                setSelectedReportDate(today);
                setReportDateFrom(today);
                setReportDateTo(today);
              }}
            >
              <Text style={styles.reportDateTodayBtnText}>Today</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Chamber + Client filters (DO access only) — Client below Chamber */}
        <Text style={[styles.reportSectionLabel, { marginTop: 10 }]}>Filters</Text>
        <View style={{ marginBottom: 4 }}>
          {renderFilterDropdown({
            label: 'Chamber',
            valueLabel: selectedChamberLabel,
            open: showReportChamberDropdown,
            setOpen: setShowReportChamberDropdown,
            closeOther: () => setShowReportClientDropdown(false),
            options: [
              { value: 'all', label: 'All Chambers' },
              ...accessChambers.map((c) => ({ value: c.id, label: c.name }))
            ],
            onSelect: (val) => {
              setReportChamberFilter(val);
              // Reset client when chamber changes — client master is chamber-wise
              setReportClientFilter('all');
            }
          })}
        </View>
        <View style={{ marginBottom: 12, marginTop: 8 }}>
          {renderFilterDropdown({
            label:
              reportChamberFilter === 'all'
                ? 'Client Master'
                : `Client Master (${selectedChamberLabel})`,
            valueLabel: selectedClientLabel,
            open: showReportClientDropdown,
            setOpen: setShowReportClientDropdown,
            closeOther: () => setShowReportChamberDropdown(false),
            emptyText:
              reportChamberFilter === 'all'
                ? 'No client masters on chambers yet.'
                : 'No client master on this chamber. Add in Master Setup.',
            options: [
              { value: 'all', label: 'All Clients' },
              ...accessClients.map((name) => ({ value: name, label: name }))
            ],
            onSelect: (val) => setReportClientFilter(val)
          })}
        </View>

        {/* Slot filter — Morning / Evening */}
        <Text style={[styles.reportSectionLabel, { marginTop: 10 }]}>Slot</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
          {[
            { value: 'all', label: 'All' },
            { value: 'Morning', label: 'Morning' },
            { value: 'Evening', label: 'Evening' }
          ].map((opt) => {
            const active = reportShiftFilter === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                activeOpacity={0.85}
                onPress={() => setReportShiftFilter(opt.value)}
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: active
                    ? (opt.value === 'Morning' ? '#eab308' : opt.value === 'Evening' ? '#2563eb' : '#0369a1')
                    : '#e2e8f0',
                  backgroundColor: active
                    ? (opt.value === 'Morning' ? '#fef9c3' : opt.value === 'Evening' ? '#eff6ff' : '#e0f2fe')
                    : '#ffffff',
                  alignItems: 'center'
                }}
              >
                <Text style={{
                  fontSize: 12,
                  fontWeight: '700',
                  color: active
                    ? (opt.value === 'Morning' ? '#ca8a04' : opt.value === 'Evening' ? '#2563eb' : '#0369a1')
                    : '#64748b'
                }}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Logs list */}
        <View style={styles.alertLogsCard}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <Text style={[styles.alertLogsCardTitle, { marginBottom: 0 }]}>
              Logs ({filteredLogs.length})
            </Text>
          </View>

          <View style={styles.reportSearchBar}>
            <Ionicons name="search-outline" size={16} color="#64748b" style={{ marginRight: 6 }} />
            <TextInput
              style={{ flex: 1, fontSize: 13, color: '#1e293b', padding: 0 }}
              placeholder="Search client, chamber, ref…"
              placeholderTextColor="#94a3b8"
              value={reportSearchQuery}
              onChangeText={setReportSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {reportSearchQuery !== '' && (
              <TouchableOpacity onPress={() => setReportSearchQuery('')}>
                <Ionicons name="close-circle" size={18} color="#94a3b8" />
              </TouchableOpacity>
            )}
          </View>

          {filteredLogs.length === 0 ? (
            <View style={styles.reportsEmptyRow}>
              <Ionicons name="clipboard-outline" size={24} color="#94a3b8" />
              <Text style={[styles.reportsEmptyText, { color: '#64748b', fontWeight: '500' }]}>
                No logs for this date / chamber / client / slot filter.
              </Text>
            </View>
          ) : (
            filteredLogs.map((log) => {
              const pattern = getChamberTypeAndDefault(log.chamber_id);
              const checkType = log.chamber_type || pattern.type;
              let isCompliant = true;
              if (checkType === 'Frozen' && log.box_temp > -18) isCompliant = false;
              if (checkType === 'Chilled' && (log.box_temp < -5 || log.box_temp > 5)) isCompliant = false;
              if (checkType === 'Dry' && (log.box_temp < 15 || log.box_temp > 25)) isCompliant = false;

              return (
                <View key={log.id} style={styles.alertLogItem}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.alertLogClient} numberOfLines={1}>
                      {log.client_name}
                    </Text>
                    <Text style={styles.alertLogMeta} numberOfLines={2}>
                      {log.entry_date || '—'} · {log.chamber_name} · {log.shift || checkType} · {log.inspection_time || '—'}
                    </Text>
                    <Text style={{ fontSize: 10, color: log.sync_status === 'synced' ? '#16a34a' : '#c2410c', fontWeight: '600', marginTop: 3 }}>
                      {log.sync_status === 'synced' ? 'Synced' : 'Pending sync'}
                      {log.reference_no ? ` · ${log.reference_no}` : ''}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', marginLeft: 8 }}>
                    <Text style={[styles.alertLogTemp, { color: isCompliant ? '#16a34a' : '#b91c1c' }]}>
                      {log.box_temp}°C
                    </Text>
                    <Text style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
                      {log.box_count != null ? `${log.box_count} boxes` : '—'}
                    </Text>
                  </View>
                </View>
              );
            })
          )}
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>
    );
  };

  const renderMoreView = () => {
    return (
      <ScrollView contentContainerStyle={styles.moreContainer} showsVerticalScrollIndicator={false}>
        <View style={styles.profileCard}>
          <View style={styles.profileAvatar}>
            <Ionicons name="person" size={32} color="#003580" />
          </View>
          <View style={styles.profileMeta}>
            <Text style={styles.profileName}>{displayName}</Text>
            <Text style={styles.profileRole}>Data Operator</Text>
            <Text style={styles.profileEmail}>{user.email || 'operator@reeferon.com'}</Text>
          </View>
        </View>

        <View style={styles.moreSectionCard}>
          <Text style={styles.moreSectionTitle}>Synchronization Engine</Text>
          <View style={styles.syncStatusRow}>
            <Text style={styles.syncStatusLabel}>Sync Queue Status:</Text>
            <View style={[
              styles.syncStatusBadge,
              { backgroundColor: unsyncedLogs.length > 0 ? '#fff7ed' : '#f0fdf4' }
            ]}>
              <Text style={[
                styles.syncStatusText,
                { color: unsyncedLogs.length > 0 ? '#c2410c' : '#16a34a' }
              ]}>
                {unsyncedLogs.length > 0 ? `${unsyncedLogs.length} Logs Pending` : 'All Synced'}
              </Text>
            </View>
          </View>

          {syncStatus === 'syncing' ? (
            <View style={styles.syncSpinnerContainer}>
              <ActivityIndicator size="small" color="#003580" />
              <Text style={styles.syncSpinnerText}>Uploading offline queue to server...</Text>
            </View>
          ) : (
            <TouchableOpacity 
              style={[styles.syncActionBtn, unsyncedLogs.length === 0 && styles.syncActionBtnDisabled]} 
              disabled={unsyncedLogs.length === 0}
              onPress={() => triggerSync(apiUrl, token, (status) => {
                setSyncStatus(status);
                loadInspectionsAndSummary();
              })}
            >
              <Ionicons name="cloud-upload" size={18} color="#ffffff" style={{ marginRight: 6 }} />
              <Text style={styles.syncActionBtnText}>Upload Local Queue Now</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.moreSectionCard}>
          <Text style={styles.moreSectionTitle}>Master Setup</Text>
          <Text style={styles.ipSettingsDesc}>Add chambers and manage client names for each chamber separately.</Text>
          <TouchableOpacity 
            style={[styles.ipUpdateActionBtn, { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0', borderWidth: 1 }]}
            onPress={openMasterManager}
          >
            <Ionicons name="cube-outline" size={16} color="#15803d" style={{ marginRight: 6 }} />
            <Text style={[styles.ipUpdateActionBtnText, { color: '#15803d' }]}>Open Master Setup</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.appInfoBox}>
          <Text style={styles.appInfoText}>ReeferON CRM Mobile Client</Text>
          <Text style={styles.appInfoVersion}>Version 1.1.0 (SQLite Active)</Text>
        </View>

        <TouchableOpacity style={styles.moreLogoutBtn} onPress={onLogout}>
          <Ionicons name="log-out" size={20} color="#ffffff" style={{ marginRight: 8 }} />
          <Text style={styles.moreLogoutBtnText}>Log Out Account</Text>
        </TouchableOpacity>

        <View style={{ height: 100 }} />
      </ScrollView>
    );
  };

  // ==========================================
  // MODALS
  // ==========================================

  // UNIFIED TASK PROFILE & INSPECTION ENTRY FORM MODAL (VERTICAL LAYOUT WITH CHAMBER SELECTOR)
  const renderTaskProfileModal = () => {
    const activePattern = (() => {
      if (selectedChamberType === 'Frozen') {
        return { type: 'Frozen', defaultTemp: -20.0, icon: 'snow', color: '#0284c7', bg: '#e0f2fe' };
      } else if (selectedChamberType === 'Chilled') {
        return { type: 'Chilled', defaultTemp: 2.0, icon: 'thermometer', color: '#0d9488', bg: '#ccfbf1' };
      } else if (selectedChamberType === 'Dry') {
        return { type: 'Dry', defaultTemp: 18.0, icon: 'leaf', color: '#16a34a', bg: '#dcfce7' };
      } else {
        return { type: 'Other', defaultTemp: 25.0, icon: 'options', color: '#64748b', bg: '#f1f5f9' };
      }
    })();

    let hasWarning = false;
    if (tempInput) {
      const tempVal = parseFloat(tempInput);
      if (!isNaN(tempVal)) {
        if (selectedChamberType === 'Frozen' && tempVal > -18) hasWarning = true;
        if (selectedChamberType === 'Chilled' && (tempVal < -5 || tempVal > 5)) hasWarning = true;
        if (selectedChamberType === 'Dry' && (tempVal < 15 || tempVal > 25)) hasWarning = true;
        // 'Other' type has no alert constraints
      }
    }

    return (
      <Modal visible={showLogModal} animationType="slide" transparent={false}>
        <SafeAreaView style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>
                  {isProfileEditable
                    ? (editingExistingLog ? 'Edit Chamber Inspection' : 'Record Chamber Inspection')
                    : 'Task Profile Details'}
                </Text>
                <Text style={styles.modalSubtitle}>
                  {selectedChamber ? `${selectedChamber.name} Profile` : 'Chamber Entry Form'}
                </Text>
              </View>
              <TouchableOpacity onPress={handleCloseModal}>
                <Ionicons name="close-circle-outline" size={26} color="#64748b" />
              </TouchableOpacity>
            </View>

            <ScrollView
              contentContainerStyle={{ paddingVertical: 10, paddingBottom: 40 }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              
              {/* Dynamic Chamber Classification Header Card */}
              {selectedChamber && (
                <View style={[
                  styles.chamberHeaderCard,
                  { backgroundColor: activePattern.bg, borderColor: activePattern.color }
                ]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={[styles.chamberHeaderIconCircle, { backgroundColor: activePattern.color }]}>
                      <Ionicons name={activePattern.icon === 'snow' ? 'snow' : activePattern.icon} size={18} color="#ffffff" />
                    </View>
                    <View style={{ marginLeft: 10 }}>
                      <Text style={[styles.chamberHeaderTitle, { color: '#0f172a' }]}>
                        Chamber - {selectedChamber.id.toString().padStart(2, '0')}
                      </Text>
                      <Text style={{ fontSize: 11, color: '#64748b', fontWeight: 'bold', marginTop: 2 }}>
                        Compliance: {selectedChamberType} | Target: {selectedChamberType === 'Frozen' ? '≤ -18.0°C' : selectedChamberType === 'Chilled' ? '-5.0°C to 5.0°C' : '> 0.0°C'}
                      </Text>
                    </View>
                  </View>
                </View>
              )}

              {/* Compliance banner for read-only mode */}
              {!isProfileEditable && (
                <View style={[
                  styles.detailStatusBar,
                  { backgroundColor: !hasWarning ? '#dcfce7' : '#fee2e2', marginHorizontal: 0, marginBottom: 15 }
                ]}>
                  <Ionicons 
                    name={!hasWarning ? "checkmark-circle" : "alert-circle"} 
                    size={20} 
                    color={!hasWarning ? "#16a34a" : "#ef4444"} 
                    style={{ marginRight: 8 }}
                  />
                  <Text style={[
                    styles.detailStatusText,
                    { color: !hasWarning ? "#15803d" : "#b91c1c" }
                  ]}>
                    {!hasWarning ? "Temperature Compliance Safe" : "Out-of-Range Temperature warning!"}
                  </Text>
                </View>
              )}

              {/* Main Body - Row Layout: Left side fields, Right side image */}
              {/* Vertical Stack Form Design */}
              <View style={{ paddingHorizontal: 4 }}>
                
                {/* Chamber Dropdown Selector (FAB '+') — inline list (not absolute) so Android does not clip */}
                {openedFromFab && isProfileEditable && (
                  <View style={{ marginBottom: 12, zIndex: 20 }}>
                    <Text style={styles.modalLabel}>Select Chamber</Text>
                    <TouchableOpacity 
                      style={styles.dropdownTrigger} 
                      onPress={() => {
                        setShowClientDropdown(false);
                        setShowChamberDropdown(!showChamberDropdown);
                      }}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.dropdownTriggerText, !selectedChamber && { color: '#94a3b8' }]}>
                        {selectedChamber?.name || 'Select Chamber...'}
                      </Text>
                      <Ionicons name={showChamberDropdown ? 'chevron-up' : 'chevron-down'} size={18} color="#64748b" />
                    </TouchableOpacity>

                    {showChamberDropdown && (
                      <View style={styles.dropdownListInline}>
                        {chambersList.length === 0 ? (
                          <Text style={{ padding: 12, fontSize: 12, color: '#94a3b8' }}>
                            No chambers available (limit: {chamberLimit}). Create chambers / assignments first.
                          </Text>
                        ) : (
                          chambersList.map(ch => (
                            <TouchableOpacity 
                              key={ch.id} 
                              style={[
                                styles.dropdownItem,
                                selectedChamber?.id === ch.id && { backgroundColor: '#eff6ff' }
                              ]} 
                              onPress={() => {
                                setSelectedChamber(ch);
                                setShowChamberDropdown(false);
                                setSelectedClient(null);
                                setSelectedChamberType(getChamberTypeAndDefault(ch.id).type);
                              }}
                            >
                              <Text style={styles.dropdownItemText}>{ch.name}</Text>
                            </TouchableOpacity>
                          ))
                        )}
                      </View>
                    )}
                  </View>
                )}
                {/* Chamber Type Selector (Dynamic tabs control) */}
                <View style={{ marginBottom: 12 }}>
                  <Text style={styles.modalLabel}>Chamber Type (Select compliance standard)</Text>
                  {isProfileEditable ? (
                    <View style={styles.typeSelectorRow}>
                      <TouchableOpacity
                        style={[
                          styles.typeTabButton,
                          selectedChamberType === 'Frozen' && { backgroundColor: '#0284c7', borderColor: '#0284c7' }
                        ]}
                        activeOpacity={0.8}
                        onPress={() => setSelectedChamberType('Frozen')}
                      >
                        <Ionicons name="snow" size={14} color={selectedChamberType === 'Frozen' ? '#ffffff' : '#0284c7'} style={{ marginRight: 4 }} />
                        <Text style={[styles.typeTabText, selectedChamberType === 'Frozen' && { color: '#ffffff' }]}>Frozen</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[
                          styles.typeTabButton,
                          selectedChamberType === 'Chilled' && { backgroundColor: '#0d9488', borderColor: '#0d9488' }
                        ]}
                        activeOpacity={0.8}
                        onPress={() => setSelectedChamberType('Chilled')}
                      >
                        <Ionicons name="thermometer" size={14} color={selectedChamberType === 'Chilled' ? '#ffffff' : '#0d9488'} style={{ marginRight: 4 }} />
                        <Text style={[styles.typeTabText, selectedChamberType === 'Chilled' && { color: '#ffffff' }]}>Chilled</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[
                          styles.typeTabButton,
                          selectedChamberType === 'Dry' && { backgroundColor: '#16a34a', borderColor: '#16a34a' }
                        ]}
                        activeOpacity={0.8}
                        onPress={() => setSelectedChamberType('Dry')}
                      >
                        <Ionicons name="leaf" size={14} color={selectedChamberType === 'Dry' ? '#ffffff' : '#16a34a'} style={{ marginRight: 4 }} />
                        <Text style={[styles.typeTabText, selectedChamberType === 'Dry' && { color: '#ffffff' }]}>Dry</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[
                          styles.typeTabButton,
                          selectedChamberType === 'Other' && { backgroundColor: '#64748b', borderColor: '#64748b' }
                        ]}
                        activeOpacity={0.8}
                        onPress={() => setSelectedChamberType('Other')}
                      >
                        <Ionicons name="options" size={14} color={selectedChamberType === 'Other' ? '#ffffff' : '#64748b'} style={{ marginRight: 4 }} />
                        <Text style={[styles.typeTabText, selectedChamberType === 'Other' && { color: '#ffffff' }]}>Other</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={[styles.readOnlyField, { backgroundColor: activePattern.bg, borderColor: activePattern.color, borderLeftWidth: 4, borderLeftColor: activePattern.color }]}>
                      <Text style={{ fontWeight: 'bold', color: activePattern.color, fontSize: 13 }}>
                        {selectedChamberType} Compliance Standard
                      </Text>
                    </View>
                  )}
                </View>

                {/* Shift Selector (Read Only) */}
                <View style={{ marginBottom: 12 }}>
                  <Text style={styles.modalLabel}>Task Time (Task Slot)</Text>
                  <View style={styles.readOnlyField}>
                    <Text style={[
                      styles.readOnlyText,
                      {
                        fontWeight: '800',
                        color: selectedShift === '10:00' ? '#ca8a04' : '#2563eb'
                      }
                    ]}>
                      {selectedShift === '10:00' ? 'Morning Task' : 'Evening Task'}
                    </Text>
                  </View>
                </View>

                {/* Client Lot Name — locked on edit (cannot change client) */}
                <View style={{ marginBottom: 12, zIndex: 10 }}>
                    <Text style={styles.modalLabel}>Client Lot Name</Text>
                    {editingExistingLog ? (
                      <View style={styles.readOnlyField}>
                        <Text style={styles.readOnlyText} numberOfLines={1}>
                          {selectedClient || editingExistingLog.client_name || '-'}
                        </Text>
                      </View>
                    ) : isProfileEditable ? (
                      <>
                        <TouchableOpacity 
                          style={[styles.dropdownTrigger, !selectedChamber && styles.dropdownDisabled, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10 }]} 
                          disabled={!selectedChamber}
                          onPress={() => {
                            if (!selectedChamber) return;
                            setShowChamberDropdown(false);
                            setShowClientDropdown(!showClientDropdown);
                          }}
                          activeOpacity={0.8}
                        >
                          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                            <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center', marginRight: 8 }}>
                              <Ionicons name="briefcase-outline" size={12} color="#475569" />
                            </View>
                            <Text style={[styles.dropdownTriggerText, !selectedClient && { color: '#94a3b8' }, { fontSize: 13, fontWeight: '700' }]} numberOfLines={1}>
                              {selectedClient || (selectedChamber ? 'Select Client Lot...' : 'Select Chamber first')}
                            </Text>
                            {selectedChamber && selectedClient && isClientCompletedToday(selectedChamber.id, selectedClient, selectedShift) && (
                              <View style={[styles.completedBadgePill, { flexDirection: 'row', alignItems: 'center', marginLeft: 8, paddingVertical: 1, paddingHorizontal: 6, backgroundColor: '#e2f0d9' }]}>
                                <Ionicons name="checkmark-circle" size={10} color="#385723" style={{ marginRight: 2 }} />
                                <Text style={[styles.completedBadgeText, { color: '#385723', fontSize: 8 }]}>Submitted</Text>
                              </View>
                            )}
                          </View>
                          <Ionicons name={showClientDropdown ? 'chevron-up' : 'chevron-down'} size={16} color="#64748b" />
                        </TouchableOpacity>

                        {showClientDropdown && selectedChamber && (
                          <View style={[styles.dropdownListInline, { maxHeight: 220 }]}>
                            <ScrollView
                              nestedScrollEnabled
                              keyboardShouldPersistTaps="handled"
                              showsVerticalScrollIndicator
                              style={{ maxHeight: 220 }}
                            >
                            {(() => {
                              const ordered = getClientsForChamber(selectedChamber.id);

                              if (ordered.length === 0) {
                                return (
                                  <Text style={{ padding: 12, fontSize: 12, color: '#94a3b8' }}>
                                    No clients on this chamber yet. Use Plus → Manage Chambers to add client names for this chamber only.
                                  </Text>
                                );
                              }

                              return ordered.map((item) => {
                                const isSelected = selectedClient === item.client_name;
                                const isCompleted = isClientCompletedToday(
                                  selectedChamber.id,
                                  item.client_name,
                                  selectedShift
                                );
                                const isLockedCompleted = isCompleted && !editingExistingLog;
                                return (
                                  <View
                                    key={item.client_name}
                                    style={{
                                      flexDirection: 'row',
                                      alignItems: 'center',
                                      borderBottomWidth: 1,
                                      borderBottomColor: '#f1f5f9',
                                      backgroundColor: isLockedCompleted
                                        ? '#f0fdf4'
                                        : isSelected
                                          ? '#eff6ff'
                                          : '#ffffff',
                                      opacity: isLockedCompleted ? 0.85 : 1
                                    }}
                                  >
                                    <TouchableOpacity
                                      style={{
                                        flex: 1,
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        paddingHorizontal: 10,
                                        paddingVertical: 10
                                      }}
                                      activeOpacity={isLockedCompleted ? 1 : 0.7}
                                      disabled={isLockedCompleted}
                                      onPress={() => {
                                        if (isLockedCompleted) return;
                                        handleSelectClientPill(item.client_name);
                                        setShowClientDropdown(false);
                                      }}
                                    >
                                      <Text
                                        style={[
                                          styles.dropdownItemText,
                                          { flex: 1 },
                                          isLockedCompleted && styles.dropdownItemTextDisabled
                                        ]}
                                        numberOfLines={1}
                                      >
                                        {item.client_name}
                                        {isLockedCompleted ? ' (submitted)' : ''}
                                      </Text>
                                      {isLockedCompleted ? (
                                        <Ionicons
                                          name="checkmark-circle"
                                          size={16}
                                          color="#16a34a"
                                          style={{ marginLeft: 6 }}
                                        />
                                      ) : isSelected ? (
                                        <Ionicons
                                          name="checkmark"
                                          size={16}
                                          color="#003580"
                                          style={{ marginLeft: 6 }}
                                        />
                                      ) : null}
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                      style={{
                                        paddingHorizontal: 12,
                                        paddingVertical: 10,
                                        justifyContent: 'center',
                                        alignItems: 'center'
                                      }}
                                      onPress={() => openDeleteClientFromTaskForm(item.client_name)}
                                      accessibilityLabel={`Delete ${item.client_name}`}
                                    >
                                      <Ionicons name="trash-outline" size={16} color="#dc2626" />
                                    </TouchableOpacity>
                                  </View>
                                );
                              });
                            })()}
                            </ScrollView>
                          </View>
                        )}

                        {selectedChamber && (
                          <TouchableOpacity
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              justifyContent: 'center',
                              paddingVertical: 8,
                              marginTop: 6,
                              backgroundColor: '#f8fafc',
                              borderWidth: 1,
                              borderColor: '#e2e8f0',
                              borderRadius: 8,
                              borderStyle: 'dashed'
                            }}
                            activeOpacity={0.8}
                            onPress={() => {
                              setInlineClientInput('');
                              setInlineRemarkInput('');
                              setShowAddClientModal(true);
                            }}
                          >
                            <Ionicons name="add-circle" size={14} color="#64748b" style={{ marginRight: 4 }} />
                            <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#64748b' }}>
                              Add New Client Lot
                            </Text>
                          </TouchableOpacity>
                        )}
                      </>
                    ) : (
                      <View style={styles.readOnlyField}>
                        <Text style={styles.readOnlyText} numberOfLines={1}>{selectedClient}</Text>
                      </View>
                    )}
                </View>

                {/* Temperature and Box Qty inputs Side-by-Side */}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
                  
                  {/* Left: Box Temp */}
                  <View style={{ flex: 1.1, marginRight: 8 }}>
                    <Text style={styles.modalLabel}>Box Temp Reading (°C)</Text>
                    {isProfileEditable ? (
                      <>
                        <View style={styles.inputWrapper}>
                          <Ionicons name="thermometer-outline" size={16} color="#64748b" style={styles.inputIcon} />
                          <TextInput
                            style={styles.input}
                            placeholder="e.g. -22.5"
                            placeholderTextColor="#94a3b8"
                            keyboardType="numeric"
                            value={tempInput}
                            onChangeText={handleTempInputChange}
                          />
                        </View>
                        {selectedChamber && (
                          <Text style={{ fontSize: 9, color: '#475569', marginTop: 4, marginLeft: 2, fontWeight: '600' }}>
                            Target: {selectedChamberType === 'Frozen' ? '≤ -18.0°C (Frozen)' : selectedChamberType === 'Chilled' ? '-5.0°C to 5.0°C (Chilled)' : selectedChamberType === 'Dry' ? '15.0°C to 25.0°C (Dry)' : 'No compliance limit'}
                          </Text>
                        )}
                      </>
                    ) : (
                      <View style={[styles.readOnlyField, { borderLeftWidth: 4, borderLeftColor: hasWarning ? '#ef4444' : '#16a34a' }]}>
                        <Text style={[styles.readOnlyText, { fontWeight: 'bold', color: hasWarning ? '#ef4444' : '#16a34a' }]}>
                          {tempInput}°C
                        </Text>
                      </View>
                    )}
                  </View>

                  {/* Right: Box Qty */}
                  <View style={{ flex: 0.9, marginLeft: 8 }}>
                    <Text style={styles.modalLabel}>Box Qty (Count)</Text>
                    {isProfileEditable ? (
                      <>
                        <View style={styles.inputWrapper}>
                          <Ionicons name="cube-outline" size={16} color="#64748b" style={styles.inputIcon} />
                          <TextInput
                            style={styles.input}
                            placeholder="e.g. 150"
                            placeholderTextColor="#94a3b8"
                            keyboardType="numeric"
                            value={boxCountInput}
                            onChangeText={(text) => {
                              // Digits only — box qty can never go negative
                              const cleaned = String(text || '').replace(/[^\d]/g, '');
                              setBoxCountInput(cleaned);
                            }}
                          />
                        </View>
                        <Text style={{ fontSize: 9, color: '#475569', marginTop: 4, marginLeft: 2, fontWeight: '600' }}>
                          Total boxes in chamber now (never negative). Example: was 30, now 45 → 15 inward.
                        </Text>
                      </>
                    ) : (
                      <View style={styles.readOnlyField}>
                        <Text style={styles.readOnlyText}>{boxCountInput || '0'} boxes</Text>
                      </View>
                    )}
                  </View>

                </View>

                {/* Sensor Photo Capture Section (Stacked below) */}
                <View style={{ marginBottom: 12 }}>
                  <Text style={styles.modalLabel}>Sensor Verification Photo</Text>
                  
                  {isProfileEditable ? (
                    capturedImage ? (
                      <View style={{ width: '100%' }}>
                        <View style={styles.verticalPhotoWrapper}>
                          <Image source={{ uri: capturedImage }} style={styles.verticalPhotoPreview} />
                          <TouchableOpacity 
                            style={styles.verticalRetakeBtn}
                            onPress={handleLaunchCamera}
                          >
                            <Ionicons name="camera-reverse" size={14} color="#ffffff" style={{ marginRight: 4 }} />
                            <Text style={{ color: '#ffffff', fontSize: 12, fontWeight: 'bold' }}>Retake Photo</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ) : (
                      <TouchableOpacity 
                        style={styles.verticalCameraBtn}
                        onPress={handleLaunchCamera}
                      >
                        <Ionicons name="camera" size={32} color="#003580" />
                        <Text style={styles.verticalCameraBtnText}>Snap Verification Photo</Text>
                        <Text style={{ fontSize: 9, color: '#64748b', marginTop: 2 }}>Must clearly show temperature reading sensor</Text>
                      </TouchableOpacity>
                    )
                  ) : (
                    capturedImage ? (
                      <View style={styles.verticalPhotoWrapper}>
                        <Image source={{ uri: capturedImage }} style={styles.verticalPhotoPreview} />
                      </View>
                    ) : (
                      <View style={[styles.verticalCameraBtn, { borderWidth: 1, borderStyle: 'solid' }]}>
                        <Ionicons name="image-outline" size={26} color="#cbd5e1" />
                        <Text style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>No Photo Verification Logged</Text>
                      </View>
                    )
                  )}
                </View>

              </View>

              {/* Read-only Metadata Details */}
              {!isProfileEditable && (
                <View style={styles.metaDataCard}>
                  <View style={styles.metaRow}>
                    <Text style={styles.metaLabel}>Operator:</Text>
                    <Text style={styles.metaVal}>{logOperatorName}</Text>
                  </View>
                  <View style={styles.metaRow}>
                    <Text style={styles.metaLabel}>Logged Date:</Text>
                    <Text style={styles.metaVal}>{logEntryDate}</Text>
                  </View>
                  <View style={styles.metaRow}>
                    <Text style={styles.metaLabel}>Logged Time:</Text>
                    <Text style={styles.metaVal}>{logEntryTime}</Text>
                  </View>
                  <View style={styles.metaRow}>
                    <Text style={styles.metaLabel}>Sync Engine:</Text>
                    <Text style={[styles.metaVal, { color: logSyncStatus === 'synced' ? '#16a34a' : '#ea580c', fontWeight: 'bold' }]}>
                      {logSyncStatus === 'synced' ? 'Synced to Cloud' : 'Device Queue (Offline)'}
                    </Text>
                  </View>
                </View>
              )}

              {/* Bottom Actions */}
              {isProfileEditable ? (
                <TouchableOpacity
                  style={[
                    styles.submitBtn,
                    editingExistingLog && { backgroundColor: '#ea580c' }
                  ]}
                  onPress={handleSaveInspection}
                >
                  <Text style={styles.submitBtnText}>
                    {editingExistingLog ? 'Update Reading' : 'Submit Reading (Save Locally)'}
                  </Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity 
                  style={[styles.submitBtn, { backgroundColor: '#64748b' }]} 
                  onPress={handleCloseModal}
                >
                  <Text style={styles.submitBtnText}>Close Task Profile</Text>
                </TouchableOpacity>
              )}

            </ScrollView>
          </View>
        </SafeAreaView>
      </Modal>
    );
  };

  // 3. CLIENT MASTER MANAGER MODAL (FULL SCREEN) — clean chamber / client UX
  const renderClientManagerModal = () => {
    const chamberClients = managerSelectedChamber
      ? getClientsForChamber(managerSelectedChamber.id)
      : [];

    return (
      <Modal visible={showClientManagerModal} animationType="slide" transparent={false}>
        <SafeAreaView style={styles.mmRoot}>
          {/* Header */}
          <View style={styles.mmHeader}>
            <View style={styles.mmHeaderTextWrap}>
              <Text style={styles.mmHeaderTitle}>Master Setup</Text>
              <Text style={styles.mmHeaderSub}>
                Chambers {chambersList.length}/{chamberLimit}
                {managerSelectedChamber
                  ? `  ·  ${managerSelectedChamber.name}: ${chamberClients.length} client${chamberClients.length === 1 ? '' : 's'}`
                  : ''}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.mmCloseBtn}
              onPress={() => {
                setShowClientManagerModal(false);
                setShowManagerChamberDropdown(false);
                setShowClientSuggestions(false);
                setEditingClientName(null);
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="close" size={22} color="#475569" />
            </TouchableOpacity>
          </View>

          {/* Tabs */}
          <View style={styles.mmTabs}>
            <TouchableOpacity
              style={[styles.mmTab, masterManagerTab === 'chambers' && styles.mmTabActive]}
              onPress={() => setMasterManagerTab('chambers')}
              activeOpacity={0.85}
            >
              <Ionicons
                name="cube-outline"
                size={16}
                color={masterManagerTab === 'chambers' ? '#003580' : '#64748b'}
              />
              <Text style={[styles.mmTabText, masterManagerTab === 'chambers' && styles.mmTabTextActive]}>
                Chambers
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.mmTab, masterManagerTab === 'clients' && styles.mmTabActive]}
              onPress={() => {
                setMasterManagerTab('clients');
                if (!managerSelectedChamber && chambersList[0]) {
                  setManagerSelectedChamber(chambersList[0]);
                }
              }}
              activeOpacity={0.85}
            >
              <Ionicons
                name="people-outline"
                size={16}
                color={masterManagerTab === 'clients' ? '#003580' : '#64748b'}
              />
              <Text style={[styles.mmTabText, masterManagerTab === 'clients' && styles.mmTabTextActive]}>
                Clients
              </Text>
            </TouchableOpacity>
          </View>

          {masterManagerTab === 'chambers' ? (
            <View style={styles.mmBody}>
              {/* Add chamber card */}
              <View style={styles.mmCard}>
                <Text style={styles.mmCardTitle}>Add chamber</Text>
                <Text style={styles.mmCardHint}>
                  Tap below → enter chamber name + remark → Send Request. Super Admin allows in Role & Permission, then chamber assigns automatically.
                </Text>
                <TouchableOpacity
                  style={[styles.mmPrimaryBtn, { alignSelf: 'stretch', justifyContent: 'center' }]}
                  onPress={openAddChamberPopup}
                  activeOpacity={0.85}
                >
                  <Ionicons name="add" size={18} color="#fff" />
                  <Text style={styles.mmPrimaryBtnText}>Request Add Chamber</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.mmSectionLabel}>Your chambers</Text>
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: 28 }}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                {chambersList.length === 0 ? (
                  <View style={styles.mmEmpty}>
                    <Ionicons name="cube-outline" size={36} color="#94a3b8" />
                    <Text style={styles.mmEmptyTitle}>No chambers yet</Text>
                    <Text style={styles.mmEmptyText}>Add your first chamber above.</Text>
                  </View>
                ) : (
                  chambersList.map((ch) => {
                    const count = getClientsForChamber(ch.id).length;
                    const selected = managerSelectedChamber?.id === ch.id;
                    return (
                      <TouchableOpacity
                        key={ch.id}
                        style={[styles.mmChamberRow, selected && styles.mmChamberRowSelected]}
                        activeOpacity={0.75}
                        onPress={() => {
                          setManagerSelectedChamber(ch);
                          setNewClientInput('');
                          setEditingClientName(null);
                          setMasterManagerTab('clients');
                        }}
                      >
                        <View style={[styles.mmChamberIcon, selected && styles.mmChamberIconSelected]}>
                          <Ionicons name="cube" size={18} color={selected ? '#003580' : '#64748b'} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.mmChamberName}>{ch.name}</Text>
                          <Text style={styles.mmChamberMeta}>
                            {count === 0 ? 'No clients · tap to add' : `${count} client${count === 1 ? '' : 's'} · tap to manage`}
                          </Text>
                        </View>
                        <TouchableOpacity
                          onPress={() => handleDeleteChamberMaster(ch)}
                          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                          style={styles.mmIconBtnDanger}
                        >
                          <Ionicons name="trash-outline" size={16} color="#dc2626" />
                        </TouchableOpacity>
                        <Ionicons name="chevron-forward" size={18} color="#94a3b8" style={{ marginLeft: 4 }} />
                      </TouchableOpacity>
                    );
                  })
                )}
              </ScrollView>
            </View>
          ) : (
            <View style={styles.mmBody}>
              {/* Chamber picker chips */}
              <Text style={styles.mmSectionLabel}>Select chamber</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.mmChipRow}
                style={{ flexGrow: 0, marginBottom: 10 }}
              >
                {chambersList.length === 0 ? (
                  <TouchableOpacity
                    style={styles.mmChipGhost}
                    onPress={() => setMasterManagerTab('chambers')}
                  >
                    <Text style={styles.mmChipGhostText}>Add a chamber first</Text>
                  </TouchableOpacity>
                ) : (
                  chambersList.map((ch) => {
                    const active = managerSelectedChamber?.id === ch.id;
                    return (
                      <TouchableOpacity
                        key={`chip-${ch.id}`}
                        style={[styles.mmChip, active && styles.mmChipActive]}
                        onPress={() => {
                          setManagerSelectedChamber(ch);
                          setNewClientInput('');
                          setEditingClientName(null);
                          setShowClientSuggestions(false);
                        }}
                        activeOpacity={0.85}
                      >
                        <Text style={[styles.mmChipText, active && styles.mmChipTextActive]}>{ch.name}</Text>
                      </TouchableOpacity>
                    );
                  })
                )}
              </ScrollView>

              {!managerSelectedChamber ? (
                <View style={styles.mmEmpty}>
                  <Ionicons name="people-outline" size={36} color="#94a3b8" />
                  <Text style={styles.mmEmptyTitle}>Pick a chamber</Text>
                  <Text style={styles.mmEmptyText}>
                    Client names are per chamber — only that chamber will see them.
                  </Text>
                </View>
              ) : (
                <>
                  <View style={styles.mmCard}>
                    <Text style={styles.mmCardTitle}>
                      Client master · {managerSelectedChamber.name}
                    </Text>
                    <Text style={styles.mmCardHint}>
                      Chamber empty hai to yahan client add karo. Add / edit / delete pe Super Admin notify hota hai (allow nahi).
                    </Text>
                    <View style={styles.mmAddRow}>
                      <TextInput
                        style={styles.mmTextInput}
                        placeholder="Client lot name"
                        placeholderTextColor="#94a3b8"
                        value={newClientInput}
                        onChangeText={setNewClientInput}
                        autoCapitalize="words"
                        returnKeyType="done"
                        onSubmitEditing={handleAddNewClient}
                      />
                      <TouchableOpacity
                        style={styles.mmPrimaryBtn}
                        onPress={handleAddNewClient}
                        activeOpacity={0.85}
                      >
                        <Ionicons name="add" size={18} color="#fff" />
                        <Text style={styles.mmPrimaryBtnText}>Add</Text>
                      </TouchableOpacity>
                    </View>

                    <TouchableOpacity
                      style={styles.mmSuggestToggle}
                      onPress={() => setShowClientSuggestions((v) => !v)}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.mmSuggestToggleText}>
                        {showClientSuggestions ? 'Hide suggestions' : 'Show name suggestions'}
                      </Text>
                      <Ionicons
                        name={showClientSuggestions ? 'chevron-up' : 'chevron-down'}
                        size={16}
                        color="#003580"
                      />
                    </TouchableOpacity>

                    {showClientSuggestions && (
                      <View style={styles.mmSuggestWrap}>
                        {masterClientLots.map((name) => {
                          const already = chamberClients.some(
                            (a) => String(a.client_name).toLowerCase() === name.toLowerCase()
                          );
                          return (
                            <TouchableOpacity
                              key={name}
                              disabled={already}
                              style={[styles.mmSuggestChip, already && styles.mmSuggestChipUsed]}
                              onPress={() => {
                                const success = addLocalAssignment(
                                  managerSelectedChamber.id,
                                  managerSelectedChamber.name,
                                  name,
                                  'Added for this chamber only'
                                );
                                if (success) {
                                  loadLocalAssignmentsData(chambersList);
                                  reportDOActivity(
                                    'ADD_CLIENT',
                                    `Added client "${name}" to ${managerSelectedChamber.name} only`,
                                    'Added for this chamber only'
                                  );
                                  if (apiUrl && token) triggerSync(apiUrl, token, setSyncStatus);
                                }
                              }}
                            >
                              <Text
                                style={[styles.mmSuggestChipText, already && styles.mmSuggestChipTextUsed]}
                                numberOfLines={1}
                              >
                                {already ? `✓ ${name}` : `+ ${name}`}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    )}
                  </View>

                  <Text style={styles.mmSectionLabel}>
                    Clients on {managerSelectedChamber.name} ({chamberClients.length})
                  </Text>

                  <ScrollView
                    style={{ flex: 1 }}
                    contentContainerStyle={{ paddingBottom: 28 }}
                    showsVerticalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                  >
                    {chamberClients.length === 0 ? (
                      <View style={styles.mmEmptyCompact}>
                        <Text style={styles.mmEmptyText}>
                          No clients yet. Add a name above — it stays on this chamber only.
                        </Text>
                      </View>
                    ) : (
                      chamberClients.map((item) => {
                        const isEditing =
                          editingClientName &&
                          Number(editingClientName.chamberId) === Number(managerSelectedChamber.id) &&
                          editingClientName.oldName === item.client_name;
                        return (
                          <View key={item.client_name} style={styles.mmClientRow}>
                            {isEditing ? (
                              <View style={styles.mmAddRow}>
                                <TextInput
                                  style={styles.mmTextInput}
                                  value={editClientDraft}
                                  onChangeText={setEditClientDraft}
                                  autoCapitalize="words"
                                  placeholder="New name"
                                  placeholderTextColor="#94a3b8"
                                  autoFocus
                                />
                                <TouchableOpacity
                                  style={styles.mmIconBtnSuccess}
                                  onPress={handleRenameChamberClient}
                                >
                                  <Ionicons name="checkmark" size={18} color="#15803d" />
                                </TouchableOpacity>
                                <TouchableOpacity
                                  style={styles.mmIconBtnNeutral}
                                  onPress={() => {
                                    setEditingClientName(null);
                                    setEditClientDraft('');
                                  }}
                                >
                                  <Ionicons name="close" size={18} color="#64748b" />
                                </TouchableOpacity>
                              </View>
                            ) : (
                              <>
                                <View style={styles.mmClientAvatar}>
                                  <Text style={styles.mmClientAvatarText}>
                                    {String(item.client_name).charAt(0).toUpperCase()}
                                  </Text>
                                </View>
                                <Text style={styles.mmClientName} numberOfLines={1}>
                                  {item.client_name}
                                </Text>
                                <TouchableOpacity
                                  style={styles.mmIconBtnNeutral}
                                  onPress={() => {
                                    setEditingClientName({
                                      chamberId: managerSelectedChamber.id,
                                      oldName: item.client_name
                                    });
                                    setEditClientDraft(item.client_name);
                                  }}
                                >
                                  <Ionicons name="create-outline" size={16} color="#0369a1" />
                                </TouchableOpacity>
                                <TouchableOpacity
                                  style={styles.mmIconBtnDanger}
                                  onPress={() => handleDeleteClient(item.client_name)}
                                >
                                  <Ionicons name="trash-outline" size={16} color="#dc2626" />
                                </TouchableOpacity>
                              </>
                            )}
                          </View>
                        );
                      })
                    )}
                  </ScrollView>
                </>
              )}
            </View>
          )}
        </SafeAreaView>
      </Modal>
    );
  };

  // 4. CUSTOM CLIENT DELETION REMARK/CONFIRM MODAL
  const renderDeleteConfirmModal = () => {
    const isChamberDeleteRequest = clientToDelete?.type === 'chamber_delete_request';
    return (
      <Modal visible={showDeleteConfirmModal} animationType="fade" transparent>
        <View style={styles.dialogOverlay}>
          <View style={styles.dialogContent}>
            <Text style={styles.dialogTitle}>
              {isChamberDeleteRequest ? 'Request Chamber Delete' : 'Delete Client Master'}
            </Text>
            <Text style={styles.dialogSubtitle}>
              {isChamberDeleteRequest
                ? `Enter remark/reason to request Super Admin allow for deleting "${clientToDelete?.chamberName}":`
                : `Please enter a remark/reason for removing "${clientToDelete?.clientName}" from ${clientToDelete?.chamberName || 'Chamber'}:`}
            </Text>
            
            <TextInput
              style={styles.dialogInput}
              value={deleteRemarkInput}
              onChangeText={setDeleteRemarkInput}
              placeholder={isChamberDeleteRequest ? 'e.g. Chamber decommissioned' : 'e.g. Inward Lot Completed'}
              autoCapitalize="sentences"
            />

            <View style={styles.dialogActionsRow}>
              <TouchableOpacity 
                style={styles.dialogCancelBtn}
                onPress={() => {
                  setShowDeleteConfirmModal(false);
                  setClientToDelete(null);
                  setDeleteRemarkInput('');
                }}
              >
                <Text style={styles.dialogCancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.dialogSaveBtn, { backgroundColor: '#ef4444' }]}
                onPress={async () => {
                  if (!deleteRemarkInput.trim()) {
                    Alert.alert('Validation Error', 'Please enter a deletion remark/reason.');
                    return;
                  }
                  const target = clientToDelete;
                  if (!target) return;
                  const remark = deleteRemarkInput.trim();

                  if (target.type === 'chamber_delete_request') {
                    setShowDeleteConfirmModal(false);
                    setDeleteRemarkInput('');
                    setClientToDelete(null);
                    await requestChamberDeletePermission(
                      { id: target.chamberId, name: target.chamberName },
                      remark
                    );
                    return;
                  }

                  const success = deleteLocalAssignment(
                    target.chamberId,
                    target.clientName,
                    remark
                  );
                  if (success) {
                    setShowDeleteConfirmModal(false);
                    setDeleteRemarkInput('');
                    loadLocalAssignmentsData(chambersList);
                    reportDOActivity(
                      'DELETE_CLIENT',
                      `${displayName} deleted client master "${target.clientName}" from ${target.chamberName} (chamber_id: ${target.chamberId}). Remark: ${remark}`,
                      remark
                    );
                    if (apiUrl && token) triggerSync(apiUrl, token, setSyncStatus);
                    if (target.permissionNotifId) {
                      markPermissionNotificationComplete(target.permissionNotifId);
                    }
                    if (selectedClient === target.clientName) {
                      setSelectedClient(null);
                      setTempInput('');
                      setBoxCountInput('');
                      setCapturedImage(null);
                      setCapturedImageTimestamp(null);
                    }
                    setClientToDelete(null);
                    Alert.alert(
                      'Deleted',
                      `"${target.clientName}" removed from ${target.chamberName}. Super Admin has been notified.`
                    );
                  } else {
                    Alert.alert('Error', 'Failed to delete client locally.');
                  }
                }}
              >
                <Text style={styles.dialogSaveBtnText}>
                  {isChamberDeleteRequest ? 'Send Request' : 'Confirm Delete'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  // Super Admin edit-permission request popup (Completed → Edit)
  const renderPermissionModal = () => {
    if (!permissionModal.isOpen) return null;
    const log = permissionModal.log;
    const status = permissionModal.status || 'None';
    const statusColor =
      status === 'Pending' ? '#ca8a04' :
      status === 'Denied' ? '#dc2626' :
      status === 'Used' ? '#64748b' :
      status === 'Approved' ? '#16a34a' : '#64748b';

    return (
      <Modal visible={permissionModal.isOpen} animationType="fade" transparent onRequestClose={() => setPermissionModal(prev => ({ ...prev, isOpen: false }))}>
        <View style={styles.dialogOverlay}>
          <View style={[styles.dialogContent, { maxWidth: 360 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <Ionicons name="shield-checkmark-outline" size={22} color="#ea580c" style={{ marginRight: 8 }} />
              <Text style={[styles.dialogTitle, { marginBottom: 0, flex: 1 }]}>Permission Required</Text>
              <TouchableOpacity onPress={() => setPermissionModal(prev => ({ ...prev, isOpen: false }))}>
                <Ionicons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>

            <View style={{ backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fef3c7', borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <Text style={{ fontSize: 12, color: '#b45309', fontWeight: '700', lineHeight: 18 }}>
                To update this completed log, first get permission from Super Admin. Each approval allows one update only.
              </Text>
            </View>

            <View style={{ backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, padding: 12, marginBottom: 12, gap: 6 }}>
              <Text style={{ fontSize: 12, color: '#334155' }}>
                <Text style={{ fontWeight: '800' }}>Record:</Text> Chamber DO Log
              </Text>
              <Text style={{ fontSize: 12, color: '#334155' }}>
                <Text style={{ fontWeight: '800' }}>Ref / ID:</Text> {log?.reference_no || `#${getServerLogIdForPermission(log) || '-'}`}
              </Text>
              <Text style={{ fontSize: 12, color: '#334155' }}>
                <Text style={{ fontWeight: '800' }}>Client:</Text> {log?.client_name || '-'}
              </Text>
              <Text style={{ fontSize: 12, color: '#334155' }}>
                <Text style={{ fontWeight: '800' }}>Chamber:</Text> {log?.chamber_name || '-'}
              </Text>
              <Text style={{ fontSize: 12, color: '#334155' }}>
                <Text style={{ fontWeight: '800' }}>Status:</Text>{' '}
                <Text style={{ fontWeight: '800', color: statusColor }}>
                  {status === 'None' ? 'Not Requested' : status === 'Used' ? 'Used (request again)' : status}
                </Text>
              </Text>
            </View>

            {status === 'Pending' ? (
              <Text style={{ fontSize: 12, color: '#ca8a04', fontWeight: '600', marginBottom: 14, lineHeight: 18 }}>
                Request is pending Super Admin approval. Open Role & Permission on Super Admin panel to approve, then tap Edit again.
              </Text>
            ) : status === 'Used' ? (
              <Text style={{ fontSize: 12, color: '#0f172a', fontWeight: '600', marginBottom: 14, lineHeight: 18 }}>
                Previous approval was already used for one update. Request permission again?
              </Text>
            ) : (
              <Text style={{ fontSize: 12, color: '#0f172a', fontWeight: '600', marginBottom: 14, lineHeight: 18 }}>
                Send an edit permission request to Super Admin?
              </Text>
            )}

            <View style={styles.dialogActionsRow}>
              <TouchableOpacity
                style={styles.dialogCancelBtn}
                onPress={() => setPermissionModal(prev => ({ ...prev, isOpen: false }))}
              >
                <Text style={styles.dialogCancelBtnText}>Back</Text>
              </TouchableOpacity>

              {(status === 'None' || status === 'Denied' || status === 'Used') && (
                <TouchableOpacity
                  style={[styles.dialogSaveBtn, { backgroundColor: '#ea580c', opacity: permissionRequestBusy ? 0.7 : 1 }]}
                  disabled={permissionRequestBusy}
                  onPress={handleRequestEditPermission}
                >
                  {permissionRequestBusy ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.dialogSaveBtnText}>Request Permission</Text>
                  )}
                </TouchableOpacity>
              )}

              {status === 'Pending' && permissionModal.taskItem && (
                <TouchableOpacity
                  style={[styles.dialogSaveBtn, { backgroundColor: '#2563eb' }]}
                  onPress={() => {
                    setPermissionModal(prev => ({ ...prev, isOpen: false }));
                    handleEditCompletedLog(permissionModal.taskItem);
                  }}
                >
                  <Text style={styles.dialogSaveBtnText}>Check Again</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  // Submission Confirmation Dialog — photo capture time vs submit time (new + edit)
  const renderSubmitConfirmModal = () => {
    if (!showSubmitConfirmModal) return null;

    const submitNowMs = Date.now();
    const diffMins = getImageTimeDifferenceInMinutes(submitNowMs);
    const isVarianceAlert = diffMins == null || diffMins > 5;
    const photoClock = formatClockTime(capturedImageTimestamp);
    const submitClock = formatClockTime(submitNowMs);

    return (
      <Modal visible={showSubmitConfirmModal} animationType="fade" transparent>
        <View style={styles.dialogOverlay}>
          <View style={[styles.dialogContent, { maxWidth: 340 }]}>
            <View style={{ alignItems: 'center', marginBottom: 15 }}>
              <View style={{
                backgroundColor: isVarianceAlert ? '#fee2e2' : '#dcfce7', 
                width: 50, 
                height: 50, 
                borderRadius: 25, 
                alignItems: 'center', 
                justifyContent: 'center',
                marginBottom: 10
              }}>
                <Ionicons 
                  name={isVarianceAlert ? "warning" : "checkmark-circle"} 
                  size={30} 
                  color={isVarianceAlert ? "#ef4444" : "#16a34a"} 
                />
              </View>
              <Text style={[styles.dialogTitle, { textAlign: 'center' }]}>
                {editingExistingLog ? 'Confirm Edit Update' : 'Confirm Submission'}
              </Text>
            </View>

            <View style={{
              backgroundColor: '#f8fafc',
              borderRadius: 10,
              borderWidth: 1,
              borderColor: '#e2e8f0',
              paddingVertical: 10,
              paddingHorizontal: 12,
              marginBottom: 14
            }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text style={{ fontSize: 11, color: '#64748b', fontWeight: '600' }}>Photo capture</Text>
                <Text style={{ fontSize: 12, color: '#0f172a', fontWeight: '800' }}>{photoClock}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text style={{ fontSize: 11, color: '#64748b', fontWeight: '600' }}>Submit time</Text>
                <Text style={{ fontSize: 12, color: '#0f172a', fontWeight: '800' }}>{submitClock}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 11, color: '#64748b', fontWeight: '600' }}>Difference</Text>
                <Text style={{
                  fontSize: 12,
                  fontWeight: '800',
                  color: isVarianceAlert ? '#dc2626' : '#16a34a'
                }}>
                  {diffMins == null ? 'N/A' : `${diffMins} min`}
                </Text>
              </View>
            </View>

            <Text style={[styles.dialogSubtitle, { textAlign: 'center', marginBottom: 20 }]}>
              {diffMins == null ? (
                <Text style={{ color: '#ef4444', fontWeight: 'bold' }}>
                  Photo capture time missing. Retake verification photo, then submit.
                </Text>
              ) : isVarianceAlert ? (
                <Text style={{ color: '#ef4444', fontWeight: 'bold' }}>
                  Warning: Photo was captured {diffMins} minutes before submit (limit 5 minutes).
                </Text>
              ) : (
                <Text style={{ color: '#16a34a', fontWeight: 'bold' }}>
                  Photo time vs submit is compliant ({diffMins} min).
                </Text>
              )}
            </Text>

            <Text style={{ fontSize: 12, color: '#64748b', textAlign: 'center', marginBottom: 20 }}>
              {editingExistingLog
                ? 'Continue to update this inspection record?'
                : 'Do you want to continue and submit this inspection record?'}
            </Text>

            <View style={styles.dialogActionsRow}>
              <TouchableOpacity 
                style={styles.dialogCancelBtn}
                onPress={() => setShowSubmitConfirmModal(false)}
              >
                <Text style={styles.dialogCancelBtnText}>Back</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[
                  styles.dialogSaveBtn, 
                  { backgroundColor: isVarianceAlert ? '#dc2626' : '#003580' }
                ]}
                onPress={handleConfirmSaveInspection}
              >
                <Text style={styles.dialogSaveBtnText}>Continue</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  // Helper to generate calendar grid days for a given month
  const getCalendarDays = (dateObj) => {
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth();
    
    const firstDay = new Date(year, month, 1);
    const totalDays = new Date(year, month + 1, 0).getDate();
    let startDayOfWeek = firstDay.getDay(); 
    
    const days = [];
    for (let i = 0; i < startDayOfWeek; i++) {
      days.push(null);
    }
    for (let day = 1; day <= totalDays; day++) {
      days.push(new Date(year, month, day));
    }
    return days;
  };

  // Custom month calendar modal — pick From then To for report range
  const renderCalendarModal = () => {
    if (!showCalendarModal) return null;

    const days = getCalendarDays(calendarMonth);
    const monthName = calendarMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const rangeStart = reportDateFrom <= reportDateTo ? reportDateFrom : reportDateTo;
    const rangeEnd = reportDateFrom <= reportDateTo ? reportDateTo : reportDateFrom;

    return (
      <Modal visible={showCalendarModal} transparent animationType="fade" onRequestClose={() => setShowCalendarModal(false)}>
        <View style={styles.dialogOverlay}>
          <View style={[styles.dialogContent, { width: 320, padding: 16 }]}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: '#0f172a', marginBottom: 4 }}>
              Select date range
            </Text>
            <Text style={{ fontSize: 11, color: '#64748b', marginBottom: 12 }}>
              {calendarPickMode === 'from'
                ? 'Tap start date, then end date'
                : 'Tap end date to finish range'}
            </Text>

            <View style={{ flexDirection: 'row', marginBottom: 12 }}>
              <TouchableOpacity
                style={[
                  styles.reportRangePickChip,
                  calendarPickMode === 'from' && styles.reportRangePickChipActive,
                  { marginRight: 8 }
                ]}
                onPress={() => setCalendarPickMode('from')}
              >
                <Text style={[
                  styles.reportRangePickChipText,
                  calendarPickMode === 'from' && styles.reportRangePickChipTextActive
                ]}>
                  From: {reportDateFrom}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.reportRangePickChip,
                  calendarPickMode === 'to' && styles.reportRangePickChipActive
                ]}
                onPress={() => setCalendarPickMode('to')}
              >
                <Text style={[
                  styles.reportRangePickChipText,
                  calendarPickMode === 'to' && styles.reportRangePickChipTextActive
                ]}>
                  To: {reportDateTo}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <TouchableOpacity onPress={() => {
                const prev = new Date(calendarMonth);
                prev.setMonth(prev.getMonth() - 1);
                setCalendarMonth(prev);
              }}>
                <Ionicons name="chevron-back" size={20} color="#003580" />
              </TouchableOpacity>
              
              <Text style={{ fontSize: 14, fontWeight: 'bold', color: '#0f172a' }}>{monthName}</Text>
              
              <TouchableOpacity onPress={() => {
                const next = new Date(calendarMonth);
                next.setMonth(next.getMonth() + 1);
                setCalendarMonth(next);
              }}>
                <Ionicons name="chevron-forward" size={20} color="#003580" />
              </TouchableOpacity>
            </View>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 }}>
              {weekDays.map(d => (
                <Text key={d} style={{ width: '14.28%', textAlign: 'center', fontSize: 10, color: '#64748b', fontWeight: 'bold' }}>
                  {d[0]}
                </Text>
              ))}
            </View>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {days.map((d, index) => {
                if (d === null) {
                  return <View key={`empty_${index}`} style={{ width: '14.28%', height: 34 }} />;
                }
                const dateStr = d.toISOString().split('T')[0];
                const isStart = dateStr === rangeStart;
                const isEnd = dateStr === rangeEnd;
                const inRange = dateStr >= rangeStart && dateStr <= rangeEnd;
                const isToday = dateStr === new Date().toISOString().split('T')[0];

                return (
                  <TouchableOpacity
                    key={dateStr}
                    style={{
                      width: '14.28%',
                      height: 34,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 17,
                      backgroundColor: isStart || isEnd ? '#003580' : inRange ? '#dbeafe' : 'transparent',
                      borderWidth: isToday && !isStart && !isEnd ? 1 : 0,
                      borderColor: '#003580',
                    }}
                    onPress={() => {
                      if (calendarPickMode === 'from') {
                        setReportDateFrom(dateStr);
                        setSelectedReportDate(dateStr);
                        // If new from is after current to, move to as well
                        if (dateStr > reportDateTo) {
                          setReportDateTo(dateStr);
                        }
                        setCalendarPickMode('to');
                      } else {
                        let nextFrom = reportDateFrom;
                        let nextTo = dateStr;
                        if (dateStr < reportDateFrom) {
                          nextFrom = dateStr;
                          nextTo = reportDateFrom;
                        }
                        setReportDateFrom(nextFrom);
                        setReportDateTo(nextTo);
                        setSelectedReportDate(nextTo);
                        setCalendarPickMode('from');
                        setShowCalendarModal(false);
                      }
                    }}
                  >
                    <Text style={{
                      fontSize: 11,
                      fontWeight: isStart || isEnd || isToday ? 'bold' : 'normal',
                      color: isStart || isEnd ? '#ffffff' : '#0f172a'
                    }}>
                      {d.getDate()}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity 
              style={[styles.dialogCancelBtn, { marginTop: 16, alignSelf: 'stretch', alignItems: 'center' }]}
              onPress={() => setShowCalendarModal(false)}
            >
              <Text style={styles.dialogCancelBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  };

  // Horizontal Date Slider selector element
  const renderDateSlider = () => {
    const sliderDates = [];
    const weekDayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      sliderDates.push(d);
    }

    return (
      <View style={styles.sliderOuterContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sliderScroll}>
          {sliderDates.map((dateObj, i) => {
            const dateStr = dateObj.toISOString().split('T')[0];
            const isSelected =
              reportDateFrom === reportDateTo && dateStr === reportDateFrom;
            const dayName = i === 0 ? 'Today' : weekDayNames[dateObj.getDay()];
            const dayNum = String(dateObj.getDate()).padStart(2, '0');

            return (
              <TouchableOpacity
                key={dateStr}
                style={[
                  styles.sliderCard,
                  isSelected && styles.sliderCardActive
                ]}
                onPress={() => {
                  setSelectedReportDate(dateStr);
                  setReportDateFrom(dateStr);
                  setReportDateTo(dateStr);
                }}
              >
                <Text style={[styles.sliderDayName, isSelected && styles.sliderTextActive]}>{dayName}</Text>
                <Text style={[styles.sliderDayNum, isSelected && styles.sliderTextActive]}>{dayNum}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        
        <TouchableOpacity 
          style={styles.sliderCalendarBtn}
          onPress={() => {
            setCalendarMonth(new Date(reportDateFrom));
            setCalendarPickMode('from');
            setShowCalendarModal(true);
          }}
        >
          <Ionicons name="calendar-outline" size={18} color="#003580" />
          <Text style={styles.sliderCalendarBtnText}>Range</Text>
        </TouchableOpacity>
      </View>
    );
  };

  // Hamburger Drawer Menu Modal
  const renderDrawerModal = () => {
    if (!showDrawer) return null;

    const isDailyTasksActive = currentNavTab === 'Tasks' || currentNavTab === 'Reports' || currentNavTab === 'More';

    return (
      <Modal
        visible={showDrawer}
        animationType="none"
        transparent
        onRequestClose={closeDrawer}
      >
        <View style={styles.drawerOverlay}>
          {/* Drawer Content Panel (rendered first to slide out from Left side) */}
          <Animated.View style={[styles.drawerPanel, { transform: [{ translateX: drawerAnim }] }]}>
            {/* Drawer Header (Contains Operator Profile & Close Button) */}
            <View style={styles.drawerHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <View style={styles.drawerUserAvatar}>
                  <Ionicons name="person" size={18} color="#003580" />
                </View>
                <View style={{ marginLeft: 10, flex: 1 }}>
                  <Text style={styles.drawerUserName} numberOfLines={1}>
                    {displayName}
                  </Text>
                  <Text style={styles.drawerUserRole}>
                    {user?.role === 'do_operator' ? 'Data Operator' : 'Operator'}
                  </Text>
                </View>
              </View>
              <TouchableOpacity onPress={closeDrawer} style={{ marginLeft: 10 }}>
                <Ionicons name="close-circle-outline" size={26} color="#64748b" />
              </TouchableOpacity>
            </View>

            {/* Menu Options List */}
            <ScrollView style={styles.drawerMenuScroll} showsVerticalScrollIndicator={false}>
              
              {/* Dashboard Menu Item */}
              <TouchableOpacity 
                style={[
                  styles.drawerMenuItem, 
                  currentNavTab === 'Dashboard' && styles.drawerMenuItemActive
                ]}
                onPress={() => {
                  handleNavTabChange('Dashboard');
                  closeDrawer();
                }}
              >
                <Ionicons 
                  name={currentNavTab === 'Dashboard' ? 'home' : 'home-outline'} 
                  size={20} 
                  color={currentNavTab === 'Dashboard' ? '#003580' : '#475569'} 
                  style={{ marginRight: 12 }}
                />
                <Text style={[
                  styles.drawerMenuText,
                  currentNavTab === 'Dashboard' && styles.drawerMenuTextActive
                ]}>
                  Dashboard
                </Text>
              </TouchableOpacity>

              {/* Daily Tasks Menu Item */}
              <TouchableOpacity 
                style={[
                  styles.drawerMenuItem, 
                  isDailyTasksActive && styles.drawerMenuItemActive
                ]}
                onPress={() => {
                  handleNavTabChange('Tasks');
                  closeDrawer();
                }}
              >
                <Ionicons 
                  name={isDailyTasksActive ? 'clipboard' : 'clipboard-outline'} 
                  size={20} 
                  color={isDailyTasksActive ? '#003580' : '#475569'} 
                  style={{ marginRight: 12 }}
                />
                <Text style={[
                  styles.drawerMenuText,
                  isDailyTasksActive && styles.drawerMenuTextActive
                ]}>
                  Daily Tasks
                </Text>
              </TouchableOpacity>

            </ScrollView>

            {/* Logout Option at Bottom of Drawer */}
            <View style={styles.drawerFooter}>
              <TouchableOpacity 
                style={styles.drawerLogoutBtn}
                onPress={() => {
                  closeDrawer();
                  onLogout();
                }}
              >
                <Ionicons name="log-out-outline" size={20} color="#ef4444" style={{ marginRight: 12 }} />
                <Text style={styles.drawerLogoutText}>Logout Session</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>

          {/* Backdrop Touch Area to close (rendered second to fill right side) */}
          <TouchableOpacity 
            style={styles.drawerBackdrop} 
            activeOpacity={1} 
            onPress={closeDrawer} 
          />
        </View>
      </Modal>
    );
  };

  // 5. ADD CHAMBER MODAL (name + remark → SA allow)
  const renderAddChamberModal = () => {
    return (
      <Modal visible={showAddChamberModal} animationType="fade" transparent>
        <View style={styles.dialogOverlay}>
          <View style={styles.dialogContent}>
            <Text style={styles.dialogTitle}>Request Add Chamber</Text>
            <Text style={styles.dialogSubtitle}>
              Fill chamber name and remark, then send request. Super Admin will allow it in Role & Permission.
            </Text>

            <Text style={[styles.modalLabel, { fontSize: 11, marginBottom: 4 }]}>Chamber Name *</Text>
            <TextInput
              style={styles.dialogInput}
              placeholder="e.g. Chamber 3 / Cold Store A"
              placeholderTextColor="#94a3b8"
              value={addChamberNameInput}
              onChangeText={setAddChamberNameInput}
              autoCapitalize="words"
            />

            <Text style={[styles.modalLabel, { fontSize: 11, marginBottom: 4 }]}>Remark / Reason *</Text>
            <TextInput
              style={styles.dialogInput}
              placeholder="e.g. New dock line activated"
              placeholderTextColor="#94a3b8"
              value={addChamberRemarkInput}
              onChangeText={setAddChamberRemarkInput}
              autoCapitalize="sentences"
            />

            <View style={styles.dialogActionsRow}>
              <TouchableOpacity
                style={styles.dialogCancelBtn}
                disabled={addChamberBusy}
                onPress={() => {
                  setShowAddChamberModal(false);
                  setAddChamberNameInput('');
                  setAddChamberRemarkInput('');
                }}
              >
                <Text style={styles.dialogCancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.dialogSaveBtn, addChamberBusy && { opacity: 0.7 }]}
                disabled={addChamberBusy}
                onPress={submitAddChamberRequest}
              >
                <Text style={styles.dialogSaveBtnText}>
                  {addChamberBusy ? 'Sending…' : 'Send Request'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  // 5b. ADD CLIENT MODAL DIALOG (CENTERED POPUP)
  const renderAddClientModal = () => {
    return (
      <Modal visible={showAddClientModal} animationType="fade" transparent>
        <View style={styles.dialogOverlay}>
          <View style={styles.dialogContent}>
            <Text style={styles.dialogTitle}>Add New Client Lot</Text>
            <Text style={styles.dialogSubtitle}>Assign a new client to {selectedChamber?.name}:</Text>
            
            <Text style={[styles.modalLabel, { fontSize: 11, marginBottom: 4 }]}>Client Name</Text>
            <TextInput
              style={styles.dialogInput}
              placeholder="e.g. Reliance Fresh"
              placeholderTextColor="#94a3b8"
              value={inlineClientInput}
              onChangeText={setInlineClientInput}
              autoCapitalize="words"
            />

            <View style={styles.dialogActionsRow}>
              <TouchableOpacity 
                style={styles.dialogCancelBtn}
                onPress={() => {
                  setInlineClientInput('');
                  setInlineRemarkInput('');
                  setShowAddClientModal(false);
                }}
              >
                <Text style={styles.dialogCancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={styles.dialogSaveBtn}
                onPress={() => {
                  if (!inlineClientInput.trim()) {
                    Alert.alert('Validation Error', 'Please enter a client name.');
                    return;
                  }
                  const name = ensureClientInLotMaster(inlineClientInput);
                  const exists = assignments.some(item => Number(item.chamber_id) === Number(selectedChamber.id) && item.client_name.toLowerCase() === name.toLowerCase());
                  if (exists) {
                    Alert.alert('Duplicate Client', `"${name}" is already in the list.`);
                    return;
                  }
                  
                  const success = addLocalAssignment(selectedChamber.id, selectedChamber.name, name, '');
                  if (success) {
                    setInlineClientInput('');
                    setInlineRemarkInput('');
                    setShowAddClientModal(false);
                    loadLocalAssignmentsData(chambersList);
                    reportDOActivity('ADD_CLIENT', `Added client "${name}" to ${selectedChamber.name} only`, '');
                    if (apiUrl && token) triggerSync(apiUrl, token, setSyncStatus);
                    setSelectedClient(name);
                    setTempInput('');
                    setBoxCountInput('');
                    setCapturedImage(null);
                    setCapturedImageTimestamp(null);
                  } else {
                    Alert.alert('Database Error', 'Failed to add client.');
                  }
                }}
              >
                <Text style={styles.dialogSaveBtnText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  // 3. BOTTOM NAVIGATION TAB BAR WITH FAB CENTER '+'
  const renderBottomTabBar = () => {
    return (
      <View style={styles.tabBarContainer}>
        {/* Left Side Tabs */}
        <View style={styles.tabBarLeft}>
          <TouchableOpacity 
            style={styles.tabBarItem} 
            onPress={() => handleNavTabChange('Dashboard')}
          >
            <Ionicons 
              name={currentNavTab === 'Dashboard' ? 'home' : 'home-outline'} 
              size={22} 
              color={currentNavTab === 'Dashboard' ? '#003580' : '#64748b'} 
            />
            <Text style={[styles.tabBarLabel, currentNavTab === 'Dashboard' && styles.tabBarLabelActive]}>
              Dashboard
            </Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.tabBarItem} 
            onPress={() => handleNavTabChange('Tasks')}
          >
            <Ionicons 
              name={currentNavTab === 'Tasks' ? 'clipboard' : 'clipboard-outline'} 
              size={22} 
              color={currentNavTab === 'Tasks' ? '#003580' : '#64748b'} 
            />
            <Text style={[styles.tabBarLabel, currentNavTab === 'Tasks' && styles.tabBarLabelActive]}>
              Tasks
            </Text>
          </TouchableOpacity>
        </View>

        {/* Center Floating Action Button (FAB) */}
        <View style={styles.fabContainer}>
          <TouchableOpacity 
            style={styles.fabBtn} 
            activeOpacity={0.8}
            onPress={openMasterManager}
          >
            <Ionicons name="add" size={32} color="#ffffff" />
          </TouchableOpacity>
        </View>

        {/* Right Side Tabs */}
        <View style={styles.tabBarRight}>
          <TouchableOpacity 
            style={styles.tabBarItem} 
            onPress={() => handleNavTabChange('Reports')}
          >
            <Ionicons 
              name={currentNavTab === 'Reports' ? 'stats-chart' : 'stats-chart-outline'} 
              size={22} 
              color={currentNavTab === 'Reports' ? '#003580' : '#64748b'} 
            />
            <Text style={[styles.tabBarLabel, currentNavTab === 'Reports' && styles.tabBarLabelActive]}>
              Reports
            </Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.tabBarItem} 
            onPress={() => handleNavTabChange('More')}
          >
            <Ionicons 
              name={currentNavTab === 'More' ? 'ellipsis-horizontal' : 'ellipsis-horizontal-outline'} 
              size={22} 
              color={currentNavTab === 'More' ? '#003580' : '#64748b'} 
            />
            <Text style={[styles.tabBarLabel, currentNavTab === 'More' && styles.tabBarLabelActive]}>
              More
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // Main UI Shell
  if (isLoadingData) {
    return (
      <SafeAreaView style={[styles.container, { justifyContent: 'center', alignItems: 'center', backgroundColor: '#f1f5f9' }]}>
        <StatusBar barStyle="dark-content" backgroundColor="#f1f5f9" />
        <ActivityIndicator size="large" color="#003580" />
        <Text style={{ marginTop: 15, fontSize: 13, color: '#475569', fontWeight: 'bold' }}>
          Loading chamber data...
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#003580" />
      
      {/* Header bar */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity onPress={() => setShowDrawer(true)}>
            <Ionicons name="menu-outline" size={26} color="#ffffff" style={{ marginRight: 10 }} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{currentNavTab}</Text>
        </View>
        <View style={styles.headerRight}>
          {syncStatus === 'syncing' ? (
            <ActivityIndicator size="small" color="#ffffff" style={{ marginRight: 12 }} />
          ) : (
            <TouchableOpacity onPress={() => triggerSync(apiUrl, token, setSyncStatus)}>
              <Ionicons name="sync-outline" size={22} color="#ffffff" style={{ marginRight: 12 }} />
            </TouchableOpacity>
          )}
          {(() => {
            const { pendingMorning, pendingEvening, isEveningUnlocked } = getActiveTasksDetails();
            const hasMorningPending = pendingMorning.length > 0;
            const hasEveningPending = isEveningUnlocked && pendingEvening.length > 0;
            const permissionAlertCount = getActivePermissionAlerts().length;
            const totalPendingCount =
              (hasMorningPending ? pendingMorning.length : 0) +
              (hasEveningPending ? pendingEvening.length : 0) +
              permissionAlertCount;

            return (
              <TouchableOpacity onPress={() => setShowNotificationsModal(true)} style={{ position: 'relative' }}>
                <Ionicons name="notifications-outline" size={24} color="#ffffff" />
                 {totalPendingCount > 0 && (
                  <View style={{
                    position: 'absolute',
                    top: 1,
                    right: 2,
                    backgroundColor: '#ef4444',
                    borderRadius: 4,
                    width: 8,
                    height: 8,
                    borderWidth: 1.2,
                    borderColor: '#003580'
                  }} />
                )}
              </TouchableOpacity>
            );
          })()}
        </View>
      </View>

      {/* Conditional View Rendering */}
      {currentNavTab === 'Dashboard' && renderDashboardView()}
      {currentNavTab === 'Tasks' && renderTasksView()}
      {currentNavTab === 'Reports' && renderReportsView()}
      {currentNavTab === 'More' && renderMoreView()}

      {/* Global Modals */}
      {renderTaskProfileModal()}
      {renderClientManagerModal()}
      {renderDeleteConfirmModal()}
      {renderAddChamberModal()}
      {renderAddClientModal()}
      {renderSubmitConfirmModal()}
      {renderPermissionModal()}
      {renderDrawerModal()}
      {renderInventoryModal()}
      {renderHistoryModal()}
      {renderNotificationsModal()}
      {renderCalendarModal()}

      {/* Navigation Tab Bar Overlay */}
      {renderBottomTabBar()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f1f5f9', 
  },
  header: {
    backgroundColor: '#003580', 
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  scrollContainer: {
    paddingHorizontal: 14,
    paddingTop: 14,
  },

  // Welcome Greetings Card
  welcomeCard: {
    backgroundColor: '#0a1128', 
    borderRadius: 12,
    padding: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  welcomeInfo: {
    flex: 1,
    marginRight: 6,
  },
  welcomeText: {
    fontSize: 14.5,
    fontWeight: 'bold',
    color: '#ffffff',
    letterSpacing: 0.2,
  },
  roleText: {
    fontSize: 11,
    color: '#94a3b8', 
    marginTop: 1,
    fontWeight: '500',
  },
  warehouseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  warehouseText: {
    fontSize: 10.5,
    color: '#93c5fd', 
    fontWeight: 'bold',
    marginLeft: 5,
  },
  dateContainer: {
    backgroundColor: '#ffffff', 
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
    width: 105,
    minHeight: 65,
    justifyContent: 'center',
  },
  dateText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  dateSub: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 2,
  },
  dayText: {
    fontSize: 8.5,
    color: '#64748b',
    fontWeight: '500',
  },
  timeText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#003580', 
  },

  // Server Connection IP Address Card
  ipConfigCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    marginBottom: 14,
  },
  ipHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  ipLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#003580',
  },
  editIpBtn: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  editIpBtnText: {
    fontSize: 12,
    color: '#003580',
    fontWeight: 'bold',
  },
  ipAddressBox: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 0.5,
    borderColor: '#e2e8f0',
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  ipAddressText: {
    fontSize: 13,
    color: '#475569',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },

  // Offline alert banner
  offlineAlertCard: {
    backgroundColor: '#fff7ed',
    borderWidth: 1,
    borderColor: '#ffedd5',
    borderRadius: 12,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  offlineAlertTextContainer: {
    flex: 1,
    marginLeft: 8,
  },
  offlineAlertTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#ea580c',
  },
  offlineAlertSubtitle: {
    fontSize: 10,
    color: '#c2410c',
  },
  syncBtn: {
    backgroundColor: '#ea580c',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  syncBtnText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: 'bold',
  },

  // Metrics horizontal scrolling container
  metricsContainer: {
    marginBottom: 14,
  },
  metricsHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 6,
    paddingHorizontal: 2,
  },
  metricsTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#003580',
  },
  viewAllText: {
    fontSize: 12,
    color: '#0284c7',
    fontWeight: 'bold',
  },
  metricsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  metricCard: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 2,
    marginHorizontal: 3,
    alignItems: 'center',
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  metricCardActive: {
    borderColor: '#0284c7',
    borderWidth: 2,
  },
  metricIconCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  metricValue: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 2,
  },
  metricLabel: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#334155',
    textAlign: 'center',
  },
  metricSubtitle: {
    fontSize: 7,
    color: '#64748b',
    textAlign: 'center',
    marginTop: 1,
  },

  // 2-column chambers grid layout
  chambersGrid: {
    flexDirection: 'column',
    paddingVertical: 8,
    width: '100%',
  },
  chamberCard: {
    width: '100%',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    borderWidth: 1.2,
    borderColor: '#e2e8f0', 
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
  },
  chamberCardAlertBorder: {
    borderColor: '#ef4444', 
    borderWidth: 1.5,
  },
  chamberCardNeedsClients: {
    borderColor: '#7dd3fc',
    backgroundColor: '#f0f9ff',
  },
  setupClientsBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#e0f2fe',
    borderWidth: 1,
    borderColor: '#7dd3fc',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  setupClientsBannerIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  setupClientsBannerTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  setupClientsBannerSub: {
    fontSize: 11,
    fontWeight: '600',
    color: '#0369a1',
    marginTop: 2,
    lineHeight: 15,
  },
  setupClientsBannerCta: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0284c7',
  },
  addClientChip: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  addClientChipText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#ffffff',
  },
  chamberCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
    width: '100%',
  },
  chamberCardName: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#64748b',
  },
  chamberCardClients: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#0f172a',
    marginVertical: 4,
    textAlign: 'center',
    height: 32,
    lineHeight: 16,
    width: '100%',
    paddingHorizontal: 4,
  },
  typePill: {
    paddingHorizontal: 12,
    paddingVertical: 2.5,
    borderRadius: 12,
    marginVertical: 6,
  },
  typePillText: {
    fontSize: 9,
    fontWeight: 'bold',
  },
  statusIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 5,
  },
  statusText: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  emptyGridPlaceholder: {
    width: '100%',
    padding: 24,
    backgroundColor: '#ffffff',
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  emptyGridText: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 6,
    textAlign: 'center',
    fontWeight: '500',
  },

  // Drill down chamber header
  chamberHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 12,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  backBtnText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#003580',
    marginLeft: 4,
  },
  selectedChamberTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  actionContainer: {
    marginVertical: 10,
  },
  recordLogBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#003580',
    paddingVertical: 12,
    borderRadius: 10,
  },
  recordLogBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: 'bold',
  },
  tasksSection: {
    marginTop: 10,
  },
  tasksSectionTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#475569',
    marginBottom: 10,
  },

  // Generic Task list items
  taskItemCard: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 10,
    flexDirection: 'row',
    overflow: 'hidden',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  taskItemCardCompleted: {
    backgroundColor: '#fcfcfd',
  },
  taskItemCardOverdue: {
    backgroundColor: '#fafafa',
  },
  taskCardAccent: {
    width: 3,
  },
  taskCardAccentPending: {
    backgroundColor: '#94a3b8',
  },
  taskCardAccentDone: {
    backgroundColor: '#003580',
  },
  taskCardAccentOverdue: {
    backgroundColor: '#64748b',
  },
  taskCardBody: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  taskCardMain: {
    flex: 1,
    marginRight: 10,
    minWidth: 0,
  },
  taskCardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  taskStatusLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginBottom: 6,
    textAlign: 'center',
  },
  taskStatusPending: {
    color: '#ea580c',
  },
  taskStatusDone: {
    color: '#16a34a',
  },
  taskStatusOverdue: {
    color: '#b91c1c',
  },
  taskMetaLine: {
    fontSize: 11,
    fontWeight: '500',
    color: '#64748b',
    lineHeight: 16,
    marginTop: 4,
  },
  taskReadingRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: 6,
  },
  taskCardActions: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tasksInfoBanner: {
    backgroundColor: '#f8fafc',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginHorizontal: 15,
    marginTop: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  tasksInfoTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#334155',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  tasksInfoText: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 4,
    lineHeight: 15,
  },
  taskItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  statusIndicator: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  taskDetails: {
    flex: 1,
  },
  taskClientName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  taskClientMeta: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  taskChamberBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#f1f5f9',
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    marginTop: 4,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  taskChamberText: {
    fontSize: 9,
    fontWeight: '600',
    color: '#475569',
  },
  taskMetaChip: {
    backgroundColor: '#f8fafc',
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  taskMetaChipText: {
    fontSize: 9,
    fontWeight: '600',
    color: '#475569',
    letterSpacing: 0.2,
  },
  taskOverdueText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#b91c1c',
    marginTop: 4,
  },
  taskOverdueDateText: {
    fontSize: 10,
    fontWeight: '500',
    color: '#94a3b8',
    marginTop: 4,
  },
  taskItemRight: {
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  readingLoggedWrapper: {
    alignItems: 'flex-end',
  },
  readingLoggedText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    marginRight: 6,
  },
  taskLoggedTime: {
    fontSize: 10,
    color: '#94a3b8',
    fontWeight: '500',
  },
  logActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#003580',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    minWidth: 98,
    minHeight: 30,
  },
  logActionBtnText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#ffffff',
  },
  pendingActionWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  pendingActionText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#003580',
    marginRight: 2,
  },

  // Global Dialog Modals & Overlays
  dialogOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialogContent: {
    width: '85%',
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    elevation: 10,
  },
  dialogTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#0f172a',
    marginBottom: 4,
  },
  dialogSubtitle: {
    fontSize: 12,
    color: '#64748b',
    marginBottom: 12,
  },
  dialogInput: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#0f172a',
    marginBottom: 16,
    backgroundColor: '#f8fafc',
  },
  dialogActionsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  dialogCancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginRight: 8,
  },
  dialogCancelBtnText: {
    fontSize: 13,
    color: '#64748b',
    fontWeight: 'bold',
  },
  dialogSaveBtn: {
    backgroundColor: '#003580',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  dialogSaveBtnText: {
    fontSize: 13,
    color: '#ffffff',
    fontWeight: 'bold',
  },

  // Master Setup (Manage Chambers / Clients)
  mmRoot: {
    flex: 1,
    backgroundColor: '#f1f5f9',
  },
  mmHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  mmHeaderTextWrap: {
    flex: 1,
    paddingRight: 8,
  },
  mmHeaderTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
  },
  mmHeaderSub: {
    marginTop: 2,
    fontSize: 12,
    color: '#64748b',
    fontWeight: '500',
  },
  mmCloseBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mmTabs: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    padding: 4,
    backgroundColor: '#e2e8f0',
    borderRadius: 12,
  },
  mmTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
  },
  mmTabActive: {
    backgroundColor: '#ffffff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
    elevation: 1,
  },
  mmTabText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#64748b',
  },
  mmTabTextActive: {
    color: '#003580',
  },
  mmBody: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  mmCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 12,
  },
  mmCardTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 4,
  },
  mmCardHint: {
    fontSize: 11,
    color: '#64748b',
    marginBottom: 10,
    lineHeight: 15,
  },
  mmAddRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  mmTextInput: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 14,
    color: '#0f172a',
    backgroundColor: '#f8fafc',
  },
  mmPrimaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#003580',
    height: 44,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  mmPrimaryBtnDisabled: {
    backgroundColor: '#94a3b8',
  },
  mmPrimaryBtnText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 13,
  },
  mmSectionLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 8,
    marginTop: 2,
  },
  mmChamberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  mmChamberRowSelected: {
    borderColor: '#93c5fd',
    backgroundColor: '#f8fbff',
  },
  mmChamberIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  mmChamberIconSelected: {
    backgroundColor: '#dbeafe',
  },
  mmChamberName: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
  },
  mmChamberMeta: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
    fontWeight: '500',
  },
  mmIconBtnDanger: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  mmIconBtnNeutral: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  mmIconBtnSuccess: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#dcfce7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mmChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 8,
  },
  mmChip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 20,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  mmChipActive: {
    backgroundColor: '#003580',
    borderColor: '#003580',
  },
  mmChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
  },
  mmChipTextActive: {
    color: '#ffffff',
  },
  mmChipGhost: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 20,
    backgroundColor: '#fff7ed',
    borderWidth: 1,
    borderColor: '#fed7aa',
  },
  mmChipGhostText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#c2410c',
  },
  mmClientRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  mmClientAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#e0f2fe',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  mmClientAvatarText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0369a1',
  },
  mmClientName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    marginRight: 8,
  },
  mmSuggestToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  mmSuggestToggleText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#003580',
  },
  mmSuggestWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  mmSuggestChip: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    maxWidth: '100%',
  },
  mmSuggestChipUsed: {
    backgroundColor: '#f1f5f9',
    borderColor: '#e2e8f0',
  },
  mmSuggestChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#1d4ed8',
  },
  mmSuggestChipTextUsed: {
    color: '#94a3b8',
  },
  mmEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  mmEmptyCompact: {
    paddingVertical: 20,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#cbd5e1',
    backgroundColor: '#ffffff',
  },
  mmEmptyTitle: {
    marginTop: 10,
    fontSize: 15,
    fontWeight: '800',
    color: '#334155',
  },
  mmEmptyText: {
    marginTop: 6,
    fontSize: 12,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 17,
  },

  // Task Log Modal with unified columns
  modalOverlay: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  modalContent: {
    flex: 1,
    backgroundColor: '#ffffff',
    padding: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    paddingBottom: 12,
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  modalSubtitle: {
    fontSize: 12,
    color: '#475569',
    marginTop: 2,
  },
  chamberHeaderCard: {
    borderRadius: 12,
    borderWidth: 1.2,
    padding: 8,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  chamberHeaderIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chamberHeaderTitle: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  modalLabel: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#003580',
    marginBottom: 3,
    marginTop: 4,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 36,
    marginBottom: 6,
    backgroundColor: '#f8fafc',
  },
  inputIcon: {
    marginRight: 8,
  },
  input: {
    flex: 1,
    fontSize: 14,
    color: '#0f172a',
    paddingVertical: 0,
  },
  submitBtn: {
    backgroundColor: '#003580',
    borderRadius: 8,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  submitBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: 'bold',
  },

  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 6,
    width: '100%',
    height: 36,
  },
  dropdownDisabled: {
    backgroundColor: '#f1f5f9',
    borderColor: '#e2e8f0',
  },
  dropdownTriggerText: {
    fontSize: 14,
    color: '#0f172a',
    fontWeight: '500',
  },
  dropdownList: {
    position: 'absolute',
    top: 42,
    left: 0,
    right: 0,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    padding: 4,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    width: '100%',
    zIndex: 9999,
  },
  // Inline (non-absolute) — works inside ScrollView on Android
  dropdownListInline: {
    marginTop: 6,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingVertical: 2,
    maxHeight: 200,
    overflow: 'hidden',
  },
  reportFilterDropdownInline: {
    marginTop: 6,
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    maxHeight: 180,
    overflow: 'hidden',
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderColor: '#e2e8f0',
  },
  dropdownItemDisabled: {
    backgroundColor: '#f1f5f9',
    opacity: 0.6,
  },
  dropdownItemText: {
    fontSize: 13,
    color: '#334155',
    fontWeight: '500',
    flex: 1,
  },
  dropdownItemTextDisabled: {
    color: '#94a3b8',
    textDecorationLine: 'line-through',
  },

  // Row columns layout
  formRowContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
  },
  columnLeft: {
    flex: 1.1,
    marginRight: 10,
  },
  columnRight: {
    flex: 0.9,
    marginLeft: 10,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  readOnlyField: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginBottom: 6,
    minHeight: 36,
    justifyContent: 'center',
  },
  readOnlyText: {
    fontSize: 13,
    color: '#334155',
    fontWeight: '600',
  },

  // Image Right Styles
  imageRightContainer: {
    position: 'relative',
    width: '100%',
    aspectRatio: 1,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f1f5f9',
    marginTop: 4,
  },
  imageRightPreview: {
    width: '100%',
    height: '100%',
  },
  imageRightRetakeBtn: {
    position: 'absolute',
    bottom: 8,
    left: '8%',
    right: '8%',
    flexDirection: 'row',
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    paddingVertical: 5,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageRightRetakeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: 'bold',
    marginLeft: 4,
  },
  imageRightCameraBtn: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 10,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#003580',
    backgroundColor: '#f0f7ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  imageRightCameraText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#003580',
    marginTop: 6,
  },
  imageRightCameraSubtext: {
    fontSize: 8,
    color: '#64748b',
    marginTop: 2,
  },
  imageRightNoImage: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 10,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  imageRightNoImageText: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 6,
  },

  // Completed Log Meta Card
  metaDataCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    marginTop: 10,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 0.5,
    borderColor: '#cbd5e1',
  },
  metaLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
  },
  metaVal: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
  },

  // Unified status banner inside Modal
  detailStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 8,
  },
  detailStatusText: {
    fontSize: 12,
    fontWeight: 'bold',
  },

  // Bottom Navigation Tab Bar Styles
  tabBarContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#ffffff',
    height: 64,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.08,
    shadowRadius: 5,
  },
  tabBarLeft: {
    flexDirection: 'row',
    width: '40%',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  tabBarRight: {
    flexDirection: 'row',
    width: '40%',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  tabBarItem: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    width: 60,
  },
  tabBarLabel: {
    fontSize: 10,
    color: '#64748b',
    fontWeight: '600',
    marginTop: 3,
  },
  tabBarLabelActive: {
    color: '#003580', 
    fontWeight: 'bold',
  },
  fabContainer: {
    position: 'absolute',
    bottom: 12,
    left: '50%',
    marginLeft: -28, 
    width: 56,
    height: 56,
    borderRadius: 28,
    zIndex: 10,
  },
  fabBtn: {
    backgroundColor: '#003580', 
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#003580',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },

  // View Containers
  tabContainer: {
    flex: 1,
    backgroundColor: '#f1f5f9',
  },
  emptyContainer: {
    padding: 30,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 40,
  },
  emptyText: {
    fontSize: 14,
    color: '#64748b',
    fontWeight: 'bold',
    marginTop: 10,
    textAlign: 'center',
  },

  // Tasks sub-filter buttons
  filterTabsRow: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    justifyContent: 'space-around',
  },
  filterTabButton: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: '#f1f5f9',
    borderWidth: 0.5,
    borderColor: '#cbd5e1',
  },
  filterTabButtonActive: {
    backgroundColor: '#003580',
    borderColor: '#003580',
  },
  filterTabButtonText: {
    fontSize: 11,
    color: '#475569',
    fontWeight: 'bold',
  },
  filterTabButtonTextActive: {
    color: '#ffffff',
  },

  // Reports View Styles
  reportsContainer: {
    padding: 14,
    flexGrow: 1,
  },
  reportScopeCard: {
    backgroundColor: '#003580',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 14,
  },
  reportScopeTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 4,
  },
  reportScopeSub: {
    fontSize: 12,
    color: '#bfdbfe',
    lineHeight: 17,
  },
  reportSectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 8,
    marginLeft: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  reportRangeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#eff6ff',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  reportRangeBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#003580',
  },
  reportRangePickChip: {
    flex: 1,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  reportRangePickChipActive: {
    backgroundColor: '#eff6ff',
    borderColor: '#003580',
  },
  reportRangePickChipText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    textAlign: 'center',
  },
  reportRangePickChipTextActive: {
    color: '#003580',
  },
  reportDateRangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  reportDateRangeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  reportDateRangeBtnText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
  },
  reportDateTodayBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  reportDateTodayBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#003580',
  },
  reportFiltersRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 14,
    zIndex: 20,
  },
  reportFilterLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 5,
    marginLeft: 2,
  },
  reportFilterTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    minHeight: 42,
  },
  reportFilterTriggerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: '#0f172a',
    marginRight: 6,
  },
  reportFilterDropdown: {
    position: 'absolute',
    top: 62,
    left: 0,
    right: 0,
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#0f172a',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
    overflow: 'hidden',
  },
  reportFilterOption: {
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f1f5f9',
  },
  reportFilterOptionText: {
    fontSize: 13,
    color: '#334155',
    fontWeight: '500',
  },
  reportSearchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 12,
  },
  reportExportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#003580',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  reportExportBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#ffffff',
  },
  reportSummaryCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 14,
  },
  reportHeader: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#003580',
    marginBottom: 12,
  },
  statsMetricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statsBox: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    paddingVertical: 12,
    marginHorizontal: 4,
  },
  statsVal: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0f172a',
  },
  statsLbl: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    marginTop: 4,
    textTransform: 'uppercase',
  },
  chartCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 14,
  },
  chartTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#1e293b',
    marginBottom: 12,
  },
  barGraphContainer: {
    flexDirection: 'row',
    height: 140,
    alignItems: 'flex-end',
    justifyContent: 'space-around',
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    marginBottom: 8,
  },
  graphBarColumn: {
    alignItems: 'center',
    width: 32,
    height: '100%',
    justifyContent: 'flex-end',
  },
  graphBarValue: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#64748b',
    marginBottom: 4,
  },
  graphBar: {
    width: 14,
    borderRadius: 4,
    minHeight: 10,
  },
  graphBarLabel: {
    fontSize: 9,
    color: '#64748b',
    marginTop: 6,
    fontWeight: '600',
  },
  chartSubtext: {
    fontSize: 9,
    color: '#94a3b8',
    textAlign: 'center',
    marginTop: 4,
  },
  alertLogsCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  alertLogsCardTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#003580',
    marginBottom: 12,
  },
  reportsEmptyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  reportsEmptyText: {
    fontSize: 12,
    color: '#16a34a',
    fontWeight: '600',
    marginLeft: 8,
  },
  alertLogItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: '#f1f5f9',
  },
  alertLogClient: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#1e293b',
  },
  alertLogMeta: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 2,
  },
  alertLogTemp: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#ef4444',
  },

  // More View Styles
  moreContainer: {
    padding: 14,
  },
  profileCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  profileAvatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  profileMeta: {
    flex: 1,
  },
  profileName: {
    fontSize: 17,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  profileRole: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: 'bold',
    marginTop: 1,
  },
  profileEmail: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },
  moreSectionCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 14,
  },
  moreSectionTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#003580',
    marginBottom: 10,
  },
  syncStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  syncStatusLabel: {
    fontSize: 13,
    color: '#475569',
    fontWeight: '500',
  },
  syncSpinnerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    justifyContent: 'center',
  },
  syncSpinnerText: {
    fontSize: 12,
    color: '#475569',
    marginLeft: 8,
  },
  syncActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ea580c',
    paddingVertical: 10,
    borderRadius: 8,
  },
  syncActionBtnDisabled: {
    backgroundColor: '#fdba74',
    opacity: 0.6,
  },
  syncActionBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  ipSettingsDesc: {
    fontSize: 12,
    color: '#64748b',
    marginBottom: 8,
    lineHeight: 18,
  },
  ipAddressContainer: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  ipAddressValue: {
    fontSize: 13,
    color: '#475569',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  ipUpdateActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    paddingVertical: 10,
    borderRadius: 8,
  },
  ipUpdateActionBtnText: {
    color: '#003580',
    fontSize: 12,
    fontWeight: 'bold',
  },
  appInfoBox: {
    alignItems: 'center',
    marginVertical: 14,
  },
  appInfoText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#94a3b8',
  },
  appInfoVersion: {
    fontSize: 9,
    color: '#cbd5e1',
    marginTop: 2,
  },
  moreLogoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ef4444',
    paddingVertical: 12,
    borderRadius: 10,
    elevation: 2,
  },
  moreLogoutBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: 'bold',
  },
  
  // Dynamic Segmented Type Selector Styles
  typeSelectorRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 4,
    width: '100%',
  },
  typeTabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingVertical: 6,
    marginHorizontal: 3,
    backgroundColor: '#ffffff',
  },
  typeTabText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#475569',
  },

  // Vertical Photo Verification Styles
  verticalCameraBtn: {
    width: '100%',
    height: 120,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#cbd5e1',
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fafc',
    marginVertical: 8,
  },
  verticalCameraBtnText: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#003580',
    marginTop: 6,
  },
  verticalPhotoWrapper: {
    width: '100%',
    height: 220,
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
    marginVertical: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1.2,
    borderColor: '#e2e8f0',
  },
  verticalPhotoPreview: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  verticalRetakeBtn: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },

  // Card-based Dropdown Row Master Styles
  dropdownCardItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    backgroundColor: '#ffffff',
    marginVertical: 3,
    marginHorizontal: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  statusIndicatorCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  dropdownCardItemText: {
    fontSize: 13,
    color: '#0f172a',
    fontWeight: '600',
    flex: 1,
  },
  completedBadgePill: {
    backgroundColor: '#dcfce7',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    marginLeft: 8,
  },
  completedBadgeText: {
    fontSize: 9,
    color: '#16a34a',
    fontWeight: 'bold',
  },
  dropdownDeleteBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#fee2e2',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 10,
  },
  dropdownAddActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#003580',
    borderRadius: 8,
    paddingVertical: 10,
    marginTop: 8,
    marginHorizontal: 4,
    marginBottom: 4,
  },
  dropdownAddActionBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  
  // Drawer Menu Styles
  drawerOverlay: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: 'rgba(15, 23, 42, 0.4)',
  },
  drawerBackdrop: {
    flex: 1,
    height: '100%',
  },
  drawerPanel: {
    width: 280,
    height: '100%',
    backgroundColor: '#ffffff',
    paddingTop: Platform.OS === 'ios' ? 50 : 20,
    shadowColor: '#0f172a',
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 16,
  },
  drawerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderColor: '#f1f5f9',
  },
  drawerBrandContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  drawerBrandText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#003580',
    marginLeft: 8,
  },
  drawerUserCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    margin: 16,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  drawerUserAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#e0e7ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  drawerUserName: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  drawerUserRole: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 1,
    fontWeight: '600',
  },
  drawerMenuScroll: {
    flex: 1,
    paddingHorizontal: 16,
  },
  drawerMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginBottom: 6,
  },
  drawerMenuItemActive: {
    backgroundColor: '#eff6ff',
  },
  drawerMenuText: {
    fontSize: 13,
    color: '#475569',
    fontWeight: '600',
  },
  drawerMenuTextActive: {
    color: '#003580',
    fontWeight: 'bold',
  },
  drawerFooter: {
    paddingHorizontal: 16,
    paddingVertical: 15,
    borderTopWidth: 1,
    borderColor: '#f1f5f9',
    marginBottom: Platform.OS === 'ios' ? 25 : 10,
  },
  drawerLogoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  drawerLogoutText: {
    fontSize: 13,
    color: '#ef4444',
    fontWeight: 'bold',
  },

  // Date Slider & Custom Calendar Styles
  sliderOuterContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    marginBottom: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 8,
  },
  sliderScroll: {
    paddingRight: 10,
  },
  sliderCard: {
    width: 50,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  sliderCardActive: {
    backgroundColor: '#003580',
    borderColor: '#003580',
  },
  sliderDayName: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#64748b',
    textTransform: 'uppercase',
  },
  sliderDayNum: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#0f172a',
    marginTop: 2,
  },
  sliderTextActive: {
    color: '#ffffff',
  },
  sliderCalendarBtn: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 12,
    borderLeftWidth: 1,
    borderLeftColor: '#e2e8f0',
    width: 55,
  },
  sliderCalendarBtnText: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#003580',
    marginTop: 2,
  },

  // Client Box Inventory Styles
  inventoryItemCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    marginBottom: 12,
  },
  inventoryItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  inventoryClientName: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  inventoryChamberLabel: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  inventoryCountBadge: {
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  inventoryCountText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#0369a1',
  },
  inventoryTrendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    padding: 8,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: '#cbd5e1',
    marginBottom: 10,
  },
  inventoryTrendText: {
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 6,
  },
  inventoryHistoryList: {
    borderTopWidth: 0.5,
    borderColor: '#cbd5e1',
    paddingTop: 8,
  },
  historyListTitle: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#64748b',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3,
  },
  historyDate: {
    fontSize: 11,
    color: '#475569',
  },
  historyBoxes: {
    fontSize: 11,
    fontWeight: '600',
    color: '#0f172a',
  },
  inventoryLauncherCard: {
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    marginBottom: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  inventoryLauncherIconBg: {
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  inventoryLauncherTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  inventoryLauncherSub: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
});
