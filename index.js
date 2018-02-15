/* jshint node: true */
'use strict';

var BasePlugin = require('ember-cli-deploy-plugin');
var RSVP    = require('rsvp');
var sshClient  = require('./lib/ssh-client');
var path       = require('path');
var Rsync      = require('rsync');
var exec       = require('child_process').exec;
var simpleGit  = require('simple-git');

module.exports = {
  name: 'ember-cli-deploy-passenger',

  createDeployPlugin: function(options) {
    var activeBranch ='';
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
        agent: null,
        appFiles: [],
        branch: 'development',
        directory: 'tmp/deploy-dist/.',
        displayCommands: true,
        exclude: false,
        flags: 'rtvu',
        host: '',
        password: null,
        path: '~/apps/',
        port: 22,
        privateKeyPath: '~/.ssh/id_rsa',
        username: ''
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
          agent: this.readConfig('agent'),
        };

        this._client = new this._sshClient(options);
        return this._client.connect(this);
      },

      willBuild(context) {
        var _this = this;
        return new RSVP.Promise(function(resolve, reject) {
          let git = simpleGit();
          let deployTarget = context.deployTarget;
          let branch = context.commandOptions.branch || _this.readConfig('branch');
          let force = context.commandOptions.force || false;
          _this.log('Deploying branch ' + branch + ' to ' + _this.readConfig('host') + '.');

          // get git status
          git.status(function(error, statusSummary){
            if (error) {
              reject(error);
            }

            if (!force && statusSummary.files.length > 0) { //git is dirty
              reject('Git: working directory is dirty');
            }

            activeBranch = statusSummary.current;
            // change branch
            git.branchLocal(function(errors, branchSummary){
              if (error) {
                reject(error);
              }
              if (branchSummary.all.indexOf(branch) !== -1) {
                git.checkout(branch, function(error) {
                  if (error) {
                    reject(error);
                  }
                  _this.log('Git: branch ' + branch + ' checked out', {verbose: true});
                  resolve();
                });
              } else {
                reject('Git: no local branch '+branch);
              }
            });
          });
        });
      },

      upload: function (context) {
        var deployPath = path.posix.join(this.readConfig('path'), '/');
        //do something here to actually deploy your app somewhere

        return RSVP.Promise.all([
          this._uploadApp(context),
          this._uploadAppFiles(deployPath) // upload app files
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
        });
      },

      didActivate() {
        return this._appRestart(this.readConfig('path')); // restart app
      },

      didDeploy: function () {
        var deployPath = path.posix.join(this.readConfig('path'), '/');
        return this._npmInstall(deployPath);
      },

      fetchRevisions() {
        return this._generateRevisionData().then(function (data) {
          return {
            revisions: data
          };
        });
      },


      fetchInitialRevisions() {
        return this._generateRevisionData().then(function (data) {
          return {
            revisions: data
          };
        });
      },

      teardown() {
        if (activeBranch) {
          let git = simpleGit();
          let _this = this;
          return git.checkout(activeBranch, function (error) {
            if (error) {
              RSVP.Promise.reject(error);
            }
            _this.log('Git: reverted, branch ' + activeBranch + ' checked out', {verbose: true});
            RSVP.Promise.resolve();
          });
        }
      },

      _appRestart(appPath) {
        var _this = this;
        var touchCmd = '/usr/bin/env passenger-config restart-app '+appPath+' --ignore-app-not-running';
        this.log('Restarting');
        return this._execCmd(touchCmd, function () {
          _this.log('Restart command finished');
        });
      },

      _npmInstall(appPath) {
        var _this = this;
        var npmCmd = 'cd ' + appPath + ' && npm install';
        this.log('NPM Install...');
        return this._execCmd(npmCmd, function () {
          _this.log('NPM Finish');
        });
      },

      _uploadApp() {
        var _this = this;
        this.log('Uploading ...');
        var revisionKey = this.readConfig('revisionKey'),
          targetPath = this.readConfig('username') + '@' + this.readConfig('host') + ':' + this.readConfig('path'),
          rsyncPath = path.posix.join(targetPath, 'releases', '/', revisionKey);
        return this._rsync(rsyncPath).then(function () {
          _this.log('Uploaded');
          _this.log('Moving...');
          // symlink rsyncPath ../../shared/assets
          // mv assets/* /home/domena.cz/apps/frontend/shared/assets
          var cmd = `cp ${path.posix.join(_this.readConfig('path'), 'releases', '/', revisionKey, '/', 'assets', '/', '*') } ${path.posix.join(_this.readConfig('path'), '/', 'shared', '/', 'assets')} && ` +
            `mv ${path.posix.join(_this.readConfig('path'), 'releases', '/', revisionKey, '/', 'assets') } ${path.posix.join(_this.readConfig('path'), 'releases', '/', revisionKey, '/', 'assets_bak') } && ` +
            `ln -s ${path.posix.join(_this.readConfig('path'), '/', 'shared', '/', 'assets')} ${path.posix.join(_this.readConfig('path'), 'releases', '/', revisionKey, '/', 'assets') }`;
          return _this._execCmd(cmd, function() {
            _this.log('Moved');
          });
        });
      },

      _uploadAppFiles(appPath) {
        var _this = this;
        var client = this._client;
        var srcFiles = this.readConfig('appFiles');
        var dest = '';
        var promises = [];
        srcFiles.forEach(function(file) {
          dest = path.posix.join(appPath, '/', file);
          _this.log('Uploading '+file, {verbose: true});
          promises.push(client.putFile(file, dest).then(function () {
            _this.log('Uploaded '+file, {verbose: true});
          }));
        });
        return RSVP.Promise.all(promises);
      },

      _execCmd: function (cmd, success) {
        var client = this._client;
        var _this = this;
        this.log('Exec cmd: ' + cmd, {verbose: true});
        return client
          .exec(cmd)
          .then(function (result) {
            _this.log('Cmd result:' + typeof(result)==='object' ? JSON.stringify(result) : result);
            if (typeof (success) !== 'undefined') {
              success(result);
            }
          }, function (e) {
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
        return new RSVP.Promise(function(resolve) {
          var rsync = new Rsync()
            .shell('ssh -p ' + _this.readConfig('port'))
            .flags(_this.readConfig('flags'))
            .source(_this.readConfig('directory'))
            .destination(destination);

          if (_this.readConfig('exclude')) {
            rsync.exclude(_this.readConfig('exclude'));
          }

          if (_this.readConfig('displayCommands')) {
            _this.log(rsync.command());
          }

          rsync.execute(function () {
            _this.log('Done !');
            resolve();
          });
        });
      },

      _generateRevisionData(){
        var basePath = this.readConfig('path');
        var releaseDir = path.posix.join(basePath, 'releases');
        var _this = this;
        var activeRelease = null;
        return new RSVP.Promise(function (resolve) {
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
        return new RSVP.Promise(function (resolve, reject) {
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
