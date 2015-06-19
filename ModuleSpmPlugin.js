//some code from webpack
var semver = require('semver');

function ModulesSpmPlugin(moduleType) {
    this.moduleType = 'spm';
    this.directories = ['spm_modules'];
}
module.exports = ModulesSpmPlugin;

ModulesSpmPlugin.prototype.apply = function(resolver) {
    var moduleType = this.moduleType;
    var directories = this.directories;

    resolver.plugin("module", function(request, callback) {
        var fs = this.fileSystem;

        var i = request.request.indexOf("/"),
            j = request.request.indexOf("\\");
        var p = i < 0 ? j : j < 0 ? i : i < j ? i : j;
        var moduleName, remainingRequest;
        if(p < 0) {
            moduleName = request.request;
            remainingRequest = "";
        } else {
            moduleName = request.request.substr(0, p);
            remainingRequest = request.request.substr(p+1);
        }

        var paths = [request.path];
        var addr = [request.path];

        var pathSeqment = popPathSeqment(addr);
        var topLevelCallback = callback;
        while(pathSeqment) {
            paths.push(addr[0]);
            pathSeqment = popPathSeqment(addr);
        }

        //取package的版本信息
        var pkgfiles = paths.map(function(p) {
            return this.join(p, 'package.json');
        }, this);
        this.forEachBail(pkgfiles, function(file, callback) {
            fs.stat(file, function(err, stat) {
                if (!err && stat && stat.isFile()) {
                    fs.readFile(file, function(err, content) {
                        if (err) {
                            return callback();
                        }
                        content = content.toString("utf-8");
                        try {
                            content = JSON.parse(content);
                        } catch (e) {
                            return callback();
                        }
                        if (content.spm && content.spm.dependencies) {
                            return callback(content.spm.dependencies[moduleName]);
                        } else {
                            return callback();
                        }
                    });
                } else {
                    return callback();
                }
            });
        }, function(version) {
            var addrs = paths.map(function(p) {
                return directories.map(function(d) {
                    return this.join(p, d);
                }, this);
            }, this).reduce(function(array, p) {
                array.push.apply(array, p);
                return array;
            }, []);

            this.forEachBail(addrs, function(addr, callback) {
                fs.stat(addr, function(err, stat) {
                    if(!err && stat && stat.isDirectory()) {
                        this.applyPluginsParallelBailResult("module-" + moduleType, {
                            path: addr,
                            request: request.request,
                            query: request.query,
                            directory: request.directory,
                            spmVersion: version || '*'
                        }, createInnerCallback(function(err, result) {
                            if(err) return callback(err);
                            if(!result) return callback();
                            return callback(null, result);
                        }, topLevelCallback, "looking for modules in " + addr));
                        return;
                    }
                    return callback();
                }.bind(this));
            }.bind(this), function(err, result) {
                if(err) return callback(err);
                if(!result) return callback();
                return callback(null, result);
            });
        }.bind(this));
    });

    resolver.plugin("module-" + this.moduleType, function(request, callback) {
        var fs = this.fileSystem;
        var i = request.request.indexOf("/"),
            j = request.request.indexOf("\\");
        var p = i < 0 ? j : j < 0 ? i : i < j ? i : j;
        var moduleName, remainingRequest;
        if(p < 0) {
            moduleName = request.request;
            remainingRequest = "";
        } else {
            moduleName = request.request.substr(0, p);
            remainingRequest = request.request.substr(p+1);
        }

        var modulePath = this.join(request.path, moduleName);
        fs.stat(modulePath, function(err, stat) {
            if(err || !stat) {
                if(callback.missing)
                    callback.missing.push(modulePath);
                if(callback.log) callback.log(modulePath + " doesn't exist (module as directory)");
                return callback();
            }
            if(stat.isDirectory()) {
                // 同步
                // modulePath = loadSpmModuleWithVersion.call(this, modulePath, request.spmVersion);

                // var type = "directory-" + moduleType;
                // return this.doResolve(request.directory ? type : ["file", type], {
                //     path: modulePath,
                //     request: remainingRequest,
                //     query: request.query
                // }, callback, true);

                //异步
                return loadSpmModuleWithVersionAsync.call(this, modulePath, request.spmVersion, function(path) {
                    modulePath = path;
                    var type = "directory-" + moduleType;
                    return this.doResolve(request.directory ? type : ["file", type], {
                        path: modulePath,
                        request: remainingRequest,
                        query: request.query
                    }, callback, true);
                }.bind(this));
            }
            if(callback.log) callback.log(modulePath + " is not a directory (module as directory)");
            return callback();
        }.bind(this));
    });

    resolver.plugin("directory-" + this.moduleType, function(request, callback) {
        var fs = this.fileSystem;
        var filename = 'package.json';
        var directory = this.join(request.path, request.request);
        var descriptionFilePath = this.join(directory, filename);

        fs.readFile(descriptionFilePath, function(err, content) {
            if(err) {
                if(callback.log)
                    callback.log(descriptionFilePath + " doesn't exist (directory description file)");
                return callback();
            }
            content = content.toString("utf-8");
            try {
                content = JSON.parse(content);
            } catch(e) {
                if(callback.log)
                    callback.log(descriptionFilePath + " (directory description file): " + e);
                else
                    e.message = descriptionFilePath + " (directory description file): " + e;
                return callback(e);
            }
            var mainModules = [];
            // spm优先
            if (content.spm && content.spm.main && typeof content.spm.main === 'string') {
                mainModules.push(content.spm.main);
            }
            if (typeof content.main === 'string') {
                mainModules.push(content.main);
            }
            if (mainModules.length === 0) {
                mainModules.push('index');
            }
            
            (function next() {
                if(mainModules.length == 0) return callback();
                var mainModule = mainModules.shift();
                return this.doResolve(["file", "directory-" + moduleType], {
                    path: directory,
                    query: request.query,
                    request: mainModule
                }, createInnerCallback(function(err, result) {
                    if(!err && result) return callback(null, result);
                    return next.call(this);
                }.bind(this), callback, "use " + mainModule + " from " + filename));
            }.call(this))
        }.bind(this));
    });
};

