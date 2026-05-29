import cds from "@sap/cds";
import { AzureOpenAiChatClient, AzureOpenAiEmbeddingClient } from "@sap-ai-sdk/langchain";
import nodemailer from "nodemailer";
import { MailReceiver } from "./mail-receiver.js";

import { z } from "zod";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StructuredOutputParser } from "@langchain/core/output_parsers";
import { OutputFixingParser } from "langchain/output_parsers";

import { getAppName, checkOrPrepareDeployments } from "./utils/ai-core.js";
import { IBaseMail, IProcessedMail, IStoredMail, IAction, MailWithSimilarity } from "./types.js";
import * as schemas from "./schemas.js";
import { ACTIONS } from "./constants.js";

import type { Mail, Translation } from "#cds-models/MailInsightsService";

export default class MailInsights extends cds.ApplicationService {
	private resourceGroupId: string;
	private transporter: any;

	async init(): Promise<void> {
		await super.init();
		
		this.transporter = nodemailer.createTransport({
			host: "smtp.ionos.de",
			port: 587,
			secure: false,
			auth: {
			user: "service@mcf.bpc.ag",
			pass: "pwUF6dGp473L8ubYpwAA6cpLdEDhsMVL"  // ← GENAU SO!
			}
		});
		this.on("getMails", this.onGetMails);
		this.on("getMail", this.onGetMail);
		this.on("addMails", this.onAddMails);
		this.on("deleteMail", this.onDeleteMail);
		this.on("submitResponse", this.onSubmitResponse);
		this.on("revokeResponse", this.onRevokeResponse);
		this.on("generateResponse", this.onGenerateResponse);
		this.on("fetchEmails", this.fetchAndImportEmails);

		this.resourceGroupId = getAppName();
		checkOrPrepareDeployments(this.resourceGroupId);

		// Beim Start E-Mails abrufen
		(async () => {
			try {
				await this.fetchAndImportEmails();
			} catch (err: any) {
				console.error("Initial fetch failed:", err);
			}
		})();
	}

	private onGetMails = async (req: cds.Request): Promise<IBaseMail | Error> => {
		try {
			const { Mails } = this.entities;
			const mails = await SELECT.from(Mails).columns((m: any) => {
				m.ID;
				m.subject;
				m.body;
				m.category;
				m.responded;
				m.sender;
			});
			return mails;
		} catch (error: any) {
			console.error(`Error: ${error?.message}`);
			return req.error(`Error: ${error?.message}`);
		}
	};

	private onGetMail = async (req: cds.Request): Promise<any | Error> => {
		try {
			const { id } = req.data;
			const { Mails } = this.entities;

			const mail = await SELECT.one
				.from(Mails, (m: Mail) => {
					//@ts-ignore
					m`.*`;
					//@ts-ignore
					m.translation((t: Translation) => {
						//@ts-ignore
						t`.*`;
					});
				})
				.where(`ID = '${id}'`);

			mail.suggestedActions = mail.suggestedActions?.map((suggestedAction: IAction) => {
				return {
					...suggestedAction,
					descr: ACTIONS[suggestedAction.value] || ""
				};
			});

			const closestMailsIDs: Array<MailWithSimilarity> = await this.getClosestMailIDsWithSimilarity(id, 5);
			const closestMailsIndex: { [key: string]: MailWithSimilarity } = closestMailsIDs.reduce(
				(acc: { [key: string]: MailWithSimilarity }, mailWithSimilarity: MailWithSimilarity) => ({
					...acc,
					[mailWithSimilarity.ID]: mailWithSimilarity
				}),
				{}
			);

			const closestMails =
				closestMailsIDs.length > 0
					? await SELECT.from(Mails, (m: Mail) => {
							m.ID;
							m.subject;
							m.body;
							m.category;
							m.sender;
							m.responded;
							m.responseBody;
							//@ts-ignore
							m.translation((t: Translation) => {
								//@ts-ignore
								t`.*`;
							});
						}).where({
							ID: {
								in: Object.keys(closestMailsIndex)
							}
						})
					: [];

			const closestMailsWithSimilarity: { similarity: number; mail: any } = closestMails.map((mail: IBaseMail) => {
				const matchingMail: MailWithSimilarity = closestMailsIndex[mail.ID];
				return { similarity: matchingMail.similarity, mail };
			});

			return { mail, closestMails: closestMailsWithSimilarity };
		} catch (error: any) {
			console.error(`Error: ${error?.message}`);
			return req.error(`Error: ${error?.message}`);
		}
	};

