// scripts/createAdmin.js
// Creates the first admin login, interactively, so a password never ends
// up in shell history or a committed file. Run once after setup:
//
//   npm run create-admin

const readline = require('readline');
const bcrypt = require('bcrypt');
const db = require('../db');

function ask(rl, question, { hidden } = {}) {
  return new Promise(resolve => {
    if (!hidden || !process.stdin.isTTY) {
      rl.question(question, answer => resolve(answer.trim()));
      return;
    }
    // Minimal masked input, so the password doesn't echo to the terminal.
    process.stdout.write(question);
    let input = '';
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = char => {
      const code = char.charCodeAt(0);
      if (char === '\n' || char === '\r' || code === 4) { // Enter or Ctrl+D
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input.trim());
        return;
      }
      if (code === 3) process.exit(1); // Ctrl+C
      if (code === 127 || code === 8) { input = input.slice(0, -1); return; } // backspace
      input += char;
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Create the first HASS NATION admin login.\n');

  const name = await ask(rl, 'Name: ');
  const phone = await ask(rl, 'Phone (leave blank to skip): ');
  const email = await ask(rl, 'Email (leave blank to skip): ');
  const station = await ask(rl, 'Station (leave blank to skip): ');
  const password = await ask(rl, 'Password: ', { hidden: true });

  if (!name || !password) {
    console.error('\nName and password are required.');
    rl.close();
    process.exit(1);
  }
  if (!phone && !email) {
    console.error('\nAt least a phone or an email is required, to log in with.');
    rl.close();
    process.exit(1);
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  try {
    const result = db.prepare(`
      INSERT INTO staff_users (name, phone, email, password_hash, role, station)
      VALUES (?, ?, ?, ?, 'admin', ?)
    `).run(name, phone || null, email || null, passwordHash, station || null);
    console.log(`\nAdmin user created: ${name} (id ${result.lastInsertRowid}). Log in at /login.html.`);
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed')) {
      console.error('\nA staff user with that phone or email already exists.');
    } else {
      console.error('\n' + err.message);
    }
    rl.close();
    process.exit(1);
  }
  rl.close();
}

main();
