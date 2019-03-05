const vscode = require('vscode');
const constants = require('./constants');
const utils = require('./utils');

function activate(context) {
  const logWorkStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  let started = false;
  let interval;

  async function login(withoutRegisterEvents) {
    const hostSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraHostSettingKey);
    const loginSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraLoginSettingKey);
    const passwordSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraPasswordSettingKey);

    if (hostSetting && loginSetting && passwordSetting) {
      logWorkStatusBarItem.show();

      if (!withoutRegisterEvents) {
        logWorkStatusBarItem.text = '$(sync~spin) jira logwork: authorization...';
      }

      try {
        const data = await request('/rest/auth/1/session', 'POST', { username: loginSetting, password: passwordSetting });
        context.globalState.update(constants.jiraSessionState, data.session.value);

        if (!withoutRegisterEvents) {
          registerEvents();
        }
      } catch (e) {
        console.log(e);
        logWorkStatusBarItem.hide();
        vscode.window.showErrorMessage('Jira worklog: Incorrect login or password');
      }
    } else {
      vscode.window.showInformationMessage('Jira worklog: Set host, login, password, project in preferences');
    }
  }

  const request = utils.requestCreator(login, context);

  const sendWorkLog = async (taskNumber) => {
    try {
      const projectSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraProjectSettingKey);
      const comment = vscode.workspace.getConfiguration().get(constants.settings.jiraWorklogCommentKey).replace(/{TaskNumber}/g, taskNumber).replace(/{JiraProject}/g, projectSetting);
      let spentSeconds = Math.ceil(new Date().getTime() / 1000 - new Date(started).getTime() / 1000);
      spentSeconds = spentSeconds < 60 ? 60 : spentSeconds;

      const data = await request(`/rest/api/2/issue/${projectSetting}-${taskNumber}/worklog`, 'POST', {
        ...(comment ? { comment } : {}),
        started: new Date(started).toISOString().replace('Z', '+0000'),
        timeSpentSeconds: spentSeconds.toString(),
      });

      if (data.errorMessages) {
        vscode.window.showErrorMessage(`Jira worklog: ${data.errorMessages[0]}`);
      }
    } catch (e) {
      console.log(e);
      vscode.window.showErrorMessage('Jira worklog: Something went wrong');
    }
  }

  function registerEvents() {
    try {
      const rootPath = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.path : '';
      let gitBranch;

      try {
        gitBranch = vscode.workspace.workspaceFolders ? require('child_process').execSync(`cd ${rootPath}; git rev-parse --abbrev-ref HEAD`).toString().trim() : '';
      } catch {
        return vscode.window.showErrorMessage('Jira worklog: You are not in a git repository.');
      }
      
      let taskNumber = gitBranch.replace(/[^0-9]/g, '');
      const projectSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraProjectSettingKey);
      let seconds = 0;

      function startWorkLog() {
        started = new Date().getTime();
        const lastWorkLogSeconds = context.globalState.get(gitBranch) || 0;

        function runWorkLog() {
          seconds = Math.floor((new Date().getTime() - started) / 1000) + lastWorkLogSeconds;
          context.globalState.update(gitBranch, seconds);

          logWorkStatusBarItem.text = `$(clock) Pause worklog (${utils.getNormalizedTime(seconds)}) for ${projectSetting}-${taskNumber}`;
        }

        interval = setInterval(() => {
          runWorkLog();
        }, 1000);
        runWorkLog();
      }

      function setCommandStartToButton() {
        logWorkStatusBarItem.show();
        logWorkStatusBarItem.text = `$(clock) Start worklog (${utils.getNormalizedTime(context.globalState.get(gitBranch) || 0)}) for ${projectSetting}-${taskNumber}`;
        
        if (!logWorkStatusBarItem.command) {
          logWorkStatusBarItem.command = constants.commands.logWorkCommandID;
        }
      }

      function stopWorkLog(oldTaskNumber) {
        setCommandStartToButton();
        sendWorkLog(oldTaskNumber || taskNumber, seconds);

        clearInterval(interval);
        started = false;
        seconds = 0;
      }

      context.subscriptions.push(vscode.commands.registerCommand(constants.commands.logWorkCommandID, () => {
        if (!started) {
          startWorkLog();
        } else {
          stopWorkLog();
        }
      }));

      if (gitBranch && taskNumber) {
        setCommandStartToButton();
      } else {
        logWorkStatusBarItem.hide();
      }

      // on branch change
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
            if (started) {
              stopWorkLog(oldTaskNumber);
            }

            logWorkStatusBarItem.hide();
          }
        }
      }, 1500);
    } catch (e) {
      console.log(e);
      vscode.window.showErrorMessage('Jira worklog: Something went wrong');
    }
  }

  function init() {
    logWorkStatusBarItem.show();
    login();
  }

  function onDidChangeConfiguration() {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration(constants.settings.jiraHostSettingKey) ||
        event.affectsConfiguration(constants.settings.jiraLoginSettingKey) ||
        event.affectsConfiguration(constants.settings.jiraPasswordSettingKey) ||
        event.affectsConfiguration(constants.settings.jiraProjectSettingKey) ||
        event.affectsConfiguration(constants.settings.jiraProjectBasicAuthLoginKey) ||
        event.affectsConfiguration(constants.settings.jiraProjectBasicAuthPasswordKey)
      ) {
        const hostSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraHostSettingKey);
        const loginSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraLoginSettingKey);
        const passwordSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraPasswordSettingKey);

        if (hostSetting && loginSetting && passwordSetting) {
          login();
        }
      }
    }));
  }

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
