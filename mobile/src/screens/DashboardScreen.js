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
  Share
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system';
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
  addLocalAssignment,
  deleteLocalAssignment
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

export default function DashboardScreen({ user, token, apiUrl, onUpdateApiUrl, onLogout }) {
  const displayName = user.full_name || user.email || 'Data Operator';

  const reportDOActivity = async (action, description) => {
    try {
      if (!apiUrl || !token) return;
      await fetch(`${apiUrl}/api/operator-activities`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          action,
          logType: 'activity',
          description
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
  
  // Completed Log Metadata for read-only view
  const [logOperatorName, setLogOperatorName] = useState('');
  const [logSyncStatus, setLogSyncStatus] = useState('');
  const [logEntryDate, setLogEntryDate] = useState('');
  const [logEntryTime, setLogEntryTime] = useState('');

  // IP Edit Modal States
  const [showIpEditModal, setShowIpEditModal] = useState(false);
  const [ipInput, setIpInput] = useState(apiUrl);
  const [selectedShift, setSelectedShift] = useState('10:00 AM');
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
  const [selectedReportDate, setSelectedReportDate] = useState(new Date().toISOString().split('T')[0]);
  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [showInventoryModal, setShowInventoryModal] = useState(false);
  const [selectedInventoryItem, setSelectedInventoryItem] = useState(null);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showNotificationsModal, setShowNotificationsModal] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [showClientDropdown, setShowClientDropdown] = useState(false);
  const [showChamberDropdown, setShowChamberDropdown] = useState(false);
  const [showAddClientModal, setShowAddClientModal] = useState(false);
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
  const [showManagerChamberDropdown, setShowManagerChamberDropdown] = useState(false);
  const [newClientInput, setNewClientInput] = useState('');
  
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

  const isMorningCompleted = useMemo(() => {
    const activeAssignments = assignments.filter(item => item.status !== 'inactive');
    if (activeAssignments.length === 0) return false;
    
    const todayStr = new Date().toISOString().split('T')[0];
    const hasPendingMorning = activeAssignments.some(item => {
      const log = completedLogs.find(l => 
        l.chamber_id === item.chamber_id && 
        l.client_name === item.client_name && 
        l.entry_date === todayStr &&
        l.entry_time === '10:00 AM'
      );
      return !log;
    });
    return !hasPendingMorning;
  }, [assignments, completedLogs]);

  const getActiveTasksDetails = () => {
    const isEveningUnlocked = new Date().getHours() >= 16;
    const activeAssignments = assignments.filter(item => item.status !== 'inactive');
    const todayStr = new Date().toISOString().split('T')[0];
    
    // For Morning tasks (10:00 AM)
    const completedMorningLogs = completedLogs.filter(log => log.entry_time === '10:00 AM' && log.entry_date === todayStr);
    const pendingMorning = activeAssignments.filter(task => 
      !completedMorningLogs.some(log => log.chamber_id === task.chamber_id && log.client_name === task.client_name)
    );

    // For Evening tasks (04:00 PM)
    const completedEveningLogs = completedLogs.filter(log => log.entry_time === '04:00 PM' && log.entry_date === todayStr);
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

      let hours = now.getHours();
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12;
      const hoursStr = String(hours).padStart(2, '0');
      setCurrentTime(`${hoursStr}:${minutes} ${ampm}`);
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

  // Sync state update when prop changes
  useEffect(() => {
    setIpInput(apiUrl);
  }, [apiUrl]);

  // Pre-select shift based on active shift filter when modal opens in editable mode
  useEffect(() => {
    if (showLogModal && isProfileEditable) {
      setSelectedShift(activeShift === 'Morning' ? '10:00 AM' : '04:00 PM');
    }
  }, [showLogModal, isProfileEditable, activeShift]);

  // Recalculate pending tasks count whenever activeShift, completedLogs or assignments change
  useEffect(() => {
    const todayStr = new Date().toISOString().split('T')[0];
    const targetShiftTime = activeShift === 'Morning' ? '10:00 AM' : '04:00 PM';
    const activeAssignmentsToday = assignments.filter(item => item.status !== 'inactive');

    const pendingTasksList = activeAssignmentsToday.filter(item => {
      // Check if this assignment has a completed log for today on the selected shift
      const log = completedLogs.find(l => 
        l.chamber_id === item.chamber_id && 
        l.client_name === item.client_name &&
        l.entry_date === todayStr &&
        l.entry_time === targetShiftTime
      );
      const isCompleted = !!log;
      if (isCompleted) return false;
      
      const chamberTasks = activeAssignmentsToday.filter(t => t.chamber_id === item.chamber_id);
      return chamberTasks.length > 1;
    });
    
    setPendingCount(pendingTasksList.length);
  }, [activeShift, completedLogs, assignments]);

  // 3. Initialize SQLite DB and Sync Services
  useEffect(() => {
    initDatabase();
    
    // Subscribe to network sync events
    const unsubscribeSync = subscribeToSync(apiUrl, token, (status) => {
      setSyncStatus(status);
      loadInspectionsAndSummary(); // Reload logs if sync completes
    });

    // Initial load
    fetchAndLoadAssignments();

    return () => {
      if (unsubscribeSync) unsubscribeSync();
    };
  }, [apiUrl]);

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
    try {
      const response = await fetch(`${apiUrl}/api/chambers/assignments`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await response.json();
      
      if (data.success && data.data) {
        cacheAssignments(data.data);
      }
    } catch (err) {
      console.log('📶 Device is offline or server unreachable. Using cached assignments.');
    } finally {
      loadLocalAssignmentsData();
    }
  };

  const loadLocalAssignmentsData = () => {
    const cachedData = getLocalAssignments();
    setAssignments(cachedData);

    const uniqueChambers = [];
    const tracker = new Set();
    
    cachedData.forEach(item => {
      if (!tracker.has(item.chamber_id)) {
        tracker.add(item.chamber_id);
        uniqueChambers.push({
          id: item.chamber_id,
          name: item.chamber_name
        });
      }
    });

    setChambersList(uniqueChambers);
    loadInspectionsAndSummary(cachedData, uniqueChambers);
  };

  const loadInspectionsAndSummary = (currAssignments = assignments, currChambers = chambersList) => {
    const todayStr = new Date().toISOString().split('T')[0];
    
    const todaysInspections = getTodaysInspections(todayStr);
    setCompletedLogs(todaysInspections);

    const pendingInspections = getPendingInspections();
    setUnsyncedLogs(pendingInspections);

    // Active assignments today (excluding soft-deleted / inactive ones)
    const activeAssignmentsToday = currAssignments.filter(item => item.status !== 'inactive');
    
    // Calculate pending count for chambers with more than 1 client task, taking shift-time and current hour into account
    const currentHour = new Date().getHours();
    const activeShiftTasks = [];
    activeAssignmentsToday.forEach(item => {
      activeShiftTasks.push({ ...item, shift_time: '10:00 AM' });
      if (currentHour >= 16) {
        activeShiftTasks.push({ ...item, shift_time: '04:00 PM' });
      }
    });

    const pendingTasksList = activeShiftTasks.filter(item => {
      const log = todaysInspections.find(l => 
        l.chamber_id === item.chamber_id && 
        l.client_name === item.client_name &&
        l.entry_time === item.shift_time
      );
      const isCompleted = !!log;
      if (isCompleted) return false;
      
      const chamberTasks = activeAssignmentsToday.filter(t => t.chamber_id === item.chamber_id);
      return chamberTasks.length > 1;
    });
    setPendingCount(pendingTasksList.length);

    // Calculate Overdue tasks for the past 5 days
    const allInspections = getAllLocalInspections();
    
    const getPastDates = (numDays) => {
      const dates = [];
      for (let i = 1; i <= numDays; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().split('T')[0]);
      }
      return dates;
    };
    
    const past5Days = getPastDates(5);
    const overdueList = [];
    
    past5Days.forEach(date => {
      currAssignments.forEach(item => {
        if (item.status === 'inactive') return;
        
        const hasLogForDate = allInspections.some(l => 
          l.chamber_id === item.chamber_id && 
          l.client_name === item.client_name && 
          l.entry_date === date
        );
        
        if (!hasLogForDate) {
          overdueList.push({
            ...item,
            id: `overdue_${item.chamber_id}_${item.client_name.replace(/\s+/g, '')}_${date}`,
            due_date: date,
            is_overdue: true
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
      setCapturedImage(existingLog.photo_uri);
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

  // Calculate variance between current time and captured image time
  const getImageTimeDifferenceInMinutes = () => {
    if (!capturedImageTimestamp) return 0;
    const diffMs = Math.abs(Date.now() - capturedImageTimestamp);
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
    if (!tempInput) {
      Alert.alert('Validation Error', 'Please enter a valid temperature value.');
      return;
    }
    if (!boxCountInput) {
      Alert.alert('Validation Error', 'Please enter a valid box count.');
      return;
    }
    const parsedBoxCount = parseInt(boxCountInput, 10);
    if (isNaN(parsedBoxCount) || parsedBoxCount <= 0) {
      Alert.alert('Validation Error', 'Please enter a valid positive box count.');
      return;
    }
    if (!capturedImage) {
      Alert.alert('Validation Error', 'Please capture a photo of the sensor/box.');
      return;
    }

    setShowSubmitConfirmModal(true);
  };

  // Save the logged inspection to SQLite and trigger sync after confirmation
  const handleConfirmSaveInspection = () => {
    setShowSubmitConfirmModal(false);

    const todayStr = new Date().toISOString().split('T')[0];
    const targetDate = selectedTaskDueDate || todayStr;
    const timeStr = selectedShift;

    // If it's already logged for targetDate and shift, delete the old record first to allow overwrite
    deleteInspectionLocally(targetDate, selectedChamber.id, selectedClient, selectedShift);

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

    const captureTimeStr = formatDateTime(capturedImageTimestamp || Date.now());

    const newLog = {
      id: `${selectedChamber.id}_${selectedClient.replace(/\s+/g, '')}_${Date.now()}`,
      operator_name: displayName,
      chamber_id: selectedChamber.id,
      chamber_name: selectedChamber.name,
      client_name: selectedClient,
      box_temp: parseFloat(tempInput),
      box_count: parseInt(boxCountInput, 10),
      photo_uri: capturedImage,
      entry_date: targetDate,
      entry_time: timeStr,
      chamber_type: selectedChamberType,
      overdue_time: overdueTimeStr,
      photo_capture_time: captureTimeStr,
      shift: selectedShift === '10:00 AM' ? 'Morning' : 'Evening'
    };

    const success = saveInspectionLocally(newLog);
    if (success) {
      setShowLogModal(false);
      setSelectedClient(null);
      setCapturedImage(null);
      setCapturedImageTimestamp(null);
      
      if (currentNavTab === 'Dashboard' || openedFromFab) {
        setSelectedChamber(null);
        setOpenedFromFab(false);
      }
      
      setActiveTab('Completed');
      loadInspectionsAndSummary(); // Refresh SQLite states
      
      Alert.alert(
        'Inspection Saved Locally',
        'Log saved to device queue. It will auto-sync once the network is connected.',
        [{ text: 'OK' }]
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
    const clientName = newClientInput.trim();

    const duplicateExists = assignments.some(
      item => item.chamber_id === managerSelectedChamber.id && item.client_name.toLowerCase() === clientName.toLowerCase()
    );
    if (duplicateExists) {
      Alert.alert('Duplicate Client', `"${clientName}" is already assigned to ${managerSelectedChamber.name}.`);
      return;
    }

    const success = addLocalAssignment(managerSelectedChamber.id, managerSelectedChamber.name, clientName, 'Added from master panel');
    if (success) {
      setNewClientInput('');
      loadLocalAssignmentsData(); 
      reportDOActivity('ADD_CLIENT', `Added client "${clientName}" to ${managerSelectedChamber.name} with remark: Added from master panel`);
      Alert.alert('Success', `Successfully added client "${clientName}" to ${managerSelectedChamber.name}.`);
    } else {
      Alert.alert('Error', 'Failed to add client to local SQLite assignments master.');
    }
  };

  const handleDeleteClient = (clientName) => {
    if (!managerSelectedChamber) return;
    setClientToDelete({
      chamberId: managerSelectedChamber.id,
      clientName: clientName,
      chamberName: managerSelectedChamber.name
    });
    setDeleteRemarkInput('');
    setShowDeleteConfirmModal(true);
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
    const targetShiftTime = activeShift === 'Morning' ? '10:00 AM' : '04:00 PM';
    const chamberLogs = completedLogs.filter(log => log.chamber_id === chamber.id && log.entry_time === targetShiftTime);
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

    const chamberAssignments = assignments.filter(item => item.chamber_id === chamber.id);
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
    if (activeTab === 'All') return chambersList;
    return chambersList.filter(chamber => {
      const chamberTasks = assignments.filter(item => item.chamber_id === chamber.id && item.status !== 'inactive');
      const targetShiftTime = activeShift === 'Morning' ? '10:00 AM' : '04:00 PM';
      const chamberLogs = completedLogs.filter(log => log.chamber_id === chamber.id && log.entry_time === targetShiftTime);
      const isCompleted = chamberLogs.length === chamberTasks.length && chamberTasks.length > 0;

      if (activeTab === 'Pending') {
        const activeChamberTasks = chamberTasks.filter(t => t.status !== 'inactive');
        return chamberLogs.length > 0 && chamberLogs.length < activeChamberTasks.length;
      }
      if (activeTab === 'Completed') {
        return isCompleted;
      }
      if (activeTab === 'Failed') {
        const pattern = getChamberTypeAndDefault(chamber.id);
        return chamberLogs.some(log => {
          if (pattern.type === 'Frozen') return log.box_temp > -18;
          if (pattern.type === 'Chilled') return log.box_temp < -5 || log.box_temp > 5;
          return log.box_temp <= 0;
        });
      }
      return true;
    });
  };

  const getFilteredAssignments = () => {
    if (activeTab === 'Overdue') {
      return overdueTasks;
    }
    
    // Duplicate active assignments for the two shifts (10:00 AM and 04:00 PM)
    const shiftTasks = [];
    assignments.forEach(item => {
      if (item.status === 'inactive') return;
      
      shiftTasks.push({
        ...item,
        shift_time: '10:00 AM',
        shift_label: 'Morning Task'
      });
      
      const currentHour = new Date().getHours();
      if (currentHour >= 16) {
        shiftTasks.push({
          ...item,
          shift_time: '04:00 PM',
          shift_label: 'Evening Task'
        });
      }
    });

    return shiftTasks.filter(item => {
      const todayStr = new Date().toISOString().split('T')[0];
      const log = completedLogs.find(l => 
        l.chamber_id === item.chamber_id && 
        l.client_name === item.client_name && 
        l.entry_date === todayStr &&
        l.entry_time === item.shift_time
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

      if (activeTab === 'Pending') {
        const chamberTasks = assignments.filter(t => t.chamber_id === item.chamber_id && t.status !== 'inactive');
        return chamberTasks.length > 1 && !isCompleted;
      }
      if (activeTab === 'Completed') {
        return isCompleted;
      }
      return true;
    });
  };

  // Check if a client log exists today for a specific chamber
  const isClientCompletedToday = (chamberId, clientName, entryTime = null) => {
    const todayStr = new Date().toISOString().split('T')[0];
    const targetShiftTime = entryTime || (activeShift === 'Morning' ? '10:00 AM' : '04:00 PM');
    return completedLogs.some(log => 
      log.chamber_id === chamberId && 
      log.client_name === clientName && 
      log.entry_date === todayStr &&
      log.entry_time === targetShiftTime
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
      setCapturedImage(log.photo_uri);
      setSelectedChamberType(log.chamber_type || getChamberTypeAndDefault(item.chamber_id).type);
      
      setLogOperatorName(log.operator_name);
      setLogSyncStatus(log.sync_status);
      setLogEntryDate(log.entry_date);
      setLogEntryTime(log.entry_time);
      
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
    
    const targetShift = item.shift_time || '10:00 AM';
    setSelectedShift(targetShift);
    
    const existingLog = completedLogs.find(l => 
      l.chamber_id === item.chamber_id && 
      l.client_name === item.client_name && 
      l.entry_date === targetDate &&
      l.entry_time === targetShift
    ) || (item.is_overdue ? unsyncedLogs.find(l =>
      l.chamber_id === item.chamber_id && 
      l.client_name === item.client_name && 
      l.entry_date === targetDate &&
      l.entry_time === targetShift
    ) : null);

    const chamber = chambersList.find(c => c.id === item.chamber_id) || { id: item.chamber_id, name: item.chamber_name };
    setSelectedChamber(chamber);
    setSelectedClient(item.client_name);
    
    if (existingLog) {
      setTempInput(existingLog.box_temp.toString());
      setBoxCountInput(existingLog.box_count ? existingLog.box_count.toString() : '');
      setCapturedImage(existingLog.photo_uri);
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

  const handleUpdateIp = () => {
    if (!ipInput.trim()) {
      Alert.alert('Validation Error', 'API base URL cannot be empty.');
      return;
    }
    onUpdateApiUrl(ipInput.trim());
    setShowIpEditModal(false);
    Alert.alert('Server IP Updated', `Local PC Server address set to: ${ipInput.trim()}`);
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
              <Text style={styles.warehouseText}>Warehouse: Bangalore-1</Text>
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

        {/* Local PC Server IP Address Configuration Card */}
        <View style={styles.ipConfigCard}>
          <View style={styles.ipHeaderRow}>
            <Text style={styles.ipLabel}>Local PC Server IP Address:</Text>
            <TouchableOpacity 
              style={styles.editIpBtn}
              onPress={() => {
                setIpInput(apiUrl);
                setShowIpEditModal(true);
              }}
            >
              <Ionicons name="create-outline" size={15} color="#003580" style={{ marginRight: 4 }} />
              <Text style={styles.editIpBtnText}>Edit IP</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.ipAddressBox}>
            <Text style={styles.ipAddressText}>{apiUrl}</Text>
          </View>
        </View>

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
                    backgroundColor: activeShift === 'Morning' ? '#eff6ff' : (isMorningCompleted ? '#f8fafc' : '#ffffff'),
                    borderColor: activeShift === 'Morning' ? '#2563eb' : '#e2e8f0',
                    borderWidth: activeShift === 'Morning' ? 1.5 : 1,
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
                    opacity: isMorningCompleted ? 0.6 : 1,
                  }}
                  disabled={isMorningCompleted}
                  activeOpacity={0.8}
                  onPress={() => handleSelectShift('Morning')}
                >
                  <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: activeShift === 'Morning' ? '#2563eb' : '#f1f5f9', alignItems: 'center', justifyContent: 'center', marginRight: 6 }}>
                    <Ionicons name="sunny" size={13} color={activeShift === 'Morning' ? '#ffffff' : '#475569'} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ 
                      fontSize: 11.5, 
                      fontWeight: showMorningRed ? '900' : '800', 
                      color: showMorningRed ? '#ef4444' : (activeShift === 'Morning' ? '#1e3a8a' : '#334155') 
                    }}>
                      Morning Task
                    </Text>
                    <Text style={{ fontSize: 8.5, color: isMorningCompleted ? '#16a34a' : '#64748b', marginTop: 0.5, fontWeight: '600' }}>
                      {isMorningCompleted ? 'Completed' : 'Morning Slot'}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })()}

            {/* Evening Shift Card */}
            {(() => {
              const isEveningUnlocked = new Date().getHours() >= 16;
              const showEveningRed = activeShift !== 'Evening' && isEveningUnlocked && !eveningClicked;
              return (
                <TouchableOpacity
                  style={{
                    flex: 1,
                    backgroundColor: activeShift === 'Evening' ? '#eff6ff' : (isEveningUnlocked ? '#ffffff' : '#f8fafc'),
                    borderColor: activeShift === 'Evening' ? '#2563eb' : '#e2e8f0',
                    borderWidth: activeShift === 'Evening' ? 1.5 : 1,
                    borderRadius: 8,
                    padding: 8,
                    alignItems: 'center',
                    flexDirection: 'row',
                    marginLeft: 4,
                    opacity: isEveningUnlocked ? 1 : 0.7,
                    elevation: 1,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.05,
                    shadowRadius: 2,
                  }}
                  disabled={!isEveningUnlocked}
                  activeOpacity={0.8}
                  onPress={() => handleSelectShift('Evening')}
                >
                  <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: activeShift === 'Evening' ? '#2563eb' : '#f1f5f9', alignItems: 'center', justifyContent: 'center', marginRight: 6 }}>
                    <Ionicons 
                      name={isEveningUnlocked ? "moon" : "lock-closed"} 
                      size={13} 
                      color={activeShift === 'Evening' ? '#ffffff' : '#475569'} 
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ 
                      fontSize: 11.5, 
                      fontWeight: showEveningRed ? '900' : '800', 
                      color: showEveningRed ? '#ef4444' : (activeShift === 'Evening' ? '#1e3a8a' : '#334155') 
                    }}>
                      Evening Task
                    </Text>
                    <Text style={{ fontSize: 8.5, color: '#64748b', marginTop: 0.5, fontWeight: '600' }}>
                      {isEveningUnlocked ? 'Evening Slot' : 'Locks until evening'}
                    </Text>
                  </View>
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
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.metricsRow}>
            {/* 0. All Tasks Card (Blue tint) */}
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
                {assignments.filter(item => item.status !== 'inactive').length}
              </Text>
              <Text style={styles.metricLabel}>All Tasks</Text>
              <Text style={styles.metricSubtitle}>Active Task</Text>
            </TouchableOpacity>

            {/* 2. Pending Tasks Card (Yellow tint) */}
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
              <Text style={[styles.metricValue, { color: '#d97706' }]}>{pendingCount}</Text>
              <Text style={styles.metricLabel}>Pending Tasks</Text>
              <Text style={styles.metricSubtitle}>To Be Done</Text>
            </TouchableOpacity>

            {/* 3. Completed Card (Green tint) */}
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
                {completedLogs.filter(log => log.entry_time === (activeShift === 'Morning' ? '10:00 AM' : '04:00 PM')).length}
              </Text>
              <Text style={styles.metricLabel}>Completed</Text>
              <Text style={styles.metricSubtitle}>Today</Text>
            </TouchableOpacity>

            {/* 4. Overdue Tasks Card (Gray tint) */}
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
              <Text style={[styles.metricValue, { color: '#64748b' }]}>{overdueCount}</Text>
              <Text style={styles.metricLabel}>Overdue</Text>
              <Text style={styles.metricSubtitle}>Tasks</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>

        {/* 2-column chambers grid view */}
        {!selectedChamber ? (
          <>
            <View style={styles.metricsHeaderRow}>
              <Text style={styles.metricsTitle}>Chamber Overview ({chambersList.length} Chambers)</Text>
              <TouchableOpacity onPress={() => handleNavTabChange('Tasks')}>
                <Text style={styles.viewAllText}>View All</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.chambersGrid}>
              {getFilteredChambers().length === 0 ? (
                <View style={styles.emptyGridPlaceholder}>
                  <Ionicons name="apps-outline" size={32} color="#94a3b8" />
                  <Text style={styles.emptyGridText}>No chambers found matching "{activeTab}" filter.</Text>
                </View>
              ) : (
                getFilteredChambers().map((chamber) => {
                  const details = getChamberDetails(chamber);
                  const chamberTasks = assignments.filter(item => item.chamber_id === chamber.id);
                  const completedChamberLogs = completedLogs.filter(log => log.chamber_id === chamber.id);
                  const clientNames = Array.from(new Set(chamberTasks.map(t => t.client_name).filter(Boolean))).join(', ');

                  return (
                    <TouchableOpacity
                      key={chamber.id}
                      style={[
                        styles.chamberCard, 
                        details.hasAlert && styles.chamberCardAlertBorder
                      ]}
                      onPress={() => {
                        setSelectedChamber(chamber);
                        setSelectedClient(null);
                        setTempInput('');
                        setBoxCountInput('');
                        setCapturedImage(null);
                        setCapturedImageTimestamp(null);
                        setIsProfileEditable(true);
                        setOpenedFromFab(false);
                        setShowLogModal(true);
                      }}
                    >
                      {/* Left: Chamber details */}
                      <View style={{ flex: 1.5, alignItems: 'flex-start' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                          <Ionicons name={details.icon} size={14} color={details.pillColor} style={{ marginRight: 6 }} />
                          <Text style={{ fontSize: 13, fontWeight: 'bold', color: '#1e293b' }}>{chamber.name}</Text>
                        </View>
                        <View style={[styles.typePill, { backgroundColor: details.pillBg, marginVertical: 0 }]}>
                          <Text style={[styles.typePillText, { color: details.pillColor }]}>{details.type}</Text>
                        </View>
                      </View>

                      {/* Middle: Clients list */}
                      <View style={{ flex: 2, paddingHorizontal: 12, borderLeftWidth: 1, borderRightWidth: 1, borderColor: '#e2e8f0' }}>
                        <Text style={{ fontSize: 9, fontWeight: '700', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 2 }}>Clients</Text>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: '#334155' }} numberOfLines={2}>
                          {clientNames || 'No Clients'}
                        </Text>
                      </View>

                      {/* Right: Status indicator */}
                      <View style={{ flex: 1, alignItems: 'flex-end', justifyContent: 'center' }}>
                        <View style={[styles.statusIndicatorRow, { marginTop: 0 }]}>
                          <View style={[styles.statusDot, { backgroundColor: details.statusColor }]} />
                          <Text style={[styles.statusText, { color: details.statusColor, fontSize: 11 }]}>
                            {completedChamberLogs.length === chamberTasks.length ? 'Done' : 'Normal'}
                          </Text>
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                })
              )}
            </View>
          </>
        ) : (
          // Drill-down Chamber View
          <>
            <View style={styles.chamberHeaderRow}>
              <TouchableOpacity 
                style={styles.backBtn}
                onPress={() => setSelectedChamber(null)}
              >
                <Ionicons name="arrow-back" size={20} color="#003580" />
                <Text style={styles.backBtnText}>Back to Chambers</Text>
              </TouchableOpacity>
              <Text style={styles.selectedChamberTitle}>{selectedChamber.name}</Text>
            </View>

            <View style={styles.actionContainer}>
              <TouchableOpacity 
                style={styles.recordLogBtn} 
                onPress={handleOpenChamberLogForm}
              >
                <Ionicons name="thermometer-outline" size={20} color="#ffffff" style={{ marginRight: 8 }} />
                <Text style={styles.recordLogBtnText}>Log Chamber Temperature</Text>
              </TouchableOpacity>
            </View>

            {/* List of client lots in this chamber */}
            <View style={styles.tasksSection}>
              <Text style={styles.tasksSectionTitle}>Client Lots Checklist</Text>
              {(() => {
                const chamberAssignments = assignments.filter(item => item.chamber_id === selectedChamber.id && item.status !== 'inactive');
                
                const listItems = [];
                chamberAssignments.forEach(item => {
                  listItems.push({
                    ...item,
                    shift_time: '10:00 AM',
                    shift_label: 'Morning Task'
                  });
                  
                  const currentHour = new Date().getHours();
                  if (currentHour >= 16) {
                    listItems.push({
                      ...item,
                      shift_time: '04:00 PM',
                      shift_label: 'Evening Task'
                    });
                  }
                });

                return listItems.map((item, idx) => {
                  const todayStr = new Date().toISOString().split('T')[0];
                  
                  const log = completedLogs.find(l => 
                    l.chamber_id === selectedChamber.id && 
                    l.client_name === item.client_name && 
                    l.entry_date === todayStr &&
                    l.entry_time === item.shift_time
                  );
                  const isCompleted = !!log;
                  
                  return (
                    <TouchableOpacity
                      key={`${item.client_name}_${item.shift_time}_${idx}`}
                      style={[styles.taskItemCard, isCompleted && styles.taskItemCardCompleted]}
                      activeOpacity={0.7}
                      onPress={() => handleOpenTaskLogForm(item)}
                    >
                      <View style={styles.taskItemLeft}>
                        <View style={[
                          styles.statusIndicator,
                          { backgroundColor: isCompleted ? '#22c55e' : '#f59e0b' }
                        ]}>
                          <Ionicons 
                            name={isCompleted ? 'checkmark' : 'ellipse-outline'} 
                            size={12} 
                            color="#ffffff" 
                          />
                        </View>
                        <View style={styles.taskDetails}>
                          <Text style={styles.taskClientName}>{item.client_name}</Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                            <View style={[styles.taskChamberBadge, { backgroundColor: item.shift_time === '10:00 AM' ? '#e0f2fe' : '#fef3c7', borderColor: item.shift_time === '10:00 AM' ? '#bae6fd' : '#fde68a', borderWidth: 0.5 }]}>
                              <Text style={[styles.taskChamberText, { color: item.shift_time === '10:00 AM' ? '#0369a1' : '#d97706', fontSize: 9 }]}>
                                {item.shift_label}
                              </Text>
                            </View>
                          </View>
                          <Text style={[styles.taskClientMeta, { marginTop: 4 }]}>
                            {isCompleted 
                              ? `Logged Temp: ${log?.box_temp}°C at ${log?.entry_time} | Ref: ${log?.reference_no || 'Pending Sync'}` 
                              : 'Reading Pending'
                            }
                          </Text>
                        </View>
                      </View>
                      
                      {!isCompleted ? (
                        <View style={styles.pendingActionWrapper}>
                          <Text style={styles.pendingActionText}>Record Log</Text>
                          <Ionicons name="chevron-forward" size={14} color="#003580" />
                        </View>
                      ) : (
                        <Ionicons name="information-circle-outline" size={20} color="#16a34a" />
                      )}
                    </TouchableOpacity>
                  );
                });
              })()}
            </View>
          </>
        )}

        <View style={{ height: 90 }} />
      </ScrollView>
    );
  };

  // B. TASKS TAB VIEW
  const renderTasksView = () => {
    return (
      <View style={styles.tabContainer}>
        {/* Top Filters */}
        <View style={styles.filterTabsRow}>
          {['All', 'Pending', 'Completed', 'Overdue'].map((tab) => (
            <TouchableOpacity
              key={tab}
              style={[styles.filterTabButton, activeTab === tab && styles.filterTabButtonActive]}
              onPress={() => setActiveTab(tab)}
            >
              <Text style={[styles.filterTabButtonText, activeTab === tab && styles.filterTabButtonTextActive]}>
                {tab}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView 
          contentContainerStyle={{ paddingHorizontal: 15, paddingTop: 10, paddingBottom: 100 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={["#003580"]} />
          }
        >
          {getFilteredAssignments().length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="clipboard-outline" size={44} color="#94a3b8" />
              <Text style={styles.emptyText}>No tasks found in "{activeTab}" filter.</Text>
            </View>
          ) : (
            getFilteredAssignments().map((item, idx) => {
              const targetDate = item.due_date || new Date().toISOString().split('T')[0];
              const log = item.is_overdue 
                ? null 
                : completedLogs.find(l => 
                    l.chamber_id === item.chamber_id && 
                    l.client_name === item.client_name && 
                    l.entry_date === targetDate &&
                    (!item.shift_time || l.entry_time === item.shift_time)
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

              return (
                <TouchableOpacity
                  key={`${item.chamber_id}_${item.client_name}_${idx}`}
                  style={[styles.taskItemCard, isCompleted && styles.taskItemCardCompleted]}
                  activeOpacity={0.7}
                  onPress={() => handleOpenTaskLogForm(item)}
                >
                  <View style={styles.taskItemLeft}>
                    <View style={[
                      styles.statusIndicator,
                      { backgroundColor: isCompleted ? (hasWarning ? '#ef4444' : '#22c55e') : (item.is_overdue ? '#ef4444' : '#f59e0b') }
                    ]}>
                      <Ionicons 
                        name={isCompleted ? (hasWarning ? 'alert-circle' : 'checkmark') : (item.is_overdue ? 'alert-circle' : 'ellipse-outline')} 
                        size={12} 
                        color="#ffffff" 
                      />
                    </View>
                    
                    <View style={styles.taskDetails}>
                      <Text style={styles.taskClientName}>{item.client_name}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                        <View style={styles.taskChamberBadge}>
                          <Text style={styles.taskChamberText}>{item.chamber_name}</Text>
                        </View>
                        {item.shift_time && (
                          <View style={[styles.taskChamberBadge, { backgroundColor: item.shift_time === '10:00 AM' ? '#e0f2fe' : '#fef3c7', marginLeft: 6, borderColor: item.shift_time === '10:00 AM' ? '#bae6fd' : '#fde68a', borderWidth: 0.5 }]}>
                            <Text style={[styles.taskChamberText, { color: item.shift_time === '10:00 AM' ? '#0369a1' : '#d97706' }]}>
                              {item.shift_label}
                            </Text>
                          </View>
                        )}
                        {item.is_overdue && (
                          <View style={{ backgroundColor: '#fee2e2', paddingHorizontal: 6, paddingVertical: 1.5, borderRadius: 4, marginLeft: 6, borderWidth: 0.5, borderColor: '#fca5a5' }}>
                            <Text style={{ fontSize: 9, color: '#ef4444', fontWeight: 'bold' }}>Overdue: {item.due_date}</Text>
                          </View>
                        )}
                      </View>
                    </View>
                  </View>

                  <View style={styles.taskItemRight}>
                    {isCompleted ? (
                      <View style={styles.readingLoggedWrapper}>
                        <Text style={[styles.readingLoggedText, hasWarning && { color: '#ef4444' }]}>
                          {log.box_temp}°C
                        </Text>
                        <Text style={styles.taskLoggedTime}>{log.entry_time}</Text>
                      </View>
                    ) : (
                      <TouchableOpacity 
                        style={styles.logActionBtn}
                        onPress={() => handleOpenTaskLogForm(item)}
                      >
                        <Ionicons name="thermometer-outline" size={14} color="#ffffff" style={{ marginRight: 4 }} />
                        <Text style={styles.logActionBtnText}>Record Log</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </ScrollView>
      </View>
    );
  };

  // Export tasks/logs of the selected date as a CSV file/sharing message
  const handleExportDailyLogs = async () => {
    try {
      const allInspections = getAllLocalInspections();
      const selectedDateLogs = allInspections.filter(log => log.entry_date === selectedReportDate);

      if (selectedDateLogs.length === 0) {
        Alert.alert('No Logs', `There are no inspection logs to export for ${selectedReportDate}.`);
        return;
      }

      let csvContent = 'Date,Chamber,Type,Client,Temp (°C),Boxes,Supervisor,Status,Submission Time,Overdue\n';
      selectedDateLogs.forEach(log => {
        if (!log) return;
        const pattern = typeof getChamberTypeAndDefault === 'function' ? getChamberTypeAndDefault(log.chamber_id) : { type: 'Other' };
        const checkType = log.chamber_type || (pattern ? pattern.type : 'Other');
        const row = [
          log.entry_date || '',
          log.chamber_name || '',
          checkType || '',
          log.client_name || '',
          log.box_temp !== undefined && log.box_temp !== null ? log.box_temp : '',
          log.box_count || 0,
          log.monitor_supervisor_name || 'System',
          log.sync_status === 'synced' ? 'Synced' : 'Pending',
          log.entry_time || '',
          log.overdue_time || 'same day'
        ];
        csvContent += row.map(val => `"${String(val !== null && val !== undefined ? val : '').replace(/"/g, '""')}"`).join(',') + '\n';
      });

      // 1. Try file sharing (progressive enhancement)
      const fileName = `ReeferON_Logs_${selectedReportDate}.csv`;
      const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
      await FileSystem.writeAsStringAsync(fileUri, csvContent, { encoding: FileSystem.EncodingType.UTF8 });

      await Share.share({
        url: fileUri,
        title: `Export Logs - ${selectedReportDate}`,
        message: Platform.OS === 'android' ? csvContent : undefined // fallback text for Android
      });
    } catch (err) {
      console.warn('Primary file share failed, running fallback text share:', err.message);
      try {
        // Fallback: Generate simple CSV text manually and share direct
        const allInspections = getAllLocalInspections();
        const selectedDateLogs = allInspections.filter(log => log.entry_date === selectedReportDate);
        
        let csvContentFallback = 'Date,Chamber,Type,Client,Temp (°C),Boxes,Supervisor,Status,Submission Time,Overdue\n';
        selectedDateLogs.forEach(log => {
          if (!log) return;
          csvContentFallback += `"${log.entry_date || ''}","${log.chamber_name || ''}","${log.chamber_type || 'Frozen'}","${log.client_name || ''}","${log.box_temp || ''}","${log.box_count || 0}","System","${log.sync_status || ''}","${log.entry_time || ''}","${log.overdue_time || ''}"\n`;
        });
        
        await Share.share({
          message: csvContentFallback,
          title: `ReeferON Logs - ${selectedReportDate}`
        });
      } catch (fallbackErr) {
        console.error('All sharing options failed:', fallbackErr);
        Alert.alert('Export Error', `Failed to export logs: ${err.message || err}`);
      }
    }
  };

  // Modal to display Client Box Inventory Reports in a dedicated overlay view
  const renderInventoryModal = () => {
    if (!showInventoryModal) return null;

    const allInspections = getAllLocalInspections();
    
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
        time: log.entry_time
      });
    });

    const inventoryList = Object.values(clientInventory).map(item => {
      item.history.sort((a, b) => b.date.localeCompare(a.date));
      item.currentCount = item.history.length > 0 ? item.history[0].boxCount : 0;
      return item;
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

          {/* List content */}
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
            {inventoryList.length === 0 ? (
              <View style={[styles.reportsEmptyRow, { backgroundColor: '#ffffff', padding: 24, borderRadius: 12 }]}>
                <Ionicons name="cube-outline" size={32} color="#94a3b8" />
                <Text style={[styles.reportsEmptyText, { marginTop: 10 }]}>No client inventory data logged yet.</Text>
              </View>
            ) : (
              inventoryList.map((item, idx) => {
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
    const totalPendingCount = (hasMorningPending ? pendingMorning.length : 0) + (hasEveningPending ? pendingEvening.length : 0);

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
              {/* Morning Task Notification Card */}
              <TouchableOpacity 
                style={{
                  backgroundColor: '#ffffff',
                  borderRadius: 10,
                  padding: 10,
                  marginBottom: 8,
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
                  handleSelectShift('Morning');
                  setShowNotificationsModal(false);
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <Text style={{ fontSize: 9.5, fontWeight: '800', color: '#64748b' }}>
                    Today's Task - {formattedDate}
                  </Text>
                  <View style={{ backgroundColor: '#eff6ff', padding: 3, borderRadius: 4 }}>
                    <Ionicons name="sunny" size={12} color="#3b82f6" />
                  </View>
                </View>
                
                <Text style={{ fontSize: 11.5, fontWeight: '700', color: '#1e293b', lineHeight: 15, marginBottom: 4 }}>
                  Morning Task: {pendingMorning.length > 0 
                    ? `${pendingMorning.length} pending assignments.` 
                    : 'All assignments completed.'
                  }
                </Text>

                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 9.5, color: '#3b82f6', fontWeight: '800' }}>
                    {pendingMorning.length > 0 ? 'Click & Check ➔' : 'View Details ➔'}
                  </Text>
                  {pendingMorning.length > 0 && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#3b82f6' }} />}
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
                    borderColor: '#f59e0b',
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
                    <View style={{ backgroundColor: '#fef3c7', padding: 3, borderRadius: 4 }}>
                      <Ionicons name="moon" size={12} color="#f59e0b" />
                    </View>
                  </View>
                  
                  <Text style={{ fontSize: 11.5, fontWeight: '700', color: '#1e293b', lineHeight: 15, marginBottom: 4 }}>
                    Evening Task: {pendingEvening.length > 0 
                      ? `${pendingEvening.length} pending assignments.` 
                      : 'All assignments completed.'
                    }
                  </Text>

                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 9.5, color: '#f59e0b', fontWeight: '800' }}>
                      {pendingEvening.length > 0 ? 'Click & Check ➔' : 'View Details ➔'}
                    </Text>
                    {pendingEvening.length > 0 && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#f59e0b' }} />}
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
                          Slot: {hist.time === '10:00 AM' ? 'Morning Task' : hist.time === '04:00 PM' ? 'Evening Task' : hist.time}
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
    const allInspections = getAllLocalInspections();
    
    // Filter inspections: if search query is active, search globally across all dates.
    // If search query is empty, show only for the selected report date.
    const filteredLogs = allInspections.filter(log => {
      if (reportSearchQuery.trim() !== '') {
        const query = reportSearchQuery.toLowerCase().trim();
        const clientMatch = log.client_name ? log.client_name.toLowerCase().includes(query) : false;
        const chamberMatch = log.chamber_name ? log.chamber_name.toLowerCase().includes(query) : false;
        const refMatch = log.reference_no ? log.reference_no.toLowerCase().includes(query) : false;
        return clientMatch || chamberMatch || refMatch;
      }
      return log.entry_date === selectedReportDate;
    });

    const alertCount = filteredLogs.filter(log => {
      const pattern = getChamberTypeAndDefault(log.chamber_id);
      const checkType = log.chamber_type || pattern.type;
      if (checkType === 'Frozen') return log.box_temp > -18;
      if (checkType === 'Chilled' && (log.box_temp < -5 || log.box_temp > 5)) return true;
      if (checkType === 'Dry' && (log.box_temp < 15 || log.box_temp > 25)) return true;
      return false;
    }).length;

    const complianceRate = filteredLogs.length > 0 
      ? Math.round(((filteredLogs.length - alertCount) / filteredLogs.length) * 100) 
      : 100;

    return (
      <ScrollView contentContainerStyle={styles.reportsContainer} showsVerticalScrollIndicator={false}>
        <View style={styles.reportSummaryCard}>
          <Text style={styles.reportHeader}>Compliance Summary ({selectedReportDate})</Text>
          
          <View style={styles.statsMetricRow}>
            <View style={styles.statsBox}>
              <Text style={styles.statsVal}>{filteredLogs.length}</Text>
              <Text style={styles.statsLbl}>Total Logs</Text>
            </View>
            <View style={styles.statsBox}>
              <Text style={[styles.statsVal, { color: alertCount > 0 ? '#ef4444' : '#16a34a' }]}>{alertCount}</Text>
              <Text style={styles.statsLbl}>Warnings</Text>
            </View>
            <View style={styles.statsBox}>
              <Text style={[styles.statsVal, { color: '#003580' }]}>{complianceRate}%</Text>
              <Text style={styles.statsLbl}>Compliance</Text>
            </View>
          </View>
        </View>

        {/* Swipeable Date Slider & Custom Calendar Picker */}
        {renderDateSlider()}
        {renderCalendarModal()}

        {/* Client Box Inventory Launcher Button */}
        <TouchableOpacity 
          style={styles.inventoryLauncherCard}
          onPress={() => setShowInventoryModal(true)}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
            <View style={styles.inventoryLauncherIconBg}>
              <Ionicons name="cube-outline" size={22} color="#003580" />
            </View>
            <View style={{ marginLeft: 12, flex: 1 }}>
              <Text style={styles.inventoryLauncherTitle}>Client Box Inventory</Text>
              <Text style={styles.inventoryLauncherSub}>View stock counts, trends & history per client</Text>
            </View>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#94a3b8" />
        </TouchableOpacity>

        <View style={styles.alertLogsCard}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={[styles.alertLogsCardTitle, { marginBottom: 0 }]}>
              Logs ({reportSearchQuery.trim() !== '' ? 'Search Results' : selectedReportDate})
            </Text>
            {filteredLogs.length > 0 && (
              <TouchableOpacity 
                style={{ 
                  flexDirection: 'row', 
                  alignItems: 'center', 
                  backgroundColor: '#003580', 
                  paddingHorizontal: 10, 
                  paddingVertical: 5, 
                  borderRadius: 6 
                }}
                onPress={handleExportDailyLogs}
              >
                <Ionicons name="share-social-outline" size={14} color="#ffffff" style={{ marginRight: 4 }} />
                <Text style={{ fontSize: 11, color: '#ffffff', fontWeight: 'bold' }}>Export CSV</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Search bar inside the logs panel */}
          <View style={{ 
            flexDirection: 'row', 
            alignItems: 'center', 
            backgroundColor: '#f1f5f9', 
            borderRadius: 8, 
            paddingHorizontal: 10, 
            paddingVertical: 6,
            marginBottom: 12,
            borderWidth: 0.5,
            borderColor: '#cbd5e1'
          }}>
            <Ionicons name="search-outline" size={16} color="#64748b" style={{ marginRight: 6 }} />
            <TextInput
              style={{ flex: 1, fontSize: 13, color: '#1e293b', padding: 0 }}
              placeholder="Search by Client, Chamber or Ref No..."
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
              <Text style={styles.reportsEmptyText}>
                {reportSearchQuery.trim() !== '' ? 'No records match search query.' : 'No inspection logs recorded on this date.'}
              </Text>
            </View>
          ) : (
            filteredLogs.map(log => {
              const pattern = getChamberTypeAndDefault(log.chamber_id);
              const checkType = log.chamber_type || pattern.type;
              
              let isCompliant = true;
              if (checkType === 'Frozen' && log.box_temp > -18) isCompliant = false;
              if (checkType === 'Chilled' && (log.box_temp < -5 || log.box_temp > 5)) isCompliant = false;
              if (checkType === 'Dry' && (log.box_temp < 15 || log.box_temp > 25)) isCompliant = false;

              return (
                <View key={log.id} style={styles.alertLogItem}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.alertLogClient}>
                      {log.client_name}
                    </Text>
                    <Text style={{ fontSize: 9.5, fontWeight: '700', color: log.reference_no ? '#0f766e' : '#b45309', marginVertical: 2 }}>
                      {log.reference_no ? `Ref: ${log.reference_no}` : 'Ref: [Pending Sync]'}
                    </Text>
                    <Text style={styles.alertLogMeta}>
                      {log.chamber_name} ({checkType}) | Time: {log.entry_time} | Date: {log.entry_date}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                      <Text style={{ fontSize: 10, color: log.sync_status === 'synced' ? '#16a34a' : '#c2410c', fontWeight: 'bold' }}>
                        ● {log.sync_status === 'synced' ? 'Synced to Cloud' : 'Pending Sync'}
                      </Text>
                      {log.overdue_time && log.overdue_time !== 'same day' && (
                        <Text style={{ fontSize: 9, color: '#ef4444', backgroundColor: '#fee2e2', fontWeight: 'bold', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3, marginLeft: 6 }}>
                          Late ({log.overdue_time})
                        </Text>
                      )}
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end', justifyContent: 'center' }}>
                    <Text style={[styles.alertLogTemp, { color: isCompliant ? '#16a34a' : '#ef4444' }]}>
                      {log.box_temp}°C
                    </Text>
                    <Text style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{log.box_count} Boxes</Text>
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
          <Text style={styles.moreSectionTitle}>IP Address Setup</Text>
          <Text style={styles.ipSettingsDesc}>Current active address of local PC hosting the backend database service:</Text>
          <View style={styles.ipAddressContainer}>
            <Text style={styles.ipAddressValue}>{apiUrl}</Text>
          </View>
          <TouchableOpacity 
            style={styles.ipUpdateActionBtn}
            onPress={() => {
              setIpInput(apiUrl);
              setShowIpEditModal(true);
            }}
          >
            <Ionicons name="settings" size={16} color="#003580" style={{ marginRight: 6 }} />
            <Text style={styles.ipUpdateActionBtnText}>Change Server Connection IP</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.moreSectionCard}>
          <Text style={styles.moreSectionTitle}>Client Master Setup</Text>
          <Text style={styles.ipSettingsDesc}>Manage client assignments (add or remove lots) dynamically for each chamber:</Text>
          <TouchableOpacity 
            style={[styles.ipUpdateActionBtn, { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0', borderWidth: 1 }]}
            onPress={() => {
              setManagerSelectedChamber(null);
              setShowClientManagerModal(true);
            }}
          >
            <Ionicons name="people" size={16} color="#15803d" style={{ marginRight: 6 }} />
            <Text style={[styles.ipUpdateActionBtnText, { color: '#15803d' }]}>Manage Dynamic Client Lots</Text>
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

  // 1. IP EDITING DIALOG MODAL
  const renderIpEditModal = () => {
    return (
      <Modal visible={showIpEditModal} animationType="fade" transparent>
        <View style={styles.dialogOverlay}>
          <View style={styles.dialogContent}>
            <Text style={styles.dialogTitle}>Edit PC Server IP Address</Text>
            <Text style={styles.dialogSubtitle}>Enter backend server connection URL:</Text>
            
            <TextInput
              style={styles.dialogInput}
              value={ipInput}
              onChangeText={setIpInput}
              placeholder="e.g. http://192.168.1.15:5000"
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <View style={styles.dialogActionsRow}>
              <TouchableOpacity 
                style={styles.dialogCancelBtn}
                onPress={() => setShowIpEditModal(false)}
              >
                <Text style={styles.dialogCancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={styles.dialogSaveBtn}
                onPress={handleUpdateIp}
              >
                <Text style={styles.dialogSaveBtnText}>Save IP</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  // 2. UNIFIED TASK PROFILE & INSPECTION ENTRY FORM MODAL (VERTICAL LAYOUT WITH CHAMBER SELECTOR)
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
                  {isProfileEditable ? 'Record Chamber Inspection' : 'Task Profile Details'}
                </Text>
                <Text style={styles.modalSubtitle}>
                  {selectedChamber ? `${selectedChamber.name} Profile` : 'Chamber Entry Form'}
                </Text>
              </View>
              <TouchableOpacity onPress={handleCloseModal}>
                <Ionicons name="close-circle-outline" size={26} color="#64748b" />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={{ paddingVertical: 10 }} showsVerticalScrollIndicator={false}>
              
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
                
                {/* Chamber Dropdown Selector (if global FAB '+' click) */}
                {openedFromFab && isProfileEditable && !selectedChamber && (
                  <View style={{ marginBottom: 12, position: 'relative', zIndex: 2000 }}>
                    <Text style={styles.modalLabel}>Select Chamber</Text>
                    <TouchableOpacity 
                      style={styles.dropdownTrigger} 
                      onPress={() => setShowChamberDropdown(!showChamberDropdown)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.dropdownTriggerText, !selectedChamber && { color: '#94a3b8' }]}>
                        {selectedChamber?.name || 'Select Chamber...'}
                      </Text>
                      <Ionicons name={showChamberDropdown ? 'chevron-up' : 'chevron-down'} size={18} color="#64748b" />
                    </TouchableOpacity>

                    {showChamberDropdown && (
                      <View style={styles.dropdownList}>
                        <ScrollView style={{ maxHeight: 180 }} nestedScrollEnabled showsVerticalScrollIndicator={true}>
                          {chambersList.map(ch => (
                            <TouchableOpacity 
                              key={ch.id} 
                              style={styles.dropdownItem} 
                              onPress={() => {
                                setSelectedChamber(ch);
                                setShowChamberDropdown(false);
                                setSelectedClient(null);
                                setSelectedChamberType(getChamberTypeAndDefault(ch.id).type);
                              }}
                            >
                              <Text style={styles.dropdownItemText}>{ch.name}</Text>
                            </TouchableOpacity>
                          ))}
                        </ScrollView>
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

                {/* Shift Selector */}
                <View style={{ marginBottom: 12 }}>
                  <Text style={styles.modalLabel}>Task Time (Task Slot)</Text>
                  {isProfileEditable ? (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                      <TouchableOpacity 
                        style={{
                          flex: 1,
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'center',
                          paddingVertical: 10,
                          borderRadius: 8,
                          borderWidth: 1.5,
                          borderColor: selectedShift === '10:00 AM' ? '#003580' : '#e2e8f0',
                          backgroundColor: selectedShift === '10:00 AM' ? '#f0f4f8' : '#ffffff',
                          marginRight: 5
                        }}
                        onPress={() => setSelectedShift('10:00 AM')}
                      >
                        <Ionicons 
                          name={selectedShift === '10:00 AM' ? 'radio-button-on' : 'radio-button-off'} 
                          size={16} 
                          color={selectedShift === '10:00 AM' ? '#003580' : '#64748b'} 
                          style={{ marginRight: 6 }}
                        />
                        <Text style={{ 
                          fontSize: 13, 
                          fontWeight: '700', 
                          color: selectedShift === '10:00 AM' ? '#003580' : '#64748b' 
                        }}>
                           Morning Task
                        </Text>
                      </TouchableOpacity>

                      {(() => {
                        const isEveningUnlocked = new Date().getHours() >= 16;
                        return (
                          <TouchableOpacity 
                            style={{
                              flex: 1,
                              flexDirection: 'row',
                              alignItems: 'center',
                              justifyContent: 'center',
                              paddingVertical: 10,
                              borderRadius: 8,
                              borderWidth: 1.5,
                              borderColor: selectedShift === '04:00 PM' ? '#003580' : '#e2e8f0',
                              backgroundColor: selectedShift === '04:00 PM' ? '#f0f4f8' : (isEveningUnlocked ? '#ffffff' : '#f8fafc'),
                              marginLeft: 5,
                              opacity: isEveningUnlocked ? 1 : 0.6
                            }}
                            disabled={!isEveningUnlocked}
                            onPress={() => setSelectedShift('04:00 PM')}
                          >
                            <Ionicons 
                              name={selectedShift === '04:00 PM' ? 'radio-button-on' : 'radio-button-off'} 
                              size={16} 
                              color={selectedShift === '04:00 PM' ? '#003580' : '#64748b'} 
                              style={{ marginRight: 6 }}
                            />
                            <Text style={{ 
                              fontSize: 13, 
                              fontWeight: '700', 
                              color: selectedShift === '04:00 PM' ? '#003580' : '#64748b' 
                            }}>
                               Evening Task
                            </Text>
                          </TouchableOpacity>
                        );
                      })()}
                    </View>
                  ) : (
                    <View style={styles.readOnlyField}>
                      <Text style={styles.readOnlyText}>
                        {logEntryTime === '10:00 AM' ? 'Morning Task' : logEntryTime === '04:00 PM' ? 'Evening Task' : 'Task Slot'}
                      </Text>
                    </View>
                  )}
                </View>

                {/* Client Lot Dropdown or Label */}
                <View style={{ marginBottom: 12, position: 'relative', zIndex: 1000 }}>
                  <Text style={styles.modalLabel}>Client Lot Name</Text>
                  {isProfileEditable ? (
                    <>
                      <TouchableOpacity 
                        style={[styles.dropdownTrigger, !selectedChamber && styles.dropdownDisabled]} 
                        disabled={!selectedChamber}
                        onPress={() => setShowClientDropdown(!showClientDropdown)}
                        activeOpacity={0.8}
                      >
                        <Text style={[styles.dropdownTriggerText, !selectedClient && { color: '#94a3b8' }]}>
                          {selectedClient || (selectedChamber ? 'Select Client Lot...' : 'Select Chamber first')}
                        </Text>
                        <Ionicons name={showClientDropdown ? 'chevron-up' : 'chevron-down'} size={18} color="#64748b" />
                      </TouchableOpacity>

                      {showClientDropdown && selectedChamber && (
                        <View style={styles.dropdownList}>
                          <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled showsVerticalScrollIndicator={true}>
                            {assignments
                              .filter(item => item.chamber_id === selectedChamber?.id)
                              .map(item => {
                                const isCompleted = isClientCompletedToday(selectedChamber.id, item.client_name, selectedShift);
                                return (
                                  <View 
                                    key={item.client_name}
                                    style={styles.dropdownCardItem}
                                  >
                                    <TouchableOpacity 
                                      style={{ flexDirection: 'row', alignItems: 'center', flex: 1, paddingVertical: 6 }}
                                      activeOpacity={0.7}
                                      onPress={() => {
                                        setSelectedClient(item.client_name);
                                        setShowClientDropdown(false);
                                        const todayStr = new Date().toISOString().split('T')[0];
                                        const log = completedLogs.find(l => 
                                          l.chamber_id === selectedChamber.id && 
                                          l.client_name === item.client_name && 
                                          l.entry_date === todayStr &&
                                          l.entry_time === selectedShift
                                        );
                                        if (log) {
                                          setTempInput(log.box_temp.toString());
                                          setBoxCountInput(log.box_count ? log.box_count.toString() : '');
                                          setCapturedImage(log.photo_uri);
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
                                      }}
                                    >
                                      <View style={[
                                        styles.statusIndicatorCircle,
                                        { backgroundColor: isCompleted ? '#e8f5e9' : '#f1f5f9' }
                                      ]}>
                                        <Ionicons 
                                          name={isCompleted ? "checkmark-circle" : "person-outline"} 
                                          size={14} 
                                          color={isCompleted ? "#2e7d32" : "#64748b"} 
                                        />
                                      </View>
                                      <Text style={styles.dropdownCardItemText} numberOfLines={1}>
                                        {item.client_name}
                                      </Text>
                                      {isCompleted && (
                                        <View style={styles.completedBadgePill}>
                                          <Text style={styles.completedBadgeText}>Logged</Text>
                                        </View>
                                      )}
                                    </TouchableOpacity>
                                    
                                    {/* Delete Client button in dropdown */}
                                    <TouchableOpacity
                                      style={styles.dropdownDeleteBtn}
                                      activeOpacity={0.7}
                                      onPress={() => {
                                        setClientToDelete({
                                          chamberId: selectedChamber.id,
                                          clientName: item.client_name,
                                          chamberName: selectedChamber.name
                                        });
                                        setDeleteRemarkInput('');
                                        setShowDeleteConfirmModal(true);
                                      }}
                                    >
                                      <Ionicons name="trash-outline" size={13} color="#ef4444" />
                                    </TouchableOpacity>
                                  </View>
                                );
                              })}

                            {/* Add client button at the bottom of the list */}
                            <TouchableOpacity 
                              style={styles.dropdownAddActionBtn}
                              activeOpacity={0.8}
                              onPress={() => {
                                setInlineClientInput('');
                                setInlineRemarkInput('');
                                setShowAddClientModal(true);
                              }}
                            >
                              <Ionicons name="add-circle" size={16} color="#ffffff" style={{ marginRight: 6 }} />
                              <Text style={styles.dropdownAddActionBtnText}>
                                Add New Client Lot
                              </Text>
                            </TouchableOpacity>
                          </ScrollView>
                        </View>
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
                            onChangeText={setTempInput}
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
                            onChangeText={setBoxCountInput}
                          />
                        </View>
                        <Text style={{ fontSize: 9, color: '#475569', marginTop: 4, marginLeft: 2, fontWeight: '600' }}>
                          Total box count
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
                <View style={{ marginBottom: 16 }}>
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
                        {capturedImageTimestamp && Math.abs(Date.now() - capturedImageTimestamp) > 5 * 60 * 1000 && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, alignSelf: 'center', paddingHorizontal: 10 }}>
                            <Ionicons name="warning" size={14} color="#ef4444" style={{ marginRight: 4 }} />
                            <Text style={{ color: '#ef4444', fontSize: 11, fontWeight: 'bold' }}>
                              Warning: Photo captured {Math.floor(Math.abs(Date.now() - capturedImageTimestamp) / (1000 * 60))} mins ago (exceeds 5 mins)!
                            </Text>
                          </View>
                        )}
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
                <TouchableOpacity style={styles.submitBtn} onPress={handleSaveInspection}>
                  <Text style={styles.submitBtnText}>Submit Reading (Save Locally)</Text>
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

  // 3. CLIENT MASTER MANAGER MODAL (FULL SCREEN)
  const renderClientManagerModal = () => {
    return (
      <Modal visible={showClientManagerModal} animationType="slide" transparent={false}>
        <SafeAreaView style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>Manage Client Lots Master</Text>
                <Text style={styles.modalSubtitle}>Edit active assignments for chambers</Text>
              </View>
              <TouchableOpacity onPress={() => setShowClientManagerModal(false)}>
                <Ionicons name="close-circle-outline" size={26} color="#64748b" />
              </TouchableOpacity>
            </View>

            {/* Chamber Selection Dropdown */}
            <Text style={styles.modalLabel}>Select Chamber Master</Text>
            <TouchableOpacity 
              style={styles.dropdownTrigger} 
              onPress={() => setShowManagerChamberDropdown(!showManagerChamberDropdown)}
              activeOpacity={0.8}
            >
              <Text style={[styles.dropdownTriggerText, !managerSelectedChamber && { color: '#94a3b8' }]}>
                {managerSelectedChamber?.name || 'Choose a Chamber...'}
              </Text>
              <Ionicons name={showManagerChamberDropdown ? 'chevron-up' : 'chevron-down'} size={18} color="#64748b" />
            </TouchableOpacity>

            {showManagerChamberDropdown && (
              <View style={styles.dropdownList}>
                {chambersList.map(ch => (
                  <TouchableOpacity 
                    key={ch.id} 
                    style={styles.dropdownItem} 
                    onPress={() => {
                      setManagerSelectedChamber(ch);
                      setShowManagerChamberDropdown(false);
                      setNewClientInput('');
                    }}
                  >
                    <Text style={styles.dropdownItemText}>{ch.name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* List of Clients currently assigned to the selected Chamber */}
            {managerSelectedChamber ? (
              <View style={{ flex: 1, marginTop: 10 }}>
                <Text style={styles.modalLabel}>
                  Assigned Client Lots ({assignments.filter(item => item.chamber_id === managerSelectedChamber.id).length})
                </Text>
                
                <ScrollView 
                  style={{ flex: 1, borderTopWidth: 1, borderColor: '#f1f5f9', marginTop: 5 }}
                  contentContainerStyle={{ paddingVertical: 10 }}
                  showsVerticalScrollIndicator={false}
                >
                  {assignments.filter(item => item.chamber_id === managerSelectedChamber.id).length === 0 ? (
                    <View style={[styles.emptyContainer, { height: 120, borderStyle: 'dashed', borderWidth: 1.5, borderColor: '#cbd5e1', borderRadius: 8, backgroundColor: '#f8fafc', padding: 15 }]}>
                      <Ionicons name="people-outline" size={24} color="#94a3b8" />
                      <Text style={[styles.emptyText, { fontSize: 11 }]}>No client lots assigned to this chamber yet.</Text>
                    </View>
                  ) : (
                    assignments
                      .filter(item => item.chamber_id === managerSelectedChamber.id)
                      .map((item) => (
                        <View 
                          key={item.client_name}
                          style={[
                            styles.taskItemCard, 
                            { 
                              paddingVertical: 10, 
                              paddingHorizontal: 12, 
                              marginBottom: 8, 
                              backgroundColor: '#f8fafc',
                              flexDirection: 'row', 
                              alignItems: 'center', 
                              justifyContent: 'space-between'
                            }
                          ]}
                        >
                          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                            <Ionicons name="person" size={16} color="#475569" style={{ marginRight: 8 }} />
                            <Text style={[styles.taskClientName, { fontSize: 13, flex: 1 }]} numberOfLines={1}>
                              {item.client_name}
                            </Text>
                          </View>
                          <TouchableOpacity 
                            style={{ padding: 6 }} 
                            onPress={() => handleDeleteClient(item.client_name)}
                          >
                            <Ionicons name="trash-outline" size={18} color="#ef4444" />
                          </TouchableOpacity>
                        </View>
                      ))
                  )}
                </ScrollView>

                {/* Add New Client Box at Bottom */}
                <View style={{ borderTopWidth: 1, borderColor: '#e2e8f0', paddingTop: 15, paddingBottom: 5 }}>
                  <Text style={styles.modalLabel}>Add New Client Lot Name</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={[styles.inputWrapper, { flex: 1, marginBottom: 0, marginRight: 10 }]}>
                      <Ionicons name="add-circle-outline" size={16} color="#64748b" style={styles.inputIcon} />
                      <TextInput
                        style={styles.input}
                        placeholder="e.g. Reliance Fresh"
                        placeholderTextColor="#94a3b8"
                        value={newClientInput}
                        onChangeText={setNewClientInput}
                        autoCapitalize="words"
                      />
                    </View>
                    <TouchableOpacity 
                      style={[styles.submitBtn, { marginTop: 0, paddingHorizontal: 16, height: 42 }]} 
                      onPress={handleAddNewClient}
                    >
                      <Text style={styles.submitBtnText}>Add</Text>
                    </TouchableOpacity>
                  </View>
                </View>

              </View>
            ) : (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 }}>
                <Ionicons name="file-tray-full-outline" size={48} color="#94a3b8" />
                <Text style={{ fontSize: 13, color: '#64748b', textAlign: 'center', marginTop: 10, fontWeight: '500' }}>
                  Please select a chamber from the dropdown above to manage its client list.
                </Text>
              </View>
            )}

          </View>
        </SafeAreaView>
      </Modal>
    );
  };

  // 4. CUSTOM CLIENT DELETION REMARK/CONFIRM MODAL
  const renderDeleteConfirmModal = () => {
    return (
      <Modal visible={showDeleteConfirmModal} animationType="fade" transparent>
        <View style={styles.dialogOverlay}>
          <View style={styles.dialogContent}>
            <Text style={styles.dialogTitle}>Delete Client Assignment</Text>
            <Text style={styles.dialogSubtitle}>
              Please enter a remark/reason for removing "{clientToDelete?.clientName}" from {clientToDelete?.chamberName || 'Chamber'}:
            </Text>
            
            <TextInput
              style={styles.dialogInput}
              value={deleteRemarkInput}
              onChangeText={setDeleteRemarkInput}
              placeholder="e.g. Inward Lot Completed"
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
                onPress={() => {
                  if (!deleteRemarkInput.trim()) {
                    Alert.alert('Validation Error', 'Please enter a deletion remark/reason.');
                    return;
                  }
                  const success = deleteLocalAssignment(clientToDelete.chamberId, clientToDelete.clientName, deleteRemarkInput.trim());
                  if (success) {
                    setShowDeleteConfirmModal(false);
                    setDeleteRemarkInput('');
                    loadLocalAssignmentsData();
                    reportDOActivity('DELETE_CLIENT', `Deleted client "${clientToDelete.clientName}" from ${clientToDelete.chamberName} with remark: ${deleteRemarkInput.trim()}`);
                    
                    // Reset selected client if it was deleted
                    if (selectedClient === clientToDelete.clientName) {
                      setSelectedClient(null);
                      setTempInput('');
                      setBoxCountInput('');
                      setCapturedImage(null);
                      setCapturedImageTimestamp(null);
                    }
                    
                    setClientToDelete(null);
                    Alert.alert('Deleted', 'Client deleted successfully from SQLite database.');
                  } else {
                    Alert.alert('Error', 'Failed to delete client locally.');
                  }
                }}
              >
                <Text style={styles.dialogSaveBtnText}>Confirm Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  // Submission Confirmation Dialog with Photo Timestamp Alert
  const renderSubmitConfirmModal = () => {
    if (!showSubmitConfirmModal) return null;

    const diffMins = getImageTimeDifferenceInMinutes();
    const isVarianceAlert = diffMins > 5;

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
              <Text style={[styles.dialogTitle, { textAlign: 'center' }]}>Confirm Submission</Text>
            </View>

            <Text style={[styles.dialogSubtitle, { textAlign: 'center', marginBottom: 20 }]}>
              {isVarianceAlert ? (
                <Text style={{ color: '#ef4444', fontWeight: 'bold' }}>
                  ⚠️ Warning: The verification photo was captured {diffMins} minutes ago, which exceeds the allowed 5-minute compliance limit.
                </Text>
              ) : (
                <Text style={{ color: '#16a34a', fontWeight: 'bold' }}>
                  ✓ Verification photo capture time is compliant (captured {diffMins} minutes ago).
                </Text>
              )}
            </Text>

            <Text style={{ fontSize: 12, color: '#64748b', textAlign: 'center', marginBottom: 20 }}>
              Do you want to continue and submit this inspection record?
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

  // Custom month calendar modal dialog
  const renderCalendarModal = () => {
    if (!showCalendarModal) return null;

    const days = getCalendarDays(calendarMonth);
    const monthName = calendarMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    return (
      <Modal visible={showCalendarModal} transparent animationType="fade" onRequestClose={() => setShowCalendarModal(false)}>
        <View style={styles.dialogOverlay}>
          <View style={[styles.dialogContent, { width: 320, padding: 16 }]}>
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
                const isSelected = dateStr === selectedReportDate;
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
                      backgroundColor: isSelected ? '#003580' : 'transparent',
                      borderWidth: isToday ? 1 : 0,
                      borderColor: '#003580',
                    }}
                    onPress={() => {
                      setSelectedReportDate(dateStr);
                      setShowCalendarModal(false);
                    }}
                  >
                    <Text style={{
                      fontSize: 11,
                      fontWeight: isSelected || isToday ? 'bold' : 'normal',
                      color: isSelected ? '#ffffff' : '#0f172a'
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
              <Text style={styles.dialogCancelBtnText}>Close</Text>
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
            const isSelected = dateStr === selectedReportDate;
            const dayName = i === 0 ? 'Today' : weekDayNames[dateObj.getDay()];
            const dayNum = String(dateObj.getDate()).padStart(2, '0');

            return (
              <TouchableOpacity
                key={dateStr}
                style={[
                  styles.sliderCard,
                  isSelected && styles.sliderCardActive
                ]}
                onPress={() => setSelectedReportDate(dateStr)}
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
            setCalendarMonth(new Date(selectedReportDate));
            setShowCalendarModal(true);
          }}
        >
          <Ionicons name="calendar-outline" size={18} color="#003580" />
          <Text style={styles.sliderCalendarBtnText}>Custom</Text>
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
        onRequestClose={() => setShowDrawer(false)}
      >
        <View style={styles.drawerOverlay}>
          {/* Backdrop Touch Area to close */}
          <TouchableOpacity 
            style={styles.drawerBackdrop} 
            activeOpacity={1} 
            onPress={() => setShowDrawer(false)} 
          />
          
          {/* Drawer Content Panel */}
          <View style={styles.drawerPanel}>
            {/* Drawer Header */}
            <View style={styles.drawerHeader}>
              <View style={styles.drawerBrandContainer}>
                <Ionicons name="cube" size={24} color="#003580" />
                <Text style={styles.drawerBrandText}>ReeferON CRM</Text>
              </View>
              <TouchableOpacity onPress={() => setShowDrawer(false)}>
                <Ionicons name="close-circle-outline" size={26} color="#64748b" />
              </TouchableOpacity>
            </View>

            {/* User Profile Card inside Drawer */}
            <View style={styles.drawerUserCard}>
              <View style={styles.drawerUserAvatar}>
                <Ionicons name="person" size={20} color="#003580" />
              </View>
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={styles.drawerUserName} numberOfLines={1}>
                  {displayName}
                </Text>
                <Text style={styles.drawerUserRole}>
                  {user?.role === 'do_operator' ? 'Data Operator' : 'Operator'}
                </Text>
              </View>
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
                  setShowDrawer(false);
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
                  setShowDrawer(false);
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
                  setShowDrawer(false);
                  onLogout();
                }}
              >
                <Ionicons name="log-out-outline" size={20} color="#ef4444" style={{ marginRight: 12 }} />
                <Text style={styles.drawerLogoutText}>Logout Session</Text>
              </TouchableOpacity>
            </View>

          </View>
        </View>
      </Modal>
    );
  };

  // 5. ADD CLIENT MODAL DIALOG (CENTERED POPUP)
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

            <Text style={[styles.modalLabel, { fontSize: 11, marginBottom: 4 }]}>Add Remark / Reason</Text>
            <TextInput
              style={styles.dialogInput}
              placeholder="e.g. Reliance lot assigned today"
              placeholderTextColor="#94a3b8"
              value={inlineRemarkInput}
              onChangeText={setInlineRemarkInput}
              autoCapitalize="sentences"
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
                  if (!inlineRemarkInput.trim()) {
                    Alert.alert('Validation Error', 'Please enter an addition remark.');
                    return;
                  }
                  const name = inlineClientInput.trim();
                  const remark = inlineRemarkInput.trim();
                  const exists = assignments.some(item => item.chamber_id === selectedChamber.id && item.client_name.toLowerCase() === name.toLowerCase());
                  if (exists) {
                    Alert.alert('Duplicate Client', `"${name}" is already in the list.`);
                    return;
                  }
                  
                  const success = addLocalAssignment(selectedChamber.id, selectedChamber.name, name, remark);
                  if (success) {
                    setInlineClientInput('');
                    setInlineRemarkInput('');
                    setShowAddClientModal(false);
                    loadLocalAssignmentsData();
                    reportDOActivity('ADD_CLIENT', `Added client "${name}" inline to ${selectedChamber.name} with remark: ${remark}`);
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
            onPress={() => {
              setOpenedFromFab(true);
              setSelectedChamber(null); 
              setSelectedClient(null);
              setTempInput('');
              setBoxCountInput('');
              setCapturedImage(null);
              setCapturedImageTimestamp(null);
              setSelectedChamberType('Frozen');
              setIsProfileEditable(true);
              setShowLogModal(true);
            }}
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
            const totalPendingCount = (hasMorningPending ? pendingMorning.length : 0) + (hasEveningPending ? pendingEvening.length : 0);

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
      {renderIpEditModal()}
      {renderClientManagerModal()}
      {renderDeleteConfirmModal()}
      {renderAddClientModal()}
      {renderSubmitConfirmModal()}
      {renderDrawerModal()}
      {renderInventoryModal()}
      {renderHistoryModal()}
      {renderNotificationsModal()}

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
    paddingVertical: 4,
  },
  metricCard: {
    width: 95,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 4,
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
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    elevation: 1,
  },
  taskItemCardCompleted: {
    backgroundColor: '#f8fafc',
    borderColor: '#e2e8f0',
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
    fontWeight: 'bold',
    color: '#1e293b',
  },
  taskClientMeta: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  taskChamberBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#eff6ff',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: 4,
    borderWidth: 0.5,
    borderColor: '#bfdbfe',
  },
  taskChamberText: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#003580',
  },
  taskItemRight: {
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  readingLoggedWrapper: {
    alignItems: 'flex-end',
  },
  readingLoggedText: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#16a34a',
  },
  taskLoggedTime: {
    fontSize: 9,
    color: '#64748b',
    marginTop: 1,
  },
  logActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#003580',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
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
    padding: 12,
    marginBottom: 14,
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
    fontSize: 12,
    fontWeight: 'bold',
    color: '#003580',
    marginBottom: 6,
    marginTop: 8,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 42,
    marginBottom: 10,
    backgroundColor: '#f8fafc',
  },
  inputIcon: {
    marginRight: 8,
  },
  input: {
    flex: 1,
    fontSize: 14,
    color: '#0f172a',
  },
  submitBtn: {
    backgroundColor: '#003580',
    borderRadius: 8,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 15,
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
    paddingVertical: 10,
    marginBottom: 10,
    width: '100%',
    height: 42,
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
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 10,
    minHeight: 42,
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
    color: '#b91c1c',
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
    paddingVertical: 10,
    marginHorizontal: 4,
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
    height: 200,
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
