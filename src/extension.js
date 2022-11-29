const os = require("node:os");
const vscode = require("vscode");
const constants = require("./constants");
const utils = require("./utils");

function activate(context) {
  const logWorkStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  let started = false;
  let issueId = "not-set-yet";
  let interval;
  const _channel = vscode.window.createOutputChannel("Jira Worklog");

  async function login(withoutRegisterEvents) {
    const hostSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraHostSettingKey);
    const loginSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraLoginSettingKey);
    const passwordSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraPasswordSettingKey);

    if (hostSetting && loginSetting && passwordSetting) {
      logWorkStatusBarItem.show();

      if (!withoutRegisterEvents) {
        logWorkStatusBarItem.text = "$(sync~spin) jira logwork: authorization...";
      }

      try {
        const data = await request("/rest/auth/1/session", "POST", { username: loginSetting, password: passwordSetting });
        _channel.appendLine("Login Response:");
        _channel.appendLine("-- " + JSON.stringify(data));
        context.globalState.update(constants.jiraSessionState, data.session.value);

        if (!withoutRegisterEvents) {
          registerEvents();
        }
      } catch (e) {
        error("Incorrect login or password", e);
      }
    } else {
      vscode.window.showInformationMessage("Jira Worklog: Set host, login, password, issueRegex in preferences");
    }
  }

  const request = utils.requestCreator(login, context);

  const sendWorklog = async (issueId) => {
    try {
      const comment = vscode.workspace
        .getConfiguration()
        .get(constants.settings.jiraWorklogCommentKey)
        .replace(/{issueId}/g, issueId);
      let spentSeconds = Math.ceil(new Date().getTime() / 1000 - new Date(started).getTime() / 1000);
      spentSeconds = spentSeconds < 60 ? 60 : spentSeconds;

      const data = await request(`/rest/api/2/issue/${issueId}/worklog`, "POST", {
        ...(comment ? { comment } : {}),
        started: new Date(started).toISOString().replace("Z", "+0000"),
        timeSpentSeconds: spentSeconds.toString(),
      });

      _channel.appendLine("Save Worklog Response:");
      _channel.appendLine(JSON.stringify(data));

      if (data.errorMessages) {
        error("An Error occured while saving Worklog in Jira.", data.errorMessages);
      }
    } catch (e) {
      error("Something went wrong.", e);
    }
  };

  const loadWorklog = async (gitBranch, issueId) => {
    try {
      const data = await request(`/rest/api/2/issue/${issueId}/worklog`, "GET", {});

      _channel.appendLine("Load Worklog Response:");
      _channel.appendLine(JSON.stringify(data));

      const totalTimeSpentSeconds = data.worklogs.reduce((accumulator, object) => {
        return accumulator + object.timeSpentSeconds;
      }, 0);
      context.globalState.update(gitBranch, totalTimeSpentSeconds);
      logWorkStatusBarItem.text = `$(clock) Start Worklog (${utils.getNormalizedTime(totalTimeSpentSeconds || 0)}) for ${issueId}`;

      _channel.appendLine("Load Worklog calulated value: " + totalTimeSpentSeconds);

      if (data.errorMessages) {
        error("An Error occured while loading Worklog in Jira.", data.errorMessages);
      }
    } catch (e) {
      error("Something went wrong.", e);
    }
  };

  function registerEvents() {
    try {
      logWorkStatusBarItem.text = "$(sync~spin) Jira Worklog: register events...";
      let workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.path : "";
      if (os.platform == "win32") {
        workspaceFolder = workspaceFolder.substring(1);
      }
      const rootPath = workspaceFolder;
      let gitBranch;

      try {
        gitBranch = vscode.workspace.workspaceFolders ? require("child_process").execSync("git rev-parse --abbrev-ref HEAD", { cwd: rootPath }).toString().trim() : "";
      } catch (e) {
        logWorkStatusBarItem.hide();
        return vscode.window.showInformationMessage("Jira Worklog: You are not in a git repository.");
      }

      let seconds = 0;

      function startWorklog() {
        started = new Date().getTime();
        const lastWorklogSeconds = context.globalState.get(gitBranch) || 0;

        function runWorklog() {
          seconds = Math.floor((new Date().getTime() - started) / 1000) + lastWorklogSeconds;
          context.globalState.update(gitBranch, seconds);

          logWorkStatusBarItem.text = `$(clock) Pause Worklog (${utils.getNormalizedTime(seconds)}) for ${issueId}`;
        }

        interval = setInterval(() => {
          runWorklog();
        }, 1000);
        runWorklog();
      }

      function setCommandStartToButton() {
        logWorkStatusBarItem.show();
        loadWorklog(gitBranch, issueId);
        logWorkStatusBarItem.text = `$(clock) Load remote Worklog for ${issueId}...`;

        if (!logWorkStatusBarItem.command) {
          logWorkStatusBarItem.command = constants.commands.logWorkCommandID;
        }
      }

      function getIssueId(branch) {
        if (!branch || branch == "") {
          return undefined;
        }
        try {
          let configIssueIdRegex = vscode.workspace.getConfiguration().get(constants.settings.jiraIssueIdRegex);
          let issueIdRegex = configIssueIdRegex ? configIssueIdRegex : ".*\\/(.*)";
          let issueIdRegexp = new RegExp(issueIdRegex, "g");
          let match = issueIdRegexp.exec(branch);
          return match[1];
        } catch (exception) {
          error("could not get issue id using regex [" + configIssueIdRegex + "].");
          return undefined;
        }
      }

      function stopWorklog(oldIssueId) {
        setCommandStartToButton();
        sendWorklog(oldIssueId || issueId, seconds);

        clearInterval(interval);
        started = false;
        seconds = 0;
      }

      context.subscriptions.push(
        vscode.commands.registerCommand(constants.commands.logWorkCommandID, () => {
          if (!started) {
            startWorklog();
          } else {
            stopWorklog();
          }
        })
      );

      issueId = getIssueId(gitBranch);
      if (gitBranch && issueId) {
        setCommandStartToButton();
      } else {
        logWorkStatusBarItem.hide();
      }

      // on branch change
      setInterval(() => {
        const newGitBranch = require("child_process").execSync("git rev-parse --abbrev-ref HEAD", { cwd: rootPath }).toString().trim();
        const oldIssueId = getIssueId(gitBranch);

        issueId = getIssueId(newGitBranch);

        if (newGitBranch !== gitBranch) {
          gitBranch = newGitBranch;
          if (issueId) {
            if (!started) {
              setCommandStartToButton();
            } else {
              stopWorklog(oldIssueId);
              startWorklog();
            }
          } else {
            if (started) {
              stopWorklog(oldIssueId);
            }

            logWorkStatusBarItem.hide();
          }
        }
      }, 1500);
    } catch (e) {
      error("Something went wrong.", e);
    }
  }

  function init() {
    logWorkStatusBarItem.show();
    login();
  }

  function error(message, exception) {
    logWorkStatusBarItem.hide();
    _channel.appendLine(message);
    _channel.appendLine("-- " + exception.stack);
    _channel.show();
    return vscode.window.showErrorMessage(message);
  }

  function onDidChangeConfiguration() {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(constants.settings.jiraHostSettingKey) || event.affectsConfiguration(constants.settings.jiraLoginSettingKey) || event.affectsConfiguration(constants.settings.jiraPasswordSettingKey) || event.affectsConfiguration(constants.settings.jiraIssueIdRegex) || event.affectsConfiguration(constants.settings.jiraProjectBasicAuthLoginKey) || event.affectsConfiguration(constants.settings.jiraProjectBasicAuthPasswordKey)) {
          const hostSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraHostSettingKey);
          const loginSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraLoginSettingKey);
          const passwordSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraPasswordSettingKey);

          if (hostSetting && loginSetting && passwordSetting) {
            login();
          }
        }
      })
    );
  }

  init();
  onDidChangeConfiguration(); // relogin after settings change
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