	private onAddMails = async (req: cds.Request): Promise<Array<IBaseMail> | Error> => {
		try {
			const { Mails } = this.entities;
			const { mails, rag } = req.data;
			const mailBatch = await this.generateInsights(mails, rag);

			await INSERT.into(Mails).entries(mailBatch);

			const insertedMails = await SELECT.from(Mails, (m: any) => {
				//@ts-ignore
				m`.*`;
				//@ts-ignore
				m.translation((t: Translation) => {
					//@ts-ignore
					t`.*`;
				});
			}).where({
				ID: { in: mailBatch.map((mail: any) => mail.ID) }
			});

			insertedMails.forEach((mail: any) => {
				mail.suggestedActions = mail.suggestedActions?.map((suggestedAction: IAction) => {
					return {
						...suggestedAction,
						descr: ACTIONS[suggestedAction.value] || ""
					};
				});
			});

			return insertedMails;
		} catch (error: any) {
			console.error(`Error: ${error?.message}`);
			return req.error(`Error: ${error?.message}`);
		}
	};

	private onGenerateResponse = async (req: cds.Request): Promise<boolean | any> => {
		try {
			const { id, rag, additionalInformation } = req.data;
			const { Mails } = this.entities;
			const mail = await SELECT.one.from(Mails, id);
			const response = await this.generateResponse(mail, rag, additionalInformation);
			return response;
		} catch (error: any) {
			console.error(`Error: ${error?.message}`);
			return req.error(`Error: ${error?.message}`);
		}
	};

	private onSubmitResponse = async (req: cds.Request): Promise<boolean | any> => {
		try {
			const { id, response } = req.data;
			const { Mails } = this.entities;
			const mail = await SELECT.one.from(Mails, id).columns((m: any) => {
				m("*");
				m.translation((t: any) => t("*"));
			});

			const translation =
				mail.languageMatch === undefined || mail.languageMatch
					? response
					: (await this.translateResponse(response, mail.languageNameDetermined)).responseBody;

			try {
				await this.sendEmailViaSMTP({
					recipient: mail.senderEmailAddress,
					subject: `Re: ${mail.subject}`,
					body: translation,
					workingLanguageResponse: response
				});
				console.log(`✅ Email successfully sent to ${mail.sender}`);
			} catch (emailError: any) {
				console.error(`❌ Email sending failed: ${emailError?.message}`);
			}

			const submittedMail = {
				...mail,
				responded: true,
				responseBody: translation,
				translation: { ...mail.translation, responseBody: response }
			};
			const success = await UPDATE(Mails, mail.ID).set(submittedMail);
			return new Boolean(success);
		} catch (error: any) {
			console.error(`Error: ${error?.message}`);
			return req.error(`Error: ${error?.message}`);
		}
	};

	private sendEmailViaSMTP = async (emailData: {
		recipient: string;
		subject: string;
		body: string;
		workingLanguageResponse?: string;
	}): Promise<any> => {
		try {
			const mailOptions = {
				from: "service@mcf.bpc.ag",
				to: emailData.recipient,
				subject: emailData.subject,
				html: `
					<html>
						<body style="font-family: Arial, sans-serif;">
							<p>${emailData.body.replace(/\n/g, "<br/>")}</p>
							<hr style="margin-top: 30px; border: none; border-top: 1px solid #ccc;">
							<p style="color: #666; font-size: 12px; margin-top: 20px;">
								<strong>bpc E-Mail Insights</strong><br/>
								Diese E-Mail wurde automatisch von unserem KI-Assistenten generiert.<br/>
								Bei Fragen kontaktieren Sie bitte unser Team.
							</p>
						</body>
					</html>
				`
			};

			const result = await this.transporter.sendMail(mailOptions);
			console.log("📧 SMTP Response:", result);
			return result;
		} catch (error: any) {
			console.error(`Error sending email via SMTP: ${error?.message}`);
			console.error(`Error details:`, error);
			throw new Error(`Email sending failed: ${error?.message}`);
		}
	};

	private onRevokeResponse = async (req: cds.Request): Promise<boolean | any> => {
		try {
			const { id } = req.data;
			const { Mails } = this.entities;
			const result = await UPDATE(Mails, id).with({ responded: false });
			return new Boolean(result);
		} catch (error: any) {
			console.error(`Error: ${error?.message}`);
			return req.error(`Error: ${error?.message}`);
		}
	};

