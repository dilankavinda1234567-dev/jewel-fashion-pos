/**
 * Jewel Fashion POS - 24/7 Cloud Automated SMS & Executive Owner Report Dispatcher
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
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const slNow = new Date(utc + (5.5 * 3600000));
  const todayStr = slNow.toISOString().split('T')[0];
  const tomorrowStr = new Date(slNow.getTime() + (24 * 3600000)).toISOString().split('T')[0];

  const slHour = slNow.getHours();
  const slMinute = slNow.getMinutes();
  const slTimeFormatted = `${String(slHour).padStart(2, '0')}:${String(slMinute).padStart(2, '0')}`;

  let jobSlot = process.env.JOB_SLOT || 'ALL_IN_ONE';
  if (jobSlot === 'AUTO') {
    jobSlot = 'ALL_IN_ONE';
  }

  console.log("==================================================================");
  console.log("👑 JEWEL FASHION - 24/7 CLOUD AUTOMATED SMS & REPORT DISPATCHER");
  console.log(`⏰ Current Sri Lanka Time: ${slTimeFormatted} (${todayStr})`);
  console.log(`🎯 Active Scheduled Job Slot: [${jobSlot}]`);
  console.log("==================================================================");

  // 1. Fetch Store Settings
  const settingsDocs = await fetchFirestoreCollection('settings');
  let settings = {
    phone: '+94 11 234 5678 / +94 77 123 4567',
    ownerPhone: '+94 77 999 8888',
    lateFeePerDay: 1500,
    autoSmsReminders: false,
    autoSmsToOwner: false,
    smsGateway: 'SMSLENZ',
    smsUserId: '2110',
    smsApiKey: '44b6b7fc-998c-4d14-8a8c-2bd52fe251f2',
    smsSenderId: 'J FASHION'
  };
  if (settingsDocs.length > 0) {
    const generalDoc = settingsDocs.find(s => s._docId === 'general') || settingsDocs[0];
    settings = Object.assign(settings, generalDoc);
  }

  // Adopt Live Credentials from Admin Panel
  if (settings.smsUserId) SMS_USER_ID = settings.smsUserId;
  if (settings.smsApiKey) SMS_API_KEY = settings.smsApiKey;
  if (settings.smsSenderId) SMS_SENDER_ID = settings.smsSenderId;

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
    return;
  }

  const activeRentals = rentals.filter(r => r.status !== 'RETURNED');
  console.log(`📦 Found ${activeRentals.length} active rental(s) out of ${rentals.length} total records.`);

  let customerSmsCount = 0;

  for (const rental of activeRentals) {
    const docId = rental._docId || rental.id || rental.rentalNumber;
    const dueDate = rental.dueDate;
    if (!dueDate) continue;

    const customer = customerMap[rental.customerId] || {
      name: rental.customerName || 'Valued Customer',
      phone: rental.customerPhone || ''
    };

    if (!customer.phone) continue;

    let smsType = null;
    let smsTitle = '';
    let message = '';

    // Condition A: Due Today
    if (dueDate === todayStr && rental.lastAutoReminderType !== 'DUE_TODAY') {
      smsType = 'DUE_TODAY';
      smsTitle = 'Return Due Today Notification';
      message = `Dear ${customer.name}, your jewellery rental (${rental.rentalNumber || docId}) from Jewel Fashion is DUE TODAY (${dueDate}). Please return the items before 6:30 PM to avoid late fees (+Rs. ${settings.lateFeePerDay || 1500}/day). Hotlines: ${settings.phone}`;
    }
    // Condition B: Due Tomorrow
    else if (dueDate === tomorrowStr && rental.lastAutoReminderType !== 'DUE_TOMORROW') {
      smsType = 'DUE_TOMORROW';
      smsTitle = 'Return Due Tomorrow Reminder';
      message = `Dear ${customer.name}, gentle reminder that your jewellery rental (${rental.rentalNumber || docId}) from Jewel Fashion is due for return TOMORROW (${dueDate}). Hotlines: ${settings.phone}`;
    }
    // Condition C: Overdue
    else if (dueDate < todayStr && rental.lastAutoReminderType !== 'OVERDUE') {
      const parts = dueDate.split('-').map(Number);
      const dueObj = new Date(parts[0], parts[1] - 1, parts[2]);
      const todayParts = todayStr.split('-').map(Number);
      const todayObj = new Date(todayParts[0], todayParts[1] - 1, todayParts[2]);
      const overdueDays = Math.max(1, Math.floor((todayObj - dueObj) / (1000 * 60 * 60 * 24)));
      const lateFee = overdueDays * (settings.lateFeePerDay || 1500);

      smsType = 'OVERDUE';
      smsTitle = 'Overdue Return Demand Notice';
      message = `URGENT NOTICE: Dear ${customer.name}, your jewellery rental (${rental.rentalNumber || docId}) is OVERDUE by ${overdueDays} day(s). Accumulated late penalty is +Rs. ${lateFee.toLocaleString()}. Please return items immediately. Contact: ${settings.phone}`;
    }

    if (smsType && message) {
      console.log(`📤 Sending [${smsType}] SMS to ${customer.name} (${customer.phone})...`);
      const res = await sendSMS({ phone: customer.phone, message });

      customerSmsCount++;
      await updateFirestoreDocument('rentals', docId, {
        lastAutoReminderDate: todayStr,
        lastAutoReminderType: smsType
      });

      await logToFirestoreSmsLogs({
        id: `SMS-${Date.now().toString().slice(-4)}`,
        recipientName: customer.name,
        recipientPhone: customer.phone,
        recipientRole: 'CUSTOMER',
        type: smsType,
        title: smsTitle,
        message: message
      });
    }
  }

  console.log(`\n🎉 Processed successfully. Total Customer SMS Dispatched: ${customerSmsCount}`);
}

runCloudReminderCron().catch(console.error);
