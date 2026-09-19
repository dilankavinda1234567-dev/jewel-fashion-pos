/**
 * Jewel Fashion POS - 24/7 Cloud Automated SMS Dispatcher
 * (Runs on Google Cloud / Firebase Cloud Functions even when PC is completely OFF)
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const https = require('https');

admin.initializeApp();
const db = admin.firestore();

// Helper: Dispatch SMS via SMSlenz.lk
function sendSMSlenz({ userId, apiKey, senderId, phone, message }) {
  return new Promise((resolve, reject) => {
    let cleanPhone = (phone || '').trim().replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('07')) {
      cleanPhone = '94' + cleanPhone.substring(1);
    } else if (cleanPhone.startsWith('7') && cleanPhone.length === 9) {
      cleanPhone = '94' + cleanPhone;
    } else if (cleanPhone.length === 10 && cleanPhone.startsWith('0')) {
      cleanPhone = '94' + cleanPhone.substring(1);
    }

    const url = `https://smslenz.lk/api/send-sms?user_id=${encodeURIComponent(userId)}&api_key=${encodeURIComponent(apiKey)}&sender_id=${encodeURIComponent(senderId)}&contact=${encodeURIComponent(cleanPhone)}&message=${encodeURIComponent(message)}`;

    https.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ raw: body });
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// Core Engine: Evaluates rentals and sends reminders
async function executeReminderScan(targetSlot = 'AUTO') {
  console.log('⏰ Executing 24/7 Cloud Automated SMS Reminder Job...');

  // 1. Get Store Settings
  let settings = {
    smsGateway: 'SMSLENZ',
    smsUserId: '2110',
    smsApiKey: '44b6b7fc-998c-4d14-8a8c-2bd52fe251f2',
    smsSenderId: 'J FASHION',
    phone: '+94 11 234 5678 / +94 77 123 4567',
    ownerPhone: '0740491342',
    lateFeePerDay: 1500,
    autoSmsReminders: true,
    autoSmsToOwner: true
  };

  try {
    const settingsDoc = await db.collection('settings').doc('general').get();
    if (settingsDoc.exists) {
      settings = Object.assign(settings, settingsDoc.data());
    }
  } catch (e) {
    console.warn('Could not load settings doc, using default config', e.message);
  }

  // Sanitize invalid or placeholder credentials
  if (!settings.smsApiKey || settings.smsApiKey === 'JF_LIVE_API_KEY_8899' || settings.smsApiKey.startsWith('YOUR_')) {
    settings.smsApiKey = '44b6b7fc-998c-4d14-8a8c-2bd52fe251f2';
  }
  if (!settings.smsUserId || settings.smsUserId === 'USER_ID') {
    settings.smsUserId = '2110';
  }
  if (!settings.smsSenderId || settings.smsSenderId === 'SMSlenzDEMO' || settings.smsSenderId === 'JEWEL-FASH' || settings.smsSenderId === 'ACCEPT WEB') {
    settings.smsSenderId = 'J FASHION';
  }

  if (settings.autoSmsReminders === false) {
    console.log('ℹ️ Auto SMS Reminders disabled in store settings.');
    return { success: true, count: 0, message: 'Disabled in settings' };
  }

  // 2. Fetch Customers
  const customersSnap = await db.collection('customers').get();
  const customers = {};
  customersSnap.forEach(doc => {
    customers[doc.id] = doc.data();
  });

  // 3. Fetch Rentals
  const rentalsSnap = await db.collection('rentals').get();
  if (rentalsSnap.empty) {
    console.log('ℹ️ No rentals found in database.');
  }

  // Calculate Today and Tomorrow in Sri Lanka Time (UTC+5:30)
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const slNow = new Date(utc + (5.5 * 3600000));
  const todayStr = slNow.toISOString().split('T')[0];
  const slTomorrow = new Date(slNow.getTime() + (24 * 3600000));
  const tomorrowStr = slTomorrow.toISOString().split('T')[0];
  const slHour = slNow.getHours();

  let jobSlot = targetSlot || 'AUTO';
  if (jobSlot === 'AUTO') {
    // Strict Night / Quiet Hours Protection (8:00 PM - 7:00 AM Sri Lanka Time)
    if (slHour < 7 || slHour >= 20) {
      console.log(`🌙 [Quiet Hours Active] Sri Lanka Time: ${slNow.toISOString()}. Night protection active. Automated SMS disabled between 8 PM and 7 AM.`);
      return { success: true, count: 0, message: 'Quiet hours active' };
    }

    if (slHour >= 7 && slHour < 10) {
      jobSlot = 'TODAY_8AM';
    } else if (slHour >= 10 && slHour < 14) {
      jobSlot = 'OVERDUE_1030AM';
    } else if (slHour >= 14 && slHour < 20) {
      jobSlot = 'TOMORROW_5PM';
    } else {
      console.log(`ℹ️ [Outside Scheduled Slot] Sri Lanka Hour: ${slHour}. Exiting cleanly.`);
      return { success: true, count: 0, message: 'No active slot' };
    }
  }

  console.log(`📅 Sri Lanka Time: ${slNow.toISOString()} | Date: ${todayStr} | Slot: [${jobSlot}]`);

  let sentCount = 0;
  const logs = [];
  const dueTodayRentals = [];
  const overdueRentals = [];
  const dueTomorrowRentals = [];
  let totalActiveRentals = 0;

  for (const doc of rentalsSnap.docs) {
    const rental = doc.data();
    if (rental.status === 'RETURNED') continue;
    totalActiveRentals++;

    if (rental.dueDate === todayStr) dueTodayRentals.push(rental);
    else if (rental.dueDate < todayStr) overdueRentals.push(rental);
    else if (rental.dueDate === tomorrowStr) dueTomorrowRentals.push(rental);

    const customer = customers[rental.customerId] || {
      name: rental.customerName || 'Valued Client',
      phone: rental.customerPhone || ''
    };

    if (!customer.phone) continue;

    let reminderType = null;
    let message = null;
    const itemNames = (rental.items && Array.isArray(rental.items) && rental.items.length > 0)
      ? rental.items.map(i => `${i.name} (Qty: ${i.quantity || 1})`).join(', ')
      : (rental.productName || 'Bridal Jewellery Set');

    // 1. Due Today (8:00 AM Slot)
    if ((jobSlot === 'TODAY_8AM' || jobSlot === 'ALL_IN_ONE') && rental.dueDate === todayStr) {
      if (rental.lastAutoReminderDate !== todayStr || rental.lastAutoReminderType !== 'DUE_TODAY') {
        reminderType = 'DUE_TODAY';
        message = `JEWEL FASHION URGENT NOTICE: Dear ${customer.name}, your jewellery rental (${rental.rentalNumber || rental.id}) is due for return TODAY (${rental.dueDate}). Items: ${itemNames}. Please visit our boutique before 6:30 PM today for return inspection & deposit refund. Hotline: ${settings.phone}`;
      }
    }
    // 2. Critical Overdue Notice (10:30 AM Slot)
    else if ((jobSlot === 'OVERDUE_1030AM' || jobSlot === 'ALL_IN_ONE') && rental.dueDate < todayStr) {
      if (rental.lastAutoReminderDate !== todayStr || rental.lastAutoReminderType !== 'OVERDUE') {
        const due = new Date(rental.dueDate);
        const current = new Date(todayStr);
        const overdueDays = Math.max(1, Math.floor((current - due) / (1000 * 60 * 60 * 24)));
        const lateFee = overdueDays * (settings.lateFeePerDay || 1500);

        reminderType = 'OVERDUE';
        message = `JEWEL FASHION CRITICAL OVERDUE ALERT: Dear ${customer.name}, rental booking ${rental.rentalNumber || rental.id} was due on ${rental.dueDate} and is now ${overdueDays} DAY(S) OVERDUE. Accumulated late fee penalty: Rs. ${lateFee.toLocaleString()} (Rs. ${(settings.lateFeePerDay || 1500).toLocaleString()}/day). Please return all jewellery items immediately to avoid deposit forfeiture. Hotline: ${settings.phone}`;
      }
    }
    // 3. Due Tomorrow 1-Day Advance (5:00 PM Slot)
    else if ((jobSlot === 'TOMORROW_5PM' || jobSlot === 'ALL_IN_ONE') && rental.dueDate === tomorrowStr) {
      if (rental.lastAutoReminderDate !== todayStr || rental.lastAutoReminderType !== 'DUE_TOMORROW') {
        reminderType = 'DUE_TOMORROW';
        message = `JEWEL FASHION (1-DAY REMINDER): Dear ${customer.name}, your jewellery rental (${rental.rentalNumber || rental.id}) is scheduled for return TOMORROW (${rental.dueDate}). Items: ${itemNames}. Please return in original protective case before 6:30 PM to collect your deposit. Hotline: ${settings.phone}`;
      }
    }

    if (message && reminderType) {
      try {
        console.log(`📱 Sending Cloud SMS to ${customer.name} (${customer.phone})...`);
        const smsRes = await sendSMSlenz({
          userId: settings.smsUserId,
          apiKey: settings.smsApiKey,
          senderId: settings.smsSenderId,
          phone: customer.phone,
          message: message
        });

        // Update rental document in Firestore
        await db.collection('rentals').doc(doc.id).update({
          lastAutoReminderDate: todayStr,
          lastAutoReminderType: reminderType
        });

        // Add to sms_logs collection
        await db.collection('sms_logs').add({
          id: 'SMS-' + Date.now().toString().slice(-4),
          recipientName: customer.name,
          recipientPhone: customer.phone,
          recipientRole: 'CUSTOMER',
          type: reminderType,
          title: `24/7 Cloud Auto-Pilot (${reminderType})`,
          message: message,
          timestamp: new Date().toISOString(),
          status: 'DELIVERED',
          source: 'FIREBASE_CLOUD_FUNCTION'
        });

        sentCount++;
        logs.push({ customer: customer.name, phone: customer.phone, type: reminderType, response: smsRes });
      } catch (smsErr) {
        console.error(`Failed to send SMS to ${customer.phone}:`, smsErr);
      }
    }
  }

  // 4. Dispatch Reports to Store Owner
  const ownerPhone = settings.ownerPhone || '0740491342';
  if (settings.autoSmsToOwner !== false && ownerPhone) {
    const reportBaseUrl = (settings.reportBaseUrl || 'https://dilankavinda1234567-dev.github.io/jewel-fashion-pos/report.html').trim();

    // 4a. Today's Due Report (08:00 AM Slot)
    if (jobSlot === 'TODAY_8AM' || jobSlot === 'ALL_IN_ONE') {
      try {
        const reportLink = `${reportBaseUrl}?type=today`;
        let totalItemsToday = 0;
        dueTodayRentals.forEach(r => {
          if (r.items && Array.isArray(r.items)) r.items.forEach(i => totalItemsToday += (parseInt(i.quantity) || 1));
          else totalItemsToday += 1;
        });

        const ownerMsg = dueTodayRentals.length > 0
          ? `👑 JEWEL FASHION OWNER REPORT (08:00 AM): ${dueTodayRentals.length} rental booking(s) (${totalItemsToday} items) due for return TODAY (${todayStr}). Pending Overdue: ${overdueRentals.length}. View live list: ${reportLink}`
          : `👑 JEWEL FASHION OWNER REPORT (08:00 AM): 0 rentals due today (${todayStr}). Active: ${totalActiveRentals}, Overdue: ${overdueRentals.length}. All clear. View live overview: ${reportLink}`;

        const ownerRes = await sendSMSlenz({
          userId: settings.smsUserId,
          apiKey: settings.smsApiKey,
          senderId: settings.smsSenderId,
          phone: ownerPhone,
          message: ownerMsg
        });

        await db.collection('sms_logs').add({
          id: 'SMS-' + Date.now().toString().slice(-4),
          recipientName: 'Store Owner',
          recipientPhone: ownerPhone,
          recipientRole: 'OWNER',
          type: 'OWNER_REPORT_TODAY',
          title: `👑 Today's Return Report Link (${dueTodayRentals.length} Due Today)`,
          message: ownerMsg,
          timestamp: new Date().toISOString(),
          status: 'DELIVERED',
          source: 'FIREBASE_CLOUD_FUNCTION'
        });

        sentCount++;
        logs.push({ customer: 'Store Owner', phone: ownerPhone, type: 'OWNER_REPORT_TODAY', response: ownerRes });
      } catch (ownerErr) {
        console.error(`Failed to send today report SMS to owner (${ownerPhone}):`, ownerErr);
      }
    }

    // 4b. Overdue Report (10:30 AM Slot)
    if (jobSlot === 'OVERDUE_1030AM' || jobSlot === 'ALL_IN_ONE') {
      try {
        const reportLink = `${reportBaseUrl}?type=overdue`;
        let totalOverdueItems = 0;
        overdueRentals.forEach(r => {
          if (r.items && Array.isArray(r.items)) r.items.forEach(i => totalOverdueItems += (parseInt(i.quantity) || 1));
          else totalOverdueItems += 1;
        });

        const ownerMsg = overdueRentals.length > 0
          ? `👑 JEWEL FASHION OWNER ALERT (10:30 AM): ${overdueRentals.length} OVERDUE rental booking(s) (${totalOverdueItems} items) pending return. Tap to view full customer list & late fees: ${reportLink}`
          : `👑 JEWEL FASHION OWNER REPORT (10:30 AM): 0 OVERDUE rentals pending (${todayStr}). All active rentals are in good standing. View live list: ${reportLink}`;

        const ownerRes = await sendSMSlenz({
          userId: settings.smsUserId,
          apiKey: settings.smsApiKey,
          senderId: settings.smsSenderId,
          phone: ownerPhone,
          message: ownerMsg
        });

        await db.collection('sms_logs').add({
          id: 'SMS-' + Date.now().toString().slice(-4),
          recipientName: 'Store Owner',
          recipientPhone: ownerPhone,
          recipientRole: 'OWNER',
          type: 'OWNER_REPORT_OVERDUE',
          title: `⚠️ Overdue Report Link (${overdueRentals.length} Overdue)`,
          message: ownerMsg,
          timestamp: new Date().toISOString(),
          status: 'DELIVERED',
          source: 'FIREBASE_CLOUD_FUNCTION'
        });

        sentCount++;
        logs.push({ customer: 'Store Owner', phone: ownerPhone, type: 'OWNER_REPORT_OVERDUE', response: ownerRes });
      } catch (ownerErr) {
        console.error(`Failed to send overdue report SMS to owner (${ownerPhone}):`, ownerErr);
      }
    }

    // 4c. Tomorrow's Due Report (05:00 PM Slot)
    if (jobSlot === 'TOMORROW_5PM' || jobSlot === 'ALL_IN_ONE') {
      try {
        const reportLink = `${reportBaseUrl}?type=tomorrow`;
        let totalItemsTomorrow = 0;
        dueTomorrowRentals.forEach(r => {
          if (r.items && Array.isArray(r.items)) r.items.forEach(i => totalItemsTomorrow += (parseInt(i.quantity) || 1));
          else totalItemsTomorrow += 1;
        });

        const ownerMsg = dueTomorrowRentals.length > 0
          ? `👑 JEWEL FASHION OWNER REPORT (05:00 PM): ${dueTomorrowRentals.length} rental booking(s) (${totalItemsTomorrow} items) scheduled for return TOMORROW (${tomorrowStr}). Tap to view expected items: ${reportLink}`
          : `👑 JEWEL FASHION OWNER REPORT (05:00 PM): 0 rental returns scheduled for tomorrow (${tomorrowStr}). Active bookings: ${totalActiveRentals}. View live list: ${reportLink}`;

        const ownerRes = await sendSMSlenz({
          userId: settings.smsUserId,
          apiKey: settings.smsApiKey,
          senderId: settings.smsSenderId,
          phone: ownerPhone,
          message: ownerMsg
        });

        await db.collection('sms_logs').add({
          id: 'SMS-' + Date.now().toString().slice(-4),
          recipientName: 'Store Owner',
          recipientPhone: ownerPhone,
          recipientRole: 'OWNER',
          type: 'OWNER_REPORT_TOMORROW',
          title: `👑 Tomorrow's Return Report Link (${dueTomorrowRentals.length} Bookings)`,
          message: ownerMsg,
          timestamp: new Date().toISOString(),
          status: 'DELIVERED',
          source: 'FIREBASE_CLOUD_FUNCTION'
        });

        sentCount++;
        logs.push({ customer: 'Store Owner', phone: ownerPhone, type: 'OWNER_REPORT_TOMORROW', response: ownerRes });
      } catch (ownerErr) {
        console.error(`Failed to send tomorrow report SMS to owner (${ownerPhone}):`, ownerErr);
      }
    }
  }

  console.log(`✅ 24/7 Cloud Reminder Job [${jobSlot}] completed. Total SMS sent: ${sentCount}`);
  return { success: true, count: sentCount, logs };
}

// 1. Scheduled Cloud Functions for Sri Lanka Time (08:00 AM, 10:30 AM, 05:00 PM)
exports.dailyScheduledSms8AM = functions.pubsub
  .schedule('0 8 * * *') // 08:00 AM Sri Lanka Time
  .timeZone('Asia/Colombo')
  .onRun(async (context) => {
    return await executeReminderScan('TODAY_8AM');
  });

exports.dailyScheduledSms1030AM = functions.pubsub
  .schedule('30 10 * * *') // 10:30 AM Sri Lanka Time
  .timeZone('Asia/Colombo')
  .onRun(async (context) => {
    return await executeReminderScan('OVERDUE_1030AM');
  });

exports.dailyScheduledSms5PM = functions.pubsub
  .schedule('0 17 * * *') // 05:00 PM Sri Lanka Time (17:00)
  .timeZone('Asia/Colombo')
  .onRun(async (context) => {
    return await executeReminderScan('TOMORROW_5PM');
  });

// 2. HTTPS Callable Endpoint (For instant manual testing from browser or curl)
exports.triggerDailySmsReminder = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  const slot = req.query.slot || 'AUTO';
  const result = await executeReminderScan(slot);
  res.status(200).json(result);
});
