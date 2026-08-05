import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  Image,
  ImageBackground,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  useWindowDimensions,
  Alert
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

/**
 * ====================================================================
 * LoginScreen Component (mobile/src/screens/LoginScreen.js)
 * ====================================================================
 * Renders the brand logo, email/password credentials input, and role-based
 * quick login shortcuts. It is fully responsive across different mobile sizes.
 * 
 * Developer Guide:
 * - Form submission currently triggers a mock success with the extracted username.
 * - In production, replace `handleSignIn` with a call to `POST /api/auth/login`.
 * - The quick login grid at the bottom is designed for developer testing and QA 
 *   to quickly toggle between user personas.
 * ====================================================================
 */
export default function LoginScreen({ onLoginSuccess, apiUrl, onUpdateApiUrl }) {
  // Input form state variables
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [secureTextEntry, setSecureTextEntry] = useState(true);
  const [loading, setLoading] = useState(false);
  const [apiUrlInput, setApiUrlInput] = useState(apiUrl);
  const [showSettings, setShowSettings] = useState(false);

  // Responsive layout scaling triggers
  const { width, height } = useWindowDimensions();
  const isSmallScreen = height < 680;
  const isTablet = width > 600;

  /**
   * Helper function to perform the actual HTTP login request to backend
   */
  const performLogin = async (loginEmail, loginPassword) => {
    if (loading) return;
    setLoading(true);
    try {
      const response = await fetch(`${apiUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          email: loginEmail.trim().toLowerCase(),
          password: loginPassword
        })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        if (data.user?.role !== 'do_operator') {
          alert('Access Denied: Only Data Operators registered in the directory are allowed to log in.');
          setLoading(false);
          return;
        }
        console.log('🔑 Real login success:', data.user);
        onLoginSuccess({
          user: data.user,
          token: data.token
        });
      } else {
        alert(data.message || 'Login failed. Please check your credentials.');
      }
    } catch (err) {
      console.warn('⚠️ Server unreachable:', err.message);
      
      Alert.alert(
        'Connection Error',
        `Could not reach the server at:\n${apiUrl}\n\nPlease check your internet connection or configure the correct Server Connection URL below.`,
        [
          { text: 'Configure Server', onPress: () => setShowSettings(true) },
          { text: 'OK' }
        ]
      );
    } finally {
      setLoading(false);
    }
  };

  /**
   * Validates input fields and triggers API authentication.
   */
  const handleSignIn = () => {
    // If fields are empty, alert user.
    if (!email || !password) {
      alert('Please fill in your username/email and password.');
      return;
    }
    
    performLogin(email, password);
  };



  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
      <ScrollView 
        contentContainerStyle={[
          styles.scrollContainer, 
          isTablet && { paddingHorizontal: (width - 500) / 2 } // Align screen center on tablets
        ]} 
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        
        {/* Top Header Background with Image */}
        <ImageBackground
          source={require('../../assets/warehouse_bg.jpg')}
          style={[
            styles.headerBackground,
            { height: height * 0.35 }
          ]}
          resizeMode="cover"
        >
          <View style={styles.headerOverlay}>
            {/* Cold Chain Badge */}
            <View style={styles.badge}>
              <Ionicons name="snow" size={12} color="#93c5fd" />
              <Text style={styles.badgeText}>COLD CHAIN</Text>
            </View>
            <Text style={styles.headerTitle}>Warehouse Ops</Text>
            <Text style={styles.headerSubtitle}>
              Monitor chambers, log inventory, stay in control.
            </Text>
          </View>
        </ImageBackground>

        {/* Bottom Card (Bottom Sheet look) */}
        <View style={styles.cardContainer}>
          <View style={styles.sheetHandle} />

          {/* Logo */}
          <Image
            source={require('../../assets/logo.png')}
            style={styles.logo}
            resizeMode="contain"
          />

          <Text style={styles.welcomeBack}>Welcome back</Text>
          <Text style={styles.formSubtitle}>Sign in with your email and password</Text>

          {/* Email / Username Field */}
          <Text style={styles.inputLabel}>Email</Text>
          <View style={styles.inputWrapper}>
            <Ionicons name="mail-outline" size={18} color="#94a3b8" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder="you@company.com"
              placeholderTextColor="#94a3b8"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
          </View>

          {/* Password Field */}
          <Text style={styles.inputLabel}>Password</Text>
          <View style={styles.inputWrapper}>
            <Ionicons name="lock-closed-outline" size={18} color="#94a3b8" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder="Enter password"
              placeholderTextColor="#94a3b8"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={secureTextEntry}
              autoCapitalize="none"
            />
            <TouchableOpacity
              onPress={() => setSecureTextEntry(!secureTextEntry)}
              style={styles.eyeIcon}
            >
              <Ionicons
                name={secureTextEntry ? 'eye-off-outline' : 'eye-outline'}
                size={18}
                color="#94a3b8"
              />
            </TouchableOpacity>
          </View>

          {/* Forgot Password action button */}
          <TouchableOpacity style={styles.forgotPassword}>
            <Text style={styles.forgotPasswordText}>Forgot Password?</Text>
          </TouchableOpacity>

          {/* Submit Sign-In button */}
          <TouchableOpacity style={styles.signInButton} onPress={handleSignIn}>
            <View style={styles.signInButtonContent}>
              <Text style={styles.signInButtonText}>Sign In</Text>
              <Ionicons name="arrow-forward-outline" size={16} color="#ffffff" style={styles.buttonArrow} />
            </View>
          </TouchableOpacity>



          {/* Collapsible Server Connection Settings */}
          <TouchableOpacity 
            onPress={() => setShowSettings(!showSettings)} 
            style={{ alignSelf: 'center', marginVertical: 12, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4 }}
          >
            <Ionicons name={showSettings ? "chevron-up" : "settings-outline"} size={12} color="#0033a0" />
            <Text style={{ color: '#0033a0', fontSize: 11, fontWeight: '700', textDecorationLine: 'underline' }}>
              {showSettings ? 'Hide Connection Settings' : 'Configure Server Connection'}
            </Text>
          </TouchableOpacity>

          {showSettings && (
            <View style={{ marginBottom: 12 }}>
              <Text style={styles.inputLabel}>Server Connection URL</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="server-outline" size={18} color="#94a3b8" style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="https://your-backend.up.railway.app"
                  placeholderTextColor="#94a3b8"
                  value={apiUrlInput}
                  onChangeText={(txt) => {
                    setApiUrlInput(txt);
                    onUpdateApiUrl(txt);
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </View>
          )}

          <Text style={styles.version}>v1.0.0</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a1d37', // dark blue to match header background image
  },
  scrollContainer: {
    flexGrow: 1,
    justifyContent: 'flex-start',
  },
  headerBackground: {
    width: '100%',
  },
  headerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(5, 20, 52, 0.45)', // dark blue tint overlay for text readability
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: Platform.OS === 'ios' ? 30 : 15,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 20,
    marginBottom: 10,
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
    marginLeft: 6,
    letterSpacing: 1.2,
  },
  headerTitle: {
    color: '#ffffff',
    fontSize: 26,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 4,
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 16,
    paddingHorizontal: 12,
  },
  cardContainer: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    marginTop: -25, // overlaps the image nicely
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: Platform.OS === 'ios' ? 40 : 30,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#e2e8f0',
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 12,
  },
  logo: {
    width: 176,
    height: 66,
    alignSelf: 'center',
    marginBottom: 18,
  },
  welcomeBack: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 6,
  },
  formSubtitle: {
    fontSize: 13,
    color: '#64748b',
    marginBottom: 24,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#334155',
    marginBottom: 4,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 48,
    marginBottom: 16,
    backgroundColor: '#f8fafc',
  },
  inputIcon: {
    marginRight: 10,
  },
  input: {
    flex: 1,
    fontSize: 14,
    color: '#0f172a',
    height: '100%',
  },
  eyeIcon: {
    padding: 6,
  },
  forgotPassword: {
    alignSelf: 'flex-end',
    marginBottom: 24,
  },
  forgotPasswordText: {
    color: '#0056b3',
    fontSize: 13,
    fontWeight: '600',
  },
  signInButton: {
    backgroundColor: '#0033a0',
    borderRadius: 12,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  signInButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  signInButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  buttonArrow: {
    marginLeft: 6,
  },
  dividerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#e2e8f0',
  },
  dividerText: {
    marginHorizontal: 12,
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  quickLoginContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  quickLoginCard: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingVertical: 10,
    marginHorizontal: 4,
    backgroundColor: '#f8fafc',
  },
  quickLoginText: {
    fontSize: 11,
    fontWeight: 'bold',
    marginTop: 4,
  },
  version: {
    textAlign: 'center',
    color: '#cbd5e1',
    fontSize: 11,
    marginTop: 6,
  },
});
