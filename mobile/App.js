import React, { useState, useEffect } from 'react';
import { StyleSheet, View, NativeModules, Platform, ActivityIndicator, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import LoginScreen from './src/screens/LoginScreen';
import DashboardScreen from './src/screens/DashboardScreen';

/** Render production API (no trailing slash, no /api) */
export const PRODUCTION_API_URL = 'https://reeferon-crm-backend.onrender.com';

/** Fallback LAN IP if Metro host cannot be detected */
const FALLBACK_LOCAL_IP = '192.168.147.129';

/** Detect local backend URL from Metro bundler (Expo Go / emulator). */
export function getLocalApiUrl() {
  try {
    const scriptURL = NativeModules.SourceCode?.scriptURL || '';
    const address = scriptURL.split('://')[1] || '';
    const host = address.split('/')[0] || '';
    const ip = host.split(':')[0];

    if (ip) {
      if (ip === 'localhost' || ip === '127.0.0.1' || ip === '10.0.2.2' || ip === '::1') {
        return Platform.OS === 'android' ? 'http://10.0.2.2:5000' : 'http://localhost:5000';
      }
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        return `http://${ip}:5000`;
      }
    }
  } catch (e) {
    console.warn('Failed to detect local API host:', e);
  }
  return `http://${FALLBACK_LOCAL_IP}:5000`;
}

export function isProductionApiUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim().toLowerCase();
  return u.includes('onrender.com') || u.startsWith('https://');
}

export default function App() {
  const [apiUrl, setApiUrl] = useState(PRODUCTION_API_URL);
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);

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
        // Restore last chosen server (production or local)
        if (storedApiUrl && storedApiUrl.trim()) {
          setApiUrl(storedApiUrl.replace(/\/$/, ''));
        } else {
          setApiUrl(PRODUCTION_API_URL);
          await AsyncStorage.setItem('api_url', PRODUCTION_API_URL);
        }
      } catch (err) {
        console.warn('Failed to restore session:', err);
      } finally {
        setLoading(false);
      }
    };
    restoreSession();
  }, []);

  useEffect(() => {
    const handleUrl = (url) => {
      if (!url) return;
      console.log('[deep-link]', url);
    };

    Linking.getInitialURL().then(handleUrl).catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => sub.remove();
  }, []);

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

  const handleUpdateApiUrl = async (newUrl) => {
    try {
      const clean = String(newUrl || '').trim().replace(/\/$/, '');
      setApiUrl(clean);
      await AsyncStorage.setItem('api_url', clean);
    } catch (err) {
      console.warn('Failed to save API URL:', err);
    }
  };

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
        <LoginScreen
          onLoginSuccess={handleLoginSuccess}
          apiUrl={apiUrl}
          onUpdateApiUrl={handleUpdateApiUrl}
          productionApiUrl={PRODUCTION_API_URL}
          localApiUrl={getLocalApiUrl()}
        />
      ) : (
        <DashboardScreen
          user={user}
          token={token}
          apiUrl={apiUrl}
          onLogout={handleLogout}
          onUserUpdate={setUser}
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
