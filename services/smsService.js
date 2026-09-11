// services/smsService.js
//
// This sends the confirmation texts from the "customer journey" — e.g.
// "You earned 40 points today. Balance: 940 points."
//
// It has NO real SMS credentials wired in, because those are yours to
// create (an Africa's Talking or Safaricom Bulk SMS account). Until you
// add them, every message just prints to this server's terminal instead
// of actually sending — so you can build and test the whole system today
// without needing a live SMS account yet.
//
// TO GO LIVE: sign up at https://africastalking.com (or Safaricom Bulk
// SMS), get an API key, then fill in the `sendViaAfricasTalking` function
// below and switch SMS_PROVIDER in your .env file to "africastalking".

require('dotenv').config();

const PROVIDER = process.env.SMS_PROVIDER || 'console';

async function sendSms(phone, message) {
  if (!phone) {
    console.log('[sms] no phone number on file — skipped:', message);
    return { sent: false, reason: 'no_phone' };
  }

  if (PROVIDER === 'console') {
    console.log(`[sms:MOCK] -> ${phone}: ${message}`);
    return { sent: true, mode: 'console' };
  }

  if (PROVIDER === 'africastalking') {
    return sendViaAfricasTalking(phone, message);
  }

  throw new Error(`Unknown SMS_PROVIDER: ${PROVIDER}`);
}

async function sendViaAfricasTalking(phone, message) {
  // -------------------------------------------------------------
  // TODO (when you're ready to go live):
  //   1. npm install africastalking
  //   2. Add AT_API_KEY and AT_USERNAME to your .env file
  //   3. Uncomment the block below
  // -------------------------------------------------------------
  //
  // const AfricasTalking = require('africastalking')({
  //   apiKey: process.env.AT_API_KEY,
  //   username: process.env.AT_USERNAME,
  // });
  // const result = await AfricasTalking.SMS.send({ to: [phone], message });
  // return { sent: true, mode: 'africastalking', result };

  console.log('[sms] africastalking provider selected but not yet configured — see TODO in smsService.js');
  return { sent: false, reason: 'not_configured' };
}

module.exports = { sendSms };
