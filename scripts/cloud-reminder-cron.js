/**
 * Jewel Fashion POS - 24/7 Cloud Automated SMS & Executive Owner Report Dispatcher
 * Scheduled 3 times daily via GitHub Actions:
 *  - 08:00 AM: Today's Due Returns (Customer Reminders + Owner Live Report Link)
 *  - 10:30 AM: Critical Overdue Returns (Customer Overdue SMS + Owner Live Report Link)
 *  - 05:00 PM: Tomorrow's Advance Returns (Customer Reminders + Owner Live Report Link)
 */

const https = require('https');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'jewel-58bcc';
let SMS_USER_ID = process.env.SMSLENZ_USER_ID || '2110';
let SMS_API_KEY = process.env.SMSLENZ_API_KEY || '44b6b7fc-998c-4d14-8a8c-2bd52fe251f2';
let SMS_SENDER_ID = process.env.SMSLENZ_SENDER_ID || 'J FASHION';
const REPORT_BASE_URL = process.env.REPORT_BASE_URL || 'https://dilankavinda1234567-dev.github.io/jewel-fashion-pos/report.html';

// Standard HTTP Request Promise
function httpsRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) JewelFashion/1.0',
      'Accept': 'application/json, text/plain, */*'
    };
    const headers = Object.assign({}, defaultHeaders, options.headers || {});
    const opts = Object.assign({ timeout: 10000 }, options, { headers });
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTPS Request Timed Out'));
    });
    req.on('error', err => reject(err));
    if (postData) req.write(postData);
    req.end();
  });
}

// Convert Firestore REST document format to plain JS object
function parseFirestoreFields(fields) {
  if (!fields) return {};
  const result = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val.stringValue !== undefined) result[key] = val.stringValue;
    else if (val.integerValue !== undefined) result[key] = parseInt(val.integerValue, 10);
    else if (val.doubleValue !== undefined) result[key] = parseFloat(val.doubleValue);
    else if (val.booleanValue !== undefined) result[key] = val.booleanValue;
    else if (val.arrayValue !== undefined) {
      result[key] = (val.arrayValue.values || []).map(v => {
        if (v.mapValue) return parseFirestoreFields(v.mapValue.fields);
        if (v.stringValue !== undefined) return v.stringValue;
        if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
        if (v.doubleValue !== undefined) return parseFloat(v.doubleValue);
        return v;
      });
    } else if (val.mapValue !== undefined) {
      result[key] = parseFirestoreFields(val.mapValue.fields);
    }
  }
  return result;
}

