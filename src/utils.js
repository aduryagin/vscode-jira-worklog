const vscode = require('vscode');
const constants = require('./constants');
const https = require('https');

function getNormalizedTime(seconds) {
  function numberWithZero(number) {
    if (number < 10) return `0${number}`;

    return number;
  }

  return `${numberWithZero(Math.floor(seconds / 60 / 60))}:${numberWithZero(Math.floor((seconds / 60) % 60))}:${numberWithZero(seconds % 60)}`;
}

const requestCreator = (login, context) => {
  return async (path, method, data) => {
    const hostSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraHostSettingKey);
    const basicAuthLoginSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraProjectBasicAuthLoginKey);
    const basicAuthPasswordSetting = vscode.workspace.getConfiguration().get(constants.settings.jiraProjectBasicAuthPasswordKey);
  
    const jiraPort = hostSetting.indexOf('https://') > -1 ? 443: 80;
    const hostSettingWithoutProtocol = hostSetting.replace(/https?:\/\//i, '');
    const postData = JSON.stringify(data);
    const session = context.globalState.get(constants.jiraSessionState);
  
    return new Promise((resolve, reject) => {
      const authRequest = https.request({
        method,
        port: jiraPort,
        hostname: hostSettingWithoutProtocol,
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
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
          let jsonData;
          if (dataQueue.indexOf('Unauthorized') > -1) {
            await login(true);
            jsonData = await request(path, method, data);
            return resolve(jsonData);
          }
  
          jsonData = JSON.parse(dataQueue);
          resolve(jsonData);
        });
      });
  
      authRequest.on('error', (error) => {
        reject(error);
      });
  
      authRequest.write(postData);
      authRequest.end();
    });
  }
  
}

module.exports = {
  getNormalizedTime,
  requestCreator
}