function loadSpmModuleWithVersion(spmModulePath, version) {
    var dirs = fs.readdirSync(spmModulePath);
    var join = this.join;
    var versions = dirs
        .filter(filterDir.bind(this))
        .filter(semver.valid)
        .sort(semver.rcompare);

    var matchVersion = versions[0] || ''
    if (version) matchVersion = semver.maxSatisfying(versions, version);

    return this.join(spmModulePath, matchVersion);

    function filterDir(dir) {
        return fs.statSync(this.join(spmModulePath, dir)).isDirectory();
    }
}

function loadSpmModuleWithVersionAsync(spmModulePath, version, callback) {
    return filterDirAsync.call(this, spmModulePath, function(versions) {
        versions
            .filter(semver.valid)
            .sort(semver.rcompare);

        var matchVersion = versions[0] || ''
        if (version) matchVersion = semver.maxSatisfying(versions, version) || '';

        return callback(this.join(spmModulePath, matchVersion));
    }.bind(this));
}

function filterDirAsync(path, callback) {
    var fs = this.fileSystem;
    var join = this.join;
    var versions = [];

    fs.readdir(path, function(err, dirs) {
        var done = 0;
        dirs.forEach(function(dir) {
            fs.stat(join(path, dir), function(err, stat) {
                done++;
                if (!err && stat && stat.isDirectory()) {
                    versions.push(dir);
                }
                if (done === dirs.length) {
                    callback(versions);
                }
            });
        });
    });
}

//from webpack/enhanced-resolve
function popPathSeqment(pathInArray) {
    var i = pathInArray[0].lastIndexOf("/"),
        j = pathInArray[0].lastIndexOf("\\");
    var p = i < 0 ? j : j < 0 ? i : i < j ? j : i;
    if(p < 0) return null;
    var s = pathInArray[0].substr(p+1);
    pathInArray[0] = pathInArray[0].substr(0, p || 1);
    return s;
}

//from webpack/enhanced-resolve
function createInnerCallback(callback, options, message) {
    var log = options.log;
    if(!log) {
        if(options.stack !== callback.stack) {
            function callbackWrapper() {
                return callback.apply(this, arguments);
            }
            callbackWrapper.stack = options.stack;
            callbackWrapper.missing = options.missing;
        }
        return callback;
    }
    function loggingCallbackWrapper() {
        log(message);
        for(var i = 0; i < theLog.length; i++)
            log("  " + theLog[i]);
        return callback.apply(this, arguments);
    }
    var theLog = [];
    loggingCallbackWrapper.log = function writeLog(msg) {
        theLog.push(msg);
    };
    loggingCallbackWrapper.stack = options.stack;
    loggingCallbackWrapper.missing = options.missing;
    return loggingCallbackWrapper;
}