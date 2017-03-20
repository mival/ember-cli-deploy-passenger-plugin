/* jshint node: true */
'use strict';

var BasePlugin = require('ember-cli-deploy-plugin');
var Promise    = require('ember-cli/lib/ext/promise');
var sshClient  = require('./lib/ssh-client');
var path       = require('path');
var Rsync      = require('rsync');
var exec       = require('child_process').exec;

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
        revisionKey: function (context) {
          return context.commandOptions.revision || (context.revisionData && context.revisionData.revisionKey);
        },
        host: '',
        username: '',
        password: null,
        privateKeyPath: '~/.ssh/id_rsa',
        agent: null,
        port: 22,
        path: '~/apps/',
        directory: 'tmp/deploy-dist/.',
        exclude: false,
        flags: 'rtvu',
        displayCommands: false
      },

      configure: function (context) {
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

      willBuild(context) {
        return new Promise(function(resolve, reject) {
          var deployEnvLn = 'rm .env.deploy && ln -s .env.' + context.deployTarget+' .env.deploy';
          exec(deployEnvLn, function(error) {
            if (error) {
              reject(error);
            }
            resolve();
          })
        });
      },

      upload: function (context) {
        var deployPath = path.posix.join(this.readConfig('path'), '/');
        //do something here to actually deploy your app somewhere

        return Promise.all([
          this._uploadApp(context),
          this._uploadAppJs(deployPath) // upload app.js
        ]);
      },

      activate() {
        var _this = this;
        var revisionKey = this.readConfig('revisionKey');
        var distDir = this.readConfig('distDir');
        var basePath = this.readConfig('path');
        var activateCmd = 'rm -rf ' + path.posix.join(basePath, distDir) + ' && ln -s ' + path.posix.join(basePath, 'releases', revisionKey) + ' ' + path.posix.join(basePath, distDir) + ' && echo ' + revisionKey +' > '+ path.posix.join(basePath, 'REVISION');
        return this._execCmd(activateCmd, function () {
          _this.log('Revision ' + revisionKey + ' activated.');
        })
      },

      didActivate() {
        var deployPath = path.posix.join(this.readConfig('path'), '/');
        return this._appRestart(deployPath); // restart app
      },

      didDeploy: function (context) {
        var deployPath = path.posix.join(this.readConfig('path'), '/');
        return this._npmInstall(deployPath);
      },

      fetchRevisions() {
        return this._generateRevisionData().then(function (data) {
          return {
            revisions: data
          }
        });
      },


      fetchInitialRevisions() {
        return this._generateRevisionData().then(function (data) {
          return {
            revisions: data
          }
        });
      },

      _appRestart(appPath) {
        var _this = this;
        var touchCmd = 'passenger-config restart-app ' + appPath;
        this.log('Restarting');
        return this._execCmd(touchCmd, function () {
          _this.log('Restart command finished');
        })
      },

      _npmInstall(appPath) {
        var _this = this;
        var npmCmd = 'cd ' + appPath + ' && npm install';
        this.log('NPM Install...');
        return this._execCmd(npmCmd, function () {
          _this.log('NPM Finish');
        })
      },

      _uploadApp(context) {
        this.log('Uploading ...');
        var revisionKey = this.readConfig('revisionKey'),
          targetPath = this.readConfig('username') + '@' + this.readConfig('host') + ':' + this.readConfig('path'),
          rsyncPath = path.posix.join(targetPath, 'releases', '/', revisionKey);
        this.log(rsyncPath);
        this._rsync(rsyncPath);
        this.log('Uploaded');
      },

      _uploadAppJs(appPath) {
        var _this = this;
        var client = this._client;
        var src = 'app.js';
        var dest = path.posix.join(appPath, '/', 'app.js');
        this.log('Uploading app.js');
        return client.putFile(src, dest).then(function () {
          _this.log('Uploaded app.js');
        })
      },

      _execCmd: function (cmd, success) {
        var client = this._client;
        var _this = this;
        this.log('Exec cmd: ' + cmd, {verbose: true});
        return client
          .exec(cmd)
          .then(success, function (e) {
            _this.log('Cmd failed:' + e, {color: 'red'});
          });
      },
      _runCmd: function (cmd, success) {
        var client = this._client;
        var _this = this;
        this.log('Running cmd: ' + cmd, {verbose: true});
        return client
          .run(cmd)
          .then(success, function (e) {
            _this.log('Cmd failed:' + e, {color: 'red'});
          });
      },
      _rsync: function (destination) {
        var _this = this;
        var rsync = new Rsync()
          .shell('ssh -p ' + this.readConfig('port'))
          .flags(this.readConfig('flags'))
          .source(this.readConfig('directory'))
          .destination(destination);

        if (this.readConfig('exclude')) {
          rsync.exclude(this.readConfig('exclude'));
        }

        if (this.readConfig('displayCommands')) {
          this.log(rsync.command())
        }

        rsync.execute(function (error, code, cmd) {
          _this.log('Done !');
        });
      },

      _generateRevisionData(){
        var basePath = this.readConfig('path');
        var releaseDir = path.posix.join(basePath, 'releases');
        var _this = this;
        var activeRelease = null;
        return new Promise(function (resolve, reject) {
          _this.log('Listing revisions', {verbose: true});
          var catCmd = 'cat ' + path.posix.join(basePath, 'REVISION');
          _this._runCmd(catCmd).then(function (revisionData) {
            activeRelease = revisionData.success.split("\n")[0];
            _this.log('Activated revision: '+activeRelease, {verbose: true});
            _this._dirList(releaseDir).then(function(dirs) {
              let data = [];
              dirs.forEach(function (dir) {
                data.push({
                  revision: dir,
                  active: activeRelease === dir // indicate whether this revision is activated
                });
              });
              resolve(data);});

          });
        });
      },

      _dirList(path) {
        var _this = this;
        return new Promise(function (resolve, reject) {
          var lsCmd = 'ls ' + path;
          _this.log('Listing directories', {verbose: true});
          _this._runCmd(lsCmd).then(function (result) {
            _this.log('Listing directories result', {verbose: true});
            resolve(result.success.split("\n"));
          }, reject);
        });
      }
    });
    return new DeployPlugin();
  },

};
