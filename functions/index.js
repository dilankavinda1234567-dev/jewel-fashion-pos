/**
 * Jewel Fashion POS - 24/7 Cloud Automated SMS Reminder & Daily Report Engine
 * Cloud Functions for Firebase (2nd Gen / Scheduled Functions)
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const https = require('https');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

// Helper: HTTP Request to SMSlenz.lk API
function sendSMSlenz({ userId, apiKey, senderId, phone, message }) {
  return new Promise((resolve, reject) => {
    let cleanPhone = String(phone).replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '94' + cleanPhone.slice(1);
    if (!cleanPhone.startsWith('94')) cleanPhone = '94' + cleanPhone;

    const payload = JSON.stringify({
      user_id: userId,
      api_key: apiKey,
      sender_id: senderId,
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

// Core SMS Dispatch Engine
async function executeAutomatedSmsJob(jobSlot = 'ALL_IN_ONE') {
  console.log('⏰ Executing 24/7 Cloud Automated SMS Reminder Job...');

  // 1. Get Store Settings
  let settings = {
    smsGateway: 'SMSLENZ',
    smsUserId: '2110',
    smsApiKey: '44b6b7fc-998c-4d14-8a8c-2bd52fe251f2',
    smsSenderId: 'J FASHION',
    phone: '0724229121 / 0750101589',
    address: '130/10 Golden Plaza Market, Main Street, Colombo 11',
    ownerPhone: '0724229121, 0750101589, 0740491342',
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
    console.warn('Could not fetch settings from Firestore, using defaults:', e);
  }

  if (settings.autoSmsReminders === false) {
    console.log('Automated SMS Reminders is toggled OFF in settings. Exiting.');
    return { success: true, count: 0, message: 'Disabled by admin' };
  }

  // Current Sri Lanka Time (UTC + 5:30)
  const nowUtc = new Date();
  const slOffsetMs = (5 * 60 + 30) * 60 * 1000;
  const slTime = new Date(nowUtc.getTime() + slOffsetMs);

  const todayStr = slTime.toISOString().split('T')[0];
  const tomorrowDate = new Date(slTime.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = tomorrowDate.toISOString().split('T')[0];

  // 2. Query Active Rentals & Customers
  const [rentalsSnap, customersSnap] = await Promise.all([
    db.collection('rentals').where('status', 'in', ['ACTIVE', 'RENTED', 'PICKED_UP', 'OVERDUE', 'DUE_TODAY', 'DUE_TOMORROW']).get(),
    db.collection('customers').get()
  ]);

  const customerMap = {};
  customersSnap.forEach(doc => {
    const data = doc.data();
    if (data.id) customerMap[data.id] = data;
    if (data.phone) customerMap[data.phone] = data;
  });

  const dueTodayRentals = [];
  const overdueRentals = [];
  const dueTomorrowRentals = [];

  rentalsSnap.forEach(doc => {
    const r = doc.data();
    r._docId = doc.id;
    if (r.dueDate === todayStr) dueTodayRentals.push(r);
    else if (r.dueDate < todayStr) overdueRentals.push(r);
    else if (r.dueDate === tomorrowStr) dueTomorrowRentals.push(r);
  });

  let sentCount = 0;
  const logs = [];

  // 3a. TODAY (8:00 AM Slot)
  if (jobSlot === 'TODAY_8AM' || jobSlot === 'ALL_IN_ONE') {
    for (const rental of dueTodayRentals) {
      if (rental.lastAutoReminderDate === todayStr && rental.lastAutoReminderType === 'DUE_TODAY') continue;

      const customer = customerMap[rental.customerId] || { name: rental.customerName || 'Valued Client', phone: rental.customerPhone || '' };
      if (!customer.phone) continue;

      const itemNames = (rental.items && rental.items.length > 0)
        ? rental.items.map(i => `${i.name} (Qty: ${i.quantity || 1})`).join(', ')
        : (rental.productName || 'Bridal Jewellery Set');

      const msg = `JEWEL FASHION URGENT NOTICE: Dear ${customer.name}, your jewellery rental (${rental.rentalNumber || rental.id}) is due for return TODAY (${rental.dueDate}). Items: ${itemNames}. Please visit our salon before 6:30 PM today for return inspection and deposit handback. Hotline: ${settings.phone}`;

      try {
        const res = await sendSMSlenz({
          userId: settings.smsUserId,
          apiKey: settings.smsApiKey,
          senderId: settings.smsSenderId,
          phone: customer.phone,
          message: msg
        });

        await db.collection('rentals').doc(rental._docId).update({
          lastAutoReminderDate: todayStr,
          lastAutoReminderType: 'DUE_TODAY'
        });

        await db.collection('sms_logs').add({
          id: 'SMS-' + Date.now().toString().slice(-4),
          recipientName: customer.name,
          recipientPhone: customer.phone,
          recipientRole: 'CUSTOMER',
          type: 'DUE_TODAY',
          title: 'Return Due Today (8:00 AM)',
          message: msg,
          timestamp: new Date().toISOString(),
          status: 'DELIVERED',
          source: 'FIREBASE_CLOUD_FUNCTION'
        });

        sentCount++;
        logs.push({ customer: customer.name, phone: customer.phone, type: 'DUE_TODAY', response: res });
      } catch (smsErr) {
        console.error(`Failed to send SMS to ${customer.phone}:`, smsErr);
      }
    }
  }

  // 3b. OVERDUE (10:30 AM Slot)
  if (jobSlot === 'OVERDUE_1030AM' || jobSlot === 'ALL_IN_ONE') {
    for (const rental of overdueRentals) {
      if (rental.lastAutoReminderDate === todayStr && rental.lastAutoReminderType === 'OVERDUE') continue;

      const customer = customerMap[rental.customerId] || { name: rental.customerName || 'Valued Client', phone: rental.customerPhone || '' };
      if (!customer.phone) continue;

      const due = new Date(rental.dueDate);
      const current = new Date(todayStr);
      const overdueDays = Math.max(1, Math.floor((current - due) / (1000 * 60 * 60 * 24)));
      const lateFee = overdueDays * (settings.lateFeePerDay || 1500);

      const msg = `JEWEL FASHION CRITICAL OVERDUE ALERT: Dear ${customer.name}, rental booking ${rental.rentalNumber || rental.id} was due on ${rental.dueDate} and is now ${overdueDays} DAY(S) OVERDUE. Accumulated late fee penalty: Rs. ${lateFee.toLocaleString()} (Rs. ${(settings.lateFeePerDay || 1500).toLocaleString()}/day). Please return all jewellery items immediately to avoid deposit forfeiture. Hotline: ${settings.phone}`;

      try {
        const res = await sendSMSlenz({
          userId: settings.smsUserId,
          apiKey: settings.smsApiKey,
          senderId: settings.smsSenderId,
          phone: customer.phone,
          message: msg
        });

        await db.collection('rentals').doc(rental._docId).update({
          lastAutoReminderDate: todayStr,
          lastAutoReminderType: 'OVERDUE'
        });

        await db.collection('sms_logs').add({
          id: 'SMS-' + Date.now().toString().slice(-4),
          recipientName: customer.name,
          recipientPhone: customer.phone,
          recipientRole: 'CUSTOMER',
          type: 'OVERDUE_ALERT',
          title: `Overdue Warning (${overdueDays}d Late)`,
          message: msg,
          timestamp: new Date().toISOString(),
          status: 'DELIVERED',
          source: 'FIREBASE_CLOUD_FUNCTION'
        });

        sentCount++;
        logs.push({ customer: customer.name, phone: customer.phone, type: 'OVERDUE_ALERT', response: res });
      } catch (smsErr) {
        console.error(`Failed to send SMS to ${customer.phone}:`, smsErr);
      }
    }
  }

  // 3c. TOMORROW (05:00 PM Slot)
  if (jobSlot === 'TOMORROW_5PM' || jobSlot === 'ALL_IN_ONE') {
    for (const rental of dueTomorrowRentals) {
      if (rental.lastAutoReminderDate === todayStr && rental.lastAutoReminderType === 'DUE_TOMORROW') continue;

      const customer = customerMap[rental.customerId] || { name: rental.customerName || 'Valued Client', phone: rental.customerPhone || '' };
      if (!customer.phone) continue;

      const itemNames = (rental.items && rental.items.length > 0)
        ? rental.items.map(i => `${i.name} (Qty: ${i.quantity || 1})`).join(', ')
        : (rental.productName || 'Bridal Jewellery Set');

      const msg = `JEWEL FASHION (1-DAY REMINDER): Dear ${customer.name}, your jewellery rental (${rental.rentalNumber || rental.id}) is scheduled for return TOMORROW (${rental.dueDate}). Items: ${itemNames}. Please return in original protective case before 6:30 PM to collect your deposit. Hotline: ${settings.phone}`;

      try {
        const res = await sendSMSlenz({
          userId: settings.smsUserId,
          apiKey: settings.smsApiKey,
          senderId: settings.smsSenderId,
          phone: customer.phone,
          message: msg
        });

        await db.collection('rentals').doc(rental._docId).update({
          lastAutoReminderDate: todayStr,
          lastAutoReminderType: 'DUE_TOMORROW'
        });

        await db.collection('sms_logs').add({
          id: 'SMS-' + Date.now().toString().slice(-4),
          recipientName: customer.name,
          recipientPhone: customer.phone,
          recipientRole: 'CUSTOMER',
          type: 'DUE_TOMORROW',
          title: 'Rental Due Tomorrow (5:00 PM)',
          message: msg,
          timestamp: new Date().toISOString(),
          status: 'DELIVERED',
          source: 'FIREBASE_CLOUD_FUNCTION'
        });

        sentCount++;
        logs.push({ customer: customer.name, phone: customer.phone, type: 'DUE_TOMORROW', response: res });
      } catch (smsErr) {
        console.error(`Failed to send SMS to ${customer.phone}:`, smsErr);
      }
    }
  }

  // 4. Dispatch Reports to Store Owner (Dispatched to all owner numbers)
  function getOwnerPhoneList(st) {
    const raw = (st && st.ownerPhone) ? st.ownerPhone : '0724229121, 0750101589, 0740491342';
    const numbers = String(raw)
      .split(/[,/|;\s]+/)
      .map(n => n.trim().replace(/[^0-9+]/g, ''))
      .filter(n => n.length >= 9);
    return numbers.length > 0 ? Array.from(new Set(numbers)) : ['0724229121', '0750101589', '0740491342'];
  }

  const ownerPhones = getOwnerPhoneList(settings);
  if (settings.autoSmsToOwner !== false && ownerPhones.length > 0) {
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
          : `👑 JEWEL FASHION OWNER REPORT (08:00 AM): 0 rentals due today (${todayStr}). Active: ${rentalsSnap.size}, Overdue: ${overdueRentals.length}. All clear. View live overview: ${reportLink}`;

        for (const phone of ownerPhones) {
          const ownerRes = await sendSMSlenz({
            userId: settings.smsUserId,
            apiKey: settings.smsApiKey,
            senderId: settings.smsSenderId,
            phone: phone,
            message: ownerMsg
          });

          await db.collection('sms_logs').add({
            id: 'SMS-' + Date.now().toString().slice(-4),
            recipientName: 'Store Owner',
            recipientPhone: phone,
            recipientRole: 'OWNER',
            type: 'OWNER_REPORT_TODAY',
            title: `👑 Today's Return Report Link (${dueTodayRentals.length} Due Today)`,
            message: ownerMsg,
            timestamp: new Date().toISOString(),
            status: 'DELIVERED',
            source: 'FIREBASE_CLOUD_FUNCTION'
          });

          sentCount++;
          logs.push({ customer: 'Store Owner', phone: phone, type: 'OWNER_REPORT_TODAY', response: ownerRes });
        }
      } catch (ownerErr) {
        console.error(`Failed to send today report SMS to owner:`, ownerErr);
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

        for (const phone of ownerPhones) {
          const ownerRes = await sendSMSlenz({
            userId: settings.smsUserId,
            apiKey: settings.smsApiKey,
            senderId: settings.smsSenderId,
            phone: phone,
            message: ownerMsg
          });

          await db.collection('sms_logs').add({
            id: 'SMS-' + Date.now().toString().slice(-4),
            recipientName: 'Store Owner',
            recipientPhone: phone,
            recipientRole: 'OWNER',
            type: 'OWNER_REPORT_OVERDUE',
            title: `⚠️ Overdue Report Link (${overdueRentals.length} Overdue)`,
            message: ownerMsg,
            timestamp: new Date().toISOString(),
            status: 'DELIVERED',
            source: 'FIREBASE_CLOUD_FUNCTION'
          });

          sentCount++;
          logs.push({ customer: 'Store Owner', phone: phone, type: 'OWNER_REPORT_OVERDUE', response: ownerRes });
        }
      } catch (ownerErr) {
        console.error(`Failed to send overdue report SMS to owner:`, ownerErr);
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
          : `👑 JEWEL FASHION OWNER REPORT (05:00 PM): 0 rental returns scheduled for tomorrow (${tomorrowStr}). Active bookings: ${rentalsSnap.size}. View live list: ${reportLink}`;

        for (const phone of ownerPhones) {
          const ownerRes = await sendSMSlenz({
            userId: settings.smsUserId,
            apiKey: settings.smsApiKey,
            senderId: settings.smsSenderId,
            phone: phone,
            message: ownerMsg
          });

          await db.collection('sms_logs').add({
            id: 'SMS-' + Date.now().toString().slice(-4),
            recipientName: 'Store Owner',
            recipientPhone: phone,
            recipientRole: 'OWNER',
            type: 'OWNER_REPORT_TOMORROW',
            title: `👑 Tomorrow's Return Report Link (${dueTomorrowRentals.length} Bookings)`,
            message: ownerMsg,
            timestamp: new Date().toISOString(),
            status: 'DELIVERED',
            source: 'FIREBASE_CLOUD_FUNCTION'
          });

          sentCount++;
          logs.push({ customer: 'Store Owner', phone: phone, type: 'OWNER_REPORT_TOMORROW', response: ownerRes });
        }
      } catch (ownerErr) {
        console.error(`Failed to send tomorrow report SMS to owner:`, ownerErr);
      }
    }
  }

  console.log(`✅ 24/7 Cloud Reminder Job [${jobSlot}] completed. Total SMS sent: ${sentCount}`);
  return { success: true, count: sentCount, logs };
}

// Export 2nd Gen Cloud Scheduled Functions (UTC time triggers)
exports.dailySmsMorning = onSchedule({ schedule: '30 2 * * *', timeZone: 'Asia/Colombo' }, async () => {
  return await executeAutomatedSmsJob('TODAY_8AM');
});

exports.dailySmsOverdue = onSchedule({ schedule: '0 5 * * *', timeZone: 'Asia/Colombo' }, async () => {
  return await executeAutomatedSmsJob('OVERDUE_1030AM');
});

exports.dailySmsTomorrow = onSchedule({ schedule: '30 11 * * *', timeZone: 'Asia/Colombo' }, async () => {
  return await executeAutomatedSmsJob('TOMORROW_5PM');
});
