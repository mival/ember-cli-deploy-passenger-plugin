/* jshint node: true */
'use strict';

var BasePlugin = require('ember-cli-deploy-plugin');
var Promise          = require('ember-cli/lib/ext/promise');
var sshClient        = require('./lib/ssh-client');
var path             = require('path');

module.exports = {
  name: 'ember-cli-deploy-passenger',

  createDeployPlugin: function(options) {
    var DeployPlugin = BasePlugin.extend({
      name: options.name,

      _sshClient: sshClient,
      _client: null,
      defaultConfig: {
        distDir: function (context) {
          return context.distDir;
        },
        host: '',
        username: '',
        password: null,
        privateKeyPath: '~/.ssh/id_rsa',
        agent: null,
        port: 22,
        path: '~/apps/'
      },

      configure: function(context) {
        this._super.configure.call(this, context);

        var options = {
          host: this.readConfig('host'),
          username: this.readConfig('username'),
          password: this.readConfig('password'),
          port: this.readConfig('port'),
          privateKeyPath: this.readConfig('privateKeyPath'),
          passphrase: this.readConfig('passphrase'),
          agent: this.readConfig('agent')
        };

        this._client = new this._sshClient(options);
        return this._client.connect(this);
      },

      didBuild: function(context) {
        //do something amazing here once the project has been built
      },

      upload: function() {
        var deployPath = path.posix.join(this.readConfig('path'), '/');
        //do something here to actually deploy your app somewhere
        return this._uploadAppJs(deployPath); // upload app.js
      },

      didDeploy: function() {
        var deployPath = path.posix.join(this.readConfig('path'), '/');
        var _this = this;

        return this._npmInstall(deployPath).then(function() {
          return _this._appRestart(deployPath); // restart app
        });
      },

      _appRestart(appPath) {
        var _this = this;
        var touchCmd = 'touch '+ path.posix.join(appPath, 'tmp', '/') +'restart.txt';
        this.log('Restarting');
        return this._runCmd(touchCmd, function() {
          _this.log('Restart command finished');
        })
      },

      _npmInstall(appPath) {
        var _this = this;
        var npmCmd = 'cd '+ appPath + ' && npm install';
        this.log('NPM Install...');
        return this._runCmd(npmCmd, function() {
          _this.log('NPM Finish');
        })
      },

      _uploadAppJs(appPath) {
        var _this = this;
        var client = this._client;
        var src = 'app.js';
        var dest = path.posix.join(appPath, '/', 'app.js');
        this.log('Uploading app.js');
        return client.putFile(src, dest).then(function() {
          _this.log('Uploaded app.js');
        })
      },

      _runCmd: function(cmd, success) {
        var client = this._client;
        return client
          .exec(cmd)
          .then(success, function (e) {
            this.log('Restart failed:' + e, { color: 'red' });
          });
      },
    });

    return new DeployPlugin();
  },

};
