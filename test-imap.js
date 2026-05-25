const Imap = require('imap');

const imap = new Imap({
  user: 'service@mcf.bpc.ag',
  password: 'B/mi29QH$+wAhtfDdOXy',
  host: 'imap.ionos.de',
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false }
});

console.log('🔄 Verbinde mit imap.ionos.de:993...');

imap.on('error', (err) => {
  console.error('❌ IMAP Error:', err.message);
});

imap.on('ready', () => {
  console.log('✅ ERFOLGREICH!');
  imap.end();
});

imap.connect();

setTimeout(() => {
  console.log('⏱️ Timeout nach 10s');
  imap.end();
}, 10000);
