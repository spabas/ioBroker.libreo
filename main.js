"use strict";

/*
 * Created with @iobroker/create-adapter v2.6.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");

// Load your modules here, e.g.:
const axios = require("axios");
const cheerio = require("cheerio");
const { wrapper } = require("axios-cookiejar-support");
const tough = require("tough-cookie");
const CircularJSON = require("circular-json");
const WebSocket = require("ws");

class Libreo extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: "libreo",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		// this.on("objectChange", this.onObjectChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));

		this.cookieJar = new tough.CookieJar();
		this.client = wrapper(axios.create({ jar: this.cookieJar }));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here

		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:
		this.USERNAME = this.config.username;
		this.PASSWORD = this.config.password;
		this.PORTAL_URL = this.config.portal_url;
		this.LOGIN_API_URL = this.config.login_api_url;
		this.ISSUER = this.config.issuer;

		this.log.info("config USERNAME: " + this.USERNAME);
		this.log.info("config PASSWORD: " + this.PASSWORD.substring(0, 3) + "...");

		this.subscribeStates("*.chargingStart");
		this.subscribeStates("*.chargingStop");
		this.subscribeStates("*.current");

		const instance = this;
		this.socketInvocationId = 1;

		let sessionIntervalUntil = new Date();
		let sessionIntervalFrom = new Date();

		//initial load of sessions
		const sessions_exists = await this.objectExists("chargingsessions");
		if (!sessions_exists) {
			sessionIntervalFrom = new Date(sessionIntervalFrom.getFullYear(), 0, 1);
		}
		//append sessions of last 30/31 days
		else
		{
			sessionIntervalFrom.setMonth(sessionIntervalFrom.getMonth() - 1);
		}

		try {
			if (this.config.username.length > 3 && this.config.password.length > 4) {
				await this.Login();
				await this.GetOrgs();

				await this.GetUserInfo();
				await this.GetChargingSessions(false, sessionIntervalFrom.toISOString(), sessionIntervalUntil.toISOString());

				this.timer_userdata = this.setInterval(async () => {
					this.log.info("Try getting user info");
					if (await instance.GetUserInfo(true))
					{
						this.log.info("Getting user info successfull");
					}
				}, 60000);

				this.timer_sessions = this.setInterval(async () => {
					sessionIntervalUntil = new Date();
					sessionIntervalFrom = new Date();
					sessionIntervalFrom.setMonth(sessionIntervalFrom.getMonth() - 1);
					this.log.info("Try getting charging sessions");
					if (await instance.GetChargingSessions(true, sessionIntervalFrom.toISOString(), sessionIntervalUntil.toISOString()))
					{
						this.log.info("Getting charging sessions successfull");
					}
				}, 300000);

				this.setInterval(async () => {
					await this.GetOrgs();
				}, 1200000);
			}
			else
				this.log.error("Missing credentials in config");
		}
		catch (error) {
			this.log.error("Error while processing libreo API: " + error);
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);

			callback();
		} catch (e) {
			callback();
		}
	}

	//If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	//You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	/**
	 * Is called if a subscribed object changes
	 * @param {string} id
	 * @param {ioBroker.Object | null | undefined} obj
	 */
	onObjectChange(id, obj) {
		if (obj) {
			// The object was changed
			this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
		} else {
			// The object was deleted
			this.log.info(`object ${id} deleted`);
		}
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

			const parts = id.split(".");
			const lastPart = parts[parts.length - 1];

			const chargingUserStateId = id.replace(/(\.[^.]*)$/, ".chargingUserId");
			this.log.info("Try getting charging user from state: " + chargingUserStateId);
			const userId = await this.GetChargingUserId(chargingUserStateId);

			if (lastPart == "current") {
				this.log.info("Try setting current");
				const station = parts.find(part => part.startsWith("cst-"));
				if (await this.SetCurrent(station, state.val, true)) {
					state.ack = true;
					this.log.info("Setting current successfull");
				}
				else
					this.log.warn("Setting of current couldn't be executed!");
			}
			else if (lastPart == "chargingStart") {
				this.log.info("Try start charging");
				const station = parts.find(part => part.startsWith("cst-"));

				if (await this.Charging(station, true, userId, true)) {
					state.ack = true;
					this.log.info("Start charging successfull for user id: " + userId);
				}
				else
					this.log.warn("Charging request couldn't be executed!");
			}
			else if (lastPart == "chargingStop") {
				this.log.info("Try stop charging");
				const station = parts.find(part => part.startsWith("cst-"));

				if (await this.Charging(station, false, userId, true)) {
					state.ack = true;
					this.log.info("Stop charging successfull for user id: " + userId);
				}
				else
					this.log.warn("Charging request couldn't be executed!");
			}
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	async GetChargingUserId(id) {
		let userId = null;
		const chargingUserState = await this.getStateAsync(id);
		if (chargingUserState?.val)
			userId = chargingUserState?.val;

		return userId;
	}

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === "object" && obj.message) {
	// 		if (obj.command === "send") {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info("send command");

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
	// 		}
	// 	}
	// }

	async Login() {
		try {

			this.log.info("Try logging in ...");

			// Schritt 0: Wir rufen die LOGIN-Seite auf für ein paar Cookies
			// https://portal.libreo.cloud/login
			const initialResponse = await this.client.get(this.PORTAL_URL + "/login?ui_locales=de&redirectUrl=/", {
				maxRedirects: 0,
				validateStatus: status => status >= 200 && status < 400 || status === 302
			});

			this.log.debug("Initial-Response-Status: " + initialResponse.status);
			//console.log('Initial-Response: ' + CircularJSON.stringify(initialResponse));

			const authUrl = initialResponse.headers.location;
			if (!authUrl) {
				throw new Error("Auth Redirect URL not found");
			}

			//Wir werden weitergeleitet zu https://id.libreo.cloud/connect/authorize
			const authResponse = await this.client.get(authUrl, {
				headers: {
					"Referer": this.PORTAL_URL
				},
				maxRedirects: 0,
				validateStatus: status => status >= 200 && status < 400 || status === 302
			});

			this.log.debug("Auth-Response-Status: " + authResponse.status);
			//console.log('Auth-Response: ' + CircularJSON.stringify(authResponse));

			const loginRedirectUrl = initialResponse.headers.location;
			if (!loginRedirectUrl) {
				throw new Error("Login Redirect URL not found");
			}

			//Wir werden weitergeleitet (wenn noch nicht angemeldet) zu https://id.libreo.cloud/login
			await this.client.get(loginRedirectUrl, {
				headers: {
					"Referer": this.PORTAL_URL
				},
				maxRedirects: 0,
				validateStatus: status => status >= 200 && status < 400 || status === 302
			});

			const xsrfToken = this.GetXsrfTokenFromCookie("id.libreo.cloud");

			//Wir beanworten die Login Seite selbst per POST gegen
			this.log.debug("Login-URL: " + this.LOGIN_API_URL);
			this.log.debug("email: " + this.USERNAME);
			this.log.debug("password: " + this.PASSWORD?.substring(0, 3) + "...");
			this.log.debug("XSRF-Token: " + xsrfToken);

			// Schritt 2: Senden Sie die Anmeldeinformationen direkt an den Auth-Server
			const loginResponse = await this.client.post(this.LOGIN_API_URL ?? "", {
				email: this.USERNAME,
				password: this.PASSWORD,
				rememberMe: false,
			}, {
				headers: {
					"Content-Type": "application/json",
					"X-Xsrf-Token": xsrfToken,
					"Origin": this.ISSUER,
					"Referer": loginRedirectUrl,
				},
				maxRedirects: 0,
				validateStatus: status => status >= 200 && status < 400 || status === 302
			});

			this.log.debug("Login-Response-Status: " + loginResponse.status);

			if (loginResponse.status === 200) {

				//GET UserInfo
				const userInfo = await this.client.get("https://id.libreo.cloud/userinfo", {
					maxRedirects: 0,
					validateStatus: null
				});

				this.log.debug("UserInfo-Response-Status: " + userInfo.status);
				//console.log("UserInfo-Response-Data: " + CircularJSON.stringify(userInfo.data));
				//userData = userInfo.data;
				//console.log('UserInfo-Response: ' + CircularJSON.stringify(userInfo));

				//Wir rufen die Auth URL erneut, diesmal sollten wir angemeldet sein und sollten einen Auth-Code erhalten
				const authResponse2 = await this.client.get(authUrl, {
					maxRedirects: 0,
					validateStatus: null
				});

				this.log.debug("Auth2-Response-Status: " + authResponse2.status);
				//console.log('Auth2-Response: ' + CircularJSON.stringify(authResponse2));

				// Wir parsen das empfangene HTML um die Formularfelder mit enthaltenem Auth-Code zu extrahieren
				const $ = cheerio.load(authResponse2.data);
				const formAction = $("form").attr("action");
				const hiddenFields = $("form input[type=\"hidden\"]");

				const formData = {};
				hiddenFields.each((i, field) => {
					formData[$(field).attr("name")] = $(field).attr("value");
				});

				// Ausgabe der extrahierten Daten
				this.log.debug("Form Action URL: " + formAction);
				this.log.debug("Form Data: " + JSON.stringify(formData));

				//Wir posten das empfangene Formular mit dem Auth-Code, um einen Access-Token zu erhalten
				const tokenResponse = await this.client.post(formAction ?? "", formData, {
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
						"Referer": this.ISSUER,
					},
					validateStatus: status => status === 200
				});

				this.log.debug("Signin-OIDC-Response-Status: " + tokenResponse.status);
				this.log.info("Logged in!");
				//console.log('Token-Response: ' + CircularJSON.stringify(tokenResponse));

				//Jetzt haben wir hoffentlich einen Access-Token erhalten (wir erhalten nicht wirklich einen Token zurück, haben aber wohl einen in unserer Sessions bzw. im Sessions Cookie gespeichert), um API-Calls ausführen zu können!
				this.loggedIn = true;

				return true;

			} else {
				this.log.warn("Login failed!");
				return false;
			}
		} catch (error) {
			this.log.error("Error while logging in!");
			return false;
		}
	}

	GetXsrfTokenFromCookie(domain) {
		// X-Xsrf-Token aus dem Cookie extrahieren
		const cookies = this.cookieJar.toJSON().cookies;
		const xsrfToken = cookies.find(cookie => cookie.key === "XSRF-TOKEN" && cookie.domain === domain)?.value;

		return xsrfToken;
	}

	async GetOrgs() {
		try {

			this.log.info("Try getting organisations and assets ...");

			const orgsresponse = await this.client.get("https://portal.libreo.cloud/api/identity/orgs");

			//console.log('Orgs-Response-Data: ' + CircularJSON.stringify(orgsresponse.data));

			if (orgsresponse.status === 200)
			{
				this.log.debug("Orgs-Response-Status: " + orgsresponse.status);

				const orgsData = orgsresponse.data;
				const that = this;
				orgsData.forEach(async(org, index) => {

					const path = org.path.replace("/", ".");
					await that.setObjectNotExistsAsync(path, {
						type: "channel",
						common: {
							name: org.name,
						},
						native: {},
					});

					//TODO: Not only for the last org, but for all
					if (index === orgsData.length - 1) {
						this.currentNode = path;
						await this.SetOrg(org.path);
						await this.GetOrg(org.path);
						await this.GetStationsOfCurrentOrg(path);
						await this.StartWebSocket(org.path, path);
					}
				});

				this.log.info("Getting organisations and assets successfull");
			}
			else {
				this.log.warn("Getting orgs failed!");
			}
		}
		catch (error) {
			this.log.error("Error while getting orgs! " + error);
		}
	}

	async GetOrg(org) {

		try {

			const xsrfToken = this.GetXsrfTokenFromCookie("portal.libreo.cloud");
			const getOrgResponse = await this.client.get(`https://portal.libreo.cloud/api/identity/orgs/${org}`,
				{
					headers: {
						"Content-Type": "application/json",
						"X-Xsrf-Token": xsrfToken,
						"Referer": "https://portal.libreo.cloud/users"
					},
					validateStatus: null,
					params: {
						"api-version": "2.0",
					}
				});

			//console.log("GetOrg-Response: " + CircularJSON.stringify(getOrgResponse));

			if (getOrgResponse.status === 200)
			{
				this.log.debug("GetOrg-Response-Status: " + getOrgResponse.status);

				const userData = getOrgResponse.data.users;
				userData.forEach(async(user) => {
					await this.setObjectNotExistsAsync("users." + user.id, {
						type: "channel",
						common: {
							name: user.userName
						},
						native: {},
					});

					await this.setObjectNotExistsAsync("users." + user.id + ".given_name", {
						type: "state",
						common: {
							name: "given name",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync("users." + user.id + ".given_name", { val: user.firstName, ack: true });

					await this.setObjectNotExistsAsync("users." + user.id + ".family_name", {
						type: "state",
						common: {
							name: "family name",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync("users." + user.id + ".family_name", { val: user.lastName, ack: true });

					await this.setObjectNotExistsAsync("users." + user.id + ".roleId", {
						type: "state",
						common: {
							name: "role id",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync("users." + user.id + ".roleId", { val: user.roleId, ack: true });
				});

			}
			else {
				this.log.warn("Getting org failed");
			}
		}
		catch (error) {
			this.log.error("Error while getting org " + org + ": " + error);
		}
	}

	async SetOrg(org) {

		try {

			const xsrfToken = this.GetXsrfTokenFromCookie("portal.libreo.cloud");
			const setOrgResponse = await this.client.post(`https://portal.libreo.cloud/org/${org}`,
				{
					headers: {
						"Content-Type": "application/json",
						"X-Xsrf-Token": xsrfToken,
						"Referer": "https://portal.libreo.cloud/api/identity/orgs"
					},
					validateStatus: null,
				}
			);

			//console.log('SetOrg-Response: ' + CircularJSON.stringify(setOrgResponse));

			if (setOrgResponse.status === 200)
			{
				this.log.debug("SetOrg-Response-Status: " + setOrgResponse.status);

			}
			else {
				this.log.warn("Setting org failed");
			}
		}
		catch (error) {
			this.log.error("Error while setting org " + org + ": " + error);
		}
	}

	async GetStationsOfCurrentOrg(path, loginIfForbidden = false) {
		try {

			const apiResponse = await this.client.get("https://portal.libreo.cloud/api/assets/chargingstations", {
				headers: {
				},
				validateStatus: null,
				params: {
					"api-version": "1.0",
					"pageNumber": 1,
					"pageSize": 100
				}
			});

			//console.log("Stations-Response: " + JSON.stringify(apiResponse));

			if (apiResponse.status === 200)
			{
				this.log.debug("GetStations-Response-Status: " + apiResponse.status);
				const stationsData = apiResponse.data.data;
				const that = this;
				stationsData.forEach(async(station) => {

					await that.setObjectNotExistsAsync(path + "." + station.id, {
						type: "channel",
						common: {
							name: station.name
						},
						native: {},
					});

					await that.setObjectNotExistsAsync(path + "." + station.id + ".serialNumber", {
						type: "state",
						common: {
							name: "serial number",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + "." + station.id + ".serialNumber", { val: station.serialNumber, ack: true });

					await that.setObjectNotExistsAsync(path + "." + station.id + ".model", {
						type: "state",
						common: {
							name: "model",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + "." + station.id + ".model", { val: station.model, ack: true });

					await that.setObjectNotExistsAsync(path + "." + station.id + ".macAddress", {
						type: "state",
						common: {
							name: "mac address",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + "." + station.id + ".macAddress", { val: station.macAddress, ack: true });

					await that.setObjectNotExistsAsync(path + "." + station.id + ".firmwareVersion", {
						type: "state",
						common: {
							name: "firmware version",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + "." + station.id + ".firmwareVersion", { val: station.firmwareVersion, ack: true });

					await that.setObjectNotExistsAsync(path + "." + station.id + ".latitude", {
						type: "state",
						common: {
							name: "latitude",
							type: "number",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + "." + station.id + ".latitude", { val: station.latitude, ack: true });

					await that.setObjectNotExistsAsync(path + "." + station.id + ".longitude", {
						type: "state",
						common: {
							name: "longitude",
							type: "number",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + "." + station.id + ".longitude", { val: station.longitude, ack: true });

					await that.setObjectNotExistsAsync(path + "." + station.id + ".mainboardBootloaderVersion", {
						type: "state",
						common: {
							name: "mainboard bootloader version",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + "." + station.id + ".mainboardBootloaderVersion", { val: station.mainboardBootloaderVersion, ack: true });

					await that.setObjectNotExistsAsync(path + "." + station.id + ".mainboardFirmwareVersion", {
						type: "state",
						common: {
							name: "mainboard firmware version",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + "." + station.id + ".mainboardFirmwareVersion", { val: station.mainboardFirmwareVersion, ack: true });

					await that.setObjectNotExistsAsync(path + "." + station.id + ".mainboardHardwareRevision", {
						type: "state",
						common: {
							name: "mainboard hardware revision",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + "." + station.id + ".mainboardHardwareRevision", { val: station.mainboardHardwareRevision, ack: true });

					await that.setObjectNotExistsAsync(path + "." + station.id + ".latestOperationMode", {
						type: "state",
						common: {
							name: "latest operation mode",
							type: "string",
							role: "indicator",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + "." + station.id + ".latestOperationMode", { val: station.latestOperationMode, ack: true });

					await that.setObjectNotExistsAsync(path + "." + station.id + ".publicKey", {
						type: "state",
						common: {
							name: "public key",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + "." + station.id + ".publicKey", { val: station.publicKey, ack: true });

					await that.setObjectNotExistsAsync(path + "." + station.id + ".connectivity", {
						type: "state",
						common: {
							name: "connectivity",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + "." + station.id + ".connectivity", { val: station.connectivity, ack: true });

					await that.setObjectNotExistsAsync(path + "." + station.id + ".creationDate", {
						type: "state",
						common: {
							name: "creation date",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + "." + station.id + ".creationDate", { val: station.creationDate, ack: true });

					await that.setObjectNotExistsAsync(path + "." + station.id + ".modificationDate", {
						type: "state",
						common: {
							name: "modification date",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + "." + station.id + ".modificationDate", { val: station.modificationDate, ack: true });


					await that.setObjectNotExistsAsync(path + "." + station.id + ".chargingStart", {
						type: "state",
						common: {
							name: "charging start",
							type: "boolean",
							role: "button",
							read: true,
							write: true,
						},
						native: {},
					});

					await that.setObjectNotExistsAsync(path + "." + station.id + ".chargingStop", {
						type: "state",
						common: {
							name: "charging stop",
							type: "boolean",
							role: "button",
							read: true,
							write: true,
						},
						native: {},
					});

					await that.setObjectNotExistsAsync(path + "." + station.id + ".chargingUserId", {
						type: "state",
						common: {
							name: "charging user id",
							type: "string",
							role: "text",
							read: true,
							write: true,
						},
						native: {},
					});

					await that.setObjectNotExistsAsync(path + "." + station.id + ".current", {
						type: "state",
						common: {
							name: "current in ampere",
							type: "number",
							role: "value",
							read: true,
							write: true,
							unit: "A",
							min: 6,
							max: 16,
							step: 2
						},
						native: {},
					});

				});
				return true;
			}
			else if (apiResponse.status === 401 && loginIfForbidden) {
				await this.Login();
				await this.GetStationsOfCurrentOrg(path, false);
			}
			else {
				console.error("Getting stations failed");
			}
		}
		catch (error) {
			console.error("Error while getting stations", error);
		}
	}

	async SetCurrent(station, current, loginIfForbidden = false) {
		try {

			const xsrfToken = this.GetXsrfTokenFromCookie("portal.libreo.cloud");
			const apiResponse = await this.client.put(`https://portal.libreo.cloud/api/customer/chargingstations/${station}?api-version=1.0`,
				{
					maxCurrent: current
				},
				{
					headers: {
						"Content-Type": "application/json",
						"X-Xsrf-Token": xsrfToken,
						"Referer": `https://portal.libreo.cloud/charging-stations?chargingStationId=${station}&dialog=settings`
					},
					validateStatus: null,
				});

			//console.log("Auth-Response: " + CircularJSON.stringify(apiResponse));

			if (apiResponse.status === 204)
			{
				this.log.debug("API-Response-Status: " + apiResponse.status);
				return true;
			}
			else if (apiResponse.status === 401 && loginIfForbidden) {
				await this.Login();
				await this.SetCurrent(station, current, false);
			}
			else {
				this.log.warn("Setting current failed");
			}
		}
		catch (error) {
			this.log.error("Error while setting current. " + error);
		}
	}

	async Charging(station, startOrStop, userId, loginIfForbidden = false) {
		try {

			const xsrfToken = this.GetXsrfTokenFromCookie("portal.libreo.cloud");
			const apiResponse = await this.client.post(`https://portal.libreo.cloud/api/customer/chargingstations/${station}/cmd/charge/${startOrStop}`,
				{
					impersonatedUserId: userId
				},
				{
					headers: {
						"Content-Type": "application/json",
						"X-Xsrf-Token": xsrfToken,
						"Referer": `https://portal.libreo.cloud/charging-stations?chargingStationId=${station}&dialog=startCharging`
					},
					validateStatus: null,
				});

			//console.log("Auth-Response: " + CircularJSON.stringify(apiResponse));
			this.log.silly("Auth-Response: " + CircularJSON.stringify(apiResponse));

			if (apiResponse.status === 204)
			{
				this.log.debug("API-Response-Status: " + apiResponse.status);
				return true;
			}
			else if (apiResponse.status === 401 && loginIfForbidden) {
				await this.Login();
				await this.Charging(station, startOrStop, userId, false);
			}
			else {
				this.log.warn("Charging request failed");
			}
		}
		catch (error) {
			this.log.error("Error while sending charging request. " + error);
		}
	}

	async GetUserInfo(loginIfForbidden = false) {
		try {

			const userInfo = await this.client.get("https://portal.libreo.cloud/userinfo");

			//console.log('UserInfo-Response-Data: ' + CircularJSON.stringify(userInfo.data));

			if (userInfo.status === 200)
			{
				this.log.debug("UserInfo-Response-Status: " + userInfo.status);
				const userData = userInfo.data;
				await this.setObjectNotExistsAsync("users." + userData.sub, {
					type: "channel",
					common: {
						name: userData.email
					},
					native: {},
				});

				await this.setObjectNotExistsAsync("users." + userData.sub + ".given_name", {
					type: "state",
					common: {
						name: "given name",
						type: "string",
						role: "text",
						read: true,
						write: false,
					},
					native: {},
				});
				await this.setStateAsync("users." + userData.sub + ".given_name", { val: userData.given_name, ack: true });

				await this.setObjectNotExistsAsync("users." + userData.sub + ".family_name", {
					type: "state",
					common: {
						name: "family name",
						type: "string",
						role: "text",
						read: true,
						write: false,
					},
					native: {},
				});
				await this.setStateAsync("users." + userData.sub + ".family_name", { val: userData.family_name, ack: true });

				await this.setObjectNotExistsAsync("users." + userData.sub + ".activeOrg", {
					type: "state",
					common: {
						name: "active organisation",
						type: "string",
						role: "text",
						read: true,
						write: false,
					},
					native: {},
				});
				await this.setStateAsync("users." + userData.sub + ".activeOrg", { val: userData.activeOrg, ack: true });

				await this.setObjectNotExistsAsync("users." + userData.sub + ".access_token", {
					type: "state",
					common: {
						name: "access token",
						type: "boolean",
						role: "boolean",
						read: true,
						write: false,
					},
					native: {},
				});
				await this.setStateAsync("users." + userData.sub + ".access_token", { val: userData.access_token, ack: true });

				await this.setObjectNotExistsAsync("users." + userData.sub + ".refresh_token", {
					type: "state",
					common: {
						name: "refresh token",
						type: "boolean",
						role: "boolean",
						read: true,
						write: false,
					},
					native: {},
				});
				await this.setStateAsync("users." + userData.sub + ".refresh_token", { val: userData.refresh_token, ack: true });

				await this.setObjectNotExistsAsync("users." + userData.sub + ".expires_at", {
					type: "state",
					common: {
						name: "expiration",
						type: "string",
						role: "text",
						read: true,
						write: false,
					},
					native: {},
				});
				await this.setStateAsync("users." + userData.sub + ".expires_at", { val: userData.expires_at, ack: true });

				await this.setObjectNotExistsAsync("users." + userData.sub + ".locale", {
					type: "state",
					common: {
						name: "locale",
						type: "string",
						role: "text",
						read: true,
						write: false,
					},
					native: {},
				});
				await this.setStateAsync("users." + userData.sub + ".locale", { val: userData.locale, ack: true });

				await this.setObjectNotExistsAsync("users." + userData.sub + ".permissions", {
					type: "state",
					common: {
						name: "permissions",
						type: "string",
						role: "text",
						read: true,
						write: false,
					},
					native: {},
				});
				await this.setStateAsync("users." + userData.sub + ".permissions", { val: JSON.stringify(userData.permissions), ack: true });

				return true;

			}
			else if (userInfo.status === 401 && loginIfForbidden) {
				await this.Login();
				await this.GetUserInfo(false);
			}
			else {
				console.error("Getting user info failed");
			}
		}
		catch (error) {
			console.error("Error while getting user info", error);
		}
	}

	async GetChargingSessions(loginIfForbidden = false, from, until) {
		try {

			const xsrfToken = this.GetXsrfTokenFromCookie("id.libreo.cloud");
			const apiResponse = await this.client.get("https://portal.libreo.cloud/api/assets/chargingsessions", {
				headers: {
					"X-Xsrf-Token": xsrfToken,
				},
				validateStatus: null,
				params: {
					"api-version": "1.0",
					"pageNumber": 1,
					"pageSize": 100,
					"start": from,
					"end": until
				}
			});

			if (apiResponse.status === 200)
			{
				this.log.debug("API-Response-Status: " + apiResponse.status);

				//console.log('Auth-Response: ' + CircularJSON.stringify(apiResponse));

				const chargingData = apiResponse.data.data;
				chargingData.forEach(async(session) => {

					if (!session)
						return;

					const sessionId = (session.chargingSessionId + "").padStart(5, "0");

					await this.setObjectNotExistsAsync("chargingsessions." + sessionId, {
						type: "channel",
						common: {
							name: session.creationDate
						},
						native: {},
					});

					await this.setObjectNotExistsAsync("chargingsessions." + sessionId + ".id", {
						type: "state",
						common: {
							name: "id",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync("chargingsessions." + sessionId + ".id", { val: session.id, ack: true });

					await this.setObjectNotExistsAsync("chargingsessions." + sessionId + ".chargingStationId", {
						type: "state",
						common: {
							name: "charging station id",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync("chargingsessions." + sessionId + ".chargingStationId", { val: session.chargingStationId, ack: true });

					await this.setObjectNotExistsAsync("chargingsessions." + sessionId + ".chargingStationName", {
						type: "state",
						common: {
							name: "charging station name",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync("chargingsessions." + sessionId + ".chargingStationName", { val: session.chargingStationName, ack: true });

					await this.setObjectNotExistsAsync("chargingsessions." + sessionId + ".chargingStatus", {
						type: "state",
						common: {
							name: "charging status",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync("chargingsessions." + sessionId + ".chargingStatus", { val: session.chargingStatus, ack: true });

					await this.setObjectNotExistsAsync("chargingsessions." + sessionId + ".location", {
						type: "state",
						common: {
							name: "charging location",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync("chargingsessions." + sessionId + ".location", { val: session.location, ack: true });

					await this.setObjectNotExistsAsync("chargingsessions." + sessionId + ".organizationPath", {
						type: "state",
						common: {
							name: "organization path",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync("chargingsessions." + sessionId + ".organizationPath", { val: session.organizationPath, ack: true });

					await this.setObjectNotExistsAsync("chargingsessions." + sessionId + ".sessionStarted", {
						type: "state",
						common: {
							name: "session started",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync("chargingsessions." + sessionId + ".sessionStarted", { val: session.sessionStarted, ack: true });

					await this.setObjectNotExistsAsync("chargingsessions." + sessionId + ".sessionCompleted", {
						type: "state",
						common: {
							name: "session completed",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync("chargingsessions." + sessionId + ".sessionCompleted", { val: session.sessionCompleted, ack: true });

					await this.setObjectNotExistsAsync("chargingsessions." + sessionId + ".sessionDuration", {
						type: "state",
						common: {
							name: "session duration in seconds",
							type: "number",
							role: "value",
							read: true,
							write: false,
							unit: "s"
						},
						native: {},
					});
					await this.setStateAsync("chargingsessions." + sessionId + ".sessionDuration", { val: session.sessionDuration, ack: true });

					await this.setObjectNotExistsAsync("chargingsessions." + sessionId + ".sessionEnergyAmount", {
						type: "state",
						common: {
							name: "session energy amount in Wh",
							type: "number",
							role: "value",
							read: true,
							write: false,
							unit: "Wh"
						},
						native: {},
					});
					await this.setStateAsync("chargingsessions." + sessionId + ".sessionEnergyAmount", { val: session.sessionEnergyAmount, ack: true });

					if (session.user) {

						await this.setObjectNotExistsAsync("chargingsessions." + sessionId + ".user" + ".id", {
							type: "state",
							common: {
								name: "user id",
								type: "string",
								role: "text",
								read: true,
								write: false,
							},
							native: {},
						});
						await this.setStateAsync("chargingsessions." + sessionId + ".user" + ".id", { val: session.user.id, ack: true });

						await this.setObjectNotExistsAsync("chargingsessions." + sessionId + ".user" + ".firstName", {
							type: "state",
							common: {
								name: "first name",
								type: "string",
								role: "text",
								read: true,
								write: false,
							},
							native: {},
						});
						await this.setStateAsync("chargingsessions." + sessionId + ".user" + ".firstName", { val: session.user.firstName, ack: true });

						await this.setObjectNotExistsAsync("chargingsessions." + sessionId + ".user" + ".lastName", {
							type: "state",
							common: {
								name: "last name",
								type: "string",
								role: "text",
								read: true,
								write: false,
							},
							native: {},
						});
						await this.setStateAsync("chargingsessions." + sessionId + ".user" + ".lastName", { val: session.user.lastName, ack: true });
					}
				});

				return true;
			}
			else if (apiResponse.status === 401 && loginIfForbidden) {
				await this.Login();
				await this.GetChargingSessions(false, from, until);
			}
			else {
				this.log.warn("Getting charging sessions failed");
			}
		}
		catch (error) {
			this.log.error("Error while getting charging sessions: " + error);
		}
	}

	async StartWebSocket(org, orgPath) {
		try {

			const xsrfToken = this.GetXsrfTokenFromCookie("portal.libreo.cloud");

			const negotiate = await this.client.post("https://portal.libreo.cloud/api/customer/hubs/metrics/negotiate?negotiateVersion=1", {
				negotiateVersion: 1,
			}, {
				headers: {
					"Content-Type": "application/json",
					"X-Xsrf-Token": xsrfToken,
					"Referer": "https://portal.libreo.cloud/charging-stations",
				},
				maxRedirects: 0,
				validateStatus: status => status >= 200 && status < 400 || status === 302
			});

			this.log.debug("Negotiate-Response-Status: " + negotiate.status);
			//console.log('UserInfo-Response-Data: ' + CircularJSON.stringify(negotiate));

			if (negotiate.status === 200) {

				//const connectionId = negotiate.data.connectionId;
				const connectionToken = negotiate.data.connectionToken;

				// WebSocket-URL
				const wsUrl = `wss://portal.libreo.cloud/api/customer/hubs/metrics?id=${connectionToken}`;
				const cookieHeader = this.cookieJar.getCookieStringSync("https://portal.libreo.cloud");

				const instance = this;

				// Bestehende WebSocket-Verbindung schließen
				if (instance.ws)
					instance.ws.close();

				// Verbindung zum WebSocket-Server herstellen
				instance.ws = new WebSocket(wsUrl,
					{
						headers: {
							"Cookie": cookieHeader,
							"Origin": "https://portal.libreo.cloud",
							"Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits"
						}
					});

				// Ereignishandler für die Verbindungseröffnung
				instance.ws.on("open", () => {
					instance.log.info("WebSocket connection opened.");

					// Send handshake
					instance.ws.send(JSON.stringify({ protocol: "json", version: 1 }) + "\u001e");
				});

				// Ereignishandler für empfangene Nachrichten
				instance.socketInvocationId = instance.socketInvocationId + 1;
				instance.ws.on("message", (data) => {

					const messageString = data.toString();
					try {

						this.log.debug("WS data received: " + messageString);

						//Bei Empfang des initialen Handshakes, senden wir unseren Subscribe-Wunsch
						if (messageString == "{}\u001e") {
							const message = JSON.stringify(
								{
									arguments: [org],
									invocationId: ("" + instance.socketInvocationId++),
									target: "SubscribeMetricsByOrgPath",
									type: 1
								}
							) + "\u001e";
							instance.log.debug("send ws message: " + message);
							instance.ws.send(message);
						}
						else {
							const messages = messageString.split("\u001e");
							for (let i = 0; i < messages.length; i++) {
								if (messages[i]) {
									instance.ParseMetricsMessage(orgPath, messages[i]);
								}
							}
						}
					} catch (error) {
						console.error("error while parsing ws message: ", error);
					}
				});

				// Ereignishandler für Verbindungsfehler
				instance.ws.on("error", (error) => {
					instance.log.error("WebSocket-Error: " + error);
				});

				// Ereignishandler für Verbindungsbeendigung
				instance.ws.on("close", () => {
					instance.log.info("WebSocket connection closed.");
				});

				// Zusätzliche Protokollierung der Verbindungsdetails
				instance.ws.on("unexpected-response", (request, response) => {
					instance.log.warn("Unexpexted ws response:");
					instance.log.warn("Status Code: " + response.statusCode);
					instance.log.warn("Headers: " + JSON.stringify(response.headers));
					response.on("data", (data) => {
						instance.log.warn("Body: " + data.toString());
					});
				});
			}
		}
		catch (error) {
			this.log.error("Error while initiating web socket connection: " + error);
		}
	}

	async ParseMetricsMessage(org, message) {
		try {
			const m = JSON.parse(message);
			if (m.target == "receiveMetrics") {

				const instance = this;
				m.arguments.forEach(async(metric) => {

					const chargingStationId = metric.chargingStationId;
					const path = org + "." + chargingStationId + ".metrics";

					await instance.setObjectNotExistsAsync(path, {
						type: "channel",
						common: {
							name: "metrics",
						},
						native: {},
					});

					await instance.setObjectNotExistsAsync(path + ".last_updated", {
						type: "state",
						common: {
							name: "online",
							type: "number",
							role: "value.time",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + ".last_updated", { val: new Date().getTime(), ack: true });

					await instance.setObjectNotExistsAsync(path + ".online", {
						type: "state",
						common: {
							name: "online",
							type: "boolean",
							role: "boolean",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + ".online", { val: metric.online, ack: true });

					await instance.setObjectNotExistsAsync(path + ".available", {
						type: "state",
						common: {
							name: "available",
							type: "boolean",
							role: "boolean",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + ".available", { val: metric.available, ack: true });

					await instance.setObjectNotExistsAsync(path + ".charging", {
						type: "state",
						common: {
							name: "charging",
							type: "boolean",
							role: "boolean",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + ".charging", { val: metric.charging, ack: true });

					await instance.setObjectNotExistsAsync(path + ".simpleCharge", {
						type: "state",
						common: {
							name: "simple charge",
							type: "boolean",
							role: "boolean",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + ".simpleCharge", { val: metric.simpleCharge, ack: true });

					await instance.setObjectNotExistsAsync(path + ".plugged", {
						type: "state",
						common: {
							name: "plugged",
							type: "boolean",
							role: "boolean",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + ".plugged", { val: metric.plugged, ack: true });

					await instance.setObjectNotExistsAsync(path + ".maxCurrent", {
						type: "state",
						common: {
							name: "max current",
							type: "number",
							role: "value",
							read: true,
							write: false,
							unit: "A",
						},
						native: {},
					});
					await this.setStateAsync(path + ".maxCurrent", { val: metric.maxCurrent, ack: true });

					await instance.setObjectNotExistsAsync(path + ".dynamicCurrent", {
						type: "state",
						common: {
							name: "dynamic current",
							type: "number",
							role: "value",
							read: true,
							write: false,
							unit: "A",
						},
						native: {},
					});
					await this.setStateAsync(path + ".dynamicCurrent", { val: metric.dynamicCurrent, ack: true });

					await instance.setObjectNotExistsAsync(path + ".chargingMode", {
						type: "state",
						common: {
							name: "charging mode",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + ".chargingMode", { val: metric.chargingMode, ack: true });

					await instance.setObjectNotExistsAsync(path + ".status", {
						type: "state",
						common: {
							name: "status",
							type: "string",
							role: "text",
							read: true,
							write: false,
						},
						native: {},
					});
					await this.setStateAsync(path + ".status", { val: metric.status, ack: true });

					if (metric.currentSessionState) {
						await instance.setObjectNotExistsAsync(path + ".currentSessionState", {
							type: "channel",
							common: {
								name: "current session state",
							},
							native: {},
						});

						await instance.setObjectNotExistsAsync(path + ".currentSessionState.startTime", {
							type: "state",
							common: {
								name: "start time",
								type: "string",
								role: "text",
								read: true,
								write: false,
							},
							native: {},
						});

						if (metric.currentSessionState.startTime)
							await this.setStateAsync(path + ".currentSessionState.startTime", { val: metric.currentSessionState.startTime, ack: true });

						await instance.setObjectNotExistsAsync(path + ".currentSessionState.status", {
							type: "state",
							common: {
								name: "status",
								type: "number",
								role: "value",
								read: true,
								write: false,
							},
							native: {},
						});

						if (metric.currentSessionState.status)
							await this.setStateAsync(path + ".currentSessionState.status", { val: metric.currentSessionState.status, ack: true });

						await instance.setObjectNotExistsAsync(path + ".currentSessionState.consumedEnergy", {
							type: "state",
							common: {
								name: "consumedEnergy",
								type: "number",
								role: "value",
								read: true,
								write: false,
							},
							native: {},
						});

						if (metric.currentSessionState.consumedEnergy)
							await this.setStateAsync(path + ".currentSessionState.consumedEnergy", { val: metric.currentSessionState.consumedEnergy, ack: true });

						await instance.setObjectNotExistsAsync(path + ".currentSessionState.trigger", {
							type: "state",
							common: {
								name: "trigger",
								type: "string",
								role: "text",
								read: true,
								write: false,
							},
							native: {},
						});

						if (metric.currentSessionState.trigger)
							await this.setStateAsync(path + ".currentSessionState.trigger", { val: metric.currentSessionState.trigger, ack: true });

						if (metric.currentSessionState.triggerUser) {
							await instance.setObjectNotExistsAsync(path + ".currentSessionState.trigger_firstName", {
								type: "state",
								common: {
									name: "trigger first name",
									type: "string",
									role: "text",
									read: true,
									write: false,
								},
								native: {},
							});

							if (metric.currentSessionState.triggerUser.firstName)
								await this.setStateAsync(path + ".currentSessionState.trigger_firstName", { val: metric.currentSessionState.triggerUser.firstName, ack: true });

							await instance.setObjectNotExistsAsync(path + ".currentSessionState.trigger_lastName", {
								type: "state",
								common: {
									name: "trigger last name",
									type: "string",
									role: "text",
									read: true,
									write: false,
								},
								native: {},
							});

							if (metric.currentSessionState.triggerUser.lastName)
								await this.setStateAsync(path + ".currentSessionState.trigger_lastName", { val: metric.currentSessionState.triggerUser.lastName, ack: true });

							await instance.setObjectNotExistsAsync(path + ".currentSessionState.trigger_originalUser", {
								type: "state",
								common: {
									name: "trigger original user",
									type: "string",
									role: "text",
									read: true,
									write: false,
								},
								native: {},
							});

							if (metric.currentSessionState.triggerUser.originalUser)
								await this.setStateAsync(path + ".currentSessionState.trigger_originalUser", { val: metric.currentSessionState.triggerUser.originalUser, ack: true });
						}

						if (metric.currentSessionState.lastMetricsData) {

							const currentArray = metric.currentSessionState.lastMetricsData.current;
							if (currentArray && currentArray.length > 0) {

								for (let i = 0; i < currentArray.length; i++) {

									const currentPath = path + ".currentSessionState.current_p" + (i + 1);
									await instance.setObjectNotExistsAsync(currentPath, {
										type: "state",
										common: {
											name: "current phase " + (i + 1),
											type: "number",
											role: "value",
											unit: "A",
											read: true,
											write: false,
										},
										native: {},
									});

									await this.setStateAsync(currentPath, { val: currentArray[i], ack: true });
								}
							}

							const powerArray = metric.currentSessionState.lastMetricsData.power;
							if (powerArray && powerArray.length > 0) {

								for (let i = 0; i < powerArray.length; i++) {

									const currentPath = path + ".currentSessionState.power_p" + (i + 1);
									await instance.setObjectNotExistsAsync(currentPath, {
										type: "state",
										common: {
											name: "power phase " + (i + 1),
											type: "number",
											role: "value",
											unit: "Wh",
											read: true,
											write: false,
										},
										native: {},
									});

									await this.setStateAsync(currentPath, { val: powerArray[i], ack: true });
								}

								await instance.setObjectNotExistsAsync(path + ".currentSessionState.power_sum", {
									type: "state",
									common: {
										name: "power sum",
										type: "number",
										role: "value",
										unit: "Wh",
										read: true,
										write: false,
									},
									native: {},
								});

								const powerSum = powerArray.reduce((a, b) => a + b, 0);
								await this.setStateAsync(path + ".currentSessionState.power_sum", { val: powerSum, ack: true });
							}

							const voltageArray = metric.currentSessionState.lastMetricsData.voltage;
							if (voltageArray && voltageArray.length > 0) {

								for (let i = 0; i < voltageArray.length; i++) {

									const currentPath = path + ".currentSessionState.voltage_p" + (i + 1);
									await instance.setObjectNotExistsAsync(currentPath, {
										type: "state",
										common: {
											name: "voltage phase " + (i + 1),
											type: "number",
											role: "value",
											unit: "V",
											read: true,
											write: false,
										},
										native: {},
									});

									await this.setStateAsync(currentPath, { val: voltageArray[i], ack: true });
								}
							}
						}

						//Session Ende
						if (metric.currentSessionState.status == 267 || metric.currentSessionState.status == 277)
						{
							const pattern = path + ".currentSessionState.*";
							const states = await this.getStatesAsync(pattern);

							if (states && Object.keys(states).length > 0) {
								Object.keys(states).forEach(async(stateId) => {
									await this.setStateAsync(stateId, { val: null, ack: true });
								});
							}
						}
					}
				});
			}
		}
		catch (error) {
			this.log.warn("Error while parsing metric data: " + error);
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Libreo(options);
} else {
	// otherwise start the instance directly
	new Libreo();
}