	private onDeleteMail = async (req: cds.Request): Promise<any> => {
		try {
			const { id } = req.data;
			const { Mails } = this.entities;
			const result = await DELETE.from(Mails, id);
			return Boolean(result);
		} catch (error: any) {
			console.error(`Error: ${error?.message}`);
			return req.error(`Error: ${error?.message}`);
		}
	};

	private generateInsights = async (mails: Array<IBaseMail>, rag: boolean = false) => {
		mails.forEach((mail) => {
			mail.ID ??= crypto.randomUUID();
		});

		const [generalInsights, potentialResponses, languageMatches, embeddings] = await Promise.all([
			this.extractGeneralInsights(mails),
			this.preparePotentialResponses(mails, rag),
			this.extractLanguageMatches(mails),
			this.createEmbeddings(mails)
		]);

		const processedMails = mails.reduce((acc, mail) => {
			const generalInsight = generalInsights.find((res: any) => res.mail.ID === mail.ID)?.insights;
			const potentialResponse = potentialResponses.find((res: any) => res.mail.ID === mail.ID)?.response;
			const languageMatch = languageMatches.find((res: any) => res.mail.ID === mail.ID)?.languageMatch;
			const embedding = embeddings.find((res: any) => res.mail.ID === mail.ID)?.embedding;
			acc.push({
				mail,
				insights: {
					...generalInsight,
					...potentialResponse,
					...languageMatch,
					embedding
				}
			});

			return acc;
		}, [] as IProcessedMail[]);

		const mailsWithTranslation: Array<IBaseMail> = await this.addTranslatedInsights(processedMails);

		return mailsWithTranslation;
	};

	private generateResponse = async (
		mail: IStoredMail,
		rag: boolean = false,
		additionalInformation?: string
	): Promise<IStoredMail> => {
		const { Translations } = this.entities;
		const responses = await this.preparePotentialResponses([mail], rag, additionalInformation);
		const regeneratedResponse = responses[0]?.response?.responseBody;

		//@ts-ignore
		const translation = await SELECT.one.from(Translations, mail.translation_ID);
		if (mail.languageMatch) {
			translation.responseBody = regeneratedResponse;
		} else {
			const translatedResponse = await this.translateResponse(regeneratedResponse, schemas.WORKING_LANGUAGE);
			translation.responseBody = translatedResponse.responseBody;
		}

		mail.suggestedActions = mail.suggestedActions?.map((suggestedAction: IAction) => {
			return {
				...suggestedAction,
				descr: ACTIONS[suggestedAction.value] || ""
			};
		});

		return {
			...mail,
			responseBody: regeneratedResponse,
			translation: translation
		};
	};

	private extractGeneralInsights = async (mails: Array<IBaseMail>): Promise<Array<IProcessedMail>> => {
		const llm = getChatModel(this.resourceGroupId);
		const parser = StructuredOutputParser.fromZodSchema(schemas.MAIL_INSIGHTS_SCHEMA);
		const formatInstructions = parser.getFormatInstructions();
		const parserWithFix = OutputFixingParser.fromLLM(llm, parser);

		const promptTemplate = await ChatPromptTemplate.fromMessages([
			[
				"system",
				"Give insights about the incoming email.\n{formatInstructions}\nMake sure to escape special characters by double slashes."
			],
			["user", "{subject}\n{body}"]
		]).partial({ formatInstructions });
		const llmChain = promptTemplate.pipe(llm).pipe(parserWithFix);

		const mailsInsights = await Promise.all(
			mails.map(async (mail: IBaseMail): Promise<IProcessedMail> => {
				const response = await llmChain.invoke({
					subject: mail.subject,
					body: mail.body
				});

				const insights: z.infer<typeof schemas.MAIL_INSIGHTS_SCHEMA> = response;
				return { mail: { ...mail }, insights: { ...insights } };
			})
		);

		return mailsInsights;
	};

