const nodemailer = require('nodemailer');

async function test() {
  const configs = [
    { name: 'smtp.ionos.de:587', host: 'smtp.ionos.de', port: 587, secure: false },
    { name: 'smtp.ionos.de:465', host: 'smtp.ionos.de', port: 465, secure: true }
  ];

  for (const c of configs) {
    try {
      console.log('Testing: ' + c.name);
      const t = nodemailer.createTransport({
        host: c.host, port: c.port, secure: c.secure,
        auth: { user: 'service@mcf.bpc.ag', pass: 'B/mi29QH$+wAhtfDdOXy' }
      });
      await t.verify();
      console.log('✅ WORKS\n');
    } catch (e) {
      console.log('❌ ' + e.message + '\n');
    }
  }
}

test();
