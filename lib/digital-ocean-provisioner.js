var _ = require('underscore'),
    _string = require('underscore.string'),
    DigitalOceanAPI = require('digitalocean-api'),
    apiCommands = require('./api_commands'),
    fs = require('fs'),
    Q = require('q'),
    nconf = require('nconf'),
    shell = require('shelljs'),
    async = require('async'),
    path = require('path'),
    tcpPortUsed = require('tcp-port-used'),
    Table = require('cli-table'),
    commander = require('commander'),
    glob = require('glob'),
    moment = require('moment'),
    MicroEvent = require('./microevent'),
    winston = require('winston'),
    DigitalOceanProvisioner;

_.mixin(_string);

/**
 * @class DigitalOceanProvisioner
 */
DigitalOceanProvisioner = function() {
    this.init.apply(this, arguments);
};

_.extend(DigitalOceanProvisioner.prototype, /** @lends DigitalOceanProvisioner.prototype */ {

    /**
     * @public
     * @constructor
     */
    'init': function(options) {
        options = options || {};
        _.defaults(options, {
            'client_id': null,
            'api_key': null,
            'scripts_path': null
        });
        if (!options.client_id) {
            throw '`client_id` is required';
        }
        if (!options.api_key) {
            throw '`api_key` is required';
        }
        if (!options.scripts_path) {
            throw '`scripts_path` is required';
        }
        if (!options.public_ssh_key) {
            throw '`public_ssk_key` is required';
        }
        if (!options.private_ssh_key) {
            throw '`private_ssh_key` is required';
        }
        if (!options.ssh_key_id) {
            throw '`ssh_key_id` is required';
        }
        if (_.isUndefined(options.enable_logging) || !_.isBoolean(options.enable_logging)) {
            options.enable_logging = true;
        }
        options.scripts_path = path.resolve(options.scripts_path);
        this._options = options;
        this._initLogger();
        this._loadPackage();
        this._initApi();
        this._initScripts();
        this._initCommand();
    },

    /**
     * @private
     */
    '_initLogger': function() {
        this._logFile = '/tmp/' + 'skiff-' + moment().format('MM-DD-YYYY') + '.log';
        winston.add(winston.transports.File, {
            'filename': this._logFile,
            'silent': false
        });
        winston.remove(winston.transports.Console);
    },

    /**
     * @private
     */
    '_loadPackage': function() {
        var contents = fs.readFileSync(__dirname + '/../package.json', 'utf8');
        this._package = JSON.parse(contents);
    },

    /**
     * @private
     */
    '_initCommand': function() {
        var self = this;
        var commands = [
            {
                'value': 'list-droplets',
                'description': 'List active droplets',
                'action': function() {
                    self.listDroplets();
                }
            },
            {
                'value': 'destroy-droplet <id>',
                'description': 'Destroy droplet with specified ID',
                'action': function(id) {
                    self.api.dropletDestroy(id, function(err, result) {
                        if (err) {
                            throw err;
                        }
                        self._log('info', 'Destroyed droplet', result);
                    });
                }
            }
        ];
        commander.version(this._package.version);
        commander.description(this._package.description);
        _.each(commands, function(command) {
            commander.command(command.value).description(command.description).action(command.action);
        });
        commander.parse(process.argv);
    },

    /**
     * @private
     */
    '_initApi': function() {
        this.api = new DigitalOceanAPI(this._options.client_id, this._options.api_key);
        this._inheritApiCommands();
    },

    /**
     * @private
     */
    '_inheritApiCommands': function() {
        _.each(apiCommands, function(cmd) {
            this[cmd] = this.api[cmd].bind(this.api);
        }, this);
    },

    /**
     * @private
     */
    '_initScripts': function() {
        var self = this;
        this._scripts = [];
        fs.stat(this._options.scripts_path, function(err, stats) {
            if (err) {
                throw err;
            }
            if (!stats.isDirectory()) {
                throw this._options.scripts_path + ' is not a directory.';
            }
            glob(self._options.scripts_path + '/*', function(err, scripts) {
                if (err) {
                    throw 'Error loading provisioning scripts';
                }
                self._scripts = scripts;
                var base_names = [];
                _.each(scripts, function(script) {
                    base_names.push(path.basename(script));
                });
                self._log('info', 'Loaded provisioning scripts from path (' + self._options.scripts_path + '): ' + base_names.join(', '));
            });
        });
    },

    /**
     * @public
     */
    'executeScripts': function(instance_id, scripts, final_cb) {
        var instances,
            all_tasks = [],
            self = this;
        this._log('info', 'Executing provisioning scripts', {
            'instance_id': instance_id,
            'scripts': scripts
        });
        if (!_.isArray(instance_id)) {
            instances = [instance_id];
        } else {
            instances = instance_id;
        }
        var promises = [];
        self.api.dropletGetAll(function(err, droplets) {
            if (err) {
                throw err;
            }
            _.each(instances, function(instance_id, instance_idx) {
                self._log('info', 'Executing scripts against instance_id ' + instance_id, {
                    'scripts': scripts
                });
                var tasks = [];
                _.each(scripts, function(script) {
                    tasks.push(function(cb) {
                        self.executeInstanceScript(instance_id, script, cb);
                    });
                });
                all_tasks.push(function(cb) {
                    async.series(tasks, function(err, result) {
                        cb(err, result);
                    });
                });
            });
            async.parallel(all_tasks, function(err, result) {
                final_cb(err, result);
            });
        });
    },

    /**
     * Copies a local folder to the remote destination on the specified droplet.
     *
     * @public
     */
    'copyFolder': function(instance_id, source, dest, cb) {
        var self = this;
        this.api.dropletGet(instance_id, function(err, instance) {
            if (err) {
                return cb(err);
            }
            if (dest.slice(-1) !== '/') {
                dest = dest + '/';
            }
            var rsync_cmd = _.sprintf("rsync -avz --delete -e 'ssh -i %s -o StrictHostKeyChecking=no -o GSSAPIAuthentication=no' %s root@%s:%s", self._options.private_ssh_key, source, instance.ip_address, dest);
            shell.exec(rsync_cmd, {
                'async': true,
                'silent': true
            }, function(code, output) {
                if (code !== 0) {
                    return cb('Error running rsync: ' + rsync_cmd);
                }
                return cb(null, output);
            });
        });
    },

    'syncFolders': function(instance_id, source, dest, cb) {
        var self = this;
        this.api.dropletGet(instance_id, function(err, instance) {
            if (err) {
                return cb(err);
            }
            if (dest.slice(-1) !== '/') {
                dest = dest + '/';
            }
            var rsync_cmd = _.sprintf("rsync -avz --delete -e 'ssh -i %s -o StrictHostKeyChecking=no -o GSSAPIAuthentication=no' %s root@%s:%s", self._options.private_ssh_key, source, instance.ip_address, dest);
            shell.exec(rsync_cmd, {
                'async': true,
                'silent': true
            }, function(code, output) {
                if (code !== 0) {
                    return cb('Error running rsync: ' + rsync_cmd);
                }
                return cb(null, output);
            });
        });
    },

    /**
     * @public
     */
    'executeInstanceScript': function(instance_id, script, cb) {
        var self = this;
        this._log('info', 'Executing `' + script + '` script against instance_id: ' + instance_id);
        var droplet = this.api.dropletGet(instance_id, function(err, instance) {
            if (err) {
                return cb(err);
            }
            var tasks = [
                function(cb2) {
                    self._copyInstanceScript(instance.ip_address, script, cb2);
                },
                function(result, cb3) {
                    self._executeExistingInstanceScript(result.ip_address, result.target_path, cb3);
                }
            ];
            async.waterfall(tasks, function(err, results) {
                if (err) {
                    return cb(err);
                }
                cb(null, results);
            });
        });
    },

    /**
     * @private
     */
    '_getScriptPath': function(script) {
        if (script.indexOf(path.sep) >= 0) {
            return script;
        } else {
            return this._options.scripts_path + '/' + script;
        }
    },

    /**
     * @private
     */
    '_copyInstanceScript': function(ip_address, script, cb) {
        var self = this,
            basename,
            attempts = 0;
        if (script.indexOf(path.sep) >= 0) {
            // A full path was specified for `script`
            basename = path.basename(script);
        } else {
            // Only a filename was specified for `script`
            basename = script;
        }
        var target_path = _.sprintf('/tmp/%s_%s', basename, moment().unix());
        var copy_cmd = _.sprintf('scp -i %s -o StrictHostKeyChecking=no -o GSSAPIAuthentication=no -q %s root@%s:%s', this._options.private_ssh_key, this._getScriptPath(script), ip_address, target_path);
        this._log('info', 'Copy script `' + script + '` to ip_address: ' + ip_address, {
            'cmd': copy_cmd
        });
        var kopy = function() {
            attempts++;
            shell.exec(copy_cmd, {
                'async': true,
                'silent': true
            }, function(code, output) {
                if (code !== 0) {
                    if (attempts > 10) {
                        self._log('error', 'Error copying provisioning script to target host', {
                            'ip_address': ip_address,
                            'script': script,
                            'cmd': copy_cmd,
                            'exit_code': code
                        });
                        return cb('scp returned with error code: ' + code);
                    } else {
                        setTimeout(function() {
                            kopy();
                        }, 120000);
                    }
                }
                self._log('info', 'Copy of script `' + script + '` to ip_address ' + ip_address + ' succeeded', {
                    'cmd': copy_cmd
                });
                return cb(null, {
                    'ip_address': ip_address,
                    'target_path': target_path
                });
            });
        };
        kopy();
    },

    /**
     * @private
     */
    '_executeExistingInstanceScript': function(ip_address, script_path, cb) {
        var script_cmd = _.sprintf('ssh root@%s -i %s -o StrictHostKeyChecking=no -o GSSAPIAuthentication=no -q "chmod +x %s; %s"', ip_address, this._options.private_ssh_key, script_path, script_path),
            self = this;
        self._log('info', 'Executing script `' + script_path + '` against ip_address: ' + ip_address);
        shell.exec(script_cmd, {
            'async': true,
            'silent': true
        }, function(code, output) {
            if (code !== 0) {
                self._log('error', 'Error executing remote provisioning script', {
                    'ip_address': ip_address,
                    'script_path': script_path,
                    'cmd': cmd,
                    'exit_code': code
                });
                return cb('ssh returned with error code: ' + code);
            }
            self._log('info', 'Execution of script `' + script_path + '` against ip_address ' + ip_address + ' succeeded');
            cb(null, output);
        });
    },

    /**
     * @public
     */
    'runInstanceCommand': function(instance_id, cmd, cb) {
        var self = this,
            cmd;
        this.api.dropletGet(instance_id, function(err, instance) {
            if (err) {
                return cb(err);
            }
            if (!instance) {
                return cb('Unable to locate instance_id: ' + instance_id);
            }
            cmd = _.sprintf('ssh root@%s -i %s -o StrictHostKeyChecking=no -o GSSAPIAuthentication=no -q "%s"', instance.ip_address, self._options.private_ssh_key, cmd),
            self._log('info', 'Running command `' + cmd + '` against ip_address: ' + instance.ip_address);
            shell.exec(cmd, {
                'async': true,
                'silent': true
            }, function(code, output) {
                if (code !== 0) {
                    self._log('error', 'Error executing remote provisioning script', {
                        'ip_address': instance.ip_address,
                        'cmd': cmd,
                        'exit_code': code
                    });
                    return cb('ssh returned with error code: ' + code);
                }
                self._log('info', 'Execution of command `' + cmd + '` against ip_address ' + instance.ip_address + ' succeeded');
                cb(null, output);
            });
        });
    },

    /**
     * @public
     */
    'provision': function(options, final_cb) {
        var instances,
            self = this;
        if (!_.isArray(options)) {
            instances = [options];
        } else {
            instances = options;
        }
        var tasks = [];
        _.each(instances, function(instance) {
            tasks.push(function(cb) {
                self._provision(instance, cb);
            });
        });
        async.parallel(tasks, function(err, provisioned_instances) {
            final_cb(err, provisioned_instances);
        });
    },

    /**
     * @private
     */
    '_provision': function(options, finalCb) {
        var self = this,
            start = moment().unix(),
            interval,
            called = false;
        self._log('info', 'Provisioning new droplet', options);
        var cb = function(err, instance) {
            if (called) {
                return;
            }
            called = true;
            if (interval) {
                clearInterval(interval);
            }
            if (err) {
                return finalCb(err);
            }
            var runScripts = function() {
                if (_.isArray(options.scripts) && !_.isEmpty(options.scripts)) {
                    self.executeScripts(instance.id, options.scripts, function(err, result) {
                        if (err) {
                            return finalCb(err);
                        }
                        return finalCb(null, instance);
                    });
                } else {
                    finalCb(null, instance);
                }
            };
            if (_.isArray(options.folders)) {
                var folderSeries = [];
                _.each(options.folders, function(folder) {
                    folderSeries.push(function(cb) {
                        self.copyFolder(instance.id, folder.source, folder.destination, cb);
                    });
                });
                async.series(folderSeries, function(err, result) {
                    if (err) {
                        return finalCb(err);
                    }
                    runScripts();
                });
            } else {
                runScripts();
            }
        };
        this.api.dropletNew(options.name, options.size, options.image, options.region, {
            'private_networking': options.private_networking,
            'ssh_key_ids': this._options.ssh_key_id
        }, function(err, droplet) {
            if (err) {
                throw err;
            }
            self._log('info', 'Droplet created', droplet);
                interval = setInterval(function() {
                self.api.eventGet(droplet.event_id, function(err, data) {
                    if (err) {
                        clearInterval(interval);
                        self._log('error', 'Droplet failed to become ready', droplet);
                        return cb(err);
                    }
                    if (data.action_status === 'done') {
                        self._log('info', 'Droplet is ready', droplet);
                        clearInterval(interval);
                        tcpPortUsed.waitUntilUsedOnHost(22, droplet.ip_address, 1000, 240000).then(function() {
                            setTimeout(function() {
                                return cb(null, droplet);
                            }, 10000);
                        }, function(err) {
                            self._log('warn', 'Unable to determine status of port 22 on host.', {
                                'droplet': droplet
                            });
                            return cb(err);
                        });
                        return;
                    }
                    self._log('info', 'Checking droplet status', {
                        'droplet': droplet,
                        'status': data
                    });
                    var tsDiff = moment().unix() - start;
                    if (tsDiff >= self._getDropletLaunchTimeout()) {
                        clearInterval(interval);
                        self._log('error', 'Droplet failed to become ready', droplet);
                        return cb('Creation of new droplet exceeded timeout of: ' + self._getDropletLaunchTimeout());
                    }
                });
            }, 8000);
        });
    },

    /**
     * @private
     */
    '_getDropletLaunchTimeout': function() {
        return 600; // 10 minutes
    },

    /**
     * @public
     */
    'dropletDestroyExcept': function(ids, cb) {
        var self = this,
            bad_ids = [];
        if (!_.isArray(ids)) {
            ids = [ids];
        }
        _.each(ids, function(id, k) {
            ids[k] = parseInt(id, 10);
        });
        this.api.dropletGetAll(function(err, droplets) {
            if (err) {
                return cb(err);
            }
            _.each(droplets, function(droplet) {
                droplet.id = parseInt(droplet.id, 10);
                if (ids.indexOf(droplet.id) < 0) {
                    bad_ids.push(droplet.id);
                }
            });
            var kill_tasks = [];
            _.each(bad_ids, function(id) {
                kill_tasks.push(function(cb) {
                    self.api.dropletDestroy(id, cb);
                });
            });
            async.parallel(kill_tasks, function(err, result) {
                if (err) {
                    return cb(err);
                }
                return cb(result);
            });
        });
    },

    /**
     * @public
     */
    'listDroplets': function() {
        this.api.dropletGetAll(function(err, droplets) {
            _.each(droplets, function(droplet) {
                _.each(droplet, function(v, k) {
                    if (v === false) {
                        droplet[k] = 'No';
                    } else if (!v) {
                        droplet[k] = 'N/A';
                    } else if (v === true) {
                        droplet[k] = 'Yes';
                    }
                });
            });
            var table = new Table({
                'head': ['ID', 'Name', 'Image ID', 'Size ID', 'Region ID', 'Backups Active', 'Public IP', 'Private IP', 'Locked', 'Status', 'Created At'],
                'colWidths': [15, 40, 15, 15, 15, 20, 20, 20, 15, 15, 25]
            });
            _.each(droplets, function(droplet) {
                table.push([droplet.id, droplet.name, droplet.image_id, droplet.size_id, droplet.region_id, droplet.backups_active, droplet.ip_address, droplet.private_ip_address, droplet.locked, droplet.status, droplet.created_at]);
            });
            console.log(table.toString());
        });
    },

    /**
     * Returns an existing droplet instance, given its name.
     *
     * @param {String} name - The name of an existing droplet.
     */
    'getDropletByName': function(name, cb) {
        this.api.dropletGetAll(function(err, droplets) {
            if (err) {
                return cb(err);
            }
            var droplet = _.findWhere(droplets, {
                'name': name
            });
            return cb(null, droplet);
        });
    },

    /**
     * @private
     */
    '_log': function() {
        if (!this._options.enable_logging) {
            return false;
        }
        winston.log.apply(winston, arguments);
        return true;
    }

});

MicroEvent.mixin(DigitalOceanProvisioner.prototype);

module.exports = DigitalOceanProvisioner;