	private preparePotentialResponses = async (
		mails: Array<IBaseMail>,
		rag: boolean = false,
		additionalInformation?: string
	): Promise<any> => {
		const llm = getChatModel(this.resourceGroupId);
		const parser = StructuredOutputParser.fromZodSchema(schemas.MAIL_RESPONSE_SCHEMA);
		const formatInstructions = parser.getFormatInstructions();
		const parserWithFix = OutputFixingParser.fromLLM(llm, parser);
		const ragSystemPrompt = `Context information based on similar mail responses is given below. 
                                    Context:{context}
                                Formulate a response to the original mail given this context information.
                                Prefer the context when generating your answer to any prior knowledge.
                                Also consider given additional information if available to enhance the response.`;
		const systemPrompt = "Formulate a response to the original mail using given additional information.";

		const promptTemplate = await ChatPromptTemplate.fromMessages([
			[
				"system",
				(rag ? ragSystemPrompt : systemPrompt) +
					`Address the sender appropriately.
                    {formatInstructions}
                    Make sure to escape special characters by double slashes except '\n'.`
			],
			["user", "{subject}\n{body}"]
		]).partial({ formatInstructions });

		const llmChain = promptTemplate.pipe(llm).pipe(parserWithFix);

		const potentialResponses = await Promise.all(
			mails.map(async (mail: IBaseMail) => {
				let closestResponses: Array<string> = [];
				if (rag) {
					closestResponses = await this.getClosestResponses(mail.ID);
				}

				const response: z.infer<typeof schemas.MAIL_RESPONSE_SCHEMA> = await llmChain.invoke({
					sender: mail.senderEmailAddress,
					subject: mail.subject,
					body: mail.body,
					additionalInformation: additionalInformation || "",
					context: closestResponses
				});

				return { mail, response };
			})
		);

		return potentialResponses;
	};

	private extractLanguageMatches = async (mails: Array<IBaseMail>): Promise<any> => {
		const llm = getChatModel(this.resourceGroupId);
		const parser = StructuredOutputParser.fromZodSchema(schemas.MAIL_LANGUAGE_SCHEMA);
		const formatInstructions = parser.getFormatInstructions();
		const parserWithFix = OutputFixingParser.fromLLM(llm, parser);

		const promptTemplate = await ChatPromptTemplate.fromMessages([
			[
				"system",
				"Extract the language related information.\n{formatInstructions}\nMake sure to escape special characters by double slashes."
			],
			["user", "{mail}"]
		]).partial({ formatInstructions });
		const llmChain = promptTemplate.pipe(llm).pipe(parserWithFix);

		const languageMatches = await Promise.all(
			mails.map(async (mail: IBaseMail) => {
				const languageMatch: z.infer<typeof schemas.MAIL_LANGUAGE_SCHEMA> = await llmChain.invoke({
					mail: mail.body
				});

				return { mail, languageMatch };
			})
		);

		return languageMatches;
	};

	private createEmbeddings = async (mails: Array<IBaseMail>): Promise<any> => {
		const embed = getEmbeddingModel(this.resourceGroupId);
		const embeddings = await Promise.all(
			mails.map(async (mail: IBaseMail) => {
				const embeddings = await embed.embedDocuments([mail.body]);
				const embedding = `[${embeddings[0]}]`;
				return { mail, embedding };
			})
		);

		return embeddings;
	};

	private addTranslatedInsights = async (mails: Array<IProcessedMail>): Promise<Array<IBaseMail>> => {
		const llm = getChatModel(this.resourceGroupId);
		const parser = StructuredOutputParser.fromZodSchema(schemas.MAIL_INSIGHTS_TRANSLATION_SCHEMA);
		const formatInstructions = parser.getFormatInstructions();
		const parserWithFix = OutputFixingParser.fromLLM(llm, parser);

		const promptTemplate = await ChatPromptTemplate.fromMessages([
			[
				"system",
				"Translate the insights of the incoming json.\n{formatInstructions}\nMake sure to escape special characters by double slashes."
			],
			["user", "{insights}"]
		]).partial({ formatInstructions });
		const llmChain = promptTemplate.pipe(llm).pipe(parserWithFix);

		const translations = await Promise.all(
			mails.map(async (mail: IProcessedMail) => {
				if (mail.insights?.languageMatch) {
					return {
						...mail,
						translation: [
							{
								subject: mail.mail?.subject || "",
								body: mail.mail?.body || "",
								sender: mail.insights?.sender || "",
								summary: mail.insights?.summary || "",
								keyFacts: mail.insights?.keyFacts || "",
								requestedServices: mail.insights?.requestedServices || "",
								responseBody: mail.insights?.responseBody || ""
							}
						]
					};
				} else {
					const translation: z.infer<typeof schemas.MAIL_INSIGHTS_TRANSLATION_SCHEMA> = await llmChain.invoke({
						insights: JSON.stringify({
							subject: mail.mail.subject,
							body: mail.mail.body,
							sender: mail.insights.sender,
							requestedServices: mail.insights.requestedServices,
							summary: mail.insights.summary,
							keyFacts: mail.insights.keyFacts,
							responseBody: mail.insights.responseBody
						})
					});
					return { ...mail, translation: [translation] };
				}
			})
		);

		return translations.map((mail) => {
			return {
				...mail.mail,
				...mail.insights,
				translation: mail.translation
			};
		});
	};

