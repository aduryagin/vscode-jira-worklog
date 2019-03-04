	const vscode = require('vscode');
	const https = require('https');

	// global state keys

	const jiraSessionState = 'jira-session';

	// settings keys

	const jiraWorklogCommentKey = 'jira-worklog.worklog.comment';
	const jiraHostSettingKey = 'jira-worklog.host';
	const jiraLoginSettingKey = 'jira-worklog.login';
	const jiraPasswordSettingKey = 'jira-worklog.password';
	const jiraProjectSettingKey = 'jira-worklog.project';
	const jiraProjectBasicAuthLoginKey = 'jira-worklog.basicAuth.login';
	const jiraProjectBasicAuthPasswordKey = 'jira-worklog.basicAuth.password';

	let interval;

	function getNormalizedTime(seconds) {
		function numberWithZero(number) {
			if (number < 10) return `0${number}`;

			return number;
		}

		return `${numberWithZero(Math.floor(seconds / 60 / 60))}:${numberWithZero(Math.floor(seconds / 60))}:${numberWithZero(seconds % 60)}`;
	}

	/**
	 * @param {vscode.ExtensionContext} context
	 */
	function activate(context) {
		const logWorkStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
		const logWorkCommandID = 'vscode-jira-logwork.logwork';
		let started = false;

		function resetExtensionState() {
			context.globalState.update(jiraSessionState, '');
		}

		const request = async (path, method, data) => {
			const hostSetting = vscode.workspace.getConfiguration().get(jiraHostSettingKey);
			const basicAuthLoginSetting = vscode.workspace.getConfiguration().get(jiraProjectBasicAuthLoginKey);
			const basicAuthPasswordSetting = vscode.workspace.getConfiguration().get(jiraProjectBasicAuthPasswordKey);

			const jiraPort = hostSetting.indexOf('https://') > -1 ? 443: 80;
			const hostSettingWithoutProtocol = hostSetting.replace(/https?:\/\//i, '');
			const postData = JSON.stringify(data);
			const session = context.globalState.get(jiraSessionState);

			return new Promise((resolve, reject) => {
				const authRequest = https.request({
					method,
					port: jiraPort,
					hostname: hostSettingWithoutProtocol,
					path,
					headers: {
						'Content-Type': 'application/json',
						'Content-Length': postData.length,
						...(session ? { 'Cookie': `JSESSIONID=${session}`} : {}),
						...(
							basicAuthLoginSetting && basicAuthPasswordSetting ?
								{
									Authorization: `Basic ${Buffer.from(`${basicAuthLoginSetting}:${basicAuthPasswordSetting}`).toString('base64')}`
								} :
								{}
							)
					}
				}, (response) => {
					let dataQueue = '';
					response.on('data', (chunk) => {
						dataQueue += chunk;
					});

					response.on('end', async () => {
						let data;
						if (dataQueue.indexOf('Unauthorized') > -1) {
							await login(true);
							data = await request(path, method, data);
							return resolve(data);
						}

						data = JSON.parse(dataQueue);
						resolve(data);
					});
				});
		
				authRequest.on('error', (error) => {
					reject(error);
				});
		
				authRequest.write(postData);
				authRequest.end();
			});
		}

		const sendWorkLog = async (taskNumber, seconds) => {
			try {
				const projectSetting = vscode.workspace.getConfiguration().get(jiraProjectSettingKey);
				const comment = vscode.workspace.getConfiguration().get(jiraWorklogCommentKey).replace(/{TaskNumber}/g, taskNumber).replace(/{JiraProject}/g, projectSetting);
				let spentSeconds = Math.ceil(new Date().getTime() / 1000 - new Date(started).getTime() / 1000);
				spentSeconds = spentSeconds < 60 ? 60 : spentSeconds;

				const data = await request(`/rest/api/2/issue/${projectSetting}-${taskNumber}/worklog`, 'POST', {
					...(comment ? { comment } : {}),
					started: new Date(started).toISOString().replace('Z', '+0000'),
					timeSpentSeconds: spentSeconds.toString(),
				});

				if (data.errorMessages) {
					vscode.window.showErrorMessage(`Jira log work: ${data.errorMessages[0]}`);
				}
			} catch (e) {
				console.log(e);
				vscode.window.showErrorMessage('Jira log work: Something went wrong');
			}
		}

		function registerEvents() {
			try {
				const rootPath = vscode.workspace.workspaceFolders[0].uri.path;
				let gitBranch = require('child_process').execSync(`cd ${rootPath}; git rev-parse --abbrev-ref HEAD`).toString().trim();
				let taskNumber = gitBranch.replace(/[^0-9]/g, '');
				const projectSetting = vscode.workspace.getConfiguration().get(jiraProjectSettingKey);
				let seconds = 0;

				function startWorkLog() {
					started = new Date().getTime();
					const lastWorkLogSeconds = context.globalState.get(gitBranch) || 0;

					function runWorkLog() {
						seconds = Math.floor((new Date().getTime() - started) / 1000) + lastWorkLogSeconds;
						context.globalState.update(gitBranch, seconds);
	
						logWorkStatusBarItem.text = `$(clock) Pause worklog (${getNormalizedTime(seconds)}) for ${projectSetting}-${taskNumber}`;
					}

					interval = setInterval(() => {
						runWorkLog();
					}, 1000);
					runWorkLog();
				}

				function setCommandStartToButton() {
					logWorkStatusBarItem.show();
					logWorkStatusBarItem.text = `$(clock) Start worklog (${getNormalizedTime(context.globalState.get(gitBranch))}) for ${projectSetting}-${taskNumber}`;
					
					if (!logWorkStatusBarItem.command) {
						logWorkStatusBarItem.command = logWorkCommandID;
					}
				}

				function stopWorkLog(oldTaskNumber) {
					setCommandStartToButton();
					sendWorkLog(oldTaskNumber || taskNumber, seconds);

					clearInterval(interval);
					started = false;
					seconds = 0;
				}

				context.subscriptions.push(vscode.commands.registerCommand(logWorkCommandID, () => {
					if (!started) {
						startWorkLog();
					} else {
						stopWorkLog();
					}
				}));

				if (gitBranch && taskNumber) {
					setCommandStartToButton();
				}

				setInterval(() => {
					const newGitBranch = require('child_process').execSync(`cd ${rootPath}; git rev-parse --abbrev-ref HEAD`).toString().trim();
					const oldTaskNumber = gitBranch.replace(/[^0-9]/g, '');
					taskNumber = newGitBranch.replace(/[^0-9]/g, '');
				
					if (newGitBranch !== gitBranch) {
						gitBranch = newGitBranch;
						if (taskNumber) {
							if (!started) {
								setCommandStartToButton();
							} else {
								stopWorkLog(oldTaskNumber);
								startWorkLog();
							}
						} else {
							stopWorkLog(oldTaskNumber);
							logWorkStatusBarItem.hide();
						}
					}
				}, 1500);
			} catch (e) {
				console.log(e);
				vscode.window.showErrorMessage('Jira log work: Something went wrong');
			}
		}

		async function login(withoutRegisterEvents) {
			const hostSetting = vscode.workspace.getConfiguration().get(jiraHostSettingKey);
			const loginSetting = vscode.workspace.getConfiguration().get(jiraLoginSettingKey);
			const passwordSetting = vscode.workspace.getConfiguration().get(jiraPasswordSettingKey);
			const projectSetting = vscode.workspace.getConfiguration().get(jiraProjectSettingKey);

			if (hostSetting && loginSetting && passwordSetting && projectSetting) {
				logWorkStatusBarItem.show();
				logWorkStatusBarItem.text = '$(sync~spin) jira logwork: authorization...';
			
				try {
					const data = await request('/rest/auth/1/session', 'POST', { username: loginSetting, password: passwordSetting });
					context.globalState.update(jiraSessionState, data.session.value);

					if (!withoutRegisterEvents) {
						registerEvents();
					}
				} catch (e) {
					console.log(e);
					logWorkStatusBarItem.hide();
					vscode.window.showErrorMessage('Jira log work: Incorrect login or password');
				}
			} else {
				vscode.window.showInformationMessage('Jira log work: Set host, login, password, project in preferences');
			}
		}

		function init() {
			logWorkStatusBarItem.show();

			if (!context.globalState.get(jiraSessionState)) {
				login();
			} else {
				registerEvents();
			}
		}

		function onDidChangeConfiguration() {
			context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
				if (
					event.affectsConfiguration(jiraHostSettingKey) ||
					event.affectsConfiguration(jiraLoginSettingKey) ||
					event.affectsConfiguration(jiraPasswordSettingKey) ||
					event.affectsConfiguration(jiraProjectSettingKey) ||
					event.affectsConfiguration(jiraProjectBasicAuthLoginKey) ||
					event.affectsConfiguration(jiraProjectBasicAuthPasswordKey)
				) {
					login();
				}
			}));
		}

		// todo onBranchChange

		init();
		onDidChangeConfiguration(); // relogin after settings change
	}
	exports.activate = activate;

	// this method is called when your extension is deactivated
	function deactivate() {}

	module.exports = {
		activate,
		deactivate
	}
