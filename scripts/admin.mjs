// Creates an IT admin account, or resets its password if it already exists.
//   npm run admin               account "admin"
//   npm run admin -- director   a second admin account (spec 10: admin passwords kept by IT and the director)
// Admin accounts manage people, groups and top-level folders. They never get access to file contents.
import { loadConfig } from '../src/config.mjs';
import { openDb } from '../src/db.mjs';
import { hashPassword, tempPassword } from '../src/auth.mjs';

const login = process.argv[2] || 'admin';
if (!/^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?$/i.test(login)) {
  console.error('Logins use Latin letters, digits, dots, dashes or underscores.');
  process.exit(1);
}

const db = openDb(loadConfig().dataDir);
const user = db.get('SELECT * FROM users WHERE login = ?', login);
if (user && !user.is_admin) {
  console.error(`"${login}" is an employee account. Admin accounts are separate; choose another login.`);
  process.exit(1);
}

const password = tempPassword();
const hash = await hashPassword(password);
if (user) {
  db.run('UPDATE users SET pass = ?, must_change = 1, disabled = 0 WHERE id = ?', hash, user.id);
  db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
  db.audit('admin', null, 'admin password reset from the server console', login);
} else {
  db.run('INSERT INTO users(login, name, pass, is_admin, created_at) VALUES(?, ?, ?, 1, ?)', login, 'IT administrator', hash, Date.now());
  db.audit('admin', null, 'admin account created from the server console', login);
}

console.log(`
  Admin login:         ${login}
  Temporary password:  ${password}

  At first sign-in you will choose a new password.
`);
