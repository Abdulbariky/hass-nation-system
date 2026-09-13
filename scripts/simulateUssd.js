// scripts/simulateUssd.js
//
// Simulates a phone dialling the USSD shortcode and pressing keys, against
// this project's own /api/ussd endpoint — so the menu (services/ussdService.js)
// can be exercised locally with no real shortcode. See README "USSD
// balance check": an actual shortcode has to be LEASED FROM SAFARICOM and
// typically takes weeks to provision — this script is the substitute
// until then.
//
// Usage (the server must already be running — `npm start` in another
// terminal):
//   node scripts/simulateUssd.js [phoneNumber]
//
// Mirrors exactly what a real USSD gateway (Africa's Talking, or a
// Safaricom-leased shortcode fronted by an aggregator using the same
// convention) sends on every key-press: phoneNumber, sessionId, and text
// (the FULL input typed so far this session, star-separated) — and
// expects back either "CON ..." (show this, keep prompting) or
// "END ..." (final screen, session over).

const readline = require('readline');

const BASE_URL = process.env.USSD_URL || 'http://localhost:3000/api/ussd';
const phoneNumber = process.argv[2] || '0712345678';
const sessionId = `sim-${Date.now()}`;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(question) {
  // rl.closed guards against input ending (e.g. piped stdin, or Ctrl+D)
  // between screens — without it, readline throws ERR_USE_AFTER_CLOSE
  // instead of just ending the session like a dropped call would.
  if (rl.closed) return Promise.resolve(null);
  return new Promise(resolve => rl.question(question, resolve));
}

async function sendUssd(text) {
  const params = new URLSearchParams({ sessionId, phoneNumber, serviceCode: '*384*1#', text });
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  return res.text();
}

async function main() {
  console.log(`Simulating a USSD session as ${phoneNumber} against ${BASE_URL}`);
  console.log('(this phone number must match an existing account\'s phone to see real data)\n');

  let text = '';
  for (;;) {
    let response;
    try {
      response = await sendUssd(text);
    } catch (err) {
      console.error(`\nCould not reach ${BASE_URL} — is "npm start" running in another terminal?`);
      process.exit(1);
    }

    const isFinal = response.startsWith('END');
    console.log('\n--- phone screen ---');
    console.log(response.replace(/^(CON|END) /, ''));
    console.log('--------------------');

    if (isFinal) {
      console.log('\n(session ended)');
      break;
    }

    const input = await ask('\nEnter your choice: ');
    if (input === null) {
      console.log('\n(input ended — session dropped)');
      break;
    }
    text = text ? `${text}*${input.trim()}` : input.trim();
  }
  rl.close();
}

main();
