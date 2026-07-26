# ❄️ ReeferON CRM & DO Temperature Monitor

A modern, responsive, developer-friendly **Reefer Logistics CRM & Data Operator (DO) Thermal Monitoring System** built with **React**, **Express.js**, and **MySQL (`reeferon_crm_db`)**.

---

## 🚀 Features

- 📱 **Multi-Device Responsive UI**: Native layout comfort for **Mobile Phones**, **Tablets**, and **Desktop Monitors**.
- 👨‍💻 **Dedicated Data Operator (DO) Window**:
  - 📥 **Inward Temp Monitor**: Track receiving dock reefer shipments, pre-cooling, seal verification, and temperatures.
  - 📤 **Outward Temp Monitor**: Track dispatch gate releases, seal verification, and temperatures.
  - 🌡️ **DO Daily Temp Monitor**: Comprehensive daily thermal inspection dashboard.
  - 📞 **Driver Communication**: Direct Call & WhatsApp action shortcuts.
  - 🚨 **Automatic Thermal Variance Calculation**: `|Actual - Target|` with automatic `Normal`, `Warning`, and `Critical` alert tags.
- 👑 **Super Admin Window**:
  - Sales Metrics Dashboard, Lead Manager, DO Thermal Overviews, and Settings.
- 🎨 **1-to-1 JSX & CSS Component Pairing**: Every component has its matching CSS file in the exact same directory.

---

## 🗄️ Database Setup (`reeferon_crm_db`)

Import the clean database schema into MySQL:
```bash
mysql -u root -p < backend/database/schema.sql
```

---

## 🛠️ Installation & Running

### 1. Backend Server (Express + MySQL)
```bash
cd backend
npm install
npm start
```
*Backend API active on http://localhost:5000*

### 2. Frontend Application (React + Vite)
```bash
cd frontend
npm install
npm run dev
```
*Frontend active on http://localhost:3000*

---

## 📂 Project Structure

```
CRM/
├── backend/
│   ├── config/          # MySQL Connection Pool (db.js)
│   ├── controllers/     # API Controllers (tempController.js, leadController.js)
│   ├── routes/          # Express Routes (tempRoutes.js, leadRoutes.js)
│   ├── database/        # MySQL Schema (schema.sql)
│   ├── server.js        # Main Express Entry Point
│   └── package.json
└── frontend/
    ├── src/
    │   ├── components/  # Paired Components (JSX + CSS)
    │   ├── pages/       # Paired Screens (JSX + CSS)
    │   ├── services/    # API Services & Mock Fallbacks (api.js)
    │   ├── App.jsx
    │   └── index.css
    ├── index.html
    └── package.json
```
