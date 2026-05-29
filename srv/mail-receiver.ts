import Imap from 'imap';
import { simpleParser } from 'mailparser';

export class MailReceiver {
	private imap: Imap;

	constructor() {
		console.log('📧 [MailReceiver] Constructor aufgerufen');
		this.imap = new Imap({
			user: 'service@mcf.bpc.ag',
			password: 'pwUF6dGp473L8ubYpwAA6cpLdEDhsMVL',
			host: 'imap.ionos.de',
			port: 993,
			tls: true,
			tlsOptions: { rejectUnauthorized: false }
		});
	}

	public async fetchEmails(): Promise<any[]> {
		return new Promise((resolve, reject) => {
			const emails: any[] = [];
			let processedCount = 0;
			let totalMessages = 0;

			console.log('📧 [MailReceiver] fetchEmails() gestartet');
			console.log('📧 [MailReceiver] Starte connect()...');
			
			this.imap.connect();

			this.imap.on('error', (err) => {
				console.error('📧 [MailReceiver] ERROR Event:', err.message);
				console.error('📧 [MailReceiver] Error Code:', err.code);
				reject(err);
			});

			this.imap.on('ready', () => {
				console.log('📧 [MailReceiver] READY Event aufgerufen!');
				
				this.imap.openBox('INBOX', false, (err, box) => {
					if (err) {
						console.error('📧 [MailReceiver] openBox Error:', err.message);
						reject(err);
						this.imap.end();
						return;
					}

					console.log('📧 [MailReceiver] INBOX geöffnet! Mails:', box.messages.total);

					this.imap.search(['ALL'], (err, results) => {
						if (err) {
							console.error('📧 [MailReceiver] search Error:', err.message);
							reject(err);
							this.imap.end();
							return;
						}

						console.log('📧 [MailReceiver] Gefundene E-Mails:', results.length);

						if (results.length === 0) {
							console.log('📧 [MailReceiver] Keine E-Mails gefunden');
							this.imap.end();
							resolve([]);
							return;
						}

						totalMessages = results.length;
						const f = this.imap.fetch(results, { bodies: '' });

						f.on('message', (msg) => {
							msg.on('body', (stream) => {
								simpleParser(stream, async (err, parsed) => {
									if (err) {
										console.error('📧 [MailReceiver] Parse Error:', err.message);
										processedCount++;
										checkIfDone();
										return;
									}

									const email = {
										sender: parsed.from?.text || 'Unknown',
										senderEmailAddress: (parsed.from?.text?.match(/[^\s<]+@[^\s>]+/) || [''])[0] || 'unknown@example.com',
										subject: parsed.subject || 'No Subject',
										body: parsed.text || parsed.html || ''
									};

									console.log('📧 [MailReceiver] E-Mail geparsed:', email.subject);
									emails.push(email);
									processedCount++;
									checkIfDone();
								});
							});
						});

						f.on('error', (err) => {
							console.error('📧 [MailReceiver] Fetch Error:', err.message);
							reject(err);
						});

						f.on('end', () => {
							console.log('📧 [MailReceiver] Fetch beendet');
							this.imap.end();
						});

						function checkIfDone() {
							if (processedCount === totalMessages) {
								console.log('📧 [MailReceiver] Alle E-Mails verarbeitet');
								setTimeout(() => {
									console.log('📧 [MailReceiver] Returning', emails.length, 'emails');
									resolve(emails);
								}, 500);
							}
						}
					});
				});
			});

			this.imap.on('end', () => {
				console.log('📧 [MailReceiver] IMAP Verbindung geschlossen');
			});

			setTimeout(() => {
				console.warn('📧 [MailReceiver] Timeout nach 30s');
				try {
					this.imap.end();
				} catch (e) {
					console.error('📧 [MailReceiver] Error beim end():', e);
				}
			}, 30000);
		});
	}
}