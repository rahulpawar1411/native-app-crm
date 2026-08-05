import React, { useState, useEffect } from 'react';
import { StyleSheet, View, NativeModules, Platform, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import LoginScreen from './src/screens/LoginScreen';
import DashboardScreen from './src/screens/DashboardScreen';

// Automatically detect local machine IP in development (from Metro bundler)
const getApiBaseUrl = () => {
  const DEFAULT_IP = '192.168.254.129'; // Your computer's current local Wi-Fi IP
  if (__DEV__) {
    try {
      const scriptURL = NativeModules.SourceCode?.scriptURL || '';
      const address = scriptURL.split('://')[1] || '';
      const host = address.split('/')[0] || '';
      const ip = host.split(':')[0];
      
      if (ip) {
        // If running in emulator, route to correct loopback host alias
        if (ip === 'localhost' || ip === '127.0.0.1' || ip === '10.0.2.2' || ip === '::1') {
          return Platform.OS === 'android' ? 'http://10.0.2.2:5000' : 'http://localhost:5000';
        }
        // If it's a valid IPv4 network address, use it
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
          return `http://${ip}:5000`;
        }
      }
    } catch (e) {
      console.warn('Failed to dynamically detect backend IP, using fallback.', e);
    }
    // Fallback for physical devices
    return `http://${DEFAULT_IP}:5000`;
  }
  // Production URL fallback
  return 'https://reeferon-crm-backend.onrender.com';
};

const API_BASE_URL = getApiBaseUrl();

export default function App() {
  // Authentication session state tracking user details and JWT token
  const [apiUrl, setApiUrl] = useState(API_BASE_URL);
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);

  // Restore session from AsyncStorage on app startup
  useEffect(() => {
    const restoreSession = async () => {
      try {
        const storedToken = await AsyncStorage.getItem('user_token');
        const storedUser = await AsyncStorage.getItem('user_profile');
        const storedApiUrl = await AsyncStorage.getItem('api_url');
        if (storedToken && storedUser) {
          setToken(storedToken);
          setUser(JSON.parse(storedUser));
        }
        if (storedApiUrl) {
          setApiUrl(storedApiUrl);
        }
      } catch (err) {
        console.warn('Failed to restore session:', err);
      } finally {
        setLoading(false);
      }
    };
    restoreSession();
  }, []);

  /**
   * Callback fired upon successful credential verification.
   * Sets token and user details dynamically.
   * @param {Object} sessionData - Contains { user, token }
   */
  const handleLoginSuccess = async (sessionData) => {
    setUser(sessionData.user);
    setToken(sessionData.token);
    try {
      await AsyncStorage.setItem('user_token', sessionData.token);
      await AsyncStorage.setItem('user_profile', JSON.stringify(sessionData.user));
    } catch (err) {
      console.warn('Failed to cache session data:', err);
    }
  };

  /**
   * Updates the server base API URL and persists it in AsyncStorage.
   * @param {string} newUrl - The new API base URL
   */
  const handleUpdateApiUrl = async (newUrl) => {
    try {
      setApiUrl(newUrl);
      await AsyncStorage.setItem('api_url', newUrl);
    } catch (err) {
      console.warn('Failed to save API URL:', err);
    }
  };

  /**
   * Clears the user session and redirects back to the Sign-In screen.
   */
  const handleLogout = async () => {
    setUser(null);
    setToken(null);
    try {
      await AsyncStorage.removeItem('user_token');
      await AsyncStorage.removeItem('user_profile');
    } catch (err) {
      console.warn('Failed to clear session cache:', err);
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color="#0056b3" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {!user || !token ? (
        // Render Login Screen if user session is not active
        <LoginScreen onLoginSuccess={handleLoginSuccess} apiUrl={apiUrl} onUpdateApiUrl={handleUpdateApiUrl} />
      ) : (
        // Render Dashboard Screen with user session and token context
        <DashboardScreen 
          user={user} 
          token={token} 
          apiUrl={apiUrl} 
          onUpdateApiUrl={handleUpdateApiUrl} 
          onLogout={handleLogout} 
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
});