	private translateResponse = async (response: string, language: string): Promise<any> => {
		try {
			const llm = getChatModel(this.resourceGroupId);
			const parser = StructuredOutputParser.fromZodSchema(schemas.MAIL_INSIGHTS_TRANSLATION_SCHEMA);
			const formatInstructions = parser.getFormatInstructions();
			const parserWithFix = OutputFixingParser.fromLLM(llm, parser);

			const promptTemplate = await ChatPromptTemplate.fromMessages([
				[
					"system",
					`Translate the following response of the customer support into ${language}.
                        {formatInstructions}
                        Make sure to escape special characters by double slashes.`
				],
				["user", "{response}"]
			]).partial({ formatInstructions });
			const llmChain = promptTemplate.pipe(llm).pipe(parserWithFix);
			const translation: z.infer<typeof schemas.MAIL_RESPONSE_TRANSLATION_SCHEMA> = await llmChain.invoke({
				response: response
			});
			return translation;
		} catch (error: any) {
			console.error(`Error: ${error?.message}`);
			return {
				responseBody: response || ""
			};
		}
	};

	private getClosestResponses = async (id: string): Promise<Array<string>> => {
		const closestMails = await this.getClosestMailIDsWithSimilarity(id, 5, true);
		if (closestMails.length === 0) {
			return [];
		}
		const { Mails } = this.entities;

		const responses: Promise<Array<string>> = (
			await SELECT.from(Mails)
				.where({
					ID: {
						in: closestMails.map((m: MailWithSimilarity) => m.ID)
					}
				})
				.columns((m: any) => {
					m.ID;
					m.responseBody;
				})
		).map((mail: any) => mail.responseBody);

		return responses;
	};

	private getClosestMailIDsWithSimilarity = async (
		id: string,
		k: number = 5,
		responded: boolean = false
	): Promise<Array<MailWithSimilarity>> => {
		const mailsWithSimilarity: Array<MailWithSimilarity> = await cds.run(
			`
            SELECT 
                similars.ID as "ID",
                similars.BODY as "body",
                COSINE_SIMILARITY(similars."EMBEDDING", focus."EMBEDDING") as "similarity"
            FROM "AI_DB_MAILS" as similars
            JOIN (
                SELECT 
                    ID, 
                    "EMBEDDING"
                FROM "AI_DB_MAILS"
                WHERE ID = ?
                LIMIT 1
            ) as focus ON focus.ID <> similars.ID
            ${responded ? "WHERE RESPONDED = true" : ""}
            ORDER BY "similarity" DESC LIMIT ?`,
			[id, k]
		);

		return mailsWithSimilarity;
	};

	private fetchAndImportEmails = async () => {
		try {
			console.log("📧 Fetching emails from service@mcf.bpc.ag...");
			const receiver = new MailReceiver();
			const emails = await receiver.fetchEmails();
			console.log(`✅ Found ${emails.length} emails`);
			
			if (emails.length > 0) {
				// Nur die 3 benötigten Felder übergeben (BaseMail kompatibel)
				const baseEmails = emails.map((email: any) => ({
					subject: email.subject,
					body: email.body,
					senderEmailAddress: email.senderEmailAddress
				}));

				await this.addMails({ mails: baseEmails });
				console.log("✅ Emails imported successfully");
			}
			return { success: true, count: emails.length };
		} catch (err: any) {
			console.error("❌ Error fetching emails:", err.message);
			throw err;
		}
	}
}

const getChatModel = (resourceGroupId: string) => {
	return new AzureOpenAiChatClient({
		modelName: "gpt-4o",
		modelVersion: "latest",
		resourceGroup: resourceGroupId
	});
};

const getEmbeddingModel = (resourceGroupId: string) => {
	return new AzureOpenAiEmbeddingClient({
		modelName: "text-embedding-3-small",
		modelVersion: "latest",
		resourceGroup: resourceGroupId
	});
};