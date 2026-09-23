/**
 * Jewel Fashion POS - 24/7 Cloud Automated SMS Reminder & Daily Report Engine
 * Multi-Owner Daily Report Link Dispatcher
 */

const https = require('https');

const PROJECT_ID = 'jewel-58bcc';
const FIRESTORE_BASE_URL = 'firestore.googleapis.com';

let SMS_USER_ID = process.env.SMS_USER_ID || '2110';
let SMS_API_KEY = process.env.SMS_API_KEY || '44b6b7fc-998c-4d14-8a8c-2bd52fe251f2';
let SMS_SENDER_ID = process.env.SMS_SENDER_ID || 'J FASHION';

function parseFirestoreDoc(doc) {
  if (!doc || !doc.fields) return {};
  const result = { _docId: doc.name.split('/').pop() };
  for (const [key, valObj] of Object.entries(doc.fields)) {
    if ('stringValue' in valObj) result[key] = valObj.stringValue;
    else if ('integerValue' in valObj) result[key] = parseInt(valObj.integerValue, 10);
    else if ('doubleValue' in valObj) result[key] = parseFloat(valObj.doubleValue);
    else if ('booleanValue' in valObj) result[key] = valObj.booleanValue;
    else if ('timestampValue' in valObj) result[key] = valObj.timestampValue;
    else if ('nullValue' in valObj) result[key] = null;
    else if ('arrayValue' in valObj) {
      result[key] = (valObj.arrayValue.values || []).map(v => {
        if ('stringValue' in v) return v.stringValue;
        if ('integerValue' in v) return parseInt(v.integerValue, 10);
        if ('mapValue' in v) return parseFirestoreDoc({ fields: v.mapValue.fields });
        return v;
      });
    } else if ('mapValue' in valObj) {
      result[key] = parseFirestoreDoc({ fields: valObj.mapValue.fields });
    }
  }
  return result;
}

