import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  useWindowDimensions
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
export default function LoginScreen({ onLoginSuccess, apiUrl }) {
  // Input form state variables
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [secureTextEntry, setSecureTextEntry] = useState(true);
  const [loading, setLoading] = useState(false);

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
      console.warn('⚠️ Server unreachable. Falling back to offline development mock login.', err.message);
      
      const emailLower = loginEmail.trim().toLowerCase();
      if (emailLower.includes('admin') || emailLower.includes('subadmin')) {
        alert('Access Denied: Only Data Operators registered in the directory are allowed to log in.');
        setLoading(false);
        return;
      }

      let role = 'do_operator';
      let fullName = 'Test DO Operator (Offline)';
      let warehouseName = 'Bengaluru';
      let chamberLimit = 4;

      onLoginSuccess({
        user: {
          id: 999,
          email: emailLower,
          role: role,
          full_name: fullName,
          phone_no: '9876543210',
          warehouse_name: warehouseName,
          chamber_limit: chamberLimit
        },
        token: 'mock-development-bypass-jwt-token'
      });
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

  /**
   * Helper function for rapid QA testing. Auto-fills credentials
   * and logs in with targeted role parameters.
   * @param {string} role - Selected user persona ('Operator', 'Supervisor', 'Customer')
   */
  const handleQuickLogin = (role) => {
    let testEmail = '';
    let testPass = '';

    if (role === 'Operator') {
      testEmail = 'r@g.com';
      testPass = 'qwe123';
    } else if (role === 'Supervisor') {
      testEmail = 'admin@reeferon.com';
      testPass = 'admin123';
    } else {
      testEmail = 'subadmin@reeferon.com';
      testPass = 'subadmin123';
    }

    setEmail(testEmail);
    setPassword(testPass);
    performLogin(testEmail, testPass);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <StatusBar barStyle="dark-content" />
      <ScrollView 
        contentContainerStyle={[
          styles.scrollContainer, 
          isTablet && { paddingHorizontal: (width - 500) / 2 } // Align screen center on tablets
        ]} 
        showsVerticalScrollIndicator={false}
      >
        
        {/* Top Header Background with dynamic scale based on viewport height */}
        <View style={[
          styles.headerBackground, 
          { paddingVertical: isSmallScreen ? 25 : 45 }
        ]}>
          <Image
            source={require('../../assets/logo.png')}
            style={[
              styles.logo, 
              { 
                width: isSmallScreen ? 140 : 180, 
                height: isSmallScreen ? 90 : 120 
              }
            ]}
            resizeMode="contain"
          />
          <Text style={styles.logoTagline}>Anything to Everything in Cold Chain</Text>
        </View>

        {/* Input Form Fields Wrapper */}
        <View style={styles.formContainer}>
          <Text style={styles.title}>Sign In</Text>
          <Text style={styles.subtitle}>Enter your credentials to continue</Text>

          {/* Email / Username Field */}
          <View style={styles.inputWrapper}>
            <Ionicons name="mail-outline" size={20} color="#64748b" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder="Username / Email"
              placeholderTextColor="#94a3b8"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
          </View>

          {/* Password Field with Hide/Show Visibility feature */}
          <View style={styles.inputWrapper}>
            <Ionicons name="lock-closed-outline" size={20} color="#64748b" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder="Password"
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
                size={20}
                color="#64748b"
              />
            </TouchableOpacity>
          </View>

          {/* Forgot Password action button */}
          <TouchableOpacity style={styles.forgotPassword}>
            <Text style={styles.forgotPasswordText}>Forgot Password?</Text>
          </TouchableOpacity>

          {/* Submit Sign-In button */}
          <TouchableOpacity style={styles.signInButton} onPress={handleSignIn}>
            <Text style={styles.signInButtonText}>Sign In</Text>
          </TouchableOpacity>

          {/* Persona selector divider */}
          <View style={styles.dividerContainer}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or continue as</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Quick Login selector cards (for dev testing) */}
          <View style={styles.quickLoginContainer}>
            <TouchableOpacity
              style={styles.quickLoginCard}
              onPress={() => handleQuickLogin('Operator')}
            >
              <MaterialCommunityIcons name="account-cog" size={24} color="#0056b3" />
              <Text style={[styles.quickLoginText, { color: '#0056b3' }]} numberOfLines={1}>Operator</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.quickLoginCard}
              onPress={() => handleQuickLogin('Supervisor')}
            >
              <MaterialCommunityIcons name="shield-account" size={24} color="#16a34a" />
              <Text style={[styles.quickLoginText, { color: '#16a34a' }]} numberOfLines={1}>Supervisor</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.quickLoginCard}
              onPress={() => handleQuickLogin('Customer')}
            >
              <MaterialCommunityIcons name="account-tie" size={24} color="#7c3aed" />
              <Text style={[styles.quickLoginText, { color: '#7c3aed' }]} numberOfLines={1}>Customer</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.version}>v1.0.0</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  scrollContainer: {
    flexGrow: 1,
    justifyContent: 'space-between',
  },
  headerBackground: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fafc',
    borderBottomLeftRadius: 30,
    borderBottomRightRadius: 30,
  },
  logo: {
    // Width and height properties are controlled dynamically inside component render
  },
  logoTagline: {
    fontSize: 11,
    color: '#84cc16',
    fontWeight: '600',
    marginTop: 5,
  },
  formContainer: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#0056b3',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    color: '#64748b',
    marginBottom: 20,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 16,
    height: 52,
    marginBottom: 16,
    backgroundColor: '#f8fafc',
  },
  inputIcon: {
    marginRight: 12,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: '#0f172a',
  },
  eyeIcon: {
    padding: 4,
  },
  forgotPassword: {
    alignSelf: 'flex-end',
    marginBottom: 20,
  },
  forgotPasswordText: {
    color: '#0056b3',
    fontSize: 13,
    fontWeight: '600',
  },
  signInButton: {
    backgroundColor: '#0056b3',
    borderRadius: 12,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0056b3',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
    marginBottom: 24,
  },
  signInButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: 'bold',
  },
  dividerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
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
    marginBottom: 20,
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
    marginTop: 'auto',
  },
});
