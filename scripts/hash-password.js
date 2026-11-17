// Make a password hash to store in the database (passwords are never stored in plain text).
//   node scripts/hash-password.js "NewPassword"
// Then run the SQL it prints in the Neon SQL Editor.
import { hashPassword } from '../lib/auth.js';

const pw = process.argv[2];
if (!pw) { console.error('Usage: node scripts/hash-password.js "<password>"'); process.exit(1); }
const h = hashPassword(pw);
console.log('\nHash:\n' + h + '\n');
console.log("-- change an account's password (replace the code):");
console.log(`update accounts set password_hash = '${h}' where code = '1008-SHBN';`);