function firestoreRequest({ method = 'GET', path, body }) {
  return new Promise((resolve, reject) => {
    const dataString = body ? JSON.stringify(body) : '';
    const options = {
      hostname: FIRESTORE_BASE_URL,
      port: 443,
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents${path}`,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dataString)
      }
    };

    const req = https.request(options, (res) => {
      let resBody = '';
      res.on('data', chunk => resBody += chunk);
      res.on('end', () => {
        try {
          resolve(resBody ? JSON.parse(resBody) : {});
        } catch (e) {
          resolve({ raw: resBody });
        }
      });
    });

    req.on('error', err => reject(err));
    if (dataString) req.write(dataString);
    req.end();
  });
}

async function fetchFirestoreCollection(colName) {
  try {
    const res = await firestoreRequest({ method: 'GET', path: `/${colName}` });
    if (!res || !res.documents) return [];
    return res.documents.map(parseFirestoreDoc);
  } catch (err) {
    console.error(`Error fetching Firestore collection [${colName}]:`, err.message);
    return [];
  }
}

async function updateFirestoreDocument(colName, docId, fields) {
  try {
    const firestoreFields = {};
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === 'string') firestoreFields[k] = { stringValue: v };
      else if (typeof v === 'number') firestoreFields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
      else if (typeof v === 'boolean') firestoreFields[k] = { booleanValue: v };
    }
    const updateMask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
    return await firestoreRequest({
      method: 'PATCH',
      path: `/${colName}/${docId}?${updateMask}`,
      body: { fields: firestoreFields }
    });
  } catch (err) {
    console.error(`Error updating Firestore doc [${colName}/${docId}]:`, err.message);
  }
}

async function logToFirestoreSmsLogs(logData) {
  try {
    const docId = logData.id || `SMS-${Date.now().toString().slice(-4)}`;
    const fields = {
      id: { stringValue: docId },
      recipientName: { stringValue: logData.recipientName || 'Valued Client' },
      recipientPhone: { stringValue: logData.recipientPhone || '' },
      recipientRole: { stringValue: logData.recipientRole || 'CUSTOMER' },
      type: { stringValue: logData.type || 'REMINDER' },
      title: { stringValue: logData.title || 'SMS Notification' },
      message: { stringValue: logData.message || '' },
      timestamp: { stringValue: new Date().toISOString() },
      status: { stringValue: 'DELIVERED' },
      source: { stringValue: 'GITHUB_ACTIONS_CRON' }
    };

    return await firestoreRequest({
      method: 'PATCH',
      path: `/sms_logs/${docId}`,
      body: { fields }
    });
  } catch (err) {
    console.error("Error logging to Firestore sms_logs:", err.message);
  }
}

function sendSMS({ phone, message }) {
  return new Promise((resolve, reject) => {
    let cleanPhone = String(phone).replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '94' + cleanPhone.slice(1);
    if (!cleanPhone.startsWith('94')) cleanPhone = '94' + cleanPhone;

    const payload = JSON.stringify({
      user_id: SMS_USER_ID,
      api_key: SMS_API_KEY,
      sender_id: SMS_SENDER_ID,
      to: cleanPhone,
      message: message
    });

    const options = {
      hostname: 'smslenz.lk',
      port: 443,
      path: '/api/v1/sms/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let resBody = '';
      res.on('data', chunk => resBody += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(resBody);
          resolve(parsed);
        } catch (e) {
          resolve({ raw: resBody });
        }
      });
    });

    req.on('error', err => reject(err));
    req.write(payload);
    req.end();
  });
}

async function runCloudReminderCron() {
  const jobSlot = process.env.JOB_SLOT || 'ALL_IN_ONE';

  // Current Sri Lanka Time (UTC + 5:30)
  const nowUtc = new Date();
  const slOffsetMs = (5 * 60 + 30) * 60 * 1000;
  const slTime = new Date(nowUtc.getTime() + slOffsetMs);

  const todayStr = slTime.toISOString().split('T')[0];
  const tomorrowDate = new Date(slTime.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = tomorrowDate.toISOString().split('T')[0];
  const slTimeFormatted = slTime.toISOString().replace('T', ' ').slice(0, 19);

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
    address: '130/10 Golden Plaza Market, Main Street, Colombo 11',
    phone: '0724229121 / 0750101589',
    ownerPhone: '0724229121, 0750101589, 0740491342',
    lateFeePerDay: 1500,
    autoSmsReminders: true,
    autoSmsToOwner: true,
    reportBaseUrl: ''
  };
  if (settingsDocs.length > 0) {
    const generalDoc = settingsDocs.find(s => s._docId === 'general') || settingsDocs[0];
    settings = Object.assign(settings, generalDoc);
  }

  // Helper: parse all owner numbers
  function getOwnerPhoneList(st) {
    const raw = (st && st.ownerPhone) ? st.ownerPhone : '0724229121, 0750101589, 0740491342';
    const numbers = String(raw)
      .split(/[,/|;\s]+/)
      .map(n => n.trim().replace(/[^0-9+]/g, ''))
      .filter(n => n.length >= 9);
    return numbers.length > 0 ? Array.from(new Set(numbers)) : ['0724229121', '0750101589', '0740491342'];
  }

  // Dynamic Live Report Base URL
  const activeReportBaseUrl = (settings.reportBaseUrl || process.env.REPORT_BASE_URL || 'https://dilankavinda1234567-dev.github.io/jewel-fashion-pos/report.html').trim();

  // Live dynamic credentials from Admin Panel Firestore settings
  if (settings.smsUserId) SMS_USER_ID = settings.smsUserId;
  if (settings.smsApiKey) SMS_API_KEY = settings.smsApiKey;
  if (settings.smsSenderId) SMS_SENDER_ID = settings.smsSenderId;

  if (!SMS_API_KEY || SMS_API_KEY === 'JF_LIVE_API_KEY_8899' || SMS_API_KEY.startsWith('YOUR_')) {
    SMS_API_KEY = '44b6b7fc-998c-4d14-8a8c-2bd52fe251f2';
    SMS_USER_ID = '2110';
    SMS_SENDER_ID = 'J FASHION';
  }

  if (settings.autoSmsReminders === false) {
    console.log("⏸️ Automated SMS Reminders is toggled OFF in Admin Settings. Exiting job cleanly.");
    return;
  }

  // 2. Fetch Active Rentals & Customers
  const [rentals, customers] = await Promise.all([
    fetchFirestoreCollection('rentals'),
    fetchFirestoreCollection('customers')
  ]);

  const customerMap = {};
  customers.forEach(c => {
    if (c.id) customerMap[c.id] = c;
    if (c.phone) customerMap[c.phone] = c;
  });

  const activeRentals = rentals.filter(r => r.status !== 'RETURNED' && r.status !== 'SETTLED');
  console.log(`📊 Found ${activeRentals.length} active rental records in vault.`);

  let customerSmsCount = 0;

  // =========================================================================
  // 1. JOB SLOT: 8:00 AM (Due Today Urgent Notice + Owner Today Report Link)
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

      const custMsg = `JEWEL FASHION URGENT NOTICE: Dear ${customer.name}, your jewellery rental (${rental.rentalNumber || rental.id}) is due for return TODAY (${rental.dueDate}). Items: ${itemNames}. Please visit our salon before 6:30 PM today for return inspection and deposit handback. Hotline: ${settings.phone}`;

      console.log(`   📱 Sending Today Due Notice to ${customer.name} (${customer.phone})...`);
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
    const ownerPhones8AM = getOwnerPhoneList(settings);
    if (settings.autoSmsToOwner && ownerPhones8AM.length > 0) {
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

      for (const phone of ownerPhones8AM) {
        console.log(`   👑 Dispatching Today's Executive Report Link to Store Owner (${phone})...`);
        await sendSMS({ phone, message: ownerMsg });

        await logToFirestoreSmsLogs({
          id: 'SMS-' + Date.now().toString().slice(-4),
          recipientName: 'Store Owner',
          recipientPhone: phone,
          recipientRole: 'OWNER',
          type: 'OWNER_REPORT_TODAY',
          title: `👑 Today's Return Report Link (${dueTodayRentals.length} Due Today)`,
          message: ownerMsg
        });
      }
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
    const ownerPhones1030AM = getOwnerPhoneList(settings);
    if (settings.autoSmsToOwner && ownerPhones1030AM.length > 0) {
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

      for (const phone of ownerPhones1030AM) {
        console.log(`   👑 Dispatching Overdue Executive Report Link to Store Owner (${phone})...`);
        await sendSMS({ phone, message: ownerMsg });

        await logToFirestoreSmsLogs({
          id: 'SMS-' + Date.now().toString().slice(-4),
          recipientName: 'Store Owner',
          recipientPhone: phone,
          recipientRole: 'OWNER',
          type: 'OWNER_REPORT_OVERDUE',
          title: `⚠️ Overdue Report Link (${overdueRentals.length} Overdue)`,
          message: ownerMsg
        });
      }
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
    const ownerPhones5PM = getOwnerPhoneList(settings);
    if (settings.autoSmsToOwner && ownerPhones5PM.length > 0) {
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

      for (const phone of ownerPhones5PM) {
        console.log(`   👑 Dispatching Tomorrow's Return Report Link to Store Owner (${phone})...`);
        await sendSMS({ phone, message: ownerMsg });

        await logToFirestoreSmsLogs({
          id: 'SMS-' + Date.now().toString().slice(-4),
          recipientName: 'Store Owner',
          recipientPhone: phone,
          recipientRole: 'OWNER',
          type: 'OWNER_REPORT_TOMORROW',
          title: `👑 Tomorrow's Return Report Link (${dueTomorrowRentals.length} Bookings)`,
          message: ownerMsg
        });
      }
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
