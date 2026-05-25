const Imap = require('imap');

const imap = new Imap({
  user: 'service@mcf.bpc.ag',
  password: 'B/mi29QH$+wAhtfDdOXy',
  host: 'imap.ionos.de',
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false }
});

console.log('🔄 Verbinde...');

imap.on('error', (err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});

imap.on('ready', () => {
  console.log('✅ READY!');
  imap.openBox('INBOX', false, (err, box) => {
    if (err) {
      console.error('❌ openBox Error:', err.message);
    } else {
      console.log('✅ INBOX geöffnet!');
    }
    imap.end();
  });
});

imap.connect();

setTimeout(() => {
  console.log('❌ Timeout!');
  process.exit(1);
}, 10000);