// Dispatch SMS to SMSlenz.lk
async function sendSMS({ phone, message }) {
  let cleanPhone = (phone || '').trim().replace(/[^0-9]/g, '');
  if (cleanPhone.startsWith('07')) {
    cleanPhone = '94' + cleanPhone.substring(1);
  } else if (cleanPhone.startsWith('7') && cleanPhone.length === 9) {
    cleanPhone = '94' + cleanPhone;
  } else if (cleanPhone.length === 10 && cleanPhone.startsWith('0')) {
    cleanPhone = '94' + cleanPhone.substring(1);
  }

  const path = `/api/send-sms?user_id=${encodeURIComponent(SMS_USER_ID)}&api_key=${encodeURIComponent(SMS_API_KEY)}&sender_id=${encodeURIComponent(SMS_SENDER_ID)}&contact=${encodeURIComponent(cleanPhone)}&message=${encodeURIComponent(message)}`;

  try {
    const res = await httpsRequest({
      hostname: 'smslenz.lk',
      path: path,
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    return res.body;
  } catch (err) {
    console.error(`Error dispatching SMS to ${cleanPhone}:`, err.message);
    return { success: false, error: err.message };
  }
}

// Fetch all documents in a Firestore collection
async function fetchFirestoreCollection(collectionName) {
  try {
    const res = await httpsRequest({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collectionName}?pageSize=500`,
      method: 'GET'
    });

    if (res.body && res.body.documents) {
      return res.body.documents.map(doc => {
        const id = doc.name.split('/').pop();
        const data = parseFirestoreFields(doc.fields);
        data._docId = id;
        return data;
      });
    }
    return [];
  } catch (err) {
    console.error(`Error fetching collection [${collectionName}]:`, err.message);
    return [];
  }
}

// Update specific fields on a Firestore document
async function updateFirestoreDocument(collectionName, docId, updates) {
  try {
    const fields = {};
    const maskParams = [];

    for (const [k, v] of Object.entries(updates)) {
      fields[k] = { stringValue: String(v) };
      maskParams.push(`updateMask.fieldPaths=${encodeURIComponent(k)}`);
    }

    const path = `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collectionName}/${docId}?${maskParams.join('&')}`;
    const payload = JSON.stringify({ fields });

    await httpsRequest({
      hostname: 'firestore.googleapis.com',
      path: path,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, payload);
    return true;
  } catch (err) {
    console.error(`Error updating document ${docId}:`, err.message);
    return false;
  }
}

// Append record to Firestore sms_logs
async function logToFirestoreSmsLogs(logItem) {
  try {
    const fields = {
      id: { stringValue: logItem.id },
      recipientName: { stringValue: logItem.recipientName || 'Customer' },
      recipientPhone: { stringValue: logItem.recipientPhone || '' },
      recipientRole: { stringValue: logItem.recipientRole || 'CUSTOMER' },
      type: { stringValue: logItem.type || 'REMINDER' },
      title: { stringValue: logItem.title || 'Cloud Reminder' },
      message: { stringValue: logItem.message || '' },
      timestamp: { stringValue: new Date().toISOString() },
      status: { stringValue: 'DELIVERED' },
      source: { stringValue: 'GITHUB_ACTIONS_CLOUD' }
    };

    const docId = 'SMS-' + Date.now().toString().slice(-4) + '-' + Math.floor(Math.random() * 100);
    const path = `/v1/projects/${PROJECT_ID}/databases/(default)/documents/sms_logs?documentId=${docId}`;
    const payload = JSON.stringify({ fields });

    await httpsRequest({
      hostname: 'firestore.googleapis.com',
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, payload);
  } catch (e) {
    console.warn("Could not log to Firestore sms_logs", e.message);
  }
}

// MAIN RUNNER
async function runCloudReminderCron() {
  // Determine current Sri Lanka Time (UTC + 5:30)
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const slNow = new Date(utc + (5.5 * 3600000));
  const todayStr = slNow.toISOString().split('T')[0];

  const slTomorrow = new Date(slNow.getTime() + (24 * 3600000));
  const tomorrowStr = slTomorrow.toISOString().split('T')[0];

  const slHour = slNow.getHours();
  const slMinute = slNow.getMinutes();
  const slTimeFormatted = `${String(slHour).padStart(2, '0')}:${String(slMinute).padStart(2, '0')}`;

  // Check custom override from environment or auto-route based on exact Sri Lanka Time
  let jobSlot = process.env.JOB_SLOT || 'AUTO';
  if (jobSlot === 'AUTO') {
    // Strict Night / Quiet Hours Protection (8:00 PM - 7:00 AM Sri Lanka Time)
    if (slHour < 7 || slHour >= 20) {
      console.log(`🌙 [Quiet Hours Active] Current Sri Lanka Time: ${slTimeFormatted} (${todayStr}). Night protection enabled. Automated SMS reminders are strictly disabled between 8:00 PM and 7:00 AM. Exiting.`);
      return;
    }

    // 08:00 AM Slot (07:00 - 09:59): Due Today (Customer SMS + Owner Morning Report)
    // 10:30 AM Slot (10:00 - 13:59): Critical Overdue (Customer SMS + Owner Overdue Report)
    // 05:00 PM Slot (14:00 - 19:59): Due Tomorrow (Customer Advance 1-Day SMS + Owner Tomorrow Report)
    if (slHour >= 7 && slHour < 10) {
      jobSlot = 'TODAY_8AM';
    } else if (slHour >= 10 && slHour < 14) {
      jobSlot = 'OVERDUE_1030AM';
    } else if (slHour >= 14 && slHour < 20) {
      jobSlot = 'TOMORROW_5PM';
    } else {
      console.log(`ℹ️ [Outside Scheduled Slot] Current Sri Lanka Time: ${slTimeFormatted}. No active reminder window. Exiting safely.`);
      return;
    }
  }

  console.log("==================================================================");
  console.log("👑 JEWEL FASHION - 24/7 CLOUD AUTOMATED SMS & REPORT DISPATCHER");
  console.log(`⏰ Current Sri Lanka Time: ${slTimeFormatted} (${todayStr})`);
  console.log(`🎯 Active Scheduled Job Slot: [${jobSlot}]`);
  console.log(`📡 SMS Gateway: SMSlenz.lk | Sender Mask: [${SMS_SENDER_ID}]`);
  console.log(`🔥 Cloud Database: [${PROJECT_ID}]`);
  console.log("==================================================================");

  // 1. Fetch Store Settings
  const settingsDocs = await fetchFirestoreCollection('settings');
  let settings = {
    phone: '+94 11 234 5678 / +94 77 123 4567',
    ownerPhone: '0740491342',
    lateFeePerDay: 1500,
    autoSmsReminders: true,
    autoSmsToOwner: true,
    reportBaseUrl: ''
  };
  if (settingsDocs.length > 0) {
    const generalDoc = settingsDocs.find(s => s._docId === 'general') || settingsDocs[0];
    settings = Object.assign(settings, generalDoc);
  }

  // Dynamic Live Report Base URL
  const activeReportBaseUrl = (settings.reportBaseUrl || process.env.REPORT_BASE_URL || 'https://dilankavinda1234567-dev.github.io/jewel-fashion-pos/report.html').trim();

  // Live dynamic credentials from Admin Panel Firestore settings
  if (settings.smsUserId) SMS_USER_ID = settings.smsUserId;
  if (settings.smsApiKey) SMS_API_KEY = settings.smsApiKey;
  if (settings.smsSenderId) SMS_SENDER_ID = settings.smsSenderId;

  // Sanitize invalid or placeholder credentials
  if (!SMS_API_KEY || SMS_API_KEY === 'JF_LIVE_API_KEY_8899' || SMS_API_KEY.startsWith('YOUR_')) {
    SMS_API_KEY = '44b6b7fc-998c-4d14-8a8c-2bd52fe251f2';
  }
  if (!SMS_USER_ID || SMS_USER_ID === 'USER_ID') {
    SMS_USER_ID = '2110';
  }
  if (!SMS_SENDER_ID || SMS_SENDER_ID === 'SMSlenzDEMO' || SMS_SENDER_ID === 'JEWEL-FASH' || SMS_SENDER_ID === 'ACCEPT WEB') {
    SMS_SENDER_ID = 'J FASHION';
  }

  if (settings.autoSmsReminders === false) {
    console.log("ℹ️ Auto SMS Reminders disabled in store settings. Exiting.");
    return;
  }

  // 2. Fetch Customers & Rentals
  const customers = await fetchFirestoreCollection('customers');
  const customerMap = {};
  customers.forEach(c => {
    customerMap[c.id || c._docId] = c;
  });

  const rentals = await fetchFirestoreCollection('rentals');
  if (rentals.length === 0) {
    console.log("ℹ️ No rentals found in database.");
  }

  const activeRentals = rentals.filter(r => r.status !== 'RETURNED');
  console.log(`📦 Found ${activeRentals.length} active rental(s) out of ${rentals.length} total records.`);

  // Optional: Check Low Stock Products in Cloud Scan
  const lowStockThreshold = (settings.lowStockThreshold !== undefined && settings.lowStockThreshold !== null) ? parseInt(settings.lowStockThreshold, 10) : 3;
  if (settings.autoSmsLowStock !== false) {
    try {
      const products = await fetchFirestoreCollection('products');
      const lowStockItems = products.filter(p => 
        (p.isBuyAvailable && typeof p.stockBuy === 'number' && p.stockBuy <= lowStockThreshold) ||
        (p.isRentalAvailable && typeof p.stockRent === 'number' && p.stockRent <= lowStockThreshold)
      );
      if (lowStockItems.length > 0) {
        console.log(`⚠️ [Stock Audit] ${lowStockItems.length} product(s) currently at low stock level (<= ${lowStockThreshold} units).`);
      }
    } catch (e) {
      console.warn("Could not check product low stock:", e.message);
    }
  }

  let customerSmsCount = 0;

  // =========================================================================
  // 1. JOB SLOT: 8:00 AM (Due Today Reminders + Owner Live Report Link)
  // =========================================================================
  if (jobSlot === 'TODAY_8AM' || jobSlot === 'ALL_IN_ONE') {
    console.log("\n🌅 [8:00 AM JOB] Scanning for Rentals Due TODAY...");
    const dueTodayRentals = activeRentals.filter(r => r.dueDate === todayStr);
    console.log(`   Found ${dueTodayRentals.length} booking(s) due today.`);

    for (const rental of dueTodayRentals) {
      if (rental.lastAutoReminderDate === todayStr && rental.lastAutoReminderType === 'DUE_TODAY') continue;

      const customer = customerMap[rental.customerId] || {
        name: rental.customerName || 'Valued Client',
        phone: rental.customerPhone || ''
      };
      if (!customer.phone) continue;

      const itemNames = (rental.items && Array.isArray(rental.items) && rental.items.length > 0)
        ? rental.items.map(i => `${i.name} (Qty: ${i.quantity || 1})`).join(', ')
        : (rental.productName || 'Bridal Jewellery Set');

      const custMsg = `JEWEL FASHION URGENT NOTICE: Dear ${customer.name}, your jewellery rental (${rental.rentalNumber || rental.id}) is due for return TODAY (${rental.dueDate}). Items: ${itemNames}. Please visit our boutique before 6:30 PM today for return inspection & deposit refund. Hotline: ${settings.phone}`;

      console.log(`   📱 Sending Due Today SMS to ${customer.name} (${customer.phone})...`);
      await sendSMS({ phone: customer.phone, message: custMsg });

      await updateFirestoreDocument('rentals', rental._docId, {
        lastAutoReminderDate: todayStr,
        lastAutoReminderType: 'DUE_TODAY'
      });

      await logToFirestoreSmsLogs({
        id: 'SMS-' + Date.now().toString().slice(-4),
        recipientName: customer.name,
        recipientPhone: customer.phone,
        recipientRole: 'CUSTOMER',
        type: 'DUE_TODAY',
        title: 'Return Due Today (8:00 AM)',
        message: custMsg
      });

      customerSmsCount++;
    }

    // Send Live Report Link to Store Owner (08:00 AM Morning Executive Summary)
    if (settings.autoSmsToOwner && settings.ownerPhone) {
      const reportLink = `${activeReportBaseUrl}?type=today`;
      let totalItemsToday = 0;
      dueTodayRentals.forEach(r => {
        if (r.items && Array.isArray(r.items)) r.items.forEach(i => totalItemsToday += (parseInt(i.quantity) || 1));
        else totalItemsToday += 1;
      });

      const overdueRentalsCount = activeRentals.filter(r => r.dueDate < todayStr).length;

      let ownerMsg = '';
      if (dueTodayRentals.length > 0) {
        ownerMsg = `👑 JEWEL FASHION OWNER REPORT (08:00 AM): ${dueTodayRentals.length} rental booking(s) (${totalItemsToday} items) due for return TODAY (${todayStr}). Pending Overdue: ${overdueRentalsCount}. View live list: ${reportLink}`;
      } else {
        ownerMsg = `👑 JEWEL FASHION OWNER REPORT (08:00 AM): 0 rentals due today (${todayStr}). Active: ${activeRentals.length}, Overdue: ${overdueRentalsCount}. All clear. View live overview: ${reportLink}`;
      }

      console.log(`   👑 Dispatching Today's Executive Report Link to Store Owner (${settings.ownerPhone})...`);
      await sendSMS({ phone: settings.ownerPhone, message: ownerMsg });

      await logToFirestoreSmsLogs({
        id: 'SMS-' + Date.now().toString().slice(-4),
        recipientName: 'Store Owner',
        recipientPhone: settings.ownerPhone,
        recipientRole: 'OWNER',
        type: 'OWNER_REPORT_TODAY',
        title: `👑 Today's Return Report Link (${dueTodayRentals.length} Due Today)`,
        message: ownerMsg
      });
    }
  }

  // =========================================================================
  // 2. JOB SLOT: 10:30 AM (Critical Overdue Notices + Owner Overdue Report Link)
  // =========================================================================
  if (jobSlot === 'OVERDUE_1030AM' || jobSlot === 'ALL_IN_ONE') {
    console.log("\n⚠️ [10:30 AM JOB] Scanning for Critical OVERDUE Rentals...");
    const overdueRentals = activeRentals.filter(r => r.dueDate < todayStr);
    console.log(`   Found ${overdueRentals.length} overdue booking(s).`);

    for (const rental of overdueRentals) {
      if (rental.lastAutoReminderDate === todayStr && rental.lastAutoReminderType === 'OVERDUE') continue;

      const customer = customerMap[rental.customerId] || {
        name: rental.customerName || 'Valued Client',
        phone: rental.customerPhone || ''
      };
      if (!customer.phone) continue;

      const due = new Date(rental.dueDate);
      const current = new Date(todayStr);
      const overdueDays = Math.max(1, Math.floor((current - due) / (1000 * 60 * 60 * 24)));
      const lateFee = overdueDays * (settings.lateFeePerDay || 1500);

      const custMsg = `JEWEL FASHION CRITICAL OVERDUE ALERT: Dear ${customer.name}, rental booking ${rental.rentalNumber || rental.id} was due on ${rental.dueDate} and is now ${overdueDays} DAY(S) OVERDUE. Accumulated late fee penalty: Rs. ${lateFee.toLocaleString()} (Rs. ${(settings.lateFeePerDay || 1500).toLocaleString()}/day). Please return all jewellery items immediately to avoid deposit forfeiture. Hotline: ${settings.phone}`;

      console.log(`   📱 Sending Overdue Notice to ${customer.name} (${customer.phone}) - ${overdueDays} days late...`);
      await sendSMS({ phone: customer.phone, message: custMsg });

      await updateFirestoreDocument('rentals', rental._docId, {
        lastAutoReminderDate: todayStr,
        lastAutoReminderType: 'OVERDUE'
      });

      await logToFirestoreSmsLogs({
        id: 'SMS-' + Date.now().toString().slice(-4),
        recipientName: customer.name,
        recipientPhone: customer.phone,
        recipientRole: 'CUSTOMER',
        type: 'OVERDUE_ALERT',
        title: `Overdue Warning (${overdueDays}d Late)`,
        message: custMsg
      });

      customerSmsCount++;
    }

    // Send Overdue Report Link to Store Owner (10:30 AM Daily Overdue Status)
    if (settings.autoSmsToOwner && settings.ownerPhone) {
      const reportLink = `${activeReportBaseUrl}?type=overdue`;
      let totalOverdueItems = 0;
      overdueRentals.forEach(r => {
        if (r.items && Array.isArray(r.items)) r.items.forEach(i => totalOverdueItems += (parseInt(i.quantity) || 1));
        else totalOverdueItems += 1;
      });

      let ownerMsg = '';
      if (overdueRentals.length > 0) {
        ownerMsg = `👑 JEWEL FASHION OWNER ALERT (10:30 AM): ${overdueRentals.length} OVERDUE rental booking(s) (${totalOverdueItems} items) pending return. Tap to view full customer list & late fees: ${reportLink}`;
      } else {
        ownerMsg = `👑 JEWEL FASHION OWNER REPORT (10:30 AM): 0 OVERDUE rentals pending (${todayStr}). All active rentals are in good standing. View live list: ${reportLink}`;
      }

      console.log(`   👑 Dispatching Overdue Executive Report Link to Store Owner (${settings.ownerPhone})...`);
      await sendSMS({ phone: settings.ownerPhone, message: ownerMsg });

      await logToFirestoreSmsLogs({
        id: 'SMS-' + Date.now().toString().slice(-4),
        recipientName: 'Store Owner',
        recipientPhone: settings.ownerPhone,
        recipientRole: 'OWNER',
        type: 'OWNER_REPORT_OVERDUE',
        title: `⚠️ Overdue Report Link (${overdueRentals.length} Overdue)`,
        message: ownerMsg
      });
    }
  }

  // =========================================================================
  // 3. JOB SLOT: 5:00 PM (Due Tomorrow 1-Day Advance Reminders + Owner Report Link)
  // =========================================================================
  if (jobSlot === 'TOMORROW_5PM' || jobSlot === 'ALL_IN_ONE') {
    console.log("\n🌇 [5:00 PM JOB] Scanning for Rentals Due TOMORROW...");
    const dueTomorrowRentals = activeRentals.filter(r => r.dueDate === tomorrowStr);
    console.log(`   Found ${dueTomorrowRentals.length} booking(s) due tomorrow.`);

    for (const rental of dueTomorrowRentals) {
      if (rental.lastAutoReminderDate === todayStr && rental.lastAutoReminderType === 'DUE_TOMORROW') continue;

      const customer = customerMap[rental.customerId] || {
        name: rental.customerName || 'Valued Client',
        phone: rental.customerPhone || ''
      };
      if (!customer.phone) continue;

      const itemNames = (rental.items && Array.isArray(rental.items) && rental.items.length > 0)
        ? rental.items.map(i => `${i.name} (Qty: ${i.quantity || 1})`).join(', ')
        : (rental.productName || 'Bridal Jewellery Set');

      const custMsg = `JEWEL FASHION (1-DAY REMINDER): Dear ${customer.name}, your jewellery rental (${rental.rentalNumber || rental.id}) is scheduled for return TOMORROW (${rental.dueDate}). Items: ${itemNames}. Please return in original protective case before 6:30 PM to collect your deposit. Hotline: ${settings.phone}`;

      console.log(`   📱 Sending Tomorrow Due Reminder to ${customer.name} (${customer.phone})...`);
      await sendSMS({ phone: customer.phone, message: custMsg });

      await updateFirestoreDocument('rentals', rental._docId, {
        lastAutoReminderDate: todayStr,
        lastAutoReminderType: 'DUE_TOMORROW'
      });

      await logToFirestoreSmsLogs({
        id: 'SMS-' + Date.now().toString().slice(-4),
        recipientName: customer.name,
        recipientPhone: customer.phone,
        recipientRole: 'CUSTOMER',
        type: 'DUE_TOMORROW',
        title: 'Rental Due Tomorrow (5:00 PM)',
        message: custMsg
      });

      customerSmsCount++;
    }

    // Send Tomorrow's Return Report Link to Store Owner (05:00 PM Daily Forecast)
    if (settings.autoSmsToOwner && settings.ownerPhone) {
      const reportLink = `${activeReportBaseUrl}?type=tomorrow`;
      let totalItemsTomorrow = 0;
      dueTomorrowRentals.forEach(r => {
        if (r.items && Array.isArray(r.items)) r.items.forEach(i => totalItemsTomorrow += (parseInt(i.quantity) || 1));
        else totalItemsTomorrow += 1;
      });

      let ownerMsg = '';
      if (dueTomorrowRentals.length > 0) {
        ownerMsg = `👑 JEWEL FASHION OWNER REPORT (05:00 PM): ${dueTomorrowRentals.length} rental booking(s) (${totalItemsTomorrow} items) scheduled for return TOMORROW (${tomorrowStr}). Tap to view expected items: ${reportLink}`;
      } else {
        ownerMsg = `👑 JEWEL FASHION OWNER REPORT (05:00 PM): 0 rental returns scheduled for tomorrow (${tomorrowStr}). Active bookings: ${activeRentals.length}. View live list: ${reportLink}`;
      }

      console.log(`   👑 Dispatching Tomorrow's Return Report Link to Store Owner (${settings.ownerPhone})...`);
      await sendSMS({ phone: settings.ownerPhone, message: ownerMsg });

      await logToFirestoreSmsLogs({
        id: 'SMS-' + Date.now().toString().slice(-4),
        recipientName: 'Store Owner',
        recipientPhone: settings.ownerPhone,
        recipientRole: 'OWNER',
        type: 'OWNER_REPORT_TOMORROW',
        title: `👑 Tomorrow's Return Report Link (${dueTomorrowRentals.length} Bookings)`,
        message: ownerMsg
      });
    }
  }

  console.log("\n==================================================================");
  console.log(`🎉 Cloud Run Complete! Total SMS Dispatched: ${customerSmsCount}`);
  console.log("==================================================================");
}

runCloudReminderCron().catch(err => {
  console.error("FATAL ERROR in Cloud Reminder Cron:", err);
  process.exit(1);
});
