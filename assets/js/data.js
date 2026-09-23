/**
 * Jewel Fashion POS - Database Schema & Initial Config
 * (Clean Database - Sample & Mock Data Cleared)
 */

const INITIAL_PRODUCTS = [];

const INITIAL_CUSTOMERS = [];

const INITIAL_RENTALS = [];

const INITIAL_SALES = [];

const INITIAL_SMS_LOGS = [];

const INITIAL_SETTINGS = {
  shopName: "JEWEL FASHION",
  tagline: "Fine Gold, Diamond & Luxury Bridal Rental House",
  address: "130/10 Golden Plaza Market, Main Street, Colombo 11",
  phone: "0724229121 / 0750101589",
  ownerPhone: "0724229121, 0750101589, 0740491342",
  ownerEmail: "owner@jewelfashion.lk",
  currency: "LKR",
  currencySymbol: "Rs.",
  lateFeePerDay: 1500,
  taxRatePercent: 0,
  defaultRentalDays: 3,
  smsGateway: "SMSLENZ", // SMSLENZ, SIMULATOR, NOTIFY_LK, DIALOG, TWILIO
  smsUserId: "2110",
  smsApiKey: "44b6b7fc-998c-4d14-8a8c-2bd52fe251f2",
  smsSenderId: "J FASHION",
  autoSmsOnRental: true,
  autoSmsOnReturn: true,
  autoSmsOnSale: true,
  autoSmsToOwner: true,
  autoSmsLowStock: true,
  lowStockThreshold: 3,
  autoSmsReminders: true,
  reportBaseUrl: "",
  cloudinaryCloudName: "yypmru3x",
  cloudinaryUploadPreset: "jewelfashion"
};

const INITIAL_USERS = [
  {
    id: "USER-1",
    name: "System Administrator",
    username: "admin",
    password: "123",
    role: "ADMIN",
    station: "Executive Head Office",
    phone: "0771234567",
    email: "admin@jewelfashion.lk",
    joinedDate: "2026-01-10",
    avatar: "https://ui-avatars.com/api/?name=Admin+User&background=0f172a&color=fde047&bold=true"
  },
  {
    id: "USER-2",
    name: "Sarah Perera",
    username: "cashier",
    password: "123",
    role: "CASHIER",
    station: "Front POS Station #01",
    phone: "0719876543",
    email: "sarah.p@jewelfashion.lk",
    joinedDate: "2026-02-15",
    avatar: "https://ui-avatars.com/api/?name=Sarah+Perera&background=1e293b&color=93c5fd&bold=true"
  },
  {
    id: "USER-3",
    name: "Kasun Fernando",
    username: "sales.kasun",
    password: "123",
    role: "SALES_ASSOCIATE",
    station: "Bridal Lounge Counter #02",
    phone: "0765544332",
    email: "kasun.f@jewelfashion.lk",
    joinedDate: "2026-03-01",
    avatar: "https://ui-avatars.com/api/?name=Kasun+Fernando&background=1e293b&color=c084fc&bold=true"
  }
];

const INITIAL_CATEGORIES = [
  { id: "CAT-001", name: "Necklaces", icon: "fa-gem", description: "Necklaces, Chokers & Chains" },
  { id: "CAT-002", name: "Bridal Sets", icon: "fa-crown", description: "Bridal Sets (Complete Suites)" },
  { id: "CAT-003", name: "Rings", icon: "fa-ring", description: "Solitaire, Diamond & Gold Rings" },
  { id: "CAT-004", name: "Bangles", icon: "fa-circle-notch", description: "Bangles, Bracelets & Kadas" },
  { id: "CAT-005", name: "Earrings", icon: "fa-feather", description: "Jhumkas, Drops & Chandeliers" },
  { id: "CAT-006", name: "Tiaras & Crowns", icon: "fa-chess-queen", description: "Tiaras & Bridal Crowns" },
  { id: "CAT-007", name: "Pendants", icon: "fa-shield-halved", description: "Pendants & Lockets" },
  { id: "CAT-008", name: "Anklets", icon: "fa-spa", description: "Payals & Bridal Anklets" }
];

window.getJewelryPlaceholderSvg = function() {
  return "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'><rect width='400' height='400' fill='%2309090b'/><circle cx='200' cy='180' r='70' fill='%2318181b' stroke='%2327272a' stroke-width='2'/><path d='M200 135 L235 170 L220 215 L180 215 L165 170 Z' fill='none' stroke='%23fbbf24' stroke-width='5' stroke-linejoin='round'/><path d='M165 170 L235 170' stroke='%23fbbf24' stroke-width='3'/><path d='M200 135 L190 170 L180 215' stroke='%23fbbf24' stroke-width='2.5'/><path d='M200 135 L210 170 L220 215' stroke='%23fbbf24' stroke-width='2.5'/><text x='200' y='285' fill='%23fde047' font-family='sans-serif' font-size='13' font-weight='bold' text-anchor='middle' letter-spacing='2'>JEWEL FASHION</text><text x='200' y='310' fill='%2371717a' font-family='sans-serif' font-size='11' text-anchor='middle'>Awaiting Photo Upload</text></svg>";
};

// High-performance Cloudinary dynamic image delivery optimizer (f_auto, q_auto, w_X)
window.getOptimizedImageUrl = function(url, width = 400) {
  if (!url || typeof url !== 'string' || !url.trim()) {
    return window.getJewelryPlaceholderSvg();
  }
  const cleanUrl = url.trim();
  if (cleanUrl.startsWith('data:image')) {
    return cleanUrl;
  }
  if (cleanUrl.includes('res.cloudinary.com') && cleanUrl.includes('/upload/')) {
    // If not already transformed, insert modern auto-format, auto-quality and width limit
    if (!cleanUrl.includes('/upload/f_auto') && !cleanUrl.includes('/upload/w_')) {
      return cleanUrl.replace('/upload/', `/upload/f_auto,q_auto,w_${width},c_limit/`);
    }
  }
  return cleanUrl;
};

// Local Time / Midnight Accurate Date Utilities (Ensures overdue triggers precisely at 12:00 Midnight)
window.getLocalDateString = function(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

window.calculateDueDate = function(startDateStr, days) {
  if (!startDateStr) startDateStr = window.getLocalDateString();
  const parts = startDateStr.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  d.setDate(d.getDate() + parseInt(days || 3));
  return window.getLocalDateString(d);
